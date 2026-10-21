import {
  DEFAULT_OVERRIDES,
  DEFAULT_PACING,
  DEFAULT_SETTINGS,
  type AppSettings,
  type ChannelConfig,
  type PersistedConfig
} from '@shared/types'
import { join, kv, readJson, writeJsonAtomic } from './kv'

export { readJson, writeJsonAtomic }

export function mergeSettings(raw: Partial<AppSettings> | undefined): AppSettings {
  const s = raw ?? {}
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    // Saved like every other setting; anything unknown (e.g. the removed preview mode) falls back to Approval.
    sendMode: s.sendMode === 'auto' ? 'auto' : 'approval',
    pacing: { ...DEFAULT_PACING, ...(s.pacing ?? {}) },
    blocklist: Array.isArray(s.blocklist) ? s.blocklist.filter((x) => typeof x === 'string') : [],
    favoriteEmotes: Array.isArray(s.favoriteEmotes) ? s.favoriteEmotes.filter((x) => typeof x === 'string') : [],
    recentEmotes: Array.isArray(s.recentEmotes) ? s.recentEmotes.filter((x) => typeof x === 'string').slice(-30) : [],
    laughEmotes: Array.isArray(s.laughEmotes) ? s.laughEmotes.filter((x) => typeof x === 'string') : [...DEFAULT_SETTINGS.laughEmotes],
    avoidEmoteWords: Array.isArray(s.avoidEmoteWords) ? s.avoidEmoteWords.filter((x) => typeof x === 'string') : [...DEFAULT_SETTINGS.avoidEmoteWords],
    customMentions: Array.isArray(s.customMentions) ? s.customMentions.filter((x) => typeof x === 'string') : [],
    greetingReplyEmotes: Array.isArray(s.greetingReplyEmotes) ? s.greetingReplyEmotes.filter((x) => typeof x === 'string') : [...DEFAULT_SETTINGS.greetingReplyEmotes]
  }
}

export function mergeChannel(raw: Partial<ChannelConfig>): ChannelConfig | null {
  if (!raw || typeof raw.login !== 'string') return null
  return {
    login: raw.login,
    displayName: raw.displayName ?? raw.login,
    twitchId: raw.twitchId ?? null,
    enabled: raw.enabled ?? false,
    allowSend: raw.allowSend ?? false,
    onlyWhenLive: raw.onlyWhenLive ?? true,
    blocklist: Array.isArray(raw.blocklist) ? raw.blocklist.filter((x) => typeof x === 'string') : [],
    overrides: { ...DEFAULT_OVERRIDES, ...(raw.overrides ?? {}) },
    addedAt: raw.addedAt ?? Date.now()
  }
}

/** Settings + channel list, saved as one JSON document in the browser's IndexedDB. */
export class ConfigStore {
  private file: string
  private timer: ReturnType<typeof setTimeout> | null = null
  settings: AppSettings
  channels: ChannelConfig[]

  constructor(dir: string) {
    this.file = join(dir, 'config.json')
    const raw = readJson<Partial<PersistedConfig>>(this.file)
    const stored = kv().get(this.file)
    if (raw === null && stored !== null) {
      // The saved copy exists but can't be read: keep it before it gets overwritten with defaults.
      kv().set(join(dir, `config.damaged-${Date.now()}.json`), stored)
    }
    this.settings = mergeSettings(raw?.settings)
    this.channels = (raw?.channels ?? []).map(mergeChannel).filter((c): c is ChannelConfig => c !== null)
    // v2: one reaction is now a single message. Configs still on the old default of 3 move to 1 (other values are kept).
    if (raw && (raw.version ?? 1) < 2) {
      if (raw.settings?.pacing?.maxPerReaction === 3) this.settings.pacing.maxPerReaction = 1
      this.save()
    }
  }

  save(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), 60)
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const data: PersistedConfig = { version: 2, settings: this.settings, channels: this.channels }
    try {
      writeJsonAtomic(this.file, data)
    } catch (err) {
      console.error('Failed to save config', err)
    }
  }
}
