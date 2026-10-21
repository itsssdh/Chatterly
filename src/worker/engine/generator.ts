import type { EmoteDensity, Personality } from '@shared/types'
import { signalThreshold, type ContextSignals } from './context'
import type { EmotePicker, Rng } from './emotePicker'
import { EMOTE_MOOD_PATTERNS, INTERJECTIONS, STYLE, textBank, type Mood } from './lexicon'
import { MessageHistory, sanitize } from './safety'

export interface GenerateInput {
  channel: string
  personality: Personality
  density: EmoteDensity
  signals: ContextSignals
  picker: EmotePicker
  history: MessageHistory
  rng: Rng
  allowFiller: boolean
  /** The room only accepts emotes right now. */
  roomEmoteOnly: boolean
  /** Whether we already said hello in this channel this session. */
  greeted: boolean
  blocked: (text: string) => boolean
  now: number
}

export type GenerateOutput =
  | { ok: true; text: string; reason: string; mood: Mood; emotes: string[]; templateKey: string; emoteOnly: boolean }
  | { ok: false; reason: string }

interface Moment {
  kind: 'wave' | 'mood' | 'filler'
  mood: Mood
  wave?: string
  users: number
  reason: string
}

const MOOD_LABEL: Record<Mood, string> = {
  laugh: 'laughing',
  hype: 'hyped',
  win: 'celebrating a win',
  loss: 'reacting to a loss',
  shock: 'surprised',
  greet: 'greeting each other',
  filler: 'chatting'
}

const pick = <T>(arr: readonly T[], rng: Rng): T => arr[Math.floor(rng() * arr.length)]

/** Decide whether chat is showing something worth reacting to — and what. */
export function findMoment(input: GenerateInput): Moment | { skip: string } {
  const { signals, picker } = input
  if (signals.sensitive) return { skip: 'a sensitive topic is in chat — staying out of it' }
  if (signals.hostileTerms) return { skip: 'chat contains terms on the block list — not joining in' }
  const threshold = signalThreshold(signals.perMinute)

  const wave = signals.waves.find((w) => w.users >= Math.max(3, threshold) && picker.has(w.name))
  const moods = signals.moods
    .filter((m) => m.users >= threshold && (m.mood !== 'greet' || !input.greeted))
    .sort((a, b) => b.users - a.users || b.lastAt - a.lastAt)

  // An emote wave and a mood can both be present; prefer whichever more chatters are behind.
  if (wave && (!moods.length || wave.users >= moods[0].users)) {
    // A wave of some other laughing emote is answered with the allowed laugh emotes, never copied.
    if (EMOTE_MOOD_PATTERNS.laugh.test(wave.name) && !picker.isLaughEmote(wave.name)) {
      return {
        kind: 'mood',
        mood: 'laugh',
        users: wave.users,
        reason: `${wave.users} chatters posted ${wave.name} in the last 20s — laughing along with an allowed laugh emote`
      }
    }
    return {
      kind: 'wave',
      mood: 'hype',
      wave: wave.name,
      users: wave.users,
      reason: `${wave.users} chatters posted ${wave.name} in the last 20s — joining the emote wave`
    }
  }
  if (moods.length) {
    const top = moods[0]
    // Variety: occasionally let a lesser mood pass instead of always taking the loudest.
    return {
      kind: 'mood',
      mood: top.mood,
      users: top.users,
      reason: `${top.users} chatters ${MOOD_LABEL[top.mood]} in the last 20s`
    }
  }
  if (input.allowFiller && signals.perMinute >= 8 && signals.chatters >= 3) {
    return {
      kind: 'filler',
      mood: 'filler',
      users: signals.chatters,
      reason: `chat is active (${signals.perMinute} msgs/min) but nothing specific happened — low-key filler`
    }
  }
  return { skip: 'nothing in chat worth reacting to' }
}

// ---------- shaping ----------

interface Shape {
  kind: 'text' | 'text+emote' | 'emote+text' | 'text-emote-text' | 'emote-only'
  emoteCount: number
}

function emoteOnlyChance(density: EmoteDensity, personality: Personality): number {
  // Emote-only density means exactly that: never a single word, whatever the personality.
  if (density === 'emote-only') return 1
  let p = density === 'high' ? 0.18 : density === 'medium' ? 0.05 : 0
  if (personality === 'emotes') p = Math.max(p, density === 'low' ? 0.35 : 0.7)
  return p
}

function emoteIncludeChance(density: EmoteDensity, personality: Personality): number {
  const base = density === 'low' ? 0.3 : density === 'medium' ? 0.7 : 0.95
  return Math.min(1, base + (personality === 'emotes' ? 0.15 : 0))
}

