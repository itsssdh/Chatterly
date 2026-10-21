import { EventEmitter } from './events'
import {
  DEFAULT_SETTINGS,
  type AuthState,
  type AutomationState,
  type ChannelConfig,
  type ChannelRuntime,
  type ConnectionState,
  type Emote,
  type EmoteDensity,
  type PendingMessage,
  type Personality,
  type SentMessage,
  type RoomState,
  type Snapshot
} from '@shared/types'
import type { EmoteManager } from './emotes/manager'
import { analyzeChat } from './engine/context'
import { EmotePicker } from './engine/emotePicker'
import { chooseGreetingReply, isDirectedGreeting, mentionSet } from './engine/greeting'
import { BOT_LOGINS, DEFAULT_BLOCKED } from './engine/lexicon'
import { generateMessage, type GenerateOutput } from './engine/generator'
import { MessageHistory, makeBlockedTest, sanitize } from './engine/safety'
import { checkSend } from './guard'
import type { ActivityLog } from './logger'
import { backoffSeconds, nextDelayMs, resolvePacing } from './pacing'
import type { ConfigStore } from './store'
import type { StreamInfo } from './twitch/helix'
import type { IrcAuth, TwitchIrc } from './twitch/irc'
import type { ChatMessage } from './twitch/parser'

interface ChannelState {
  conn: ChannelRuntime['conn']
  connDetail?: string
  live: ChannelRuntime['live']
  viewers?: number
  title?: string
  game?: string
  room: RoomState
  sent: number
  /** Messages that count against limits (everything actually sent). */
  counted: number
  halted: boolean
  haltReason?: string
  nextEligibleAt: number
  nextEvalAt: number
  backoffUntil: number
  buffer: ChatMessage[]
  greeted: boolean
  badges: string[]
  joinTimer: ReturnType<typeof setTimeout> | null
  lastSkip: { reason: string; at: number } | null
  limitNoted: boolean
  /** Messages in the current reaction (consecutive messages with no long silence between them). */
  burstCount: number
  lastMsgAt: number
  /** Fresh greetings aimed at the logged-in account, waiting for a reply. */
  directed: { login: string; name: string; text: string; ts: number; blocked?: string }[]
  /** Who was answered when, so one person isn't answered repeatedly. */
  greetedUsers: Map<string, number>
}

export interface AutomationDeps {
  store: ConfigStore
  log: ActivityLog
  irc: TwitchIrc
  emotes: EmoteManager
  getIrcAuth: () => Promise<IrcAuth | null>
  authState: () => AuthState
  /** Twitch chat refused the token: the host decides whether to renew it, reconnect, or log out. */
  onAuthRejected: () => void | Promise<void>
  /** Called when a ROOMSTATE reveals a channel's Twitch id. */
  onRoomId: (login: string, id: string) => void
  rng?: () => number
  now?: () => number
}

/** The scheduler sleeps until the next thing could happen, between these bounds. */
const TICK_MIN_MS = 200
const TICK_MAX_MS = 2000
const DIRECTED_TTL_MS = 30_000
const PENDING_TTL_MS = 120_000
const BUFFER_MAX = 120
const BUFFER_AGE_MS = 120_000
const JOIN_CONFIRM_MS = 20_000

const DEFAULT_ROOM: RoomState = { slow: 0, followersOnly: -1, subsOnly: false, emoteOnly: false, r9k: false }

/**
 * Orchestrates everything: it reads chat, decides (rarely) to say something, and routes the result to
 * the approval queue or an actual send — always through `checkSend`.
 */
export class Automation extends EventEmitter {
  private state: AutomationState = 'stopped'
  private pauseReason?: string
  private channels = new Map<string, ChannelState>()
  private pending: PendingMessage[] = []
  private history = new MessageHistory()
  private timer: ReturnType<typeof setTimeout> | null = null
  private snapTimer: ReturnType<typeof setTimeout> | null = null
  private connState: ConnectionState = 'disconnected'
  private connDetail?: string
  private sessionSent = 0
  private sessionSkipped = 0
  private lastGlobalSendAt = 0
  private backoffLevel = 0
  private backoffUntil = 0
  private lastBackoffAt = 0
  private startedAt: number | null = null
  private warnings = new Map<string, string>()
  private nextPendingId = 1
  private lastSnapKey = ''
  private lastPeriodicSnap = 0
  private rng: () => number
  private nowFn: () => number

  constructor(private deps: AutomationDeps) {
    super()
    this.rng = deps.rng ?? Math.random
    this.nowFn = deps.now ?? Date.now
    this.wireIrc()
  }

  private get store(): ConfigStore {
    return this.deps.store
  }
  private get log(): ActivityLog {
    return this.deps.log
  }
  private now(): number {
    return this.nowFn()
  }

  // ---------- public control ----------

  get automationState(): AutomationState {
    return this.state
  }

  get pendingCount(): number {
    return this.pending.length
  }

