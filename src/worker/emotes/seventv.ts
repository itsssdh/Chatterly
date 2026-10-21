import type { Emote } from '@shared/types'
import type { ActivityLog } from '../logger'
import { join, readJson, writeJsonAtomic } from '../kv'

const API = 'https://7tv.io/v3'
export const GLOBAL_TTL_MS = 6 * 3600_000
export const CHANNEL_TTL_MS = 3 * 3600_000
const NEGATIVE_TTL_MS = 3600_000

// 7TV content flags we never use in generated chat: sexual, epilepsy-triggering and edgy emotes.
const SKIP_CONTENT_FLAGS = 65536 | 131072 | 262144
const ZERO_WIDTH_FLAG = 256
const LIFECYCLE_LIVE = 3
const PERSONAL_SET_FLAG = 4

interface RawEmote {
  id: string
  name: string
  flags?: number
  data?: { id: string; name: string; flags?: number; animated?: boolean; listed?: boolean; lifecycle?: number }
}
interface RawSet {
  id?: string
  name?: string
  emotes?: RawEmote[] | null
}

export interface LoadedSet {
  emotes: Emote[]
  setName: string
  fetchedAt: number
  /** True when the live request failed and cached data was used instead. */
  stale: boolean
  /** The channel has no 7TV account / emote set. */
  none: boolean
}

const CACHE_VERSION = 2

interface CacheFile {
  v?: number
  fetchedAt: number
  setName: string
  none?: boolean
  emotes: Emote[]
}

export function parseSet(raw: RawSet, source: Emote['source']): Emote[] {
  const out: Emote[] = []
  for (const e of raw.emotes ?? []) {
    const d = e.data
    if (!d || !e.id || !e.name) continue
    if (d.lifecycle !== undefined && d.lifecycle !== LIFECYCLE_LIVE) continue
    const contentFlags = d.flags ?? 0
    if (contentFlags & SKIP_CONTENT_FLAGS) continue
    // Zero-width emotes overlay the emote before them. They are kept, flagged, and only ever used as an overlay.
    const zeroWidth = !!((e.flags ?? 0) & 1 || contentFlags & ZERO_WIDTH_FLAG)
    out.push({ id: e.id, name: e.name, animated: !!d.animated, source, zeroWidth })
  }
  return out
}

/** 7TV emote metadata with browser-side caching, stale-cache fallback and negative caching. */
export class SevenTv {
  constructor(
    private dir: string,
    private log: ActivityLog,
    private fetchFn: typeof fetch = (input, init) => fetch(input, init),
    private now: () => number = Date.now
  ) {}

  private async getJson<T>(url: string): Promise<{ status: number; body: T | null }> {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 15_000)
    try {
      const res = await this.fetchFn(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } })
      if (res.status === 404) return { status: 404, body: null }
      if (!res.ok) throw new Error(`7TV responded ${res.status}`)
      return { status: res.status, body: (await res.json()) as T }
    } finally {
      clearTimeout(t)
    }
  }

  private async load(file: string, ttl: number, force: boolean, fetcher: () => Promise<CacheFile>): Promise<LoadedSet> {
    const path = join(this.dir, file)
    const cached = readJson<CacheFile>(path)
    const fresh = cached && cached.v === CACHE_VERSION && this.now() - cached.fetchedAt < (cached.none ? NEGATIVE_TTL_MS : ttl)
    if (cached && fresh && !force) {
      return { emotes: cached.emotes, setName: cached.setName, fetchedAt: cached.fetchedAt, stale: false, none: !!cached.none }
    }
    try {
      const next = await fetcher()
      writeJsonAtomic(path, next)
      return { emotes: next.emotes, setName: next.setName, fetchedAt: next.fetchedAt, stale: false, none: !!next.none }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (cached) {
        this.log.warn(`7TV unreachable (${msg}) — using cached emotes from ${new Date(cached.fetchedAt).toLocaleString()}`)
        return { emotes: cached.emotes, setName: cached.setName, fetchedAt: cached.fetchedAt, stale: true, none: !!cached.none }
      }
      throw err
    }
  }

  getGlobal(force = false): Promise<LoadedSet> {
    return this.load('global.json', GLOBAL_TTL_MS, force, async () => {
      const { body } = await this.getJson<RawSet>(`${API}/emote-sets/global`)
      if (!body) throw new Error('7TV global emote set not found')
      return { v: CACHE_VERSION, fetchedAt: this.now(), setName: body.name ?? 'Global', emotes: parseSet(body, 'global') }
    })
  }

  getChannel(twitchId: string, force = false): Promise<LoadedSet> {
    if (!/^\d+$/.test(twitchId)) return Promise.reject(new Error('invalid Twitch user id'))
    return this.load(`channel-${twitchId}.json`, CHANNEL_TTL_MS, force, async () => {
      const { status, body } = await this.getJson<{ emote_set?: RawSet | null }>(`${API}/users/twitch/${twitchId}`)
      if (status === 404 || !body?.emote_set) {
        return { v: CACHE_VERSION, fetchedAt: this.now(), setName: '', none: true, emotes: [] }
      }
      return { v: CACHE_VERSION, fetchedAt: this.now(), setName: body.emote_set.name ?? 'Channel emotes', emotes: parseSet(body.emote_set, 'channel') }
    })
  }

  /**
   * The account's 7TV *personal* emote sets (flag 4). 7TV shows these to viewers wherever that account chats,
   * so they can be used in any channel. Empty if the account has no 7TV profile or no personal set.
   */
  getPersonal(twitchId: string, force = false): Promise<LoadedSet> {
    if (!/^\d+$/.test(twitchId)) return Promise.reject(new Error('invalid Twitch user id'))
    return this.load(`personal-${twitchId}.json`, CHANNEL_TTL_MS, force, async () => {
      const { status, body } = await this.getJson<{ user?: { emote_sets?: { id: string; flags?: number }[] } }>(`${API}/users/twitch/${twitchId}`)
      if (status === 404 || !body?.user) return { v: CACHE_VERSION, fetchedAt: this.now(), setName: '', none: true, emotes: [] }
      const personal = (body.user.emote_sets ?? []).filter((s) => ((s.flags ?? 0) & PERSONAL_SET_FLAG) !== 0)
      const emotes: Emote[] = []
      for (const set of personal) {
        const res = await this.getJson<RawSet>(`${API}/emote-sets/${set.id}`)
        if (res.body) emotes.push(...parseSet(res.body, 'personal'))
      }
      return { v: CACHE_VERSION, fetchedAt: this.now(), setName: 'Personal', none: personal.length === 0, emotes }
    })
  }
}
