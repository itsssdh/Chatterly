import type { LiveState } from '@shared/types'
import type { ActivityLog } from '../logger'

export interface StreamInfo {
  live: LiveState
  viewers?: number
  title?: string
  game?: string
}

export interface UserInfo {
  id: string
  login: string
  displayName: string
}

/** Thin wrapper over the few Helix endpoints we need. Both require a logged-in user token and the app's Client ID. */
export class Helix {
  constructor(
    private getToken: () => Promise<string | null>,
    private getClientId: () => string,
    private onUnauthorized: () => Promise<string | null>,
    private log: ActivityLog,
    private fetchFn: typeof fetch = (input, init) => fetch(input, init)
  ) {}

  private async get<T>(path: string, params: string[][], retried = false): Promise<T | null> {
    const token = await this.getToken()
    const clientId = this.getClientId()
    if (!token || !clientId) return null
    const url = `https://api.twitch.tv/helix/${path}?${new URLSearchParams(params as [string, string][])}`
    const res = await this.fetchFn(url, { headers: { Authorization: `Bearer ${token}`, 'Client-Id': clientId } })
    if (res.status === 401 && !retried) {
      // Expired or revoked: renew once and retry before giving up.
      return (await this.onUnauthorized()) ? this.get<T>(path, params, true) : null
    }
    if (!res.ok) {
      this.log.debug(`Helix ${path} returned ${res.status}`)
      return null
    }
    return (await res.json()) as T
  }

  async users(logins: string[]): Promise<Map<string, UserInfo> | null> {
    if (!logins.length) return new Map()
    const out = new Map<string, UserInfo>()
    for (let i = 0; i < logins.length; i += 100) {
      const chunk = logins.slice(i, i + 100)
      const body = await this.get<{ data: { id: string; login: string; display_name: string }[] }>(
        'users',
        chunk.map((l) => ['login', l])
      )
      if (!body) return null
      for (const u of body.data) out.set(u.login.toLowerCase(), { id: u.id, login: u.login.toLowerCase(), displayName: u.display_name })
    }
    return out
  }

  /** Live status for each login; `null` if status can't be determined (not logged in, network error). */
  async streams(logins: string[]): Promise<Map<string, StreamInfo> | null> {
    if (!logins.length) return new Map()
    const out = new Map<string, StreamInfo>()
    for (let i = 0; i < logins.length; i += 100) {
      const chunk = logins.slice(i, i + 100)
      const body = await this.get<{ data: { user_login: string; viewer_count: number; title: string; game_name: string; type: string }[] }>(
        'streams',
        chunk.map((l) => ['user_login', l])
      )
      if (!body) return null
      for (const l of chunk) out.set(l, { live: 'offline' })
      for (const s of body.data) {
        if (s.type === 'live') out.set(s.user_login.toLowerCase(), { live: 'live', viewers: s.viewer_count, title: s.title, game: s.game_name })
      }
    }
    return out
  }
}
