import { EventEmitter } from '../events'
import type { AuthState } from '@shared/types'
import type { ActivityLog } from '../logger'
import type { StoredToken, TokenVault } from '../secrets'

export const SCOPES = ['chat:read', 'chat:edit']

const HOUR = 3600_000
/** Refresh when less than this is left on the access token. */
const REFRESH_MARGIN_MS = 60 * 60_000
/** Exchange the refresh token at least this often, which keeps Twitch's 30-day idle window from ever running out. */
const RENEW_EVERY_MS = 12 * HOUR
const MAINTENANCE_MS = 15 * 60_000
const ID_BASE = 'https://id.twitch.tv/oauth2'

type Fetch = typeof fetch

interface TokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number
  scope?: string[]
}

interface ValidateResponse {
  login: string
  user_id: string
  client_id: string
  scopes: string[]
  expires_in: number
}

function form(data: Record<string, string>): URLSearchParams {
  return new URLSearchParams(data)
}

/**
 * The page where the user approves the login, with the code already filled in. Built here in the form Twitch documents
 * (`/activate?public=true&device-code=<code>`) instead of trusting the returned link, which can omit `public=true`;
 * without it, signing in to Twitch first can leave the browser on twitch.tv's home page instead of the activation page.
 */
export function activateUrl(userCode: string): string {
  return `https://www.twitch.tv/activate?public=true&device-code=${encodeURIComponent(userCode)}`
}

/**
 * Twitch Device Code Grant flow for a *public* client: no client secret, no redirect server,
 * no password handling. The user approves on twitch.tv with a short code.
 */
export class TwitchAuth extends EventEmitter {
  private state: AuthState = { status: 'logged-out', clientIdSet: false }
  private abort: AbortController | null = null
  private refreshing: Promise<string | null> | null = null
  private maintenance: ReturnType<typeof setTimeout> | null = null
  private lastValidated = 0

  constructor(
    private vault: TokenVault,
    private getClientId: () => string,
    private log: ActivityLog,
    private openUrl: (url: string) => void,
    private fetchFn: Fetch = (input, init) => fetch(input, init)
  ) {
    super()
    this.state = { status: 'logged-out', clientIdSet: !!getClientId() }
  }

  getState(): AuthState {
    if (this.state.status === 'logged-out') return { ...this.state, clientIdSet: !!this.getClientId() }
    return this.state
  }

  private set(s: AuthState): void {
    this.state = s
    this.emit('state', s)
  }

  get login(): string | null {
    return this.state.status === 'logged-in' ? this.state.login : null
  }

  /** Restore a saved session at startup; refreshes or drops it if it is no longer valid. */
  async restore(): Promise<void> {
    const t = this.vault.load()
    if (!t) return
    if (t.clientId !== this.getClientId()) {
      this.log.info('Saved login belongs to a different Client ID — please log in again')
      this.vault.clear()
      return
    }
    // Every launch renews the session (if it hasn't been in the last 12 h), restarting Twitch's 30-day idle window.
    const token = await this.getAccessToken(true)
    this.startMaintenance()
    if (!token) this.set({ status: 'logged-out', clientIdSet: true, error: 'Your Twitch session expired. Log in again.', errorKind: 'session' })
  }

