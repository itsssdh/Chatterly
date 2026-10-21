import { describe, expect, it } from 'vitest'
import { analyzeChat } from '../src/worker/engine/context'
import { EmotePicker } from '../src/worker/engine/emotePicker'
import { generateMessage, type GenerateInput } from '../src/worker/engine/generator'
import { MessageHistory, makeBlockedTest, sanitize } from '../src/worker/engine/safety'
import type { EmoteDensity, Personality } from '../src/shared/types'
import { EMOTE_NAMES, burst, chat, emotes, mulberry32 } from './helpers'

const blocked = makeBlockedTest([])
const NOW = 1_000_000

function setup(msgs: ReturnType<typeof chat>[], over: Partial<GenerateInput> = {}, emoteList = emotes()) {
  const picker = new EmotePicker(emoteList, { favorites: [], recent: [], observed: new Map(), blocked })
  const signals = analyzeChat(msgs, { now: NOW, self: 'me', isKnownEmote: (n) => picker.has(n), blocked })
  const input: GenerateInput = {
    channel: 'testchan',
    personality: 'chill',
    density: 'medium',
    signals,
    picker,
    history: new MessageHistory(),
    rng: mulberry32(7),
    allowFiller: false,
    roomEmoteOnly: false,
    greeted: false,
    blocked,
    now: NOW,
    ...over
  }
  return input
}

describe('context analysis', () => {
  it('needs several distinct chatters before a moment counts', () => {
    const one = setup([chat('a', 'LUL LUL LUL', NOW - 1000), chat('a', 'lmao', NOW - 900)])
    expect(generateMessage(one).ok).toBe(false)
  })

  it('does not react to quiet or unrelated chat', () => {
    const r = generateMessage(setup(burst(['what game is this', 'how long till the end', 'i like the music', 'cool setup'], NOW)))
    expect(r.ok).toBe(false)
  })

  it('reacts when several chatters laugh', () => {
    const r = generateMessage(setup(burst(['LMAO', 'kekw', 'lol that', 'LULW'], NOW)))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.mood).toBe('laugh')
  })

  it('joins an emote wave with that same emote, only if the channel has it', () => {
    const wave = burst(['KEKW', 'KEKW', 'KEKW hah', 'KEKW'], NOW)
    const r = generateMessage(setup(wave))
    expect(r.ok && r.text.includes('KEKW')).toBe(true)
    const noEmote = generateMessage(setup(burst(['ZZZZ', 'ZZZZ', 'ZZZZ', 'ZZZZ'], NOW)))
    expect(noEmote.ok).toBe(false)
  })

  it('ignores bots, commands and its own messages', () => {
    const msgs = [
      chat('nightbot', 'lol lmao kekw', NOW - 1000),
      chat('b', '!lurk lol', NOW - 1000),
      chat('me', 'lol', NOW - 1000),
      chat('c', 'lol', NOW - 1000)
    ]
    expect(generateMessage(setup(msgs)).ok).toBe(false)
  })

  it('stays out of sensitive topics', () => {
    const msgs = [...burst(['lol', 'lmao', 'kekw'], NOW), chat('z', 'my dad died last week', NOW - 1500)]
    const r = generateMessage(setup(msgs))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/sensitive/)
  })

  it('ignores stale chat', () => {
    const old = [chat('a', 'lol', NOW - 50_000), chat('b', 'lmao', NOW - 50_000), chat('c', 'kekw', NOW - 50_000)]
    expect(generateMessage(setup(old)).ok).toBe(false)
  })

  it('greets at most once', () => {
    const msgs = burst(['hello chat', 'hey', 'hi everyone'], NOW)
    expect(generateMessage(setup(msgs)).ok).toBe(true)
    expect(generateMessage(setup(msgs, { greeted: true })).ok).toBe(false)
  })

  it('filler only when allowed and chat is active', () => {
    const busy = Array.from({ length: 12 }, (_, i) => chat(`u${i % 5}`, `random talk ${i}`, NOW - 1000 - i * 2000))
    expect(generateMessage(setup(busy)).ok).toBe(false)
    expect(generateMessage(setup(busy, { allowFiller: true })).ok).toBe(true)
    expect(generateMessage(setup([chat('a', 'hi', NOW - 1000)], { allowFiller: true })).ok).toBe(false)
  })
})

