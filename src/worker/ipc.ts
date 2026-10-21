import type { ChannelPatch, InitPayload, Result } from '@shared/ipc'
import {
  DEFAULT_OVERRIDES,
  type AppSettings,
  type ChannelConfig,
  type EmoteDensity,
  type EmoteListPayload,
  type Personality,
  type SendMode,
  type ThemeSetting
} from '@shared/types'
import type { Automation } from './automation'
import type { EmoteManager } from './emotes/manager'
import { freezeKv, kv } from './kv'
import type { ActivityLog } from './logger'
import { num, sanitizePacing, strList } from './pacing'
import { mergeChannel, mergeSettings, type ConfigStore } from './store'
import type { TwitchAuth } from './twitch/auth'

export interface IpcDeps {
  store: ConfigStore
  log: ActivityLog
  auth: TwitchAuth
  automation: Automation
  emotes: EmoteManager
  initPayload: () => InitPayload
  broadcastConfig: () => void
  resolveChannel: (cfg: ChannelConfig) => Promise<void>
  refreshLive: () => Promise<void>
  applySettings: (prev: AppSettings) => void
  validLogin: (raw: string) => string | null
  onAutomationChange: () => void
  /** Registers a request handler (the transport is the page's message channel). */
  register: (channel: string, fn: (...args: any[]) => unknown) => void // eslint-disable-line @typescript-eslint/no-explicit-any
  history: () => import('@shared/types').SentMessage[]
  watchChat: (login: string | null) => import('@shared/types').ChatLine[]
}

const PERSONALITIES: Personality[] = ['chill', 'playful', 'supportive', 'gaming', 'emotes']
const DENSITIES: EmoteDensity[] = ['low', 'medium', 'high', 'emote-only']
const MODES: SendMode[] = ['approval', 'auto']
const THEMES: ThemeSetting[] = ['system', 'light', 'dark']


/** Twitch allows an account to be in 100 chat rooms at once. */
const MAX_CHANNELS = 100

/** Validates and applies a settings patch (used by the settings page and by Restore, so both follow the same rules). */
function applySettingsPatch(s: AppSettings, p: Partial<AppSettings>): { clientIdChanged: boolean } {
  let clientIdChanged = false
    if (THEMES.includes(p.theme as ThemeSetting)) s.theme = p.theme as ThemeSetting
    if (MODES.includes(p.sendMode as SendMode)) s.sendMode = p.sendMode as SendMode
    if (PERSONALITIES.includes(p.personality as Personality)) s.personality = p.personality as Personality
    if (DENSITIES.includes(p.density as EmoteDensity)) s.density = p.density as EmoteDensity
    if (p.pacing) s.pacing = sanitizePacing(p.pacing, s.pacing)
    if (typeof p.twitchClientId === 'string' && p.twitchClientId.trim().slice(0, 64) !== s.twitchClientId) {
      s.twitchClientId = p.twitchClientId.trim().slice(0, 64)
      clientIdChanged = true
    }
    if (typeof p.fillerWhenQuiet === 'boolean') s.fillerWhenQuiet = p.fillerWhenQuiet
    if (typeof p.logToFile === 'boolean') s.logToFile = p.logToFile
    if (typeof p.verboseLog === 'boolean') s.verboseLog = p.verboseLog
    if (typeof p.openAtLogin === 'boolean') s.openAtLogin = p.openAtLogin
    if (typeof p.menuBarIcon === 'boolean') s.menuBarIcon = p.menuBarIcon
    if (p.blocklist) s.blocklist = strList(p.blocklist, 200)
    if (p.favoriteEmotes) s.favoriteEmotes = strList(p.favoriteEmotes, 500)
    if (p.laughEmotes) s.laughEmotes = strList(p.laughEmotes, 100).filter((n) => /^[\w()\-:.!?]{1,50}$/.test(n))
    if (p.avoidEmoteWords) s.avoidEmoteWords = strList(p.avoidEmoteWords, 100)
    if (typeof p.answerGreetings === 'boolean') s.answerGreetings = p.answerGreetings
    if (p.customMentions) s.customMentions = strList(p.customMentions, 20).map((m) => m.replace(/^@/, '')).filter((m) => /^[\p{L}\p{N}_]{1,30}$/u.test(m))
    if (p.greetingReplyEmotes) s.greetingReplyEmotes = strList(p.greetingReplyEmotes, 50).filter((n) => /^[\w()\-:.!?]{1,50}$/.test(n))
    if (p.greetingCooldownSec !== undefined) s.greetingCooldownSec = num(p.greetingCooldownSec, 0, 1_000_000, s.greetingCooldownSec)
  return { clientIdChanged }
}

