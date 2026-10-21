import type { Emote } from '@shared/types'

/** Single words that read as a hello ("hii", "wsg", "yooo" …). Matched per token, case-insensitively. */
const GREETING_WORD = /^(hello+|hi+|hey+|heya|hiya|yo+|sup|wsg|wsp|wassup|wazzup|whatsup|howdy|hola|gm|ayo+)$/i
/** Multi-word hellos ("what's good", "whats up", "good morning"). */
const GREETING_PHRASE = /\b(what'?s\s?(up|good)|wats\s?good|whaddup|good\s(morning|evening|afternoon)|how\s?(are\s?you|is\s?it\s?going)|hows\s?it\s?going)\b/i
/** Emotes that are themselves a hello. */
const GREETING_EMOTE = /^(hi+|hello+|hey+|hellow|heya|wave\w*|wsg|sup|agahi|peepohey|catwave|heyguys|modcheck)$/i

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter(Boolean)
}

export function mentionSet(login: string | null, custom: readonly string[]): Set<string> {
  const out = new Set<string>()
  if (login) out.add(login.toLowerCase())
  for (const c of custom) {
    const t = c.trim().toLowerCase().replace(/^@/, '')
    if (t) out.add(t)
  }
  return out
}

export function mentionsMe(text: string, mentions: ReadonlySet<string>): boolean {
  if (!mentions.size) return false
  return tokenize(text).some((t) => mentions.has(t))
}

export function containsGreeting(text: string): boolean {
  if (GREETING_PHRASE.test(text)) return true
  if (tokenize(text).some((t) => GREETING_WORD.test(t))) return true
  return text.split(/\s+/).some((t) => GREETING_EMOTE.test(t))
}

/** A greeting that names the logged-in account (or a custom mention), e.g. "hi <username>". */
export function isDirectedGreeting(text: string, mentions: ReadonlySet<string>): boolean {
  return mentionsMe(text, mentions) && containsGreeting(text)
}

export interface ReplyOptions {
  text: string
  /** Emotes we may post here: the channel's and global 7TV sets plus our own 7TV personal set, by exact name. */
  usable: ReadonlyMap<string, Emote>
  replyList: readonly string[]
  /** Most recent last; used to rotate through the reply collection. */
  recent: readonly string[]
  rng: () => number
  isDuplicate: (name: string) => boolean
}

export interface GreetingReply {
  name: string
  why: string
}

/**
 * The reply to a directed greeting: always one emote from the greeting list that exists for this channel (or in the
 * personal set), and never the same emote or word the greeter used themselves.
 */
export function chooseGreetingReply(o: ReplyOptions): GreetingReply | null {
  const theirs = new Set(o.text.toLowerCase().split(/\s+/).filter(Boolean))
  const byLower = new Map<string, string>()
  for (const name of o.usable.keys()) byLower.set(name.toLowerCase(), name)
  const options = [...new Set(o.replyList.map((n) => byLower.get(n.trim().toLowerCase())).filter((n): n is string => !!n))].filter(
    (n) => !theirs.has(n.toLowerCase()) && !o.isDuplicate(n)
  )
  if (!options.length) return null
  // Prefer the options used least recently.
  const age = (n: string): number => {
    const i = o.recent.lastIndexOf(n)
    return i < 0 ? Infinity : o.recent.length - i
  }
  const best = Math.max(...options.map(age))
  const pool = options.filter((n) => age(n) === best)
  const name = pool[Math.floor(o.rng() * pool.length)]
  return { name, why: `answering with ${name} from your greeting emotes` }
}