describe('message shaping', () => {
  const laugh = burst(['LMAO', 'kekw', 'lol that', 'LULW'], NOW)

  it('only uses emotes that exist in the pool and keeps messages short', () => {
    const pool = emotes()
    const names = new Set(pool.map((e) => e.name))
    for (const personality of ['chill', 'playful', 'supportive', 'gaming', 'emotes'] as Personality[]) {
      for (const density of ['low', 'medium', 'high', 'emote-only'] as EmoteDensity[]) {
        for (let seed = 1; seed <= 25; seed++) {
          const r = generateMessage(setup(laugh, { personality, density, rng: mulberry32(seed) }, pool))
          if (!r.ok) continue
          for (const e of r.emotes) expect(names.has(e)).toBe(true)
          expect(r.text.split(' ').length).toBeLessThanOrEqual(12)
          expect(r.text.length).toBeLessThanOrEqual(120)
          expect(r.text).not.toMatch(/https?:|@/)
        }
      }
    }
  })

  it('emote-only density is ONLY emotes: never a single extra word, for every mood and personality', () => {
    const pool = emotes([...EMOTE_NAMES, 'wsg', 'sup'])
    const names = new Set(pool.map((e) => e.name))
    const chats = {
      laugh: burst(['LMAO', 'kekw', 'lol that', 'LULW'], NOW),
      hype: burst(['LETS GO', 'insane', 'clutch', 'sheesh'], NOW),
      win: burst(['gg', 'ez', 'gz', 'ggs'], NOW),
      loss: burst(['F', 'rip', 'oof', 'unlucky'], NOW),
      shock: burst(['wtf', 'no way', 'omg', 'bruh'], NOW),
      greet: burst(['hello chat', 'hey', 'hi everyone'], NOW),
      wave: burst(['monkaS', 'monkaS', 'monkaS lol', 'monkaS'], NOW)
    }
    let produced = 0
    for (const [mood, chatMsgs] of Object.entries(chats)) {
      for (const personality of ['chill', 'playful', 'supportive', 'gaming', 'emotes'] as Personality[]) {
        for (let seed = 1; seed <= 60; seed++) {
          const r = generateMessage(setup(chatMsgs, { personality, density: 'emote-only', rng: mulberry32(seed) }, pool))
          if (!r.ok) continue
          produced++
          const tokens = r.text.split(' ')
          expect(tokens.every((t) => names.has(t)), `${mood}/${personality}/${seed}: "${r.text}"`).toBe(true)
          expect(r.emoteOnly).toBe(true)
        }
      }
    }
    expect(produced).toBeGreaterThan(500)
  })

  it('low density is mostly text; high density is emote-heavy', () => {
    const count = (density: EmoteDensity) => {
      let withEmote = 0
      for (let seed = 1; seed <= 60; seed++) {
        const input = setup(burst(['gg', 'ez', 'gz', 'ggs'], NOW), { density, rng: mulberry32(seed) })
        const r = generateMessage(input)
        if (r.ok && r.emotes.length) withEmote++
      }
      return withEmote
    }
    expect(count('low')).toBeLessThan(count('high'))
  })

  it('emote-only room forces emote-only output and never text', () => {
    const names = new Set(emotes().map((e) => e.name))
    for (let seed = 1; seed <= 20; seed++) {
      const r = generateMessage(setup(laugh, { roomEmoteOnly: true, rng: mulberry32(seed) }))
      if (r.ok) expect(r.text.split(' ').every((t) => names.has(t))).toBe(true)
    }
  })

  it('never repeats identical messages and does not cycle', () => {
    const history = new MessageHistory()
    const out: string[] = []
    for (let i = 0; i < 35; i++) {
      const r = generateMessage(setup(laugh, { history, rng: mulberry32(100 + i) }))
      if (r.ok) {
        history.record('testchan', r.text, r.templateKey, NOW, r.emoteOnly)
        out.push(r.text)
      }
    }
    expect(out.length).toBeGreaterThan(15)
    expect(new Set(out.map((t) => t.toLowerCase())).size).toBe(out.length)
  })

  it('falls back to text when the channel has no matching emotes', () => {
    const r = generateMessage(setup(burst(['lmao', 'lol', 'haha lol'], NOW), { density: 'high' }, emotes(['SomethingOdd'])))
    expect(r.ok).toBe(true)
  })

  it('refuses emote-only when there are no emotes at all', () => {
    const r = generateMessage(setup(burst(['lmao', 'lol', 'haha lol'], NOW), { density: 'emote-only' }, []))
    expect(r.ok).toBe(false)
  })
})

