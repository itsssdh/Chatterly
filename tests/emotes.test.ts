import { clearNs, ns } from './helpers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EmoteManager } from '../src/worker/emotes/manager'
import { CHANNEL_TTL_MS, SevenTv, parseSet } from '../src/worker/emotes/seventv'
import { ActivityLog } from '../src/worker/logger'

const mk = (id: string, name: string, extra: Record<string, unknown> = {}, flags = 0, dflags = 0) => ({
  id,
  name,
  flags,
  data: { id, name, flags: dflags, animated: false, lifecycle: 3, listed: true, ...extra }
})

const GLOBAL = { name: 'Global', emotes: [mk('A'.repeat(26), 'KEKW'), mk('B'.repeat(26), 'Clap')] }
const CHANNEL = {
  emote_set: {
    name: 'Chan set',
    emotes: [
      mk('C'.repeat(26), 'chanEmote'),
      mk('D'.repeat(26), 'zw', {}, 1), // zero width
      mk('E'.repeat(26), 'spicy', {}, 0, 65536), // sexual content flag
      mk('F'.repeat(26), 'deleted', { lifecycle: 0 }),
      { id: 'G'.repeat(26), name: 'nodata', flags: 0 }
    ]
  }
}

function fakeFetch(routes: Record<string, () => Response>, calls: string[]) {
  return (async (url: string) => {
    calls.push(url)
    const key = Object.keys(routes).find((k) => url.includes(k))
    if (!key) throw new Error('network down')
    return routes[key]()
  }) as unknown as typeof fetch
}
const json = (v: unknown, status = 200) => () => new Response(JSON.stringify(v), { status })

