// Types shared by the main process, preload bridge and renderer.

export type Personality = 'chill' | 'playful' | 'supportive' | 'gaming' | 'emotes'
export type EmoteDensity = 'low' | 'medium' | 'high' | 'emote-only'
/** approval: every message waits for your click. auto: sends on its own to allowed channels. */
export type SendMode = 'approval' | 'auto'
export type ThemeSetting = 'system' | 'light' | 'dark'

export interface PacingSettings {
  /** Shortest gap between two messages in the same channel. */
  minDelaySec: number
  /** Longest gap; the actual gap is random within [min, max]. */
  maxDelaySec: number
  /** Extra quiet time added after every message. */
  cooldownSec: number
  /** Minimum gap between messages across all channels. */
  globalGapSec: number
  maxPerSession: number
  maxPerChannel: number
  /** Probability (0-1) of acting on a good moment once pacing allows it. */
  reactChance: number
  /** One reaction = at most this many messages in a row, then the channel rests. 0 = no cap. */
  maxPerReaction: number
  /** Seconds of silence required after a reaction hit its cap before the next reaction can start. */
  reactionRestSec: number
  /** Connection-level guard: minimum seconds between any two sends. 0 = off. */
  guardMinGapSec: number
  /** Connection-level guard: max sends per rolling 30 s. 0 = off. */
  guardMaxPer30s: number
}

export interface ChannelOverrides {
  personality: Personality | null
  density: EmoteDensity | null
  minDelaySec: number | null
  maxDelaySec: number | null
  maxMessages: number | null
}

export interface ChannelConfig {
  login: string
  displayName: string
  twitchId: string | null
  /** Channel takes part in automation (chat is read and messages are generated). */
  enabled: boolean
  /** Channel may actually receive messages. Off by default, must be switched on explicitly. */
  allowSend: boolean
  /** Only send while the channel is confirmed live. */
  onlyWhenLive: boolean
  /** Words never used in this channel (added to the global blocked words). */
  blocklist: string[]
  overrides: ChannelOverrides
  addedAt: number
}

export interface AppSettings {
  theme: ThemeSetting
  sendMode: SendMode
  personality: Personality
  density: EmoteDensity
  pacing: PacingSettings
  /** Public Twitch application Client ID (not a secret). Needed once for login. */
  twitchClientId: string
  /** Allow low-key generic lines when nothing specific is happening (still only in active chat). */
  fillerWhenQuiet: boolean
  blocklist: string[]
  favoriteEmotes: string[]
  recentEmotes: string[]
  /** The only emotes used when reacting to laughter. Used only if the channel has them; no substitutes. */
  laughEmotes: string[]
  /** Emotes whose names contain any of these words are never used. */
  avoidEmoteWords: string[]
  /** Reply when someone greets the logged-in account by name (or a custom mention). */
  answerGreetings: boolean
  /** Extra names that count as mentioning you, besides your Twitch username. */
  customMentions: string[]
  /** Emotes used to answer a greeting that contained no emote. Only those the channel (or your 7TV personal set) has. */
  greetingReplyEmotes: string[]
  /** Seconds before the same person can be answered again in a channel. */
  greetingCooldownSec: number
  logToFile: boolean
  verboseLog: boolean
  /** Open Chatterly when you log in to the Mac (keeps the Twitch session renewed). */
  openAtLogin: boolean
  /** Show the Chatterly icon in the macOS menu bar (play/pause + live chat). */
  menuBarIcon: boolean
}

export interface PersistedConfig {
  version: 1 | 2
  settings: AppSettings
  channels: ChannelConfig[]
}

export type AutomationState = 'stopped' | 'running' | 'paused'
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting'
export type ChannelConnState = 'idle' | 'connecting' | 'joined' | 'unavailable'
export type LiveState = 'live' | 'offline' | 'unknown'

export interface RoomState {
  slow: number
  followersOnly: number
  subsOnly: boolean
  emoteOnly: boolean
  r9k: boolean
}

export interface ChannelRuntime {
  login: string
  conn: ChannelConnState
  connDetail?: string
  live: LiveState
  viewers?: number
  title?: string
  game?: string
  room: RoomState
  /** Messages that really went out this session. */
  sent: number
  /** Halted by the user ("stop") or automatically (ban, restriction). */
  halted: boolean
  haltReason?: string
  emotes: EmoteSetInfo
  chatPerMin: number
}

export interface EmoteSetInfo {
  status: 'none' | 'loading' | 'ready' | 'unavailable'
  channelCount: number
  globalCount: number
  personalCount?: number
  setName?: string
  detail?: string
  fetchedAt?: number
}

export interface Emote {
  id: string
  name: string
  animated: boolean
  source: 'global' | 'channel' | 'personal'
  /** 7TV overlay emote: renders on top of the emote before it, so it may accompany one normal emote. */
  zeroWidth?: boolean
}

export type AuthState =
  | { status: 'logged-out'; clientIdSet: boolean; error?: string; /** 'session' = a saved login stopped working (shown everywhere); 'login' = a login attempt failed (shown on the Account page). */ errorKind?: 'login' | 'session' }
  | { status: 'pending'; userCode: string; verificationUri: string; expiresAt: number }
  | { status: 'logged-in'; login: string; userId: string; scopes: string[]; storedSecurely: boolean; renewedAt: number }

