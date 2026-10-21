import type { Emote } from '../src/shared/types'
import type { ChatMessage } from '../src/worker/twitch/parser'

export function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const EMOTE_NAMES = [
  'KEKW', 'LULW', 'OMEGALUL', 'ICANT', 'Pog', 'PogU', 'POGGERS', 'LETSGO', 'Clap', 'EZ', 'GIGACHAD',
  'Sadge', 'FeelsBadMan', 'monkaS', 'monkaW', 'PauseChamp', 'peepoHappy', 'catJAM', 'Wave', 'peepoHey', 'Okayge'
]

export function emotes(names: string[] = EMOTE_NAMES): Emote[] {
  return names.map((name, i) => ({ id: `id${i}`, name, animated: false, source: i % 2 ? 'channel' : 'global' }))
}

let n = 0
export function chat(login: string, text: string, ts: number, channel = 'testchan'): ChatMessage {
  return { id: `m${n++}`, channel, userId: login, login, displayName: login, text, ts, isAction: false, badges: [], nativeEmotes: [] }
}

/** Several distinct chatters all saying `text` within the last few seconds. */
export function burst(texts: string[], now: number): ChatMessage[] {
  return texts.map((t, i) => chat(`viewer${i}`, t, now - 2000 + i * 100))
}

// ---- test storage: each test gets its own namespace in the in-memory store ----
import { kv } from '../src/worker/kv'
let nsCounter = 0
/** A unique key prefix, standing in for the temp folder the desktop tests used. */
export const ns = (name: string): string => `${name}-${++nsCounter}`
export const clearNs = (prefix: string): void => {
  for (const k of kv().keys(prefix)) kv().delete(k)
}
