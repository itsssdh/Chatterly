import { describe, expect, it } from 'vitest'
import { analyzeChat } from '../src/worker/engine/context'
import { EmotePicker } from '../src/worker/engine/emotePicker'
import { generateMessage } from '../src/worker/engine/generator'
import { MessageHistory, makeBlockedTest } from '../src/worker/engine/safety'
import type { Emote, EmoteDensity, Personality } from '../src/shared/types'
import { chat, mulberry32 } from './helpers'

const NOW = 5_000_000
const WORDS = ['lol', 'LMAO', 'kekw', 'KEKW', 'gg', 'ez', 'rip', 'F', 'wtf', 'omg', 'hi', 'hello', 'yo', 'sup', 'wsg', 'insane', 'clutch', 'LETS GO', 'pog', 'POGGERS', 'no way', 'bruh', 'monkaS', 'Sadge', 'widepeepoSad', 'Clap', 'LULW', 'OMEGALUL', 'ICANT', 'EZ', 'GIGACHAD', 'catJAM', 'peepoHappy', 'hello chat', '!lurk', 'http://evil.example/x', '@someone', 'my dad died', 'badword', 'x'.repeat(300), '\u0000\u0001', '🙂', '😂', 'ÄÖÜ', 'مرحبا', '   ', '']
const EMOTES = ['KEKW', 'LMAO', 'LMFAO', 'LOL', 'ROFL', 'LULW', 'OMEGALUL', 'ICANT', 'Pog', 'POGGERS', 'PogU', 'Clap', 'EZ', 'GIGACHAD', 'Sadge', 'widepeepoSad', 'monkaS', 'monkaW', 'catJAM', 'peepoHappy', 'wsg', 'sup', 'hiii', 'agahi', 'F', 'W', 'LETSGO', 'badwordEmote', 'Okayge', 'Wave', 'peepoHey', 'ZWoverlay']

function randomPool(rng: () => number): Emote[] {
  const n = 1 + Math.floor(rng() * EMOTES.length)
  const names = [...EMOTES].sort(() => rng() - 0.5).slice(0, n)
  return names.map((name, i) => ({ id: `id${i}`, name, animated: rng() < 0.3, source: rng() < 0.5 ? 'channel' : 'global', zeroWidth: name === 'ZWoverlay' || rng() < 0.05 }))
}

function randomChat(rng: () => number) {
  const n = Math.floor(rng() * 40)
  const users = 1 + Math.floor(rng() * 12)
  return Array.from({ length: n }, () => {
    const parts = Array.from({ length: 1 + Math.floor(rng() * 4) }, () => WORDS[Math.floor(rng() * WORDS.length)])
    return chat(`user${Math.floor(rng() * users)}`, parts.join(' '), NOW - Math.floor(rng() * 70_000))
  })
}

describe('engine fuzz: invariants hold for random chats, settings and emote pools', () => {
  it('every generated message is safe, short, single-emote and obeys the settings', () => {
    const rng = mulberry32(20261020)
    const personalities: Personality[] = ['chill', 'playful', 'supportive', 'gaming', 'emotes']
    const densities: EmoteDensity[] = ['low', 'medium', 'high', 'emote-only']
    let produced = 0
    let attempts = 0
    for (let iter = 0; iter < 6000; iter++) {
      attempts++
      const pool = randomPool(rng)
      const blockedWords = rng() < 0.4 ? ['badword', 'lol'].slice(0, 1 + Math.floor(rng() * 2)) : []
      const blocked = makeBlockedTest(blockedWords)
      const laughList = rng() < 0.5 ? ['KEKW', 'LMFAO', 'LMAO', 'LOL', 'ROFL'] : ['KEKW']
      const avoid = rng() < 0.7 ? ['pog'] : []
      const favorites = rng() < 0.3 ? [EMOTES[Math.floor(rng() * EMOTES.length)]] : []
      const recent = Array.from({ length: Math.floor(rng() * 8) }, () => EMOTES[Math.floor(rng() * EMOTES.length)])
      const picker = new EmotePicker(pool, { favorites, recent, observed: new Map(), blocked, laughEmotes: laughList, avoidWords: avoid })
      const msgs = randomChat(rng)
      const signals = analyzeChat(msgs, { now: NOW, self: 'user0', isKnownEmote: (n) => picker.has(n), blocked })
      const density = densities[Math.floor(rng() * 4)]
      const personality = personalities[Math.floor(rng() * 5)]
      const r = generateMessage({
        channel: 'c', personality, density, signals, picker, history: new MessageHistory(), rng, allowFiller: rng() < 0.5,
        roomEmoteOnly: rng() < 0.1, greeted: rng() < 0.5, blocked, now: NOW
      })
      if (!r.ok) continue
      produced++
      const text = r.text
      const ctx = `[${personality}/${density}] "${text}"`
      expect(text.length, ctx).toBeGreaterThan(0)
      expect(text.length, ctx).toBeLessThanOrEqual(120)
      expect(text, ctx).not.toMatch(/https?:|www\.|@|^[/.!\\]/)
      // eslint-disable-next-line no-control-regex
      expect(text, ctx).not.toMatch(/[\u0000-\u001f]/)
      expect(text, ctx).not.toMatch(/ {2}/)
      expect(text, ctx).not.toBe('')
      const names = new Set(picker.names())
      const tokens = text.split(' ')
      const emoteTokens = tokens.filter((t) => names.has(t))
      expect(emoteTokens.length, ctx).toBeLessThanOrEqual(1)
      for (const e of r.emotes) {
        expect(names.has(e), ctx).toBe(true)
        expect(pool.find((p) => p.name === e)?.zeroWidth, ctx).not.toBe(true)
        for (const a of avoid) expect(e.toLowerCase(), ctx).not.toContain(a)
      }
      if (avoid.includes('pog')) expect(text.toLowerCase(), ctx).not.toContain('pog')
      for (const w of blockedWords) expect(text.toLowerCase(), ctx).not.toContain(w)
      if (density === 'emote-only' || (r.mood === 'laugh' && r.emotes.length)) {
        if (density === 'emote-only') expect(tokens.every((t) => names.has(t)), ctx).toBe(true)
      }
      if (r.mood === 'laugh') for (const e of r.emotes) expect(laughList.map((l) => l.toLowerCase()), ctx).toContain(e.toLowerCase())
    }
    // make sure the fuzz actually exercised the generator
    expect(produced).toBeGreaterThan(300)
    expect(attempts).toBe(6000)
  })

  it('analyzeChat never throws on hostile input', () => {
    const rng = mulberry32(7)
    for (let i = 0; i < 3000; i++) {
      const picker = new EmotePicker(randomPool(rng), { favorites: [], recent: [], observed: new Map(), blocked: () => false })
      expect(() => analyzeChat(randomChat(rng), { now: NOW, self: null, isKnownEmote: (n) => picker.has(n), blocked: () => false })).not.toThrow()
    }
  })
})
