import type {
  ActivityEntry,
  ChatLine,
  SentMessage,
  AppSettings,
  ChannelConfig,
  ChannelOverrides,
  ConfigPayload,
  EmoteListPayload,
  Snapshot
} from './types'

export interface InitPayload {
  snapshot: Snapshot
  config: ConfigPayload
  activity: ActivityEntry[]
  /** Messages the app has sent, oldest first (persisted across launches). */
  recentSent: SentMessage[]
  platform: { version: string; /** The Twitch login is encrypted in this browser. */ secureStorage: boolean; /** Data survives closing the tab (false in private windows or when storage is blocked). */ persistent: boolean }
}

export type ChannelPatch = Partial<Pick<ChannelConfig, 'enabled' | 'allowSend' | 'onlyWhenLive' | 'blocklist'>> & {
  overrides?: Partial<ChannelOverrides>
}

/** Pages, plus 'account' which means Settings → Account. */
export type NavTarget = 'dashboard' | 'channels' | 'settings' | 'account'
export type Page = Exclude<NavTarget, 'account'>
export type SettingsSection = 'messages' | 'greetings' | 'pacing' | 'account' | 'app'
/** Messages from the engine about the window itself. */
export type UiEvent = 'toggleSidebar' | 'resync'

export interface Result {
  ok: boolean
  error?: string
  warning?: string
}

export interface ChatterlyApi {
  init(): Promise<InitPayload>
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  addChannel(login: string): Promise<Result>
  removeChannel(login: string): Promise<void>
  updateChannel(login: string, patch: ChannelPatch): Promise<void>
  start(): Promise<void>
  pause(): Promise<void>
  resume(): Promise<void>
  stop(): Promise<void>
  haltChannel(login: string): Promise<void>
  resumeChannel(login: string): Promise<void>
  approve(id: string, editedText?: string): Promise<Result>
  reject(id: string): Promise<void>
  login(): Promise<void>
  cancelLogin(): Promise<void>
  logout(): Promise<void>
  /** The emotes usable in a channel (its own 7TV set first, then global), or global only for null. */
  listEmotes(channel: string | null, opts?: { personal?: boolean }): Promise<EmoteListPayload>
  refreshEmotes(channel: string | null): Promise<void>
  getLogs(): Promise<ActivityEntry[]>
  /** Download the activity log as a text file. */
  downloadLog(): Promise<void>
  /** Download settings, channels and sent history as a JSON backup (never the Twitch login). */
  exportData(): Promise<void>
  importData(json: string): Promise<Result>
  /** Log out and erase everything Chatterly stored in this browser, then reload. */
  resetData(): Promise<void>
  /** Open one of a short list of Twitch / 7TV pages in a new tab. */
  openExternal(url: string): Promise<void>
  /** Write a UI error into the log. */
  reportError(message: string): Promise<void>
  onSnapshot(cb: (s: Snapshot) => void): () => void
  onConfig(cb: (c: ConfigPayload) => void): () => void
  onActivity(cb: (e: ActivityEntry) => void): () => void
  onEmotes(cb: (channel: string | null) => void): () => void
  /** Live chat is only streamed for the channel being watched (null = none). Returns its recent lines. */
  watchChat(login: string | null): Promise<ChatLine[]>
  onChat(cb: (lines: ChatLine[]) => void): () => void
  onUi(cb: (e: UiEvent) => void): () => void
  onSent(cb: (m: SentMessage) => void): () => void
  onNav(cb: (t: NavTarget) => void): () => void
}