  async start(): Promise<void> {
    if (this.state !== 'stopped') return
    const enabled = this.store.channels.filter((c) => c.enabled)
    if (!enabled.length) {
      this.log.warn('Nothing to start: enable at least one channel first')
      this.setWarning('no-channels', 'Enable a channel first.')
      this.snapshotSoon()
      return
    }
    this.clearWarning('no-channels')
    this.clearWarning('session-limit')
    this.history.clear()
    this.sessionSent = this.sessionSkipped = 0
    this.lastGlobalSendAt = 0
    this.backoffLevel = 0
    this.backoffUntil = 0
    this.applyGuard()
    for (const cfg of this.store.channels) {
      const rt = this.rt(cfg.login)
      rt.sent = rt.counted = 0
      // First message comes after a random part of the minimum delay, so the room is read first.
      const p = resolvePacing(this.store.settings.pacing, cfg.overrides, rt.room)
      rt.nextEligibleAt = this.now() + this.rng() * p.minSec * 1000
      rt.nextEvalAt = 0
      rt.greeted = false
      rt.limitNoted = false
      rt.burstCount = 0
      rt.lastMsgAt = 0
      rt.directed = []
      rt.greetedUsers.clear()
      rt.halted = false
      rt.haltReason = undefined
      rt.backoffUntil = 0
    }
    this.startedAt = this.now()
    this.state = 'running'
    this.pauseReason = undefined
    const mode = this.store.settings.sendMode
    this.log.info(`Started · ${mode} · ${enabled.map((c) => '#' + c.login).join(' ')}`)
    await this.connect()
    if (this.state === 'running') this.scheduleTick(0)
    this.snapshotSoon()
  }

  /** Run the scheduler again soon (something happened that it should react to). */
  kick(): void {
    if (this.state === 'running') this.scheduleTick(0)
  }