describe('laugh emote list and Pog filter', () => {
  const laughChat = burst(['LMAO', 'kekw', 'lol that', 'LULW'], NOW)
  const ALLOWED = ['KEKW', 'LMFAO', 'LMAO', 'LOL', 'ROFL', 'LMAOOOOOO', 'LMAOOOOOOOOOO']
  const pool = emotes([...ALLOWED, 'LULW', 'OMEGALUL', 'ICANT', 'Pog', 'PogU', 'POGGERS', 'PogChamp', 'Clap', 'Sadge', 'monkaS'])

  it('laughter is answered only with emotes from the allowed list', () => {
    let withEmote = 0
    for (const personality of ['chill', 'playful', 'gaming', 'emotes'] as Personality[]) {
      for (const density of ['low', 'medium', 'high', 'emote-only'] as EmoteDensity[]) {
        for (let seed = 1; seed <= 40; seed++) {
          const r = generateMessage(setup(laughChat, { personality, density, rng: mulberry32(seed) }, pool))
          if (!r.ok) continue
          for (const e of r.emotes) expect(ALLOWED).toContain(e)
          expect(r.text).not.toMatch(/LULW|OMEGALUL|ICANT/)
          if (r.emotes.length) withEmote++
        }
      }
    }
    expect(withEmote).toBeGreaterThan(100)
  })

  it('no substitutes: a channel without any allowed laugh emote gets text only', () => {
    const noList = emotes(['LULW', 'OMEGALUL', 'ICANT', 'Clap', 'Sadge'])
    for (let seed = 1; seed <= 40; seed++) {
      const r = generateMessage(setup(laughChat, { density: 'high', rng: mulberry32(seed) }, noList))
      if (r.ok) expect(r.emotes).toEqual([])
    }
    const emoteOnly = generateMessage(setup(laughChat, { density: 'emote-only' }, noList))
    expect(emoteOnly.ok).toBe(false)
  })

  it('a wave of another laugh emote is answered with an allowed one, not copied', () => {
    const wave = burst(['OMEGALUL', 'OMEGALUL', 'OMEGALUL', 'OMEGALUL'], NOW)
    for (let seed = 1; seed <= 30; seed++) {
      const r = generateMessage(setup(wave, { density: 'emote-only', rng: mulberry32(seed) }, pool))
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(r.text).not.toContain('OMEGALUL')
        expect(r.emotes.every((e) => ALLOWED.includes(e))).toBe(true)
      }
    }
  })

  it('a wave of an allowed laugh emote is joined as is', () => {
    const r = generateMessage(setup(burst(['LMAO', 'LMAO', 'LMAO', 'LMAO'], NOW), {}, pool))
    expect(r.ok && r.text).toBe('LMAO')
  })

  it("matches the channel's own spelling of an allowed emote", () => {
    const r = generateMessage(setup(laughChat, { density: 'emote-only', rng: mulberry32(3) }, emotes(['Kekw', 'Clap'])))
    expect(r.ok && r.text).toBe('Kekw')
  })

  it('Pog emotes are never used, in any mood, and chat Pog spam is not copied', () => {
    const hype = burst(['POG', 'pogchamp', 'LETS GO', 'insane'], NOW)
    for (const chat of [hype, laughChat, burst(['gg', 'ez', 'gz'], NOW), burst(['PogU', 'PogU', 'PogU', 'PogU'], NOW)]) {
      for (const density of ['medium', 'high', 'emote-only'] as EmoteDensity[]) {
        for (let seed = 1; seed <= 40; seed++) {
          const r = generateMessage(setup(chat, { density, rng: mulberry32(seed) }, pool))
          if (r.ok) expect(r.text).not.toMatch(/pog/i)
        }
      }
    }
  })

  it('the avoid-word list is configurable', () => {
    const picker = new EmotePicker(emotes(['Clap', 'EZ', 'GIGACHAD']), { favorites: [], recent: [], observed: new Map(), blocked, avoidWords: ['clap', 'gigachad'] })
    expect(picker.names()).toEqual(['EZ'])
    const custom = new EmotePicker(emotes(['KEKW', 'LOL']), { favorites: [], recent: [], observed: new Map(), blocked, laughEmotes: ['LOL'] })
    expect(custom.candidates('laugh')).toEqual(['LOL'])
  })
})

