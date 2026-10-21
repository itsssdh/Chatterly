import { HARD_LIMITS } from '@shared/types'
import { DEFAULT_BLOCKED } from './lexicon'

export function makeBlockedTest(userTerms: readonly string[]): (text: string) => boolean {
  const terms = userTerms.map((t) => t.trim().toLowerCase()).filter(Boolean)
  return (text: string) => {
    if (DEFAULT_BLOCKED.test(text)) return true
    const lower = text.toLowerCase()
    return terms.some((t) => lower.includes(t))
  }
}

/** Strip anything we never want to post: links, mentions, control characters; enforce a length cap. */
export function sanitize(text: string, opts: { allowMentions?: boolean } = {}): string {
  let t = text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/https?:\/\/\S+|\b\S+\.(com|tv|gg|net|org|io|ly)\b\S*/gi, '')
    .replace(opts.allowMentions ? /$^/ : /@\w+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (t.length > HARD_LIMITS.maxMessageChars) {
    t = t.slice(0, HARD_LIMITS.maxMessageChars)
    const sp = t.lastIndexOf(' ')
    if (sp > 20) t = t.slice(0, sp)
  }
  return t
}

export function normalizeForCompare(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function jaccard(a: string, b: string): number {
  const A = new Set(a.split(' '))
  const B = new Set(b.split(' '))
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  const union = A.size + B.size - inter
  return union ? inter / union : 0
}

/** How long a message blocks its own repeat. Emote-only messages match Twitch's 30 s duplicate window. */
export const REPEAT_WINDOWS = {
  emoteOnlyMs: 30_000,
  textChannelMs: 10 * 60_000,
  textGlobalMs: 2 * 60_000,
  textSimilarMs: 3 * 60_000
}

interface Entry {
  n: string
  ts: number
  emoteOnly: boolean
}

/** Remembers what was posted so we don't repeat ourselves, per channel and across channels. */
export class MessageHistory {
  private perChannel = new Map<string, Entry[]>()
  private global: Entry[] = []
  private templates: string[] = []

  constructor(
    private channelDepth = 60,
    private globalDepth = 30
  ) {}

  isDuplicate(channel: string, text: string, now: number, emoteOnly = false): boolean {
    const n = normalizeForCompare(text)
    if (!n) return true
    const w = REPEAT_WINDOWS
    const own = this.perChannel.get(channel) ?? []
    const window = (e: Entry, textMs: number): number => (e.emoteOnly && emoteOnly ? w.emoteOnlyMs : textMs)
    if (own.some((e) => e.n === n && now - e.ts < window(e, w.textChannelMs))) return true
    if (this.global.some((e) => e.n === n && now - e.ts < window(e, w.textGlobalMs))) return true
    // Near-duplicates of recent text lines also look robotic (emote-only messages are exempt).
    if (emoteOnly) return false
    return own.slice(-8).some((e) => !e.emoteOnly && now - e.ts < w.textSimilarMs && jaccard(e.n, n) >= 0.8)
  }

  templateRecentlyUsed(key: string): boolean {
    return this.templates.slice(-12).includes(key)
  }

  record(channel: string, text: string, templateKey: string | undefined, now: number, emoteOnly = false): void {
    const entry: Entry = { n: normalizeForCompare(text), ts: now, emoteOnly }
    const own = this.perChannel.get(channel) ?? []
    own.push(entry)
    if (own.length > this.channelDepth) own.shift()
    this.perChannel.set(channel, own)
    this.global.push(entry)
    if (this.global.length > this.globalDepth) this.global.shift()
    if (templateKey) {
      this.templates.push(templateKey)
      if (this.templates.length > 60) this.templates.shift()
    }
  }

  clear(): void {
    this.perChannel.clear()
    this.global = []
    this.templates = []
  }
}
