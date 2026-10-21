import { describe, expect, it } from 'vitest'
import { chooseGreetingReply, containsGreeting, isDirectedGreeting, mentionSet } from '../src/worker/engine/greeting'
import type { Emote } from '../src/shared/types'
import { mulberry32 } from './helpers'

const mentions = mentionSet('someuser', ['sm'])
const emo = (names: string[]): Map<string, Emote> => new Map(names.map((n, i) => [n, { id: `i${i}`, name: n, animated: false, source: 'channel' as const }]))

describe('directed greeting detection', () => {
  it.each([
    'hi someuser',
    'hello @someuser',
    'Hellooo SomeUser',
    'wsg someuser',
    "what's good someuser",
    'whats good someuser',
    'sup sm',
    'yo SM',
    'sup, sm!',
    'someuser hiii',
    'good morning someuser',
    'wsg someuser peepoHappy',
    'heya @SM'
  ])('matches %s', (t) => expect(isDirectedGreeting(t, mentions)).toBe(true))

  it.each([
    'hi chat',
    'hello everyone',
    'someuser is a legend', // mention but no greeting
    'hi smith', // "sm" is only a whole-word match
    'hi someuserxyz',
    'whats the game',
    'chicken sup'.replace('chicken', 'hey').replace('sup', 'there')
  ])('does not match %s', (t) => expect(isDirectedGreeting(t, mentions)).toBe(false))

  it('recognises greeting emotes as greetings', () => {
    expect(containsGreeting('peepoHey')).toBe(true)
    expect(isDirectedGreeting('agahi someuser', mentions)).toBe(true)
  })

  it('without a username or custom mention nothing is directed at us', () => {
    expect(isDirectedGreeting('hi someuser', mentionSet(null, []))).toBe(false)
    expect(isDirectedGreeting('hi dh', mentionSet(null, ['dh']))).toBe(true)
  })
})

describe('greeting reply', () => {
  const list = ['wsg', 'sup', 'hiii', 'agahi', 'hi']
  const base = { replyList: list, recent: [] as string[], rng: mulberry32(1), isDuplicate: () => false }
  const run = (text: string, names: string[], over: Partial<Parameters<typeof chooseGreetingReply>[0]> = {}, personal: string[] = []) =>
    chooseGreetingReply({ ...base, text, usable: emo([...names, ...personal]), ...over })

  it('never uses the emote or word the greeter used, only the greeting list', () => {
    const r = run('hi someuser peepoHappy', ['peepoHappy', 'wsg'])
    expect(r?.name).toBe('wsg') // not their peepoHappy (which isn't in the list anyway)
    // they said wsg: reply with something else from the list
    for (let seed = 1; seed <= 30; seed++) {
      expect(run('wsg someuser', ['wsg', 'sup', 'hiii'], { rng: mulberry32(seed) })?.name).not.toBe('wsg')
    }
    // an emote that is the only one in the list and was used by them: no reply
    expect(run('sup someuser', ['sup'], { replyList: ['sup'] })).toBeNull()
  })

  it('only uses collection emotes that exist, matching case-insensitively, and returns null if none do', () => {
    expect(run('hi someuser', ['Hiii', 'Clap'])?.name).toBe('Hiii')
    expect(run('hi someuser', ['Clap', 'Kappa'])).toBeNull()
  })

  it('rotates through the collection instead of repeating', () => {
    const recent: string[] = []
    const seen: string[] = []
    for (let i = 0; i < 5; i++) {
      const r = run('hello someuser', list, { recent, rng: mulberry32(i + 3) })!
      recent.push(r.name)
      seen.push(r.name)
    }
    expect(new Set(seen).size).toBe(5)
  })

  it('skips duplicates', () => {
    const r = run('hi someuser', ['wsg', 'sup'], { isDuplicate: (n) => n === 'wsg' })
    expect(r?.name).toBe('sup')
  })
})