export function chooseShape(density: EmoteDensity, personality: Personality, rng: Rng, textWords: number, preferEmote = false): Shape {
  // Laughter is expressed with the allowed laugh emotes whenever the channel has them.
  const emoteOnly = preferEmote ? Math.max(emoteOnlyChance(density, personality), 0.5) : emoteOnlyChance(density, personality)
  const include = preferEmote ? Math.max(emoteIncludeChance(density, personality), 0.95) : emoteIncludeChance(density, personality)
  if (rng() < emoteOnly) {
    return { kind: 'emote-only', emoteCount: 1 }
  }
  if (rng() >= include) return { kind: 'text', emoteCount: 0 }
  // A message never carries more than one normal emote.
  const emoteCount = 1
  const r = rng()
  if (r < 0.66) return { kind: 'text+emote', emoteCount }
  if (r < 0.8) return { kind: 'emote+text', emoteCount }
  if (r < 0.92 && textWords >= 3 && density !== 'low') return { kind: 'text-emote-text', emoteCount: 1 }
  return { kind: 'text+emote', emoteCount }
}

function varyText(text: string, personality: Personality, mood: Mood, rng: Rng): string {
  const style = STYLE[personality]
  let t = text
  if (rng() < style.dropPunct) t = t.replace(/[.!]+$/, '')
  else if (!/[.!?]$/.test(t) && rng() < 0.3) t += '!'
  if (rng() < style.lower) {
    // Keep fully-capitalised reactions like "W" or "F" as they are; they read as intentional.
    if (!/^[A-Z]{1,3}$/.test(t) && !/\bI\b/.test(t)) t = t.toLowerCase()
  }
  if (/(go|no|so|oo)$/.test(t) && rng() < style.elongate) t += t.slice(-1).repeat(1 + Math.floor(rng() * 2))
  const interjectable: Mood[] = ['laugh', 'hype', 'shock', 'filler']
  if (interjectable.includes(mood) && t.split(' ').length <= 3 && rng() < style.interject) {
    t = pick(INTERJECTIONS, rng) + t
  }
  return t
}

function compose(shape: Shape, text: string, emotes: string[], rng: Rng): string {
  switch (shape.kind) {
    case 'emote-only':
      return emotes.join(' ')
    case 'text':
      return text
    case 'emote+text':
      return `${emotes.join(' ')} ${text}`
    case 'text-emote-text': {
      const words = text.split(' ')
      const at = 1 + Math.floor(rng() * (words.length - 1))
      return [...words.slice(0, at), emotes.join(' '), ...words.slice(at)].join(' ')
    }
    default:
      return `${text} ${emotes.join(' ')}`
  }
}

export function generateMessage(input: GenerateInput): GenerateOutput {
  const { picker, history, rng, channel } = input
  const moment = findMoment(input)
  if ('skip' in moment) return { ok: false, reason: moment.skip }

  const forceEmoteOnly = input.roomEmoteOnly
  const density: EmoteDensity = forceEmoteOnly ? 'emote-only' : input.density

  for (let attempt = 0; attempt < 8; attempt++) {
    let text = ''
    let emotes: string[] = []
    let templateKey: string
    let shape: Shape

    if (moment.kind === 'wave') {
      // Joining a wave means posting the same single emote chat is posting.
      emotes = [moment.wave!]
      shape = { kind: 'emote-only', emoteCount: 1 }
      templateKey = `wave:${moment.wave}`
    } else {
      const mood = moment.mood
      const bank = textBank(input.personality, mood)
      const fresh = bank.filter((line) => !history.templateRecentlyUsed(`${mood}:${line}`))
      const line = pick(fresh.length ? fresh : bank, rng)
      templateKey = `${mood}:${line}`
      const words = line.split(' ').length
      shape = chooseShape(density, input.personality, rng, words, mood === 'laugh' && picker.laughCount > 0 && !forceEmoteOnly)

      if (shape.kind !== 'text') {
        // Prefer a known combo for pure-emote reactions, otherwise pick by mood.
        if (shape.kind === 'emote-only' && mood !== 'filler' && rng() < 0.5) {
          emotes = picker.starterCombo(mood, rng) ?? []
        }
        if (!emotes.length) emotes = picker.pick(mood, 1, rng)
        if (!emotes.length) {
          // Nothing fits: fall back to plain text, unless the room or density demands emotes.
          if (density === 'emote-only') return { ok: false, reason: 'no suitable emotes available for an emote-only message' }
          shape = { kind: 'text', emoteCount: 0 }
        }
      }
      text = shape.kind === 'emote-only' ? '' : varyText(line, input.personality, mood, rng)
    }

    const composed = sanitize(compose(shape, text, emotes, rng))
    if (!composed) continue
    // Defensive: in emote-only mode every token must be an emote.
    if (density === 'emote-only' && composed.split(' ').some((t) => !picker.has(t))) continue
    // Hard rule: at most one normal emote per message (words in the text that happen to be emote names count).
    if (composed.split(' ').filter((t) => picker.has(t)).length > 1) continue
    if (input.blocked(composed)) continue
    const emoteOnly = shape.kind === 'emote-only'
    if (history.isDuplicate(channel, composed, input.now, emoteOnly)) continue
    return {
      ok: true,
      text: composed,
      reason: moment.reason,
      mood: moment.mood,
      emotes,
      templateKey,
      emoteOnly
    }
  }
  return { ok: false, reason: 'could not find a fresh variation (everything matching was recently used)' }
}