  async startLogin(): Promise<void> {
    const clientId = this.getClientId()
    if (!clientId) {
      this.set({ status: 'logged-out', clientIdSet: false, error: 'Enter a Client ID first.', errorKind: 'login' })
      return
    }
    this.cancelLogin()
    const abort = new AbortController()
    this.abort = abort
    try {
      const res = await this.fetchFn(`${ID_BASE}/device`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form({ client_id: clientId, scopes: SCOPES.join(' ') }),
        signal: abort.signal
      })
      if (!res.ok) {
        throw new Error(res.status === 400 || res.status === 401 ? "Twitch didn't accept that Client ID." : `Twitch returned an error (${res.status}).`)
      }
      const d = (await res.json()) as { device_code: string; user_code: string; verification_uri: string; expires_in: number; interval: number }
      const expiresAt = Date.now() + d.expires_in * 1000
      const link = activateUrl(d.user_code)
      this.set({ status: 'pending', userCode: d.user_code, verificationUri: link, expiresAt })
      this.openUrl(link)
      this.log.info(`Twitch login started — code ${d.user_code}`)
      await this.poll(clientId, d.device_code, Math.max(d.interval, 1), expiresAt, abort.signal)
    } catch (err) {
      if (abort.signal.aborted) return
      const raw = err instanceof Error ? err.message : String(err)
      const message = /fetch failed|failed to fetch|load failed|networkerror|network|ENOTFOUND|ECONN|timed out/i.test(raw) ? "Couldn't reach Twitch. Check your connection." : raw
      this.log.error(`Twitch login failed: ${raw}`)
      this.set({ status: 'logged-out', clientIdSet: !!clientId, error: message, errorKind: 'login' })
    }
  }

  private async poll(clientId: string, deviceCode: string, intervalSec: number, expiresAt: number, signal: AbortSignal): Promise<void> {
    let interval = intervalSec
    let netFailures = 0
    while (Date.now() < expiresAt) {
      await new Promise((r) => setTimeout(r, interval * 1000))
      if (signal.aborted) return
      let res: Response
      try {
        res = await this.fetchFn(`${ID_BASE}/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form({
            client_id: clientId,
            scopes: SCOPES.join(' '),
            device_code: deviceCode,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
          }),
          signal
        })
      } catch (err) {
        // A brief network drop while waiting for you to approve must not cancel the login.
        if (signal.aborted) return
        if (++netFailures > 8) throw err
        continue
      }
      netFailures = 0
      if (res.ok) {
        const tok = (await res.json()) as TokenResponse
        await this.finishLogin(clientId, tok)
        return
      }
      const err = (await res.json().catch(() => ({}))) as { message?: string }
      const msg = err.message ?? ''
      if (/authorization_pending/i.test(msg)) continue
      if (/slow_down/i.test(msg)) {
        interval += 5
        continue
      }
      throw new Error(/expired/i.test(msg) ? 'The login code expired. Try again.' : /denied/i.test(msg) ? 'Login was denied on twitch.tv.' : msg || `Twitch returned ${res.status}`)
    }
    throw new Error('The login code expired. Try again.')
  }

  private async validate(accessToken: string): Promise<ValidateResponse | null> {
    const res = await this.fetchFn(`${ID_BASE}/validate`, { headers: { Authorization: `OAuth ${accessToken}` } })
    return res.ok ? ((await res.json()) as ValidateResponse) : null
  }

  private async finishLogin(clientId: string, tok: TokenResponse): Promise<void> {
    const v = await this.validate(tok.access_token)
    if (!v) throw new Error('Twitch could not validate the new token.')
    const stored: StoredToken = {
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token,
      expiresAt: Date.now() + tok.expires_in * 1000,
      login: v.login,
      userId: v.user_id,
      scopes: v.scopes,
      clientId,
      refreshedAt: Date.now()
    }
    this.vault.save(stored)
    this.lastValidated = Date.now()
    this.startMaintenance()
    this.log.info(`Logged in to Twitch as ${v.login}${this.vault.persistent ? '' : ' (this session only — secure storage unavailable)'}`)
    this.setLoggedIn(stored)
  }

  private setLoggedIn(t: StoredToken): void {
    this.set({ status: 'logged-in', login: t.login, userId: t.userId, scopes: t.scopes, storedSecurely: this.vault.persistent, renewedAt: t.refreshedAt ?? Date.now() })
  }

  /** Forget a stale login error (e.g. after the Client ID was edited). */
  clearError(): void {
    if (this.state.status === 'logged-out' && this.state.error) this.set({ status: 'logged-out', clientIdSet: !!this.getClientId() })
  }

  cancelLogin(): void {
    this.abort?.abort()
    this.abort = null
    if (this.state.status === 'pending') this.set({ status: 'logged-out', clientIdSet: !!this.getClientId() })
  }

  /**
   * A valid access token, refreshing it first if it is about to expire.
   * `renewIfStale` also exchanges the refresh token when it hasn't been for 12 h.
   */
  async getAccessToken(renewIfStale = false): Promise<string | null> {
    const t = this.vault.load()
    if (!t) return null
    const stale = renewIfStale && Date.now() - (t.refreshedAt ?? 0) > RENEW_EVERY_MS
    if (t.expiresAt - Date.now() > REFRESH_MARGIN_MS && !stale) {
      if (this.state.status !== 'logged-in') this.setLoggedIn(t)
      return t.accessToken
    }
    return this.forceRefresh()
  }

  /** Exchange the refresh token now (single-flight). Returns the new access token, or null. */
  forceRefresh(): Promise<string | null> {
    const t = this.vault.load()
    if (!t) return Promise.resolve(null)
    if (!this.refreshing) this.refreshing = this.refresh(t).finally(() => (this.refreshing = null))
    return this.refreshing
  }

  /** Twitch rejected our token: try one refresh, and only drop the login if that fails for good. */
  async handleUnauthorized(): Promise<string | null> {
    this.log.warn('Twitch rejected the access token — refreshing it')
    return this.forceRefresh()
  }

  /** Keeps the session alive in the background: renew before expiry, renew daily, validate hourly (as Twitch asks). */
  private startMaintenance(): void {
    if (this.maintenance) return
    this.maintenance = setInterval(() => void this.maintain(), MAINTENANCE_MS)
    this.maintenance.unref?.()
  }

  async maintain(): Promise<void> {
    const t = this.vault.load()
    if (!t || this.state.status !== 'logged-in') return
    const now = Date.now()
    if (t.expiresAt - now < REFRESH_MARGIN_MS + MAINTENANCE_MS || now - (t.refreshedAt ?? 0) > RENEW_EVERY_MS) {
      await this.forceRefresh()
      return
    }
    if (now - this.lastValidated > HOUR) {
      this.lastValidated = now
      try {
        if (!(await this.validate(t.accessToken))) await this.forceRefresh()
      } catch {
        // offline: try again next round
      }
    }
  }

  private async refresh(t: StoredToken): Promise<string | null> {
    try {
      const res = await this.fetchFn(`${ID_BASE}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form({ client_id: t.clientId, grant_type: 'refresh_token', refresh_token: t.refreshToken })
      })
      if (res.status === 400 || res.status === 401) {
        // Refresh tokens are single-use and expire after 30 days idle; once invalid, a new login is the only way.
        this.log.warn('Twitch no longer accepts the saved session — please log in again')
        this.vault.clear()
        this.set({ status: 'logged-out', clientIdSet: true, error: 'Your Twitch session expired. Log in again.', errorKind: 'session' })
        return null
      }
      if (!res.ok) throw new Error(`Twitch returned ${res.status}`)
      const tok = (await res.json()) as TokenResponse
      const now = Date.now()
      const next: StoredToken = { ...t, accessToken: tok.access_token, refreshToken: tok.refresh_token, expiresAt: now + tok.expires_in * 1000, refreshedAt: now }
      // The old refresh token is now dead, so the new one is persisted before anything else happens.
      this.vault.save(next)
      this.lastValidated = now
      this.setLoggedIn(next)
      this.log.debug('Twitch session renewed')
      return next.accessToken
    } catch (err) {
      // Network or Twitch trouble: keep the saved session untouched and try again later.
      this.log.warn(`Could not renew the Twitch session (will retry): ${err instanceof Error ? err.message : err}`)
      if (this.state.status !== 'logged-in') this.setLoggedIn(t)
      return t.expiresAt > Date.now() ? t.accessToken : null
    }
  }

  /** Called when Twitch rejects the current token (e.g. revoked in Twitch settings). */
  invalidate(): void {
    this.vault.clear()
    this.set({ status: 'logged-out', clientIdSet: !!this.getClientId(), error: 'Twitch rejected the saved login. Log in again.', errorKind: 'session' })
  }

  async logout(): Promise<void> {
    const t = this.vault.load()
    this.cancelLogin()
    this.vault.clear()
    this.set({ status: 'logged-out', clientIdSet: !!this.getClientId() })
    if (t) {
      try {
        await this.fetchFn(`${ID_BASE}/revoke`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form({ client_id: t.clientId, token: t.accessToken })
        })
      } catch {
        // best effort
      }
      this.log.info('Logged out of Twitch and revoked the token')
    }
  }
}