export function registerIpc(d: IpcDeps): void {
  const { store, log, auth, automation, emotes } = d
  /** Personal 7TV emotes (usable everywhere) are listed after the set's own emotes. */
  const withPersonal = (list: import('@shared/types').Emote[]): import('@shared/types').Emote[] => {
    const names = new Set(list.map((e) => e.name))
    return [...list, ...emotes.personalEmotes().filter((e) => !names.has(e.name))]
  }
  const handle = <A extends unknown[], R>(channel: string, fn: (...args: A) => R | Promise<R>): void => {
    d.register(channel, async (...args: unknown[]) => {
      try {
        return await fn(...(args as A))
      } catch (err) {
        log.error(`Internal error in ${channel}: ${err instanceof Error ? err.message : err}`)
        throw err
      }
    })
  }

  handle('init', () => d.initPayload())

  handle('settings:update', (patch: Partial<AppSettings>) => {
    const prev = { ...store.settings }
    const { clientIdChanged } = applySettingsPatch(store.settings, (patch ?? {}) as Partial<AppSettings>)
    if (clientIdChanged) auth.clearError()
    store.save()
    d.applySettings(prev)
    d.broadcastConfig()
    return store.settings
  })

  handle('channels:add', async (raw: string): Promise<Result> => {
    const login = d.validLogin(String(raw ?? ''))
    if (!login) return { ok: false, error: 'Not a valid Twitch username.' }
    if (store.channels.some((c) => c.login === login)) return { ok: false, error: 'Already added.' }
    if (store.channels.length >= MAX_CHANNELS) return { ok: false, error: `Up to ${MAX_CHANNELS} channels (Twitch's chat-room limit).` }
    // New channels start disabled: the user has to switch each one on, and sending on separately.
    const cfg: ChannelConfig = {
      login,
      displayName: login,
      twitchId: null,
      enabled: false,
      allowSend: false,
      onlyWhenLive: true,
      blocklist: [],
      overrides: { ...DEFAULT_OVERRIDES },
      addedAt: Date.now()
    }
    store.channels.push(cfg)
    store.save()
    log.info('Added', login)
    automation.syncChannels()
    d.broadcastConfig()
    void d.resolveChannel(cfg).then(() => {
      d.broadcastConfig()
      void d.refreshLive()
    })
    return { ok: true }
  })

  handle('channels:remove', (login: string) => {
    const i = store.channels.findIndex((c) => c.login === login)
    if (i < 0) return
    store.channels.splice(i, 1)
    emotes.remove(login)
    store.save()
    automation.syncChannels()
    log.info('Removed', login)
    d.broadcastConfig()
  })

  handle('channels:update', (login: string, patch: ChannelPatch) => {
    const cfg = store.channels.find((c) => c.login === login)
    if (!cfg || !patch) return
    if (typeof patch.enabled === 'boolean' && patch.enabled !== cfg.enabled) {
      cfg.enabled = patch.enabled
      log.info(cfg.enabled ? 'Enabled' : 'Disabled', login)
      // Turning a channel off also revokes its permission to receive messages.
      if (!cfg.enabled) cfg.allowSend = false
    }
    if (typeof patch.allowSend === 'boolean' && patch.allowSend !== cfg.allowSend) {
      cfg.allowSend = patch.allowSend && cfg.enabled
      log.info(cfg.allowSend ? 'Sending allowed' : 'Sending not allowed', login)
    }
    if (typeof patch.onlyWhenLive === 'boolean') cfg.onlyWhenLive = patch.onlyWhenLive
    if (Array.isArray(patch.blocklist)) cfg.blocklist = strList(patch.blocklist, 200).map((w) => w.slice(0, 60))
    if (patch.overrides) {
      const o = patch.overrides
      const ov = cfg.overrides
      if ('personality' in o) ov.personality = PERSONALITIES.includes(o.personality as Personality) ? (o.personality as Personality) : null
      if ('density' in o) ov.density = DENSITIES.includes(o.density as EmoteDensity) ? (o.density as EmoteDensity) : null
      if ('minDelaySec' in o) ov.minDelaySec = o.minDelaySec == null ? null : num(o.minDelaySec, 0, 1_000_000, 90)
      if ('maxDelaySec' in o) ov.maxDelaySec = o.maxDelaySec == null ? null : num(o.maxDelaySec, 0, 1_000_000, 240)
      if ('maxMessages' in o) ov.maxMessages = o.maxMessages == null ? null : num(o.maxMessages, 1, 1_000_000, 12)
    }
    store.save()
    automation.syncChannels()
    d.broadcastConfig()
  })

  handle('automation:start', async () => {
    await automation.start()
    d.onAutomationChange()
  })
  handle('automation:pause', () => {
    automation.pause()
    d.onAutomationChange()
  })
  handle('automation:resume', () => {
    automation.resume()
    d.onAutomationChange()
  })
  handle('automation:stop', () => {
    automation.stop()
    d.onAutomationChange()
  })
  handle('channel:halt', (login: string) => automation.haltChannel(login, 'stopped by you'))
  handle('channel:resume', (login: string) => automation.resumeChannel(login))
  handle('approval:approve', (id: string, text?: string): Result => {
    const r = automation.approve(String(id), typeof text === 'string' ? text : undefined)
    return { ok: r.ok, error: r.reason }
  })
  handle('approval:reject', (id: string) => automation.reject(String(id)))

  handle('auth:login', () => auth.startLogin())
  handle('auth:cancel', () => auth.cancelLogin())
  handle('auth:logout', () => auth.logout())

  handle('emotes:list', (channel: string | null, opts?: { personal?: boolean }): EmoteListPayload => {
    const personal = opts?.personal !== false
    const withP = (list: import('@shared/types').Emote[]): import('@shared/types').Emote[] => (personal ? withPersonal(list) : list)
    if (channel && store.channels.some((c) => c.login === channel)) {
      return { channel, info: emotes.info(channel), emotes: withP(emotes.forChannel(channel)) }
    }
    const g = emotes.globalStatus()
    return {
      channel: null,
      info: { status: g.count ? 'ready' : g.error ? 'unavailable' : 'loading', channelCount: 0, globalCount: g.count, detail: g.error, fetchedAt: g.fetchedAt },
      emotes: withP(emotes.globalEmotes())
    }
  })
  handle('emotes:refresh', async (channel: string | null) => {
    await emotes.refresh(channel)
  })
  handle('logs:get', () => log.all())
  handle('data:export', (): string =>
    JSON.stringify({ app: 'chatterly-web', version: 1, exportedAt: new Date().toISOString(), settings: store.settings, channels: store.channels, sentHistory: d.history() }, null, 2)
  )
  handle('data:import', (raw: string): Result => {
    let data: { app?: string; settings?: Partial<AppSettings>; channels?: Partial<ChannelConfig>[] }
    try {
      data = JSON.parse(String(raw))
    } catch {
      return { ok: false, error: "That file isn't valid JSON." }
    }
    if (!data || typeof data !== 'object' || !data.settings || !Array.isArray(data.channels)) return { ok: false, error: "That doesn't look like a Chatterly export." }
    const prev = { ...store.settings }
    // Everything goes through the same checks as the settings page, starting from the defaults.
    const fresh = mergeSettings(undefined)
    applySettingsPatch(fresh, data.settings)
    if (!fresh.twitchClientId) fresh.twitchClientId = store.settings.twitchClientId
    store.settings = fresh
    const seen = new Set<string>()
    store.channels = data.channels
      .map(mergeChannel)
      // A backup never switches sending on by itself: that stays a deliberate, per-channel choice.
      .map((c) => (c ? { ...c, allowSend: false } : c))
      .filter((c): c is ChannelConfig => c !== null && d.validLogin(c.login) === c.login && !seen.has(c.login) && !!seen.add(c.login))
      .slice(0, MAX_CHANNELS)
    store.save()
    d.applySettings(prev)
    automation.syncChannels()
    d.broadcastConfig()
    for (const c of store.channels) void d.resolveChannel(c)
    log.info(`Imported ${store.channels.length} channels and your settings — sending is off for every channel`)
    return { ok: true }
  })
  handle('data:reset', async () => {
    automation.stop()
    await auth.logout()
    for (const k of kv().keys()) kv().delete(k)
    await kv().flush()
    freezeKv()
  })
  handle('chat:watch', (login: string | null) => d.watchChat(typeof login === 'string' ? login : null))
  handle('logs:report', (message: string) => log.error(`UI error: ${String(message).slice(0, 600)}`))
}