  /** Sleep until the earliest moment a channel could act, instead of polling on a fixed beat. */
  private scheduleTick(delay: number): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.state !== 'running') return
      this.tick()
      if (this.state === 'running' && !this.timer) this.scheduleTick(this.nextTickDelay())
    }, Math.max(0, delay))
    this.timer.unref?.()
  }

  private nextTickDelay(): number {
    const now = this.now()
    let earliest = now + TICK_MAX_MS
    for (const cfg of this.store.channels) {
      if (!cfg.enabled || !cfg.allowSend) continue
      const rt = this.channels.get(cfg.login)
      if (!rt || rt.halted || rt.conn !== 'joined') continue
      if (cfg.onlyWhenLive && rt.live !== 'live') continue
      if (rt.directed.length) return TICK_MIN_MS
      const due = Math.max(rt.nextEligibleAt, rt.nextEvalAt, rt.backoffUntil, this.backoffUntil)
      if (due < earliest) earliest = due
    }
    for (const p of this.pending) if (p.expiresAt < earliest) earliest = p.expiresAt
    return Math.min(TICK_MAX_MS, Math.max(TICK_MIN_MS, earliest - now))
  }

  private applyGuard(): void {
    const p = this.store.settings.pacing
    this.deps.irc.setLimits(p.guardMinGapSec, p.guardMaxPer30s)
  }

  private async connect(): Promise<void> {
    const auth = await this.deps.getIrcAuth()
    // Stop may have been pressed while the login was being fetched: don't connect after that.
    if (this.state === 'stopped') return
    this.deps.irc.connect(auth)
    this.syncChannels()
  }

  stop(_reason = ''): void {
    if (this.state === 'stopped') return
    this.state = 'stopped'
    this.pauseReason = undefined
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.deps.irc.disconnect()
    for (const rt of this.channels.values()) {
      if (rt.joinTimer) clearTimeout(rt.joinTimer)
      rt.joinTimer = null
      rt.conn = 'idle'
      rt.connDetail = undefined
      rt.buffer = []
    }
    this.dropPending('automation stopped')
    this.startedAt = null
    this.log.info(`Stopped · ${this.sessionSent} sent`)
    this.snapshotSoon()
  }

  pause(reason = 'by you'): void {
    if (this.state !== 'running') return
    this.state = 'paused'
    this.pauseReason = reason
    this.log.info(`Paused — ${reason}`)
    this.snapshotSoon()
  }

  resume(): void {
    if (this.state !== 'paused') return
    this.state = 'running'
    this.pauseReason = undefined
    // Give chat a moment after resuming so messages aren't based on stale context.
    for (const rt of this.channels.values()) rt.nextEvalAt = Math.max(rt.nextEvalAt, this.now())
    this.log.info('Resumed')
    this.kick()
    this.snapshotSoon()
  }

  haltChannel(login: string, reason: string, automatic = false): void {
    const rt = this.rt(login)
    if (rt.halted) return
    rt.halted = true
    rt.haltReason = reason
    this.dropPending('channel halted', login)
    if (automatic) this.log.warn(`Halted: ${reason}`, login)
    else this.log.info('Stopped by you', login)
    this.snapshotSoon()
  }

  resumeChannel(login: string): void {
    const rt = this.rt(login)
    if (!rt.halted) return
    rt.halted = false
    rt.haltReason = undefined
    rt.nextEvalAt = this.now()
    this.log.info('Resumed', login)
    this.kick()
    this.snapshotSoon()
  }

  /** Re-read the channel list: join newly enabled channels, leave removed or disabled ones. */
  syncChannels(): void {
    const wanted = new Set(this.store.channels.filter((c) => c.enabled).map((c) => c.login))
    for (const login of [...this.channels.keys()]) {
      if (!this.store.channels.some((c) => c.login === login)) {
        const rt = this.channels.get(login)!
        if (rt.joinTimer) clearTimeout(rt.joinTimer)
        this.channels.delete(login)
        this.dropPending('channel removed', login)
        if (this.state !== 'stopped') this.deps.irc.part(login)
      }
    }
    for (const cfg of this.store.channels) {
      const rt = this.rt(cfg.login)
      if (this.state === 'stopped') continue
      if (wanted.has(cfg.login)) {
        if (rt.conn === 'idle') this.beginJoin(cfg.login, rt)
      } else if (rt.conn !== 'idle') {
        this.deps.irc.part(cfg.login)
        rt.conn = 'idle'
        rt.buffer = []
        this.dropPending('channel disabled', cfg.login)
        if (rt.joinTimer) clearTimeout(rt.joinTimer)
      }
    }
    if (wanted.size) this.clearWarning('no-channels')
    this.snapshotSoon()
  }

  /** Settings changed (mode, pacing, …). Called by the IPC layer after every update. */
  onSettingsChanged(): void {
    this.applyGuard()
    // Changed limits or pacing apply right away (a channel that hit its limit is looked at again).
    for (const rt of this.channels.values()) {
      rt.nextEvalAt = 0
      rt.limitNoted = false
    }
    if (this.sessionCount() < this.store.settings.pacing.maxPerSession) this.clearWarning('session-limit')
    this.kick()
    // Messages queued for approval don't carry over into Auto mode.
    if (this.store.settings.sendMode !== 'approval' && this.pending.length) {
      this.dropPending('switched to auto mode')
    }
    this.snapshotSoon()
  }

  /** Reconnect chat (used when the Twitch login changes while running). */
  async reconnect(): Promise<void> {
    if (this.state === 'stopped') return
    await this.connect()
  }

  markUnavailable(login: string, detail: string): void {
    const rt = this.rt(login)
    rt.conn = 'unavailable'
    rt.connDetail = detail
    this.snapshotSoon()
  }

  setStream(login: string, info: StreamInfo | null): void {
    const rt = this.rt(login)
    if (!info) rt.live = 'unknown'
    else {
      rt.live = info.live
      rt.viewers = info.viewers
      rt.title = info.title
      rt.game = info.game
    }
    this.snapshotSoon()
  }

  // ---------- approvals ----------

  approve(id: string, editedText?: string): { ok: boolean; reason?: string } {
    const idx = this.pending.findIndex((p) => p.id === id)
    if (idx < 0) return { ok: false, reason: 'That message is no longer pending.' }
    const p = this.pending[idx]
    const cfg = this.store.channels.find((c) => c.login === p.channel)
    if (!cfg) {
      this.pending.splice(idx, 1)
      return { ok: false, reason: 'Channel no longer exists.' }
    }
    let text = p.text
    if (editedText !== undefined && editedText.trim() !== p.text) {
      text = sanitize(editedText, { allowMentions: true })
      if (!text) return { ok: false, reason: 'The edited message is empty.' }
      if (this.blockedFor(cfg)(text)) return { ok: false, reason: 'The edited message contains blocked terms.' }
    }
    const res = this.trySend(cfg, text, p.reason, true)
    if (res.ok) this.pending.splice(idx, 1)
    this.snapshotSoon()
    return res
  }

  reject(id: string): void {
    const p = this.pending.find((x) => x.id === id)
    if (!p) return
    this.pending = this.pending.filter((x) => x.id !== id)
    this.log.add('info', 'skipped', 'You rejected this message', { channel: p.channel, text: p.text })
    this.sessionSkipped++
    this.restAfterUnsent(p.channel)
    this.snapshotSoon()
  }

  /** A suggestion that was rejected or ignored still uses up the normal spacing, so a new one doesn't appear instantly. */
  private restAfterUnsent(login: string): void {
    const cfg = this.store.channels.find((c) => c.login === login)
    const rt = this.channels.get(login)
    if (!cfg || !rt) return
    rt.nextEligibleAt = this.now() + nextDelayMs(this.resolved(cfg, rt), this.store.settings.pacing.cooldownSec, this.rng)
  }

  private dropPending(why: string, channel?: string): void {
    const drop = this.pending.filter((p) => !channel || p.channel === channel)
    if (!drop.length) return
    this.pending = this.pending.filter((p) => channel && p.channel !== channel)
    for (const p of drop) this.log.add('info', 'skipped', 'Discarded', { channel: p.channel, text: p.text, detail: why })
  }

  // ---------- IRC wiring ----------

  private wireIrc(): void {
    const irc = this.deps.irc
    irc.on('status', (status, detail) => {
      this.connState = status
      this.connDetail = detail
      if (status === 'connected') {
        this.clearWarning('connection')
        for (const cfg of this.store.channels) if (cfg.enabled) this.beginJoin(cfg.login, this.rt(cfg.login))
      } else if (status === 'reconnecting') {
        this.setWarning('connection', `Chat disconnected — ${detail ?? 'reconnecting'}`)
        for (const rt of this.channels.values()) if (rt.conn !== 'idle') rt.conn = 'connecting'
      } else if (status === 'disconnected' && this.state !== 'stopped' && detail === 'login failed') {
        this.setWarning('connection', 'Twitch rejected the login. Log in again.')
      }
      this.snapshotSoon()
    })
    irc.on('authfailed', (text) => {
      this.log.error(`Twitch chat login failed: ${text}`)
      void this.deps.onAuthRejected()
    })
    irc.on('roomstate', (channel, room, roomId) => {
      const rt = this.channels.get(channel)
      if (!rt) return
      rt.room = room
      if (rt.joinTimer) clearTimeout(rt.joinTimer)
      rt.joinTimer = null
      if (rt.conn !== 'joined') this.log.info('Joined', channel)
      rt.conn = 'joined'
      rt.connDetail = undefined
      if (roomId) this.deps.onRoomId(channel, roomId)
      if (room.slow > 0) this.log.debug(`Slow mode: ${room.slow}s`, channel)
      this.snapshotSoon()
    })
    irc.on('userstate', (channel, badges) => {
      const rt = this.channels.get(channel)
      if (rt) rt.badges = badges
    })
    irc.on('message', (msg) => {
      const rt = this.channels.get(msg.channel)
      if (!rt) return
      rt.buffer.push(msg)
      this.emit('chat', { channel: msg.channel, login: msg.login, name: msg.displayName, text: msg.text, ts: msg.ts })
      const cutoff = msg.ts - BUFFER_AGE_MS
      this.noteDirected(rt, msg)
      while (rt.buffer.length > BUFFER_MAX || (rt.buffer[0] && rt.buffer[0].ts < cutoff)) rt.buffer.shift()
    })
    irc.on('notice', (channel, msgId, text) => this.handleNotice(channel, msgId, text))
    irc.on('selftimeout', (channel, seconds) => {
      this.haltChannel(channel, seconds ? `you were timed out for ${seconds}s` : 'you were banned', true)
    })
  }

  private beginJoin(login: string, rt: ChannelState): void {
    rt.conn = 'connecting'
    rt.connDetail = undefined
    if (rt.joinTimer) clearTimeout(rt.joinTimer)
    rt.joinTimer = setTimeout(() => {
      if (rt.conn !== 'joined') {
        rt.conn = 'unavailable'
        rt.connDetail = 'Channel not found.'
        this.log.warn('Channel not found', login)
        this.snapshotSoon()
      }
    }, JOIN_CONFIRM_MS)
    rt.joinTimer.unref?.()
    this.deps.irc.join(login)
  }

  private handleNotice(channel: string | null, msgId: string, text: string): void {
    const now = this.now()
    const login = channel ?? undefined
    const halt = (reason: string): void => {
      if (login) this.haltChannel(login, reason, true)
    }
    switch (msgId) {
      case 'msg_ratelimit': {
        this.backoffLevel++
        const secs = backoffSeconds(this.backoffLevel)
        this.backoffUntil = now + secs * 1000
        this.lastBackoffAt = now
        this.setWarning('ratelimit', `Rate limited — paused for ${Math.round(secs / 60)} min.`)
        this.log.warn(`Rate-limit warning from Twitch — backing off for ${secs}s (level ${this.backoffLevel})`, login)
        this.dropPending('rate limit backoff')
        break
      }
      case 'msg_duplicate':
        this.log.warn('Twitch rejected the last message as a duplicate — waiting longer before the next one', login)
        if (login) this.rt(login).backoffUntil = now + 60_000
        break
      case 'msg_slowmode':
        this.log.warn('Slow mode rejected the last message — spacing messages further apart', login)
        if (login) this.rt(login).backoffUntil = now + 90_000
        break
      case 'msg_banned':
      case 'msg_channel_blocked':
      case 'msg_channel_suspended':
      case 'msg_suspended':
        halt(`Twitch says: ${text}`)
        break
      case 'msg_timedout':
        halt('you are timed out in this channel')
        break
      case 'msg_followersonly':
      case 'msg_followersonly_followed':
      case 'msg_followersonly_zero':
        halt('followers-only chat — this account has not followed long enough')
        break
      case 'msg_subsonly':
        halt('subscribers-only chat')
        break
      case 'msg_emoteonly':
        halt('emote-only chat rejected the message')
        break
      case 'msg_r9k':
        halt('unique-chat (R9K) mode rejected the message')
        break
      case 'msg_requires_verified_phone_number':
      case 'msg_verified_email':
        halt('channel requires a verified phone number or email')
        break
      case 'msg_bad_characters':
      case 'msg_rejected':
      case 'msg_rejected_mandatory':
        this.log.warn(`Twitch rejected the last message: ${text}`, login)
        break
      default:
        if (msgId) this.log.debug(`NOTICE ${msgId}: ${text}`, login)
    }
    this.snapshotSoon()
  }

  // ---------- tick ----------

  /** One scheduling pass (public so tests can drive it). */
  tick(): void {
    if (this.state !== 'running') return
    const now = this.now()
    this.pending = this.pending.filter((p) => {
      if (p.expiresAt > now) return true
      this.log.add('info', 'skipped', 'Expired before approval', { channel: p.channel, text: p.text, detail: 'The moment had passed, so the suggestion was dropped.' })
      this.sessionSkipped++
      this.restAfterUnsent(p.channel)
      return false
    })
    if (this.backoffLevel > 0 && now > this.backoffUntil && now - this.lastBackoffAt > 3600_000) this.backoffLevel = 0
    if (this.backoffUntil && now > this.backoffUntil) {
      this.backoffUntil = 0
      this.clearWarning('ratelimit')
    }

    for (const cfg of this.store.channels) {
      if (!cfg.enabled) continue
      const rt = this.rt(cfg.login)
      if (rt.halted || rt.conn !== 'joined') continue
      // Read-only (not logged in): nothing could be sent, so nothing is generated or queued.
      if (!this.deps.irc.authenticated) continue
      // Only channels you allowed to receive messages get any: otherwise a message could never be sent.
      if (!cfg.allowSend) continue
      // Offline channels (with "Only when live" on) are left alone: no messages are generated, queued or logged for them.
      if (cfg.onlyWhenLive && rt.live !== 'live') continue
      // A greeting aimed at us is answered promptly, outside the normal spacing (but within limits and caps).
      if (this.handleDirected(cfg, rt, now)) continue
      if (now < rt.nextEligibleAt || now < rt.nextEvalAt || now < rt.backoffUntil) continue
      if (this.pending.some((p) => p.channel === cfg.login)) continue
      this.evaluate(cfg, rt, now)
      if (this.state !== 'running') break
    }
    // Chat-rate numbers drift continuously; refresh them occasionally (identical snapshots are dropped).
    if (now - this.lastPeriodicSnap > 5000) {
      this.lastPeriodicSnap = now
      this.snapshotSoon()
    }
  }

  private noteDirected(rt: ChannelState, msg: ChatMessage): void {
    const s = this.store.settings
    if (!s.answerGreetings || this.state === 'stopped') return
    // (A greeting typed from your own account in another window counts too, which makes it easy to try out.)
    if (BOT_LOGINS.has(msg.login) || msg.text.startsWith('!')) return
    // Same rule as the scheduler: channels that can't be sent to right now are ignored (and not logged).
    const cfg = this.store.channels.find((c) => c.login === msg.channel)
    if (!cfg || !cfg.allowSend || (cfg.onlyWhenLive && rt.live !== 'live')) return
    if (!isDirectedGreeting(msg.text, mentionSet(this.deps.irc.login, s.customMentions))) return
    this.log.add('info', 'info', `${msg.login} greeted you`, { channel: msg.channel, detail: msg.text.slice(0, 100) })
    rt.directed.push({ login: msg.login, name: msg.displayName, text: msg.text, ts: msg.ts })
    if (rt.directed.length > 5) rt.directed.shift()
    this.kick()
  }

  /** Words that must never appear for this channel: the global list plus the channel's own. */
  private blockedFor(cfg: ChannelConfig): (text: string) => boolean {
    return makeBlockedTest([...this.store.settings.blocklist, ...cfg.blocklist])
  }

  /** Everything we may post in a greeting reply: the channel's and global emotes plus the 7TV personal set. */
  private greetingPool(cfg: ChannelConfig): Map<string, Emote> {
    const s = this.store.settings
    const avoid = s.avoidEmoteWords.map((w) => w.trim().toLowerCase()).filter(Boolean)
    const blocked = this.blockedFor(cfg)
    const ok = (e: Emote): boolean =>
      !e.zeroWidth && /^[\w()\-:.!?]+$/.test(e.name) && !DEFAULT_BLOCKED.test(e.name) && !blocked(e.name) && !avoid.some((w) => e.name.toLowerCase().includes(w))
    const usable = new Map<string, Emote>()
    for (const e of this.deps.emotes.forChannel(cfg.login)) if (ok(e) && !usable.has(e.name)) usable.set(e.name, e)
    for (const e of this.deps.emotes.personalEmotes()) if (ok(e) && !usable.has(e.name)) usable.set(e.name, e)
    return usable
  }

  /** Returns true if it dealt with a queued greeting this tick. */
  private handleDirected(cfg: ChannelConfig, rt: ChannelState, now: number): boolean {
    // A greeting that could not be answered in time is reported instead of vanishing.
    const stale = rt.directed.filter((d) => now - d.ts > DIRECTED_TTL_MS)
    if (stale.length) {
      rt.directed = rt.directed.filter((d) => now - d.ts <= DIRECTED_TTL_MS)
      for (const d of stale) this.noteSkip(cfg.login, rt, `${d.login}'s greeting went unanswered${d.blocked ? ` (${d.blocked})` : ''}`, now)
    }
    if (!rt.directed.length) return false
    const s = this.store.settings
    const waiting = (why: string): false => {
      rt.directed[0].blocked = why
      return false
    }
    // Replies to a greeting are not "reactions", so the reaction cap and any queued approval don't hold them back.
    if (now < rt.backoffUntil || now < this.backoffUntil) return waiting('backing off after a rate-limit warning')
    const pacing = resolvePacing(s.pacing, cfg.overrides, rt.room)
    if (this.sessionCount() >= s.pacing.maxPerSession) return waiting('session message limit reached')
    if (rt.counted >= pacing.maxMessages) return waiting('channel message limit reached')
    if (now - this.lastGlobalSendAt < s.pacing.globalGapSec * 1000) return waiting('waiting out the gap between messages')

    const item = rt.directed.shift()!
    const last = rt.greetedUsers.get(item.login)
    if (last !== undefined && now - last < s.greetingCooldownSec * 1000) {
      this.noteSkip(cfg.login, rt, `${item.login} greeted you again, but they were answered ${Math.round((now - last) / 1000)}s ago`, now)
      return true
    }
    // The reply @-mentions whoever said hello (display name when it is plain ASCII, otherwise their login).
    const who = /^[A-Za-z0-9_]{1,25}$/.test(item.name) ? item.name : item.login
    const reply = chooseGreetingReply({
      text: item.text,
      usable: this.greetingPool(cfg),
      replyList: s.greetingReplyEmotes,
      recent: s.recentEmotes,
      rng: this.rng,
      isDuplicate: (name) => this.history.isDuplicate(cfg.login, `@${who} ${name}`, now, false)
    })
    if (!reply) {
      this.noteSkip(cfg.login, rt, `${item.login} greeted you, but none of your greeting emotes (${s.greetingReplyEmotes.join(', ')}) are available in this channel`, now)
      return true
    }
    if (this.blockedFor(cfg)(`@${who} ${reply.name}`)) {
      this.noteSkip(cfg.login, rt, `not replying to ${item.login}: the reply would contain a blocked word`, now)
      return true
    }
    rt.greetedUsers.set(item.login, now)
    this.dispatch(
      cfg,
      rt,
      {
        ok: true,
        text: `@${who} ${reply.name}`,
        reason: `${item.login} greeted you ("${item.text.slice(0, 80)}") — ${reply.why}`,
        mood: 'greet',
        emotes: [reply.name],
        templateKey: `greetreply:${reply.name}`,
        emoteOnly: false,
        directed: true
      },
      now
    )
    return true
  }

  private evaluate(cfg: ChannelConfig, rt: ChannelState, now: number): void {
    const s = this.store.settings
    const pacing = resolvePacing(s.pacing, cfg.overrides, rt.room)

    if (this.sessionCount() >= s.pacing.maxPerSession) {
      this.setWarning('session-limit', `Session limit of ${s.pacing.maxPerSession} messages reached. Raise it, or Stop and Start for a new session.`)
      this.pause(`session limit of ${s.pacing.maxPerSession} messages reached`)
      return
    }
    if (rt.counted >= pacing.maxMessages) {
      if (!rt.limitNoted) {
        rt.limitNoted = true
        this.log.info(`Reached its limit of ${pacing.maxMessages} messages`, cfg.login)
      }
      rt.nextEvalAt = now + 30_000 // looked at again later, in case the limit is raised
      return
    }
    // One reaction is at most N messages in a row; after that the channel rests before reacting again.
    if (s.pacing.maxPerReaction > 0 && rt.burstCount >= s.pacing.maxPerReaction) {
      const restUntil = rt.lastMsgAt + s.pacing.reactionRestSec * 1000
      if (now < restUntil) {
        this.noteSkip(cfg.login, rt, `already reacted ${rt.burstCount} times in a row — resting ${s.pacing.reactionRestSec}s before reacting again`, now)
        rt.nextEvalAt = restUntil
        return
      }
      rt.burstCount = 0
    }
    const gap = s.pacing.globalGapSec * 1000
    if (now - this.lastGlobalSendAt < gap) {
      rt.nextEvalAt = this.lastGlobalSendAt + gap
      return
    }

    const out = this.generate(cfg, rt, now)
    if (!out.ok) {
      this.noteSkip(cfg.login, rt, out.reason, now)
      rt.nextEvalAt = now + this.retryMs(pacing.minSec, 6000)
      return
    }
    // Even when chat gives a good moment, only act on some of them.
    if (this.rng() >= s.pacing.reactChance) {
      this.noteSkip(cfg.login, rt, `${out.reason} — but chose not to react this time`, now)
      rt.nextEvalAt = now + this.retryMs(pacing.minSec, 12_000)
      return
    }
    this.dispatch(cfg, rt, out, now)
  }

  /** How soon to look at chat again after passing on a moment. Scales down with a short minimum delay. */
  private retryMs(minSec: number, capMs: number): number {
    const base = Math.max(500, Math.min(capMs, minSec * 1000))
    return base * (1 + this.rng())
  }

  private resolved(cfg: ChannelConfig, rt: ChannelState): ReturnType<typeof resolvePacing> {
    return resolvePacing(this.store.settings.pacing, cfg.overrides, rt.room)
  }

  private noteSkip(login: string, rt: ChannelState, reason: string, now: number): void {
    this.sessionSkipped++
    if (rt.lastSkip && rt.lastSkip.reason === reason && now - rt.lastSkip.at < 60_000) return
    rt.lastSkip = { reason, at: now }
    this.log.add('info', 'skipped', reason, { channel: login })
  }

  private sessionCount(): number {
    return this.sessionSent
  }

  private effective(cfg: ChannelConfig): { personality: Personality; density: EmoteDensity } {
    return {
      personality: cfg.overrides.personality ?? this.store.settings.personality,
      density: cfg.overrides.density ?? this.store.settings.density
    }
  }

  private generate(cfg: ChannelConfig, rt: ChannelState, now: number, seed?: ChatMessage[]): GenerateOutput {
    const s = this.store.settings
    const blocked = this.blockedFor(cfg)
    const emotes = this.deps.emotes.forChannel(cfg.login)
    const buffer = seed ?? rt.buffer
    // The picker is built first so chat analysis can recognise which tokens are emotes this channel can render.
    const preliminary = new EmotePicker(emotes, { favorites: s.favoriteEmotes, recent: s.recentEmotes, observed: new Map(), blocked, laughEmotes: s.laughEmotes, avoidWords: s.avoidEmoteWords })
    const signals = analyzeChat(buffer, {
      now,
      self: this.deps.irc.login,
      isKnownEmote: (n) => preliminary.has(n),
      blocked
    })
    const picker = new EmotePicker(emotes, { favorites: s.favoriteEmotes, recent: s.recentEmotes, observed: signals.observedEmotes, blocked, laughEmotes: s.laughEmotes, avoidWords: s.avoidEmoteWords })
    const { personality, density } = this.effective(cfg)
    return generateMessage({
      channel: cfg.login,
      personality,
      density,
      signals,
      picker,
      history: this.history,
      rng: this.rng,
      allowFiller: s.fillerWhenQuiet,
      roomEmoteOnly: rt.room.emoteOnly,
      greeted: rt.greeted,
      blocked,
      now
    })
  }

  private afterMessage(cfg: ChannelConfig, rt: ChannelState, out: { text: string; emotes: string[]; templateKey: string; mood: string; emoteOnly: boolean; directed?: boolean }, now: number): void {
    this.history.record(cfg.login, out.text, out.templateKey, now, out.emoteOnly)
    if (out.mood === 'greet') rt.greeted = true
    if (out.emotes.length) {
      const s = this.store.settings
      s.recentEmotes = [...s.recentEmotes, ...out.emotes].slice(-30)
      this.store.save()
    }
    const pacing = resolvePacing(this.store.settings.pacing, cfg.overrides, rt.room)
    rt.nextEligibleAt = now + nextDelayMs(pacing, this.store.settings.pacing.cooldownSec, this.rng)
    rt.nextEvalAt = 0
    rt.counted++
    // A reply to a greeting isn't a "reaction": it doesn't count towards the reaction cap.
    if (out.directed) return
    // Silence longer than the rest period starts a fresh reaction.
    if (now - rt.lastMsgAt >= this.store.settings.pacing.reactionRestSec * 1000) rt.burstCount = 0
    rt.burstCount++
    rt.lastMsgAt = now
  }

  private dispatch(cfg: ChannelConfig, rt: ChannelState, out: Extract<GenerateOutput, { ok: true }> & { directed?: boolean }, now: number): void {
    const mode = this.store.settings.sendMode
    if (mode === 'approval') {
      const p: PendingMessage = {
        id: `p${this.nextPendingId++}`,
        channel: cfg.login,
        text: out.text,
        reason: out.reason,
        createdAt: now,
        expiresAt: now + PENDING_TTL_MS
      }
      this.pending.push(p)
      // Keep the generated text out of the repeat pool right away so a follow-up isn't a duplicate.
      this.history.record(cfg.login, out.text, out.templateKey, now, out.emoteOnly)
      rt.nextEvalAt = now
      this.log.add('info', 'pending', 'Needs approval', { channel: cfg.login, text: out.text, detail: out.reason })
      return
    }
    const res = this.trySend(cfg, out.text, out.reason, false, out)
    if (!res.ok) {
      this.noteSkip(cfg.login, rt, `generated a message but did not send: ${res.reason}`, now)
      rt.nextEvalAt = now + this.retryMs(this.resolved(cfg, rt).minSec, 6000)
    }
  }

  /** Every real send goes through here. */
  private trySend(
    cfg: ChannelConfig,
    text: string,
    reason: string,
    userApproved: boolean,
    meta?: { emotes: string[]; templateKey: string; mood: string; emoteOnly: boolean; directed?: boolean }
  ): { ok: boolean; reason?: string } {
    const rt = this.rt(cfg.login)
    const now = this.now()
    const s = this.store.settings
    const pacing = resolvePacing(s.pacing, cfg.overrides, rt.room)
    const check = checkSend({
      mode: s.sendMode,
      automation: this.state,
      userApproved,
      channel: cfg,
      runtime: { halted: rt.halted, haltReason: rt.haltReason, conn: rt.conn, live: rt.live, sent: rt.sent, room: rt.room, badges: rt.badges },
      authenticated: this.deps.irc.authenticated,
      connected: this.deps.irc.status === 'connected',
      sessionSent: this.sessionSent,
      limits: { maxPerSession: s.pacing.maxPerSession, maxPerChannel: pacing.maxMessages },
      globalBackoffActive: now < this.backoffUntil || now < rt.backoffUntil
    })
    if (!check.ok) {
      this.log.add('info', 'skipped', `Not sent: ${check.reason}`, { channel: cfg.login, text })
      return { ok: false, reason: check.reason }
    }
    const sent = this.deps.irc.say(cfg.login, text)
    if (!sent.ok) {
      this.log.add('warn', 'skipped', `Not sent: ${sent.reason}`, { channel: cfg.login, text })
      return { ok: false, reason: sent.reason }
    }
    rt.sent++
    this.sessionSent++
    this.lastGlobalSendAt = now
    const emotes = meta?.emotes ?? text.split(' ').filter((t) => this.deps.emotes.forChannel(cfg.login).some((e) => e.name === t))
    this.afterMessage(cfg, rt, { text, emotes, templateKey: meta?.templateKey ?? `manual:${text}`, mood: meta?.mood ?? 'manual', emoteOnly: meta?.emoteOnly ?? false, directed: meta?.directed }, now)
    this.log.add('info', 'sent', 'Sent', { channel: cfg.login, text, detail: `${reason}${userApproved ? ' (approved by you)' : ''}` })
    this.emit('sent', { id: `s${now}-${this.sessionSent}`, ts: now, channel: cfg.login, text, account: this.deps.irc.login ?? '', approved: userApproved } satisfies SentMessage)
    return { ok: true }
  }

  // ---------- state ----------

  private rt(login: string): ChannelState {
    let rt = this.channels.get(login)
    if (!rt) {
      rt = {
        conn: 'idle',
        live: 'unknown',
        room: { ...DEFAULT_ROOM },
        sent: 0,
        counted: 0,
        halted: false,
        nextEligibleAt: 0,
        nextEvalAt: 0,
        backoffUntil: 0,
        buffer: [],
        greeted: false,
        badges: [],
        joinTimer: null,
        lastSkip: null,
        limitNoted: false,
        burstCount: 0,
        lastMsgAt: 0,
        directed: [],
        greetedUsers: new Map()
      }
      this.channels.set(login, rt)
    }
    return rt
  }

  private setWarning(key: string, text: string): void {
    this.warnings.set(key, text)
  }
  private clearWarning(key: string): void {
    this.warnings.delete(key)
  }

  snapshotSoon(): void {
    if (this.snapTimer) return
    this.snapTimer = setTimeout(() => {
      this.snapTimer = null
      const snap = this.snapshot()
      // Nothing is sent to the UI unless something actually changed.
      const key = JSON.stringify(snap)
      if (key === this.lastSnapKey) return
      this.lastSnapKey = key
      this.emit('snapshot', snap)
    }, 150)
    this.snapTimer.unref?.()
  }

  snapshot(): Snapshot {
    const now = this.now()
    const s = this.store.settings ?? DEFAULT_SETTINGS
    const channels: ChannelRuntime[] = this.store.channels.map((cfg) => {
      const rt = this.rt(cfg.login)
      const recent = rt.buffer.filter((m) => now - m.ts < 60_000).length
      return {
        login: cfg.login,
        conn: rt.conn,
        connDetail: rt.connDetail,
        live: rt.live,
        viewers: rt.viewers,
        title: rt.title,
        game: rt.game,
        room: rt.room,
        sent: rt.sent,
        halted: rt.halted,
        haltReason: rt.haltReason,
        emotes: this.deps.emotes.info(cfg.login),
        chatPerMin: recent
      }
    })
    return {
      automation: { state: this.state, pauseReason: this.pauseReason },
      connection: { state: this.connState, authenticated: this.deps.irc.authenticated, detail: this.connDetail },
      auth: this.deps.authState(),
      channels,
      counters: {
        sentSession: this.sessionSent,
        skippedSession: this.sessionSkipped,
        sessionLimit: s.pacing.maxPerSession
      },
      pending: this.pending.slice(),
      warnings: [...this.warnings.values()],
      globalBackoffUntil: this.backoffUntil > now ? this.backoffUntil : 0,
      startedAt: this.startedAt
    }
  }

  dispose(): void {
    this.stop('app closing')
    for (const t of [this.timer, this.snapTimer]) if (t) clearTimeout(t)
  }
}