export interface PendingMessage {
  id: string
  channel: string
  text: string
  reason: string
  createdAt: number
  expiresAt: number
}

export type ActivityKind = 'sent' | 'pending' | 'skipped' | 'info' | 'warning' | 'error' | 'chat'
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface ActivityEntry {
  id: number
  ts: number
  level: LogLevel
  kind: ActivityKind
  channel?: string
  text?: string
  /** What happened, in a few words (this is what the feed shows). */
  reason: string
  /** The full explanation (why a message was sent or skipped): in the log file and as a tooltip. */
  detail?: string
}

export interface Snapshot {
  automation: { state: AutomationState; pauseReason?: string }
  connection: { state: ConnectionState; authenticated: boolean; detail?: string }
  auth: AuthState
  channels: ChannelRuntime[]
  counters: { sentSession: number; skippedSession: number; sessionLimit: number }
  pending: PendingMessage[]
  warnings: string[]
  /** Epoch ms until which sending is paused after a Twitch rate-limit warning (0 = none). */
  globalBackoffUntil: number
  startedAt: number | null
}

export interface ChatLine {
  channel: string
  login: string
  name: string
  text: string
  ts: number
}

/** A message the app actually posted to Twitch chat. */
export interface SentMessage {
  id: string
  ts: number
  channel: string
  text: string
  /** Twitch login of the account that sent it. */
  account: string
  /** True if you approved it by hand (Approval mode). */
  approved: boolean
}

export interface ConfigPayload {
  settings: AppSettings
  channels: ChannelConfig[]
}

export interface EmoteListPayload {
  channel: string | null
  info: EmoteSetInfo
  emotes: Emote[]
}

export const DEFAULT_PACING: PacingSettings = {
  minDelaySec: 90,
  maxDelaySec: 240,
  cooldownSec: 30,
  globalGapSec: 20,
  maxPerSession: 30,
  maxPerChannel: 12,
  reactChance: 0.6,
  maxPerReaction: 1,
  reactionRestSec: 120,
  guardMinGapSec: 5,
  guardMaxPer30s: 8
}

export const DEFAULT_LAUGH_EMOTES = ['KEKW', 'LMFAO', 'LMAO', 'LOL', 'ROFL', 'LMAOOOOOO', 'LMAOOOOOOOOOO']
export const DEFAULT_AVOID_WORDS = ['pog']
export const DEFAULT_GREETING_EMOTES = ['wsg', 'sup', 'hiii', 'agahi', 'hi']

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  sendMode: 'approval',
  personality: 'chill',
  density: 'medium',
  pacing: DEFAULT_PACING,
  twitchClientId: '',
  fillerWhenQuiet: false,
  blocklist: [],
  favoriteEmotes: [],
  recentEmotes: [],
  laughEmotes: [...DEFAULT_LAUGH_EMOTES],
  avoidEmoteWords: [...DEFAULT_AVOID_WORDS],
  answerGreetings: true,
  customMentions: [],
  greetingReplyEmotes: [...DEFAULT_GREETING_EMOTES],
  greetingCooldownSec: 300,
  logToFile: true,
  verboseLog: false,
  openAtLogin: false,
  menuBarIcon: true
}

export const DEFAULT_OVERRIDES: ChannelOverrides = {
  personality: null,
  density: null,
  minDelaySec: null,
  maxDelaySec: null,
  maxMessages: null
}

export const PERSONALITY_INFO: Record<Personality, { label: string; blurb: string }> = {
  chill: { label: 'Chill', blurb: 'Casual and low-key' },
  playful: { label: 'Playful', blurb: 'Jokier, more energy' },
  supportive: { label: 'Supportive', blurb: 'Warm and encouraging' },
  gaming: { label: 'Gaming', blurb: 'gg, clutch, nice one' },
  emotes: { label: 'Emotes', blurb: 'Emotes first, few words' }
}

export const DENSITY_INFO: Record<EmoteDensity, { label: string; blurb: string }> = {
  low: { label: 'Low', blurb: 'Mostly text' },
  medium: { label: 'Medium', blurb: 'A mix' },
  high: { label: 'High', blurb: 'Almost always an emote' },
  'emote-only': { label: 'Emote only', blurb: 'Only an emote, never words' }
}

/** Fixed limits that are not about pacing. */
export const HARD_LIMITS = {
  maxMessageChars: 120
}

/** Accepts a name, @name, #name or a twitch.tv link (with or without https/www). Anything with spaces is rejected. */
export function normalizeLogin(input: string): string {
  const t = input.trim().toLowerCase()
  if (/\s/.test(t)) return ''
  return t
    .replace(/^(https?:\/\/)?(www\.|m\.)?twitch\.tv\//, '')
    .replace(/^[#@]/, '')
    .split(/[/?#]/)[0]
}

export function isValidLogin(login: string): boolean {
  return /^[a-z0-9_]{3,25}$/.test(login)
}