describe('7TV emotes', () => {
  let dir: string
  let clock: number
  beforeEach(() => {
    dir = ns('emotes')
    clock = 1_000_000
  })
  afterEach(() => clearNs(dir))

  it('parses real-shaped sets and keeps zero-width emotes flagged, and drops sexual-flagged, deleted and data-less ones', () => {
    const parsed = parseSet(CHANNEL.emote_set, 'channel')
    expect(parsed.map((e) => e.name)).toEqual(['chanEmote', 'zw'])
    expect(parsed.find((e) => e.name === 'zw')?.zeroWidth).toBe(true)
    expect(parsed.find((e) => e.name === 'chanEmote')?.zeroWidth).toBe(false)
  })

  it('caches to disk and serves from cache within the TTL', async () => {
    const calls: string[] = []
    const api = new SevenTv(dir, new ActivityLog(), fakeFetch({ '/emote-sets/global': json(GLOBAL) }, calls), () => clock)
    const a = await api.getGlobal()
    expect(a.emotes.map((e) => e.name)).toEqual(['KEKW', 'Clap'])
    await api.getGlobal()
    expect(calls.length).toBe(1)
    clock += 7 * 3600_000 // stale
    await api.getGlobal()
    expect(calls.length).toBe(2)
    await api.getGlobal(true) // forced
    expect(calls.length).toBe(3)
  })

  it('falls back to stale cache when 7TV is unreachable, and errors when there is no cache', async () => {
    const calls: string[] = []
    const ok = new SevenTv(dir, new ActivityLog(), fakeFetch({ '/emote-sets/global': json(GLOBAL) }, calls), () => clock)
    await ok.getGlobal()
    clock += 10 * 3600_000
    const down = new SevenTv(dir, new ActivityLog(), fakeFetch({}, calls), () => clock)
    const r = await down.getGlobal()
    expect(r.stale).toBe(true)
    expect(r.emotes.length).toBe(2)
    const empty = new SevenTv(ns('empty'), new ActivityLog(), fakeFetch({}, calls), () => clock)
    await expect(empty.getChannel('123')).rejects.toThrow()
  })

  it('handles channels without a 7TV account (404) and caches the negative result', async () => {
    const calls: string[] = []
    const api = new SevenTv(dir, new ActivityLog(), fakeFetch({ '/users/twitch/': () => new Response('{}', { status: 404 }) }, calls), () => clock)
    const r = await api.getChannel('999')
    expect(r.none).toBe(true)
    await api.getChannel('999')
    expect(calls.length).toBe(1)
    expect(CHANNEL_TTL_MS).toBeGreaterThan(0)
  })

  it('manager merges channel + global emotes (channel wins) and survives missing sets', async () => {
    const calls: string[] = []
    const log = new ActivityLog()
    const api = new SevenTv(
      dir,
      log,
      fakeFetch({ '/emote-sets/global': json(GLOBAL), '/users/twitch/1': json(CHANNEL), '/users/twitch/2': () => new Response('{}', { status: 404 }) }, calls),
      () => clock
    )
    const m = new EmoteManager(api, log)
    await m.loadGlobal()
    await m.loadChannel('one', '1')
    await m.loadChannel('two', '2')
    expect(m.forChannel('one').map((e) => e.name).sort()).toEqual(['Clap', 'KEKW', 'chanEmote', 'zw'])
    expect(m.info('one').status).toBe('ready')
    expect(m.forChannel('two').map((e) => e.name).sort()).toEqual(['Clap', 'KEKW'])
    expect(m.info('two').status).toBe('unavailable')
    expect(m.forChannel('never-seen').length).toBe(2)
  })

  it('the same emote name resolves to a different emote in each channel (channel set overrides global)', async () => {
    const mkSet = (kind: string, ids: Record<string, string>) => ({ name: kind, emotes: Object.entries(ids).map(([name, id]) => mk(id, name)) })
    const G = mkSet('Global', { KEKW: 'G'.repeat(26), Clap: 'g'.repeat(26) })
    const A = { emote_set: mkSet('A', { KEKW: 'A'.repeat(26) }) }
    const B = { emote_set: mkSet('B', { KEKW: 'B'.repeat(26), Clap: 'b'.repeat(26) }) }
    const log = new ActivityLog()
    const api = new SevenTv(dir, log, fakeFetch({ '/emote-sets/global': json(G), '/users/twitch/1': json(A), '/users/twitch/2': json(B), '/users/twitch/3': () => new Response('{}', { status: 404 }) }, []), () => clock)
    const m = new EmoteManager(api, log)
    await m.loadGlobal()
    await m.loadChannel('chana', '1')
    await m.loadChannel('chanb', '2')
    await m.loadChannel('chanc', '3') // no 7TV set: global only
    const id = (login: string, name: string) => m.forChannel(login).find((e) => e.name === name)?.id
    expect(id('chana', 'KEKW')).toBe('A'.repeat(26)) // its own KEKW
    expect(id('chanb', 'KEKW')).toBe('B'.repeat(26)) // a different KEKW
    expect(id('chanc', 'KEKW')).toBe('G'.repeat(26)) // the global one
    expect(id('chana', 'Clap')).toBe('g'.repeat(26)) // no channel Clap: falls back to global
    expect(id('chanb', 'Clap')).toBe('b'.repeat(26))
    // never two entries with the same name in one channel's list
    for (const c of ['chana', 'chanb', 'chanc']) {
      const names = m.forChannel(c).map((e) => e.name)
      expect(new Set(names).size).toBe(names.length)
    }
  })
})

describe('emote loading recovers from a network that is not ready yet', () => {
  it('retries the global set and a channel set with growing delays until they load', async () => {
    const dir = ns('retry')
    let up = false
    let calls = 0
    const f = (async (url: string) => {
      calls++
      if (!up) throw new TypeError('This operation was aborted')
      if (url.includes('/emote-sets/global')) return new Response(JSON.stringify(GLOBAL))
      return new Response(JSON.stringify(CHANNEL))
    }) as unknown as typeof fetch
    const log = new ActivityLog()
    const m = new EmoteManager(new SevenTv(dir, log, f), log, 20)
    await m.loadGlobal()
    await m.loadChannel('chan', '7')
    expect(m.forChannel('chan')).toEqual([])
    const afterFirst = calls
    up = true // the network comes up a moment later
    const t0 = Date.now()
    while (m.forChannel('chan').length === 0 && Date.now() - t0 < 4000) await new Promise((r) => setTimeout(r, 20))
    expect(m.forChannel('chan').map((e) => e.name)).toEqual(expect.arrayContaining(['chanEmote', 'KEKW', 'Clap']))
    expect(m.forChannel('chan').length).toBeGreaterThan(0)
    expect(m.globalEmotes().length).toBe(2)
    expect(calls).toBeGreaterThan(afterFirst)
    m.stop()
    clearNs(dir)
  })
})