describe('one emote per message', () => {
  const laugh = burst(['LMAO', 'kekw', 'lol that', 'LULW'], NOW)
  const withOverlays = [...emotes(), ...['ovA', 'ovB'].map((name, i) => ({ id: `ov${i}`, name, animated: false, source: 'channel' as const, zeroWidth: true }))]
  const normal = new Set(emotes().map((e) => e.name))

  // Chat itself is using the overlay ovA, and the channel has overlays: they are still never used.
  const laughWithOverlay = burst(['LMAO ovA', 'kekw ovA', 'lol that', 'LULW'], NOW)

  it('never posts more than one emote, and never an overlay (zero-width) emote', () => {
    let withEmote = 0
    for (const personality of ['chill', 'playful', 'supportive', 'gaming', 'emotes'] as Personality[]) {
      for (const density of ['low', 'medium', 'high', 'emote-only'] as EmoteDensity[]) {
        for (let seed = 1; seed <= 40; seed++) {
          for (const chatMsgs of [laughWithOverlay, laugh]) {
            const r = generateMessage(setup(chatMsgs, { personality, density, rng: mulberry32(seed) }, withOverlays))
            if (!r.ok) continue
            const tokens = r.text.split(' ')
            expect(tokens.filter((t) => normal.has(t)).length).toBeLessThanOrEqual(1)
            expect(r.text).not.toMatch(/ov[AB]/)
            if (r.emotes.length) withEmote++
          }
        }
      }
    }
    expect(withEmote).toBeGreaterThan(100)
  })

  it('emote waves are copied as a single emote', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const r = generateMessage(setup(burst(['KEKW', 'KEKW', 'KEKW hah', 'KEKW'], NOW), { rng: mulberry32(seed) }, withOverlays))
      expect(r.ok && r.text).toBe('KEKW')
    }
  })

  it('without overlay emotes in the channel, no overlay is ever added', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const r = generateMessage(setup(laugh, { density: 'high', rng: mulberry32(seed) }))
      if (r.ok) expect(r.text).not.toMatch(/ov[AB]/)
    }
  })
})

