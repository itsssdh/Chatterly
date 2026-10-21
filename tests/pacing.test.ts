import { describe, expect, it } from 'vitest'
import { nextDelayMs, resolvePacing, sanitizePacing } from '../src/worker/pacing'
import { DEFAULT_OVERRIDES, DEFAULT_PACING } from '../src/shared/types'

const room = { slow: 0, followersOnly: -1, subsOnly: false, emoteOnly: false, r9k: false }

describe('pacing has no built-in floor', () => {
  it('accepts zero and sub-second values', () => {
    const p = sanitizePacing(
      { minDelaySec: 0, maxDelaySec: 0.5, cooldownSec: 0, globalGapSec: 0, guardMinGapSec: 0, guardMaxPer30s: 0, reactChance: 0 },
      DEFAULT_PACING
    )
    expect(p).toMatchObject({ minDelaySec: 0, maxDelaySec: 0.5, cooldownSec: 0, globalGapSec: 0, guardMinGapSec: 0, guardMaxPer30s: 0, reactChance: 0 })
  })

  it('accepts very large values and ignores garbage', () => {
    const p = sanitizePacing({ minDelaySec: 86_400, maxPerSession: 99_999, maxDelaySec: NaN as unknown as number }, DEFAULT_PACING)
    expect(p.minDelaySec).toBe(86_400)
    expect(p.maxPerSession).toBe(99_999)
    expect(p.maxDelaySec).toBe(Math.max(86_400, DEFAULT_PACING.maxDelaySec))
  })

  it('resolves a 0 s minimum and per-channel overrides as given', () => {
    const r = resolvePacing({ ...DEFAULT_PACING, minDelaySec: 0, maxDelaySec: 0 }, { ...DEFAULT_OVERRIDES }, room)
    expect(r).toMatchObject({ minSec: 0, maxSec: 0 })
    expect(nextDelayMs(r, 0, () => 0.5)).toBe(0)
    const o = resolvePacing(DEFAULT_PACING, { ...DEFAULT_OVERRIDES, minDelaySec: 2, maxDelaySec: 3 }, room)
    expect(o).toMatchObject({ minSec: 2, maxSec: 3 })
  })

  it('only Twitch slow mode raises the minimum', () => {
    const r = resolvePacing({ ...DEFAULT_PACING, minDelaySec: 1, maxDelaySec: 1 }, { ...DEFAULT_OVERRIDES }, { ...room, slow: 30 })
    expect(r.minSec).toBe(31)
  })
})
