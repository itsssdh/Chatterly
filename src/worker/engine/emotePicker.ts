import { DEFAULT_AVOID_WORDS, DEFAULT_LAUGH_EMOTES, type Emote } from '@shared/types'
import { DEFAULT_BLOCKED, EMOTE_MOOD_PATTERNS, GENERIC_EMOTE_PATTERN, STARTER_COMBOS, type Mood } from './lexicon'

export type Rng = () => number

export interface PickerOptions {
  favorites: readonly string[]
  /** Most recent last. */
  recent: readonly string[]
  /** Emote name -> times seen in recent chat. */
  observed: ReadonlyMap<string, number>
  blocked: (text: string) => boolean
  /** The only emotes used for laughter. Defaults to the built-in list. */
  laughEmotes?: readonly string[]
  /** Emote names containing any of these words are never used. */
  avoidWords?: readonly string[]
}

/**
 * Chooses emotes from the set a channel can actually render. Every name returned exists in the
 * `emotes` array handed in (which comes from 7TV), so no emote is ever invented.
 */
export class EmotePicker {
  private byName = new Map<string, Emote>()
  /** Channel's actual spellings of the allowed laugh emotes (matched case-insensitively). */
  private laugh = new Set<string>()
  private favorites: Set<string>
  private recent: string[]

  constructor(
    emotes: readonly Emote[],
    private opts: PickerOptions
  ) {
    const avoid = (opts.avoidWords ?? DEFAULT_AVOID_WORDS).map((w) => w.trim().toLowerCase()).filter(Boolean)
    const wantedLaugh = new Set((opts.laughEmotes ?? DEFAULT_LAUGH_EMOTES).map((n) => n.toLowerCase()))
    for (const e of emotes) {
      if (!/^[\w()\-:.!?]+$/.test(e.name)) continue
      if (avoid.some((w) => e.name.toLowerCase().includes(w))) continue
      if (DEFAULT_BLOCKED.test(e.name) || opts.blocked(e.name)) continue
      // Zero-width (overlay) emotes are never used.
      if (e.zeroWidth) continue
      if (!this.byName.has(e.name)) this.byName.set(e.name, e)
      if (wantedLaugh.has(e.name.toLowerCase())) this.laugh.add(e.name)
    }
    this.favorites = new Set(opts.favorites)
    this.recent = [...opts.recent]
  }

  /** Number of emotes available. */
  get size(): number {
    return this.byName.size
  }

  has(name: string): boolean {
    return this.byName.has(name)
  }

  names(): string[] {
    return [...this.byName.keys()]
  }

  /** True if this channel has the emote and it is on the allowed laugh list. */
  isLaughEmote(name: string): boolean {
    return this.laugh.has(name)
  }

  get laughCount(): number {
    return this.laugh.size
  }

  /** Names that fit a mood, by emote-name conventions. Laughter uses only the allowed list. */
  candidates(mood: Mood): string[] {
    if (mood === 'laugh') return [...this.laugh]
    const out: string[] = []
    for (const name of this.byName.keys()) {
      if (mood === 'filler') {
        if (GENERIC_EMOTE_PATTERN.test(name)) out.push(name)
      } else if (EMOTE_MOOD_PATTERNS[mood].test(name)) out.push(name)
    }
    return out
  }

  private weight(name: string): number {
    let w = 1
    if (this.favorites.has(name)) w *= 3
    const seen = this.opts.observed.get(name) ?? 0
    if (seen > 0) w *= 1 + Math.min(seen, 5) * 0.4
    const idx = this.recent.lastIndexOf(name)
    if (idx >= 0) {
      // The more recently an emote was used, the less likely it is to come up again.
      const age = this.recent.length - idx
      w *= Math.min(1, 0.08 * age)
    }
    return w
  }

  private weightedPick(names: string[], rng: Rng, exclude: ReadonlySet<string>): string | null {
    const pool = names.filter((n) => !exclude.has(n))
    if (!pool.length) return null
    const weights = pool.map((n) => this.weight(n))
    const total = weights.reduce((a, b) => a + b, 0)
    let r = rng() * total
    for (let i = 0; i < pool.length; i++) {
      r -= weights[i]
      if (r <= 0) return pool[i]
    }
    return pool[pool.length - 1]
  }

  /**
   * Pick `count` distinct emotes for a mood. Falls back to generic positive emotes, then to what
   * chat itself is using; returns fewer (possibly none) rather than guessing.
   */
  pick(mood: Mood, count: number, rng: Rng): string[] {
    const chosen: string[] = []
    const exclude = new Set<string>()
    // Laughter never falls back to other emotes: no allowed laugh emote in the channel means text only.
    if (mood === 'laugh') {
      const n = this.weightedPick([...this.laugh], rng, new Set())
      return n ? [n] : []
    }
    // Laughing emotes outside the allowed list are never used for other moods either.
    const notLaughy = (n: string): boolean => !EMOTE_MOOD_PATTERNS.laugh.test(n) || this.laugh.has(n)
    const tiers: string[][] = [this.candidates(mood).filter(notLaughy)]
    if (mood !== 'filler') tiers.push(this.candidates('filler').filter(notLaughy))
    tiers.push([...this.favorites].filter((f) => this.byName.has(f)))
    tiers.push([...this.opts.observed.keys()].filter((o) => this.byName.has(o) && notLaughy(o)))
    for (const tier of tiers) {
      while (chosen.length < count) {
        const n = this.weightedPick(tier, rng, exclude)
        if (!n) break
        chosen.push(n)
        exclude.add(n)
      }
      if (chosen.length >= count) break
      // Only fall through to looser tiers if the mood-specific tier found nothing at all.
      if (chosen.length > 0) break
    }
    return chosen
  }

  /** A well-known single-emote reaction for the mood, but only if that emote exists here. */
  starterCombo(mood: Exclude<Mood, 'filler'>, rng: Rng): string[] | null {
    if (mood === 'laugh') {
      const n = this.pick('laugh', 1, rng)
      return n.length ? n : null
    }
    const usable = STARTER_COMBOS[mood].filter((combo) => combo.length === 1 && this.byName.has(combo[0]))
    if (!usable.length) return null
    return usable[Math.floor(rng() * usable.length)]
  }

  markUsed(names: readonly string[]): void {
    this.recent.push(...names)
    if (this.recent.length > 30) this.recent.splice(0, this.recent.length - 30)
  }
}