describe('repeat windows', () => {
  it('lets an emote-only message be reused after 30s, but not before', () => {
    const h = new MessageHistory()
    h.record('c', 'KEKW', 'wave:KEKW', NOW, true)
    expect(h.isDuplicate('c', 'KEKW', NOW + 10_000, true)).toBe(true)
    expect(h.isDuplicate('c', 'KEKW', NOW + 29_999, true)).toBe(true)
    expect(h.isDuplicate('c', 'KEKW', NOW + 30_000, true)).toBe(false)
  })

  it('keeps text lines blocked much longer so they do not look robotic', () => {
    const h = new MessageHistory()
    h.record('c', 'that got me', 'laugh:x', NOW, false)
    expect(h.isDuplicate('c', 'that got me', NOW + 60_000, false)).toBe(true)
    expect(h.isDuplicate('c', 'that got me', NOW + 11 * 60_000, false)).toBe(false)
  })

  it('a wave in the same channel can reuse the same emote 30s later', () => {
    const wave = burst(['KEKW', 'KEKW', 'KEKW hah', 'KEKW'], NOW)
    const history = new MessageHistory()
    const first = generateMessage(setup(wave, { history }))
    expect(first.ok).toBe(true)
    if (first.ok) history.record('testchan', first.text, first.templateKey, NOW, first.emoteOnly)
    const soon = generateMessage(setup(wave, { history }))
    // Inside 30s it never posts the identical message again (it may vary the count instead).
    if (soon.ok && first.ok) expect(soon.text).not.toBe(first.text)
    // 30s later the same emote is fine again (chat is re-timed to stay "fresh").
    const later = NOW + 30_000
    const fresh = burst(['KEKW', 'KEKW', 'KEKW hah', 'KEKW'], later)
    const again = setup(fresh, { history, now: later })
    again.signals = analyzeChat(fresh, { now: later, self: 'me', isKnownEmote: (n) => again.picker.has(n), blocked })
    expect(generateMessage(again).ok).toBe(true)
  })
})

describe('blocked words', () => {
  it('a blocked word never appears in a message, and blocks matching emotes', () => {
    const laughNoLmao = burst(['lol', 'kekw', 'haha lol', 'LULW'], NOW)
    const blockedLmao = makeBlockedTest(['lmao'])
    const pool = emotes(['KEKW', 'LMAO', 'LMFAO', 'LOL', 'Clap'])
    let n = 0
    for (let seed = 1; seed <= 80; seed++) {
      const picker = new EmotePicker(pool, { favorites: [], recent: [], observed: new Map(), blocked: blockedLmao })
      const signals = analyzeChat(laughNoLmao, { now: NOW, self: 'me', isKnownEmote: (x) => picker.has(x), blocked: blockedLmao })
      const r = generateMessage({ ...setup(laughNoLmao, {}, pool), signals, picker, blocked: blockedLmao, rng: mulberry32(seed) })
      if (!r.ok) continue
      n++
      expect(r.text.toLowerCase()).not.toContain('lmao')
    }
    expect(n).toBeGreaterThan(40)
  })

  it('chat containing a blocked word is not reacted to', () => {
    const blockedKekw = makeBlockedTest(['kekw'])
    const chatWithWord = burst(['LMAO', 'kekw', 'lol that', 'LULW'], NOW)
    const picker = new EmotePicker(emotes(), { favorites: [], recent: [], observed: new Map(), blocked: blockedKekw })
    const signals = analyzeChat(chatWithWord, { now: NOW, self: 'me', isKnownEmote: (x) => picker.has(x), blocked: blockedKekw })
    expect(generateMessage({ ...setup(chatWithWord, {}), signals, picker, blocked: blockedKekw }).ok).toBe(false)
  })
})

describe('safety', () => {
  it('keeps an @mention only when explicitly allowed (greeting replies, approved edits)', () => {
    expect(sanitize('@bob hi', { allowMentions: true })).toBe('@bob hi')
    expect(sanitize('@bob hi')).toBe('hi')
  })
  it('strips links and mentions', () => {
    expect(sanitize('hey @someone check https://evil.example/x now')).toBe('hey check now')
    expect(sanitize('go to foo.com/bar')).toBe('go to')
  })
  it('blocks offensive emote names and user block terms', () => {
    const picker = new EmotePicker(emotes(['KEKW', 'badword']), { favorites: [], recent: [], observed: new Map(), blocked: makeBlockedTest(['badword']) })
    expect(picker.has('KEKW')).toBe(true)
    expect(picker.has('badword')).toBe(false)
  })
})
