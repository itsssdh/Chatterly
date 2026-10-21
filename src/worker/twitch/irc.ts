import { EventEmitter } from '../events'
import WebSocket from '../socket'
import { HARD_LIMITS, type RoomState } from '@shared/types'
import type { ActivityLog } from '../logger'
import { parseIrc, toChatMessage, type ChatMessage, type IrcMessage } from './parser'

export const TWITCH_IRC_URL = 'wss://irc-ws.chat.twitch.tv:443'

export type IrcStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting'

export interface IrcAuth {
  login: string
  token: string
}

export interface IrcEvents {
  status: [status: IrcStatus, detail?: string]
  message: [msg: ChatMessage]
  roomstate: [channel: string, room: RoomState, roomId: string | null]
  userstate: [channel: string, badges: string[]]
  joined: [channel: string]
  notice: [channel: string | null, msgId: string, text: string]
  selftimeout: [channel: string, seconds: number | null]
  authfailed: [text: string]
}

export interface IrcOptions {
  url?: string
  log?: ActivityLog
  baseBackoffMs?: number
  maxBackoffMs?: number
  joinGapMs?: number
  rng?: () => number
  now?: () => number
}

export type SayResult = { ok: true } | { ok: false; reason: string }

const DEFAULT_ROOM: RoomState = { slow: 0, followersOnly: -1, subsOnly: false, emoteOnly: false, r9k: false }

/**
 * Minimal Twitch chat (IRC over WebSocket) client: anonymous read-only or authenticated read/write,
 * automatic reconnection with exponential backoff, and a hard outgoing rate limit that no caller can bypass.
 */
export class TwitchIrc extends EventEmitter {
  private ws: WebSocket | null = null
  private auth: IrcAuth | null = null
  private _status: IrcStatus = 'disconnected'
  private wanted = new Set<string>()
  private joined = new Set<string>()
  private joinQueue: string[] = []
  private joinTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private stableTimer: ReturnType<typeof setTimeout> | null = null
  private watchdog: ReturnType<typeof setTimeout> | null = null
  private attempt = 0
  private intentional = true
  private lastData = 0
  private sendTimes: number[] = []
  private rooms = new Map<string, RoomState>()
  private nick = ''
  private limits = { minGapSec: 5, maxPer30s: 8 }
  private authProvider: (() => Promise<IrcAuth | null>) | null = null
  private gen = 0

  constructor(private opts: IrcOptions = {}) {
    super()
  }

  override on<K extends keyof IrcEvents>(event: K, listener: (...args: IrcEvents[K]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void)
  }
  override emit<K extends keyof IrcEvents>(event: K, ...args: IrcEvents[K]): boolean {
    return super.emit(event, ...args)
  }

  get status(): IrcStatus {
    return this._status
  }
  get authenticated(): boolean {
    return this.auth !== null
  }
  get login(): string | null {
    return this.auth?.login ?? null
  }
  isJoined(channel: string): boolean {
    return this.joined.has(channel)
  }
  roomState(channel: string): RoomState {
    return this.rooms.get(channel) ?? { ...DEFAULT_ROOM }
  }

  /** Supplies a fresh token on every reconnect (the 4 h access token may have expired in the meantime). */
  setAuthProvider(fn: () => Promise<IrcAuth | null>): void {
    this.authProvider = fn
  }

  /** Connection-level send guard. 0 turns a limit off. */
  setLimits(minGapSec: number, maxPer30s: number): void {
    this.limits = { minGapSec, maxPer30s }
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now()
  }
  private setStatus(s: IrcStatus, detail?: string): void {
    this._status = s
    this.emit('status', s, detail)
  }

  /** Connect (or reconnect with different credentials). `null` means anonymous read-only. */
  connect(auth: IrcAuth | null): void {
    this.teardown()
    this.auth = auth
    this.intentional = false
    this.attempt = 0
    this.open()
  }

  disconnect(): void {
    this.teardown()
    this.joined.clear()
    this.joinQueue = []
    // The next connection joins only what the host asks for then (not whatever was wanted before).
    this.wanted.clear()
    this.rooms.clear()
    this.setStatus('disconnected')
  }

  private teardown(): void {
    this.gen++
    this.intentional = true
    for (const t of [this.reconnectTimer, this.stableTimer, this.joinTimer]) if (t) clearTimeout(t)
    this.reconnectTimer = this.stableTimer = this.joinTimer = null
    if (this.watchdog) clearInterval(this.watchdog)
    this.watchdog = null
    const ws = this.ws
    this.ws = null
    if (ws) {
      ws.removeAllListeners()
      ws.on('error', () => {})
      try {
        ws.close()
      } catch {
        // already closed
      }
    }
  }

