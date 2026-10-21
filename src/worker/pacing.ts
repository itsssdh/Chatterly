import type { ChannelOverrides, PacingSettings, RoomState } from '@shared/types'

export interface ResolvedPacing {
  minSec: number
  maxSec: number
  maxMessages: number
}

/** Merge global pacing with per-channel overrides and the room's slow mode. */
export function resolvePacing(global: PacingSettings, ov: ChannelOverrides, room: RoomState): ResolvedPacing {
  let minSec = Math.max(0, ov.minDelaySec ?? global.minDelaySec)
  // Slow mode is Twitch's own rule for the room: posting faster than it allows is simply rejected.
  if (room.slow > 0) minSec = Math.max(minSec, room.slow + 1)
  const maxSec = Math.max(minSec, ov.maxDelaySec ?? global.maxDelaySec)
  return { minSec, maxSec, maxMessages: ov.maxMessages ?? global.maxPerChannel }
}

/** Randomised spacing inside [min, max], plus the fixed cooldown. */
export function nextDelayMs(p: ResolvedPacing, cooldownSec: number, rng: () => number): number {
  return Math.round((p.minSec + rng() * (p.maxSec - p.minSec) + Math.max(0, cooldownSec)) * 1000)
}

/** Exponential backoff after a rate-limit warning from Twitch: 2 min, 4, 8 … capped at 30 min. */
export function backoffSeconds(level: number): number {
  return Math.min(1800, 120 * 2 ** Math.max(0, level - 1))
}

const LARGE = 1_000_000

/** Clamp to a finite, non-negative number. There is deliberately no minimum beyond zero. */
export function num(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v * 100) / 100)) : fallback
}

export function sanitizePacing(p: Partial<PacingSettings> | undefined, cur: PacingSettings): PacingSettings {
  if (!p || typeof p !== 'object') return cur
  const minDelaySec = num(p.minDelaySec, 0, LARGE, cur.minDelaySec)
  return {
    minDelaySec,
    maxDelaySec: Math.max(minDelaySec, num(p.maxDelaySec, 0, LARGE, cur.maxDelaySec)),
    cooldownSec: num(p.cooldownSec, 0, LARGE, cur.cooldownSec),
    globalGapSec: num(p.globalGapSec, 0, LARGE, cur.globalGapSec),
    maxPerSession: num(p.maxPerSession, 1, LARGE, cur.maxPerSession),
    maxPerChannel: num(p.maxPerChannel, 1, LARGE, cur.maxPerChannel),
    reactChance: num(p.reactChance, 0, 1, cur.reactChance),
    maxPerReaction: num(p.maxPerReaction, 0, LARGE, cur.maxPerReaction),
    reactionRestSec: num(p.reactionRestSec, 0, LARGE, cur.reactionRestSec),
    guardMinGapSec: num(p.guardMinGapSec, 0, LARGE, cur.guardMinGapSec),
    guardMaxPer30s: num(p.guardMaxPer30s, 0, LARGE, cur.guardMaxPer30s)
  }
}

/** Trimmed, non-empty strings with duplicates (ignoring capitalisation) removed. */
export const strList = (v: unknown, maxItems: number): string[] => {
  if (!Array.isArray(v)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const x of v) {
    if (typeof x !== 'string') continue
    const t = x.trim()
    if (!t || seen.has(t.toLowerCase())) continue
    seen.add(t.toLowerCase())
    out.push(t)
  }
  return out.slice(0, maxItems)
}
