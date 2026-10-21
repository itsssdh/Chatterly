import type { ChatMessage } from '../twitch/parser'
import { BOT_LOGINS, CHAT_PATTERNS, REACTIVE_MOODS, SENSITIVE_PATTERN, type Mood } from './lexicon'

export interface MoodSignal {
  mood: Exclude<Mood, 'filler'>
  /** Distinct chatters who expressed this mood within the fresh window. */
  users: number
  lastAt: number
}

export interface EmoteWave {
  name: string
  users: number
  lastAt: number
}

export interface ContextSignals {
  /** Messages from real chatters in the last 60 s. */
  perMinute: number
  chatters: number
  moods: MoodSignal[]
  waves: EmoteWave[]
  /** Emote-ish tokens in recent chat with usage counts (used to prefer what this chat actually uses). */
  observedEmotes: Map<string, number>
  sensitive: boolean
  hostileTerms: boolean
}

export const FRESH_WINDOW_MS = 20_000
export const RECENT_WINDOW_MS = 60_000

export interface AnalyzeOptions {
  now: number
  /** Own login, excluded so the bot never reacts to itself. */
  self?: string | null
  isKnownEmote: (name: string) => boolean
  blocked: (text: string) => boolean
}

function relevant(m: ChatMessage, self: string | null | undefined): boolean {
  if (m.login === self) return false
  if (BOT_LOGINS.has(m.login)) return false
  if (m.text.startsWith('!')) return false
  return true
}

export function analyzeChat(buffer: readonly ChatMessage[], opts: AnalyzeOptions): ContextSignals {
  const { now } = opts
  const recent = buffer.filter((m) => now - m.ts <= RECENT_WINDOW_MS && relevant(m, opts.self))
  const fresh = recent.filter((m) => now - m.ts <= FRESH_WINDOW_MS)

  const moods: MoodSignal[] = []
  for (const mood of REACTIVE_MOODS as Exclude<Mood, 'filler'>[]) {
    const users = new Set<string>()
    let lastAt = 0
    for (const m of fresh) {
      if (CHAT_PATTERNS[mood].test(m.text) || (mood !== 'greet' && m.nativeEmotes.some((n) => CHAT_PATTERNS[mood].test(n)))) {
        users.add(m.login)
        lastAt = Math.max(lastAt, m.ts)
      }
    }
    if (users.size) moods.push({ mood, users: users.size, lastAt })
  }

  const waveUsers = new Map<string, Set<string>>()
  const waveLast = new Map<string, number>()
  const observed = new Map<string, number>()
  for (const m of recent) {
    const tokens = new Set(m.text.split(/\s+/).filter(Boolean))
    for (const tok of tokens) {
      if (!opts.isKnownEmote(tok)) continue
      observed.set(tok, (observed.get(tok) ?? 0) + 1)
      if (now - m.ts <= FRESH_WINDOW_MS) {
        if (!waveUsers.has(tok)) waveUsers.set(tok, new Set())
        waveUsers.get(tok)!.add(m.login)
        waveLast.set(tok, Math.max(waveLast.get(tok) ?? 0, m.ts))
      }
    }
  }
  const waves: EmoteWave[] = [...waveUsers.entries()]
    .map(([name, u]) => ({ name, users: u.size, lastAt: waveLast.get(name) ?? 0 }))
    .sort((a, b) => b.users - a.users || b.lastAt - a.lastAt)

  const sensitive = fresh.some((m) => SENSITIVE_PATTERN.test(m.text))
  const hostileTerms = fresh.some((m) => opts.blocked(m.text))

  return {
    perMinute: recent.length,
    chatters: new Set(recent.map((m) => m.login)).size,
    moods,
    waves,
    observedEmotes: observed,
    sensitive,
    hostileTerms
  }
}

/** How many distinct chatters must show a signal before we treat it as a real moment. */
export function signalThreshold(perMinute: number): number {
  return perMinute < 8 ? 2 : 3
}