  private open(): void {
    this.setStatus(this.attempt > 0 ? 'reconnecting' : 'connecting')
    if (this.auth && this.authProvider && this.attempt > 0) {
      const gen = this.gen
      void this.authProvider()
        .then((a) => {
          if (a) this.auth = a
        })
        .catch(() => undefined)
        .then(() => {
          if (gen === this.gen) this.openSocket()
        })
      return
    }
    this.openSocket()
  }

  private openSocket(): void {
    this.joined.clear()
    const ws = new WebSocket(this.opts.url ?? TWITCH_IRC_URL)
    this.ws = ws
    ws.on('open', () => {
      this.lastData = this.now()
      this.raw('CAP REQ :twitch.tv/tags twitch.tv/commands')
      if (this.auth) {
        this.nick = this.auth.login
        this.raw(`PASS oauth:${this.auth.token.replace(/^oauth:/, '')}`, true)
        this.raw(`NICK ${this.auth.login}`)
      } else {
        this.nick = `justinfan${10000 + Math.floor((this.opts.rng ?? Math.random)() * 80000)}`
        this.raw('PASS SCHMOOPIIE')
        this.raw(`NICK ${this.nick}`)
      }
    })
    ws.on('message', (data) => {
      this.lastData = this.now()
      for (const line of data.toString().split('\r\n')) {
        if (!line) continue
        const msg = parseIrc(line)
        if (msg) this.handle(msg)
      }
    })
    ws.on('error', (err) => this.opts.log?.debug(`IRC socket error: ${err.message}`))
    ws.on('close', () => {
      if (this.ws !== ws) return
      this.ws = null
      this.joined.clear()
      if (this.watchdog) clearInterval(this.watchdog)
      if (this.stableTimer) clearTimeout(this.stableTimer)
      if (!this.intentional) this.scheduleReconnect()
    })
    this.watchdog = setInterval(() => this.checkAlive(), 60_000)
    this.watchdog.unref?.()
  }

  private checkAlive(): void {
    const idle = this.now() - this.lastData
    if (idle > 7 * 60_000) {
      this.opts.log?.warn('Chat connection went silent — reconnecting')
      this.ws?.terminate()
    } else if (idle > 6 * 60_000) {
      this.raw('PING :tmi.twitch.tv')
    }
  }

