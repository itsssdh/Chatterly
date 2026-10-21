import { EventEmitter } from '../events'
import type { Emote, EmoteSetInfo } from '@shared/types'
import type { ActivityLog } from '../logger'
import type { SevenTv } from './seventv'

interface ChannelEntry {
  emotes: Emote[]
  info: EmoteSetInfo
  twitchId: string | null
}

const REFRESH_CHECK_MS = 30 * 60_000

/**
 * Holds the emotes each channel can render: its own 7TV set plus the global 7TV set.
 * Emits 'changed' (channel | null) whenever data is (re)loaded.
 */
export class EmoteManager extends EventEmitter {
  private globals: Emote[] = []
  private globalInfo: { loaded: boolean; error?: string; fetchedAt?: number } = { loaded: false }
  private channels = new Map<string, ChannelEntry>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private globalLoading: Promise<void> | null = null
  private personal: Emote[] = []
  private personalId: string | null = null

  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private retryCount = new Map<string, number>()

  constructor(
    private api: SevenTv,
    private log: ActivityLog,
    /** First retry delay after a failed download (then x3 each time, up to 5 minutes). */
    private retryBaseMs = 5000
  ) {
    super()
  }

  /** A failed download (offline, network still starting up) is retried with growing delays instead of waiting for the next refresh. */
  private scheduleRetry(key: string, fn: () => void): void {
    if (this.retryTimers.has(key)) return
    const n = (this.retryCount.get(key) ?? 0) + 1
    this.retryCount.set(key, n)
    const delay = Math.min(300_000, this.retryBaseMs * 3 ** (n - 1))
    const t = setTimeout(() => {
      this.retryTimers.delete(key)
      fn()
    }, delay)
    t.unref?.()
    this.retryTimers.set(key, t)
  }

  start(): void {
    this.timer = setInterval(() => void this.refreshStale(), REFRESH_CHECK_MS)
    this.timer.unref?.()
    void this.loadGlobal()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    for (const t of this.retryTimers.values()) clearTimeout(t)
    this.retryTimers.clear()
  }

  loadGlobal(force = false): Promise<void> {
    if (this.globalLoading) return this.globalLoading
    this.globalLoading = (async () => {
      try {
        const set = await this.api.getGlobal(force)
        this.globals = set.emotes
        this.globalInfo = { loaded: true, fetchedAt: set.fetchedAt }
        this.retryCount.delete('global')
        this.log.info(`Loaded ${set.emotes.length} global 7TV emotes${set.stale ? ' (cached)' : ''}`)
      } catch (err) {
        this.globalInfo = { loaded: this.globals.length > 0, error: err instanceof Error ? err.message : String(err) }
        this.log.warn(`Could not load global 7TV emotes: ${this.globalInfo.error}`)
        if (!this.globals.length) this.scheduleRetry('global', () => void this.loadGlobal())
      } finally {
        this.globalLoading = null
        this.emit('changed', null)
      }
    })()
    return this.globalLoading
  }

  private entry(login: string): ChannelEntry {
    let e = this.channels.get(login)
    if (!e) {
      e = { emotes: [], twitchId: null, info: { status: 'none', channelCount: 0, globalCount: this.globals.length } }
      this.channels.set(login, e)
    }
    return e
  }

  /** Load a channel's 7TV set once its Twitch user id is known. Safe to call repeatedly. */
  async loadChannel(login: string, twitchId: string, force = false): Promise<void> {
    const e = this.entry(login)
    if (e.info.status === 'loading' && !force) return
    e.twitchId = twitchId
    e.info = { ...e.info, status: 'loading' }
    this.emit('changed', login)
    try {
      const set = await this.api.getChannel(twitchId, force)
      e.emotes = set.emotes
      e.info = {
        status: set.none ? 'unavailable' : 'ready',
        channelCount: set.emotes.length,
        globalCount: this.globals.length,
        setName: set.setName || undefined,
        detail: set.none ? 'No channel emote set — using global emotes.' : set.stale ? 'Offline — showing saved emotes.' : undefined,
        fetchedAt: set.fetchedAt
      }
      this.retryCount.delete(`ch:${login}`)
      this.log.info(
        set.none ? 'No 7TV set — using global emotes' : `Loaded ${set.emotes.length} emotes${set.stale ? ' (cached)' : ''}`,
        login
      )
    } catch (err) {
      e.info = {
        status: 'unavailable',
        channelCount: e.emotes.length,
        globalCount: this.globals.length,
        detail: 'Could not load emotes.'
      }
      this.log.warn(`7TV emotes unavailable: ${err instanceof Error ? err.message : err}`, login)
      if (!e.emotes.length) this.scheduleRetry(`ch:${login}`, () => void this.loadChannel(login, twitchId))
    }
    this.emit('changed', login)
  }

  /** Load the logged-in account's 7TV personal emotes (usable in every channel). Pass null on logout. */
  async loadPersonal(twitchId: string | null, force = false): Promise<void> {
    this.personalId = twitchId
    if (!twitchId) {
      this.personal = []
      this.emit('changed', null)
      return
    }
    try {
      const set = await this.api.getPersonal(twitchId, force)
      this.personal = set.emotes
      this.log.info(set.emotes.length ? `Loaded ${set.emotes.length} personal 7TV emotes (${set.emotes.map((e) => e.name).join(', ')})` : 'No personal 7TV emote set on this account')
    } catch (err) {
      this.log.warn(`Could not load personal 7TV emotes: ${err instanceof Error ? err.message : err}`)
    }
    this.emit('changed', null)
  }

  personalEmotes(): Emote[] {
    return this.personal
  }

  remove(login: string): void {
    this.channels.delete(login)
  }

  /** Emotes usable in a channel: channel set first (wins name clashes), then global. */
  forChannel(login: string): Emote[] {
    const c = this.channels.get(login)
    const seen = new Set<string>()
    const out: Emote[] = []
    for (const e of [...(c?.emotes ?? []), ...this.globals]) {
      if (seen.has(e.name)) continue
      seen.add(e.name)
      out.push(e)
    }
    return out
  }

  globalEmotes(): Emote[] {
    return this.globals
  }

  info(login: string): EmoteSetInfo {
    const c = this.channels.get(login)
    const base: EmoteSetInfo = c?.info ?? { status: 'none', channelCount: 0, globalCount: this.globals.length }
    return { ...base, globalCount: this.globals.length, personalCount: this.personal.length, detail: base.detail ?? this.globalInfo.error }
  }

  globalStatus(): { count: number; error?: string; fetchedAt?: number } {
    return { count: this.globals.length, error: this.globalInfo.error, fetchedAt: this.globalInfo.fetchedAt }
  }

  async refresh(login: string | null): Promise<void> {
    await this.loadGlobal(true)
    if (login) {
      const e = this.channels.get(login)
      if (e?.twitchId) await this.loadChannel(login, e.twitchId, true)
    } else {
      for (const [l, e] of this.channels) if (e.twitchId) await this.loadChannel(l, e.twitchId, true)
    }
  }

  private async refreshStale(): Promise<void> {
    await this.loadGlobal()
    for (const [login, e] of this.channels) if (e.twitchId) await this.loadChannel(login, e.twitchId)
    if (this.personalId) await this.loadPersonal(this.personalId)
  }
}