  private scheduleReconnect(immediate = false): void {
    const base = this.opts.baseBackoffMs ?? 1000
    const max = this.opts.maxBackoffMs ?? 60_000
    const rng = this.opts.rng ?? Math.random
    const delay = immediate ? 0 : Math.round(Math.min(max, base * 2 ** this.attempt) * (0.7 + rng() * 0.3))
    this.attempt++
    this.setStatus('reconnecting', immediate ? 'server asked to reconnect' : `retrying in ${Math.ceil(delay / 1000)}s`)
    this.opts.log?.warn(`Chat connection lost — ${immediate ? 'reconnecting now' : `retrying in ${Math.ceil(delay / 1000)}s (attempt ${this.attempt})`}`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.open()
    }, delay)
  }

  private raw(line: string, secret = false): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    if (secret) this.opts.log?.debug('IRC > PASS ********')
    else this.opts.log?.debug(`IRC > ${line}`)
    this.ws.send(line)
  }

  // ---------- channels ----------

  join(channel: string): void {
    this.wanted.add(channel)
    this.queueJoin(channel)
  }

  part(channel: string): void {
    this.wanted.delete(channel)
    this.joinQueue = this.joinQueue.filter((c) => c !== channel)
    if (this.joined.delete(channel) || this.status === 'connected') this.raw(`PART #${channel}`)
    this.rooms.delete(channel)
  }

  private queueJoin(channel: string): void {
    if (this._status !== 'connected' || this.joined.has(channel) || this.joinQueue.includes(channel)) return
    this.joinQueue.push(channel)
    this.pumpJoins()
  }

  private pumpJoins(): void {
    if (this.joinTimer || !this.joinQueue.length) return
    const next = this.joinQueue.shift()!
    this.raw(`JOIN #${next}`)
    // Twitch limits JOINs, so they are spaced out.
    this.joinTimer = setTimeout(() => {
      this.joinTimer = null
      this.pumpJoins()
    }, this.opts.joinGapMs ?? 350)
  }

  // ---------- sending ----------

  /** Last line of defence: refuses anything that isn't a plain chat message, and applies the user's send guard. */
  say(channel: string, text: string): SayResult {
    if (!this.auth) return { ok: false, reason: 'not logged in (read-only connection)' }
    if (this._status !== 'connected') return { ok: false, reason: 'chat is not connected' }
    if (!this.joined.has(channel)) return { ok: false, reason: `not joined to #${channel}` }
    const t = text.trim()
    if (!t) return { ok: false, reason: 'empty message' }
    if (/^[/.!\\]/.test(t)) return { ok: false, reason: 'refusing to send something that looks like a command' }
    if (t.length > HARD_LIMITS.maxMessageChars) return { ok: false, reason: 'message too long' }
    const now = this.now()
    this.sendTimes = this.sendTimes.filter((x) => now - x < 30_000)
    const last = this.sendTimes[this.sendTimes.length - 1]
    if (this.limits.minGapSec > 0 && last !== undefined && now - last < this.limits.minGapSec * 1000) {
      return { ok: false, reason: `rate limit guard: less than ${this.limits.minGapSec}s since the last message` }
    }
    if (this.limits.maxPer30s > 0 && this.sendTimes.length >= this.limits.maxPer30s) {
      return { ok: false, reason: `rate limit guard: ${this.limits.maxPer30s} messages in the last 30s` }
    }
    this.sendTimes.push(now)
    this.raw(`PRIVMSG #${channel} :${t}`)
    return { ok: true }
  }

  // ---------- inbound ----------

  private handle(m: IrcMessage): void {
    const chan = (m.params[0] ?? '').startsWith('#') ? m.params[0].slice(1).toLowerCase() : null
    switch (m.command) {
      case 'PING':
        this.raw(`PONG :${m.trailing ?? 'tmi.twitch.tv'}`)
        break
      case 'RECONNECT':
        this.ws?.removeAllListeners('close')
        this.teardown()
        this.intentional = false
        this.scheduleReconnect(true)
        break
      case '001':
        this.setStatus('connected')
        this.stableTimer = setTimeout(() => (this.attempt = 0), 30_000)
        this.stableTimer.unref?.()
        for (const c of this.wanted) this.queueJoin(c)
        break
      case 'JOIN':
        if (chan && (m.prefix ?? '').startsWith(this.nick.toLowerCase() + '!')) {
          this.joined.add(chan)
          this.emit('joined', chan)
        }
        break
      case 'ROOMSTATE': {
        if (!chan) break
        const prev = this.rooms.get(chan) ?? { ...DEFAULT_ROOM }
        const t = m.tags
        const next: RoomState = {
          slow: t['slow'] !== undefined ? Number(t['slow']) || 0 : prev.slow,
          followersOnly: t['followers-only'] !== undefined ? Number(t['followers-only']) : prev.followersOnly,
          subsOnly: t['subs-only'] !== undefined ? t['subs-only'] === '1' : prev.subsOnly,
          emoteOnly: t['emote-only'] !== undefined ? t['emote-only'] === '1' : prev.emoteOnly,
          r9k: t['r9k'] !== undefined ? t['r9k'] === '1' : prev.r9k
        }
        this.rooms.set(chan, next)
        this.emit('roomstate', chan, next, t['room-id'] ?? null)
        break
      }
      case 'USERSTATE':
        if (chan) this.emit('userstate', chan, (m.tags['badges'] ?? '').split(',').filter(Boolean).map((b) => b.split('/')[0]))
        break
      case 'PRIVMSG': {
        const msg = toChatMessage(m, this.now())
        if (msg) this.emit('message', msg)
        break
      }
      case 'CLEARCHAT':
        if (chan && m.params[1] && m.params[1].toLowerCase() === this.nick.toLowerCase()) {
          const d = m.tags['ban-duration']
          this.emit('selftimeout', chan, d ? Number(d) : null)
        }
        break
      case 'NOTICE': {
        const text = m.params[m.params.length - 1] ?? ''
        if (!chan && /authentication failed|improperly formatted auth|login unsuccessful/i.test(text)) {
          this.intentional = true
          this.emit('authfailed', text)
          this.teardown()
          this.setStatus('disconnected', 'login failed')
          break
        }
        this.emit('notice', chan, m.tags['msg-id'] ?? '', text)
        break
      }
      default:
        break
    }
  }
}
