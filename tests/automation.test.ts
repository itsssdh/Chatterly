import { join } from '../src/worker/kv'
import { WebSocketServer, type WebSocket } from 'ws'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Automation } from '../src/worker/automation'
import { EmoteManager } from '../src/worker/emotes/manager'
import { SevenTv } from '../src/worker/emotes/seventv'
import { ActivityLog } from '../src/worker/logger'
import { ConfigStore } from '../src/worker/store'
import { TwitchIrc } from '../src/worker/twitch/irc'
import { DEFAULT_OVERRIDES, type ChannelConfig, type SendMode } from '../src/shared/types'
import { mulberry32, clearNs, ns } from './helpers'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timed out')
    await sleep(10)
  }
}

class MockTwitch {
  wss: WebSocketServer
  received: string[] = []
  sockets: WebSocket[] = []
  nick = ''
  constructor() {
    this.wss = new WebSocketServer({ port: 0 })
    this.wss.on('connection', (ws) => {
      this.sockets.push(ws)
      ws.on('message', (d) => {
        for (const line of d.toString().split('\r\n')) {
          this.received.push(line)
          if (line.startsWith('NICK ')) {
            this.nick = line.slice(5)
            ws.send(`:tmi.twitch.tv 001 ${this.nick} :Welcome, GLHF!`)
          }
          const j = /^JOIN #(\w+)/.exec(line)
          if (j) {
            ws.send(`:${this.nick}!${this.nick}@${this.nick}.tmi.twitch.tv JOIN #${j[1]}`)
            ws.send(`@room-id=${j[1].length * 1111};slow=0;emote-only=0;subs-only=0;followers-only=-1;r9k=0 :tmi.twitch.tv ROOMSTATE #${j[1]}`)
          }
        }
      })
    })
  }
  get url(): string {
    return `ws://127.0.0.1:${(this.wss.address() as { port: number }).port}`
  }
  privmsgs(): string[] {
    return this.received.filter((l) => l.startsWith('PRIVMSG'))
  }
  say(channel: string, user: string, text: string, displayName?: string): void {
    for (const s of this.sockets) s.send(`@id=${Math.random()};user-id=${user}${displayName ? `;display-name=${displayName}` : ''} :${user}!${user}@${user}.tmi.twitch.tv PRIVMSG #${channel} :${text}`)
  }
  notice(channel: string, msgId: string, text: string): void {
    for (const s of this.sockets) s.send(`@msg-id=${msgId} :tmi.twitch.tv NOTICE #${channel} :${text}`)
  }
  close(): void {
    this.wss.close()
  }
}

const SET = {
  name: 'Test set',
  emotes: ['KEKW', 'LULW', 'Pog', 'Clap', 'Sadge', 'wsg', 'sup', 'peepoHey'].map((name, i) => ({
    id: `0123456789ABCDEFGHJK${i}`,
    name,
    data: { id: `0123456789ABCDEFGHJK${i}`, name, animated: false, lifecycle: 3, flags: 0 }
  }))
}

function cfg(login: string, enabled: boolean, allowSend: boolean): ChannelConfig {
  return { login, displayName: login, twitchId: null, enabled, allowSend, onlyWhenLive: true, blocklist: [], overrides: { ...DEFAULT_OVERRIDES }, addedAt: 0 }
}

describe('automation against a mock Twitch chat server', () => {
  let dir: string
  let server: MockTwitch
  let clock: number
  let irc: TwitchIrc
  let auto: Automation
  let store: ConfigStore
  let authed: boolean

  const now = () => clock

  async function boot(mode: SendMode, loggedIn: boolean, fetchOverride?: typeof fetch) {
    authed = loggedIn
    store.settings.sendMode = mode
    store.settings.pacing = { ...store.settings.pacing, reactChance: 1, globalGapSec: 0, maxPerSession: 50, maxPerChannel: 50 }
    const log = new ActivityLog()
    const emotes = new EmoteManager(
      new SevenTv(join(dir, 'emotes'), log, fetchOverride ?? ((async () => new Response(JSON.stringify(SET))) as unknown as typeof fetch)),
      log
    )
    await emotes.loadGlobal()
    irc = new TwitchIrc({ url: server.url, log, now, baseBackoffMs: 20, joinGapMs: 5 })
    auto = new Automation({
      store,
      log,
      irc,
      emotes,
      getIrcAuth: async () => (authed ? { login: 'me', token: 'tok' } : null),
      authState: () => ({ status: 'logged-out', clientIdSet: false }),
      onAuthRejected: () => {},
      onRoomId: () => {},
      rng: mulberry32(11),
      now
    })
    await auto.start()
    await waitFor(() => auto.snapshot().channels.filter((c) => c.conn === 'joined').length === store.channels.filter((c) => c.enabled).length)
    return { log, emotes }
  }

  /** Feed a laughing chat to every channel, jump past the initial wait, and run the scheduler. */
  async function laughAndTick(channels: string[], rounds = 3) {
    for (let r = 0; r < rounds; r++) {
      clock += 90_000
      for (const c of channels) {
        for (let u = 0; u < 4; u++) server.say(c, `viewer${u}`, ['LMAO', 'kekw', 'lol', 'LULW'][u])
      }
      await sleep(60)
      auto.tick()
      auto.tick()
    }
  }

  /** Auto mode with alpha live and the connection guard off, so tests can drive the engine quickly. */
  async function bootAuto(fetchOverride?: typeof fetch) {
    const r = await boot('auto', true, fetchOverride)
    store.settings.pacing = { ...store.settings.pacing, guardMinGapSec: 0, guardMaxPer30s: 0 }
    auto.onSettingsChanged()
    auto.setStream('alpha', { live: 'live' })
    return r
  }

  beforeEach(() => {
    dir = ns('test')
    server = new MockTwitch()
    clock = 1_700_000_000_000
    store = new ConfigStore(dir)
    store.channels = [cfg('alpha', true, true), cfg('bravo', true, false), cfg('charlie', false, true)]
  })

  afterEach(() => {
    auto?.dispose()
    irc?.disconnect()
    server.close()
    clearNs(dir)
  })

  it('approval mode never sends anything on its own, and only queues messages for channels allowed to send', async () => {
    await boot('approval', true)
    auto.setStream('alpha', { live: 'live' })
    auto.setStream('bravo', { live: 'live' })
    await laughAndTick(['alpha', 'bravo', 'charlie'], 2)
    expect(server.privmsgs()).toEqual([])
    const snap = auto.snapshot()
    expect(snap.counters.sentSession).toBe(0)
    expect(snap.pending.map((p) => p.channel)).toEqual(['alpha']) // bravo: not allowed to send, charlie: disabled
  })

  it('auto mode sends only to channels that are enabled AND allowed, and only while live', async () => {
    await boot('auto', true)
    // Not live yet -> nothing may be sent anywhere.
    await laughAndTick(['alpha', 'bravo', 'charlie'], 2)
    expect(server.privmsgs()).toEqual([])

    auto.setStream('alpha', { live: 'live' })
    auto.setStream('bravo', { live: 'live' })
    auto.setStream('charlie', { live: 'live' })
    await laughAndTick(['alpha', 'bravo', 'charlie'], 4)
    const sent = server.privmsgs()
    expect(sent.length).toBeGreaterThan(0)
    expect(sent.every((l) => l.startsWith('PRIVMSG #alpha '))).toBe(true) // bravo: not allowed, charlie: disabled
    expect(server.received.some((l) => l.startsWith('JOIN #charlie'))).toBe(false)
  })

  it('emits a "sent" event for every real send , tagged with the account', async () => {
    await boot('auto', true)
    const events: { account: string; channel: string; text: string }[] = []
    auto.on('sent', (m) => events.push(m))
    auto.setStream('alpha', { live: 'live' })
    await laughAndTick(['alpha'], 3)
    await sleep(50)
    expect(events.length).toBeGreaterThan(0)
    expect(events.length).toBe(server.privmsgs().length)
    expect(events.every((e) => e.account === 'me' && e.channel === 'alpha')).toBe(true)
    expect(server.privmsgs()[0]).toBe(`PRIVMSG #alpha :${events[0].text}`)
  })

  it('approval mode emits "sent" only once you approve', async () => {
    await boot('approval', true)
    let n = 0
    auto.on('sent', () => n++)
    auto.setStream('alpha', { live: 'live' })
    await laughAndTick(['alpha'], 2)
    expect(n).toBe(0)
    expect(auto.approve(auto.snapshot().pending[0].id).ok).toBe(true)
    expect(n).toBe(1)
  })

  it('leaves offline channels alone: nothing generated, queued or logged while "Only when live" is on', async () => {
    const { log } = await boot('approval', true)
    auto.setStream('alpha', { live: 'offline' })
    await laughAndTick(['alpha'], 3)
    expect(auto.snapshot().pending).toEqual([])
    expect(auto.snapshot().counters.skippedSession).toBe(0)
    expect(log.all().filter((e) => e.channel === 'alpha' && (e.kind === 'skipped' || e.kind === 'pending'))).toEqual([])
    // once it goes live it is handled normally
    auto.setStream('alpha', { live: 'live' })
    await laughAndTick(['alpha'], 2)
    expect(auto.snapshot().pending.length).toBe(1)
  })

  it('a channel set to chat while offline ("Only when live" off) is still handled when offline', async () => {
    store.channels[0].onlyWhenLive = false
    await boot('approval', true)
    auto.setStream('alpha', { live: 'offline' })
    await laughAndTick(['alpha'], 2)
    expect(auto.snapshot().pending.length).toBe(1)
  })

  it('offline channels get no greeting replies either, and nothing is logged about them', async () => {
    const { log } = await bootAuto()
    auto.setStream('alpha', { live: 'offline' })
    server.say('alpha', 'bob', 'hi me')
    await sleep(60)
    clock += 500
    auto.tick()
    expect(server.privmsgs()).toEqual([])
    expect(log.all().some((e) => e.channel === 'alpha' && (e.kind === 'skipped' || /greeted you/.test(e.reason)))).toBe(false)
  })

  it("a channel's own blocked words apply only to that channel", async () => {
    store.channels = [cfg('alpha', true, true), cfg('bravo', true, true)]
    store.channels[0].blocklist = ['kekw'] // alpha: chat that says "kekw" is off limits
    await boot('auto', true)
    auto.setStream('alpha', { live: 'live' })
    auto.setStream('bravo', { live: 'live' })
    await laughAndTick(['alpha', 'bravo'], 3)
    const out = server.privmsgs()
    expect(out.some((l) => l.startsWith('PRIVMSG #bravo '))).toBe(true) // bravo has no such list
    expect(out.some((l) => l.startsWith('PRIVMSG #alpha '))).toBe(false)
  })

  it("an approval edit containing a channel's blocked word is refused", async () => {
    store.channels[0].blocklist = ['badword']
    await boot('approval', true)
    auto.setStream('alpha', { live: 'live' })
    await laughAndTick(['alpha'], 2)
    const p = auto.snapshot().pending[0]
    const r = auto.approve(p.id, 'this has a BadWord inside')
    expect(r.ok).toBe(false)
    expect(server.privmsgs()).toEqual([])
  })

  it('every enabled, allowed, live channel is used at the same time (no channel crowds out another)', async () => {
    store.channels = ['a', 'b', 'c', 'd', 'e'].map((l) => cfg(l, true, true))
    await bootAuto()
    for (const l of ['a', 'b', 'c', 'd', 'e']) auto.setStream(l, { live: 'live' })
    await laughAndTick(['a', 'b', 'c', 'd', 'e'], 3)
    const who = new Set(server.privmsgs().map((l) => /^PRIVMSG #(\w+) /.exec(l)![1]))
    expect([...who].sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('feed entries are short ("Sent"), with the full explanation kept as detail', async () => {
    const { log } = await bootAuto()
    await laughAndTick(['alpha'], 2)
    const sent = log.all().find((e) => e.kind === 'sent')!
    expect(sent.reason).toBe('Sent')
    expect(sent.detail).toMatch(/chatters/)
    const pend = (await (async () => {
      auto.stop()
      return log.all().filter((e) => e.kind === 'pending')
    })())
    expect(pend.every((e) => e.reason === 'Needs approval')).toBe(true)
  })

  it('read-only (not logged in) never sends even in auto mode', async () => {
    await boot('auto', false)
    auto.setStream('alpha', { live: 'live' })
    await laughAndTick(['alpha'], 4)
    expect(server.privmsgs()).toEqual([])
  })

  it('approval mode holds messages until approved, then sends exactly that one', async () => {
    await boot('approval', true)
    auto.setStream('alpha', { live: 'live' })
    await laughAndTick(['alpha'], 2)
    expect(server.privmsgs()).toEqual([])
    const pending = auto.snapshot().pending
    expect(pending.length).toBe(1)
    const res = auto.approve(pending[0].id)
    expect(res.ok).toBe(true)
    await waitFor(() => server.privmsgs().length === 1)
    expect(server.privmsgs()[0]).toBe(`PRIVMSG #alpha :${pending[0].text}`)
    expect(auto.snapshot().pending.length).toBe(0)
  })

  it('pausing blocks even a message you already approved, until resumed', async () => {
    await boot('approval', true)
    auto.setStream('alpha', { live: 'live' })
    await laughAndTick(['alpha'], 2)
    const pending = auto.snapshot().pending
    expect(pending.length).toBe(1)
    auto.pause()
    expect(auto.approve(pending[0].id).ok).toBe(false)
    await sleep(50)
    expect(server.privmsgs()).toEqual([])
    auto.resume()
    expect(auto.approve(pending[0].id).ok).toBe(true)
    await waitFor(() => server.privmsgs().length === 1)
  })

  it('a rejected suggestion uses up the normal spacing instead of being replaced instantly', async () => {
    await boot('approval', true)
    auto.setStream('alpha', { live: 'live' })
    await laughAndTick(['alpha'], 2)
    const first = auto.snapshot().pending[0]
    expect(first).toBeTruthy()
    auto.reject(first.id)
    // chat is still laughing right now, but a new suggestion must wait for the normal delay
    for (let u = 0; u < 4; u++) server.say('alpha', `viewer${u}`, ['LMAO', 'kekw', 'lol', 'LULW'][u])
    await sleep(60)
    clock += 500
    auto.tick()
    auto.tick()
    expect(auto.snapshot().pending).toEqual([])
    // after the usual delay it suggests again
    await laughAndTick(['alpha'], 3)
    expect(auto.snapshot().pending.length).toBe(1)
  })

  it('raising a per-channel limit takes effect without restarting; the session-limit banner explains a pause', async () => {
    store.settings.pacing.maxPerChannel = 1
    await bootAuto()
    store.settings.pacing = { ...store.settings.pacing, maxPerChannel: 1, maxPerSession: 1 }
    await laughAndTick(['alpha'], 4)
    expect(server.privmsgs().length).toBe(1)
    expect(auto.snapshot().automation.state).toBe('paused') // session limit
    expect(auto.snapshot().warnings.join(' ')).toMatch(/Session limit/)
    store.settings.pacing = { ...store.settings.pacing, maxPerChannel: 5, maxPerSession: 5 }
    auto.onSettingsChanged()
    expect(auto.snapshot().warnings.join(' ')).not.toMatch(/Session limit/)
    auto.resume()
    await laughAndTick(['alpha'], 3)
    expect(server.privmsgs().length).toBeGreaterThan(1)
  })

  it('Stop pressed while Start is still connecting leaves nothing connected', async () => {
    await boot('approval', true)
    auto.stop()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    ;(auto as unknown as { deps: { getIrcAuth: () => Promise<unknown> } }).deps.getIrcAuth = async () => {
      await gate
      return { login: 'me', token: 'tok' }
    }
    const starting = auto.start()
    await sleep(20)
    auto.stop() // user stops before the login finished loading
    release()
    await starting
    await sleep(150)
    expect(irc.status).toBe('disconnected')
    expect(auto.snapshot().automation.state).toBe('stopped')
  })

  it('switching to auto discards messages still waiting for approval', async () => {
    await boot('approval', true)
    auto.setStream('alpha', { live: 'live' })
    await laughAndTick(['alpha'], 2)
    expect(auto.snapshot().pending.length).toBe(1)
    store.settings.sendMode = 'auto'
    auto.onSettingsChanged()
    expect(auto.snapshot().pending.length).toBe(0)
  })

  it('a rate-limit notice halts sending and backs off', async () => {
    await boot('auto', true)
    auto.setStream('alpha', { live: 'live' })
    await laughAndTick(['alpha'], 2)
    const before = server.privmsgs().length
    expect(before).toBeGreaterThan(0)
    server.notice('alpha', 'msg_ratelimit', 'too fast')
    await sleep(50)
    expect(auto.snapshot().globalBackoffUntil).toBeGreaterThan(0)
    await laughAndTick(['alpha'], 1) // 90s later: still inside the 2 minute backoff
    expect(server.privmsgs().length).toBe(before)
  })

  it('a ban notice halts the channel until resumed', async () => {
    await boot('auto', true)
    auto.setStream('alpha', { live: 'live' })
    server.notice('alpha', 'msg_banned', 'You are permanently banned from talking in alpha.')
    await sleep(50)
    expect(auto.snapshot().channels.find((c) => c.login === 'alpha')?.halted).toBe(true)
    await laughAndTick(['alpha'], 3)
    expect(server.privmsgs()).toEqual([])
  })

  it('per-channel stop prevents generation; pause stops everything', async () => {
    await bootAuto()
    auto.haltChannel('alpha', 'test')
    auto.haltChannel('bravo', 'test')
    await laughAndTick(['alpha', 'bravo'], 3)
    expect(auto.snapshot().counters.sentSession).toBe(0)
    auto.resumeChannel('alpha')
    auto.pause()
    await laughAndTick(['alpha'], 3)
    expect(auto.snapshot().counters.sentSession).toBe(0)
    auto.resume()
    await laughAndTick(['alpha'], 3)
    expect(auto.snapshot().counters.sentSession).toBeGreaterThan(0)
  })

  it('respects the per-channel message limit', async () => {
    store.settings.pacing.maxPerChannel = 2
    await bootAuto()
    store.settings.pacing = { ...store.settings.pacing, maxPerChannel: 2 }
    await laughAndTick(['alpha'], 8)
    expect(auto.snapshot().channels.find((c) => c.login === 'alpha')?.sent).toBeLessThanOrEqual(2)
  })

  it('with zero delays and the guard off, messages go out back-to-back', async () => {
    store.settings.pacing = { ...store.settings.pacing, minDelaySec: 0, maxDelaySec: 0, cooldownSec: 0, globalGapSec: 0, guardMinGapSec: 0, guardMaxPer30s: 0, maxPerReaction: 0 }
    await boot('auto', true)
    store.settings.pacing = { ...store.settings.pacing, minDelaySec: 0, maxDelaySec: 0, cooldownSec: 0, globalGapSec: 0, guardMinGapSec: 0, guardMaxPer30s: 0, maxPerReaction: 0 }
    auto.onSettingsChanged()
    auto.setStream('alpha', { live: 'live' })
    for (let r = 0; r < 6; r++) {
      clock += 1000 // one second apart, far inside the default guard
      for (let u = 0; u < 4; u++) server.say('alpha', `viewer${u}`, ['LMAO', 'kekw', 'lol', 'LULW'][u])
      await sleep(40)
      auto.tick()
    }
    await sleep(50)
    expect(server.privmsgs().length).toBeGreaterThanOrEqual(4)
  })

  it('reconnects after the server drops the connection and rejoins channels', async () => {
    await bootAuto()
    for (const s of server.sockets) s.terminate()
    await waitFor(() => irc.status === 'reconnecting' || irc.status === 'connecting', 1000)
    await waitFor(() => server.received.filter((l) => l.startsWith('JOIN #alpha')).length >= 2, 4000)
    expect(irc.status).toBe('connected')
  })

  it('one ongoing moment gets at most 3 messages in a row, then the channel rests', async () => {
    // Tiny delays would otherwise let the bot answer a single moment every second.
    const fast = { minDelaySec: 0, maxDelaySec: 0, cooldownSec: 0, globalGapSec: 0, reactChance: 1 }
    store.settings.pacing = { ...store.settings.pacing, ...fast }
    await bootAuto()
    store.settings.pacing = { ...store.settings.pacing, ...fast, maxPerReaction: 3, reactionRestSec: 120 }
    const spam = async (seconds: number) => {
      for (let i = 0; i < seconds; i++) {
        clock += 1000
        for (let u = 0; u < 4; u++) server.say('alpha', `viewer${u}`, ['LMAO', 'kekw', 'lol', 'LULW'][u])
        await sleep(15)
        auto.tick()
      }
    }
    await spam(60) // a whole minute of continuous laughing
    const sentCount = () => auto.snapshot().channels.find((c) => c.login === 'alpha')!.sent
    expect(sentCount()).toBe(3)
    await spam(50) // 110 s in: still inside the 120 s rest period
    expect(sentCount()).toBe(3)
    await spam(60) // rest is over: a new reaction may start, again capped at 3
    expect(sentCount()).toBeGreaterThan(3)
    expect(sentCount()).toBeLessThanOrEqual(6)
  })

  describe('greetings aimed at the logged-in account', () => {
    const sentCount = () => auto.snapshot().channels.find((c) => c.login === 'alpha')!.sent
    const feed = async (lines: [string, string][]) => {
      for (const [u, t] of lines) server.say('alpha', u, t)
      await sleep(60)
      clock += 500
      auto.tick()
    }
    const lastSent = (log: ActivityLog) => [...log.all()].reverse().find((e) => e.kind === 'sent')

    it('answers "hi <username>" with an emote from the greeting list, never text', async () => {
      const { log } = await bootAuto()
      await feed([['bob', 'hi me']])
      expect(sentCount()).toBe(1)
      const e = lastSent(log)!
      expect(e.text).toMatch(/^@bob (wsg|sup)$/) // mentions the greeter; the channel has wsg and sup, not hiii/agahi/hi
      expect(e.reason).toBe('Sent') // the feed line is short
      expect(e.detail).toMatch(/greeted you/) // the explanation is still kept
    })

    it('never repeats the emote the greeter used', async () => {
      const { log } = await bootAuto()
      await feed([['bob', 'wsg me peepoHey']])
      const text = lastSent(log)?.text ?? ''
      expect(text).toMatch(/^@bob sup$/) // the channel has wsg and sup from the list; wsg was theirs
      expect(text).not.toContain('peepoHey')
    })

    it('honours custom mentions and ignores greetings that are not about us', async () => {
      store.settings.customMentions = ['nick']
      const { log } = await bootAuto()
      await feed([['a', 'hello chat'], ['b', 'hi everyone'], ['c', 'me is cool'], ['d', 'sup nickname']])
      expect(sentCount()).toBe(0)
      await feed([['e', 'sup Nick']])
      expect(sentCount()).toBe(1)
      expect(lastSent(log)).toBeTruthy()
    })

    it('does not answer the same person twice within the cooldown, and can be switched off', async () => {
      await bootAuto()
      await feed([['bob', 'hi me']])
      await feed([['bob', 'hey me again']])
      expect(sentCount()).toBe(1)
      clock += 301_000
      await feed([['bob', 'yo me']])
      expect(sentCount()).toBe(2)
      store.settings.answerGreetings = false
      await feed([['carl', 'hi me']])
      expect(sentCount()).toBe(2)
    })

    it('is answered even while the reaction cap is exhausted', async () => {
      store.settings.pacing = { ...store.settings.pacing, maxPerReaction: 1, reactionRestSec: 120 }
      await bootAuto()
      store.settings.pacing = { ...store.settings.pacing, maxPerReaction: 1, reactionRestSec: 120 }
      await laughAndTick(['alpha'], 1)
      expect(sentCount()).toBe(1)
      await laughAndTick(['alpha'], 1) // 90 s later: inside the 120 s rest, reactions are held back
      expect(sentCount()).toBe(1)
      await feed([['bob', 'hi me']])
      expect(sentCount()).toBe(2)
      expect(server.privmsgs().at(-1)).toMatch(/^PRIVMSG #alpha :@bob (wsg|sup)$/)
    })

    it('is answered in approval mode even while another message is waiting for approval', async () => {
      await boot('approval', true)
      auto.setStream('alpha', { live: 'live' })
      await laughAndTick(['alpha'], 1)
      expect(auto.snapshot().pending.length).toBe(1)
      await feed([['bob', 'hello me']])
      const pending = auto.snapshot().pending
      expect(pending.length).toBe(2)
      expect(pending.some((p) => /^@bob (wsg|sup)$/.test(p.text))).toBe(true)
    })

    it('@-mentions the greeter by display name, or by login when the display name is not plain', async () => {
      const { log } = await bootAuto()
      server.say('alpha', 'bob_smith', 'hi me', 'Bob_Smith')
      await sleep(60)
      clock += 500
      auto.tick()
      expect(lastSent(log)?.text).toMatch(/^@Bob_Smith (wsg|sup)$/)
      server.say('alpha', 'carl', 'hello me', 'Cärl')
      await sleep(60)
      clock += 500
      auto.tick()
      expect(lastSent(log)?.text).toMatch(/^@carl (wsg|sup)$/)
    })

    it('an approval edit may keep the @mention (other messages never contain one)', async () => {
      await boot('approval', true)
      auto.setStream('alpha', { live: 'live' })
      await feed([['bob', 'hi me']])
      const p = auto.snapshot().pending[0]
      expect(p.text).toMatch(/^@bob (wsg|sup)$/)
      expect(auto.approve(p.id, '@bob heyyy').ok).toBe(true)
      await waitFor(() => server.privmsgs().length === 1)
      expect(server.privmsgs()[0]).toBe('PRIVMSG #alpha :@bob heyyy')
    })

    it('also answers a greeting typed from your own account in another window', async () => {
      await bootAuto()
      await feed([['me', 'hi me']])
      expect(sentCount()).toBe(1)
    })

    it('logs what it heard, and reports a greeting it could not answer instead of dropping it silently', async () => {
      const { log } = await bootAuto()
      server.notice('alpha', 'msg_ratelimit', 'too fast')
      await sleep(50)
      await feed([['bob', 'hi me']])
      expect(sentCount()).toBe(0)
      expect(log.all().some((e) => /greeted you/.test(e.reason))).toBe(true)
      clock += 31_000
      auto.tick()
      expect(log.all().some((e) => /greeting went unanswered \(backing off/.test(e.reason))).toBe(true)
    })

    it('uses the 7TV personal set so "hi" works in a channel that lacks it', async () => {
      const personalFetch = (async (url: string) => {
        if (url.includes('/users/twitch/')) return new Response(JSON.stringify({ user: { emote_sets: [{ id: 'PERS', flags: 4 }, { id: 'OTHER', flags: 0 }] } }))
        if (url.includes('/emote-sets/PERS')) {
          return new Response(JSON.stringify({ name: 'Alright', flags: 4, emotes: [{ id: 'P'.repeat(26), name: 'hi', flags: 0, data: { id: 'P'.repeat(26), name: 'hi', flags: 0, animated: false, lifecycle: 3 } }] }))
        }
        return new Response(JSON.stringify({ name: 'g', emotes: [{ id: 'C'.repeat(26), name: 'Clap', data: { id: 'C'.repeat(26), name: 'Clap', animated: false, lifecycle: 3, flags: 0 } }] }))
      }) as unknown as typeof fetch
      const { log, emotes } = await bootAuto(personalFetch)
      await emotes.loadPersonal('99')
      expect(emotes.personalEmotes().map((e) => e.name)).toEqual(['hi'])
      expect(emotes.forChannel('alpha').some((e) => e.name === 'hi')).toBe(false) // personal emotes aren't channel emotes
      await feed([['bob', 'hello me']])
      expect(lastSent(log)?.text).toBe('@bob hi')
    })

    it('says nothing when none of the greeting emotes exist in the channel', async () => {
      store.settings.greetingReplyEmotes = ['nonexistent1', 'nonexistent2']
      await bootAuto()
      await feed([['bob', 'hi me']])
      expect(sentCount()).toBe(0)
    })

    it('in auto mode the reply is really sent, only to allowed live channels', async () => {
      await boot('auto', true)
      auto.setStream('alpha', { live: 'live' })
      auto.setStream('bravo', { live: 'live' })
      for (const ch of ['alpha', 'bravo']) server.say(ch, 'bob', 'hi me')
      await sleep(60)
      clock += 500
      auto.tick()
      await sleep(60)
      const sent = server.privmsgs()
      expect(sent.length).toBe(1)
      expect(sent[0]).toMatch(/^PRIVMSG #alpha :@bob (wsg|sup)$/)
    })
  })

  it('reconnects with a freshly fetched token, not the one from the first connection', async () => {
    await bootAuto()
    let n = 0
    irc.setAuthProvider(async () => ({ login: 'me', token: `renewed${++n}` }))
    for (const sk of server.sockets) sk.terminate()
    await waitFor(() => server.received.some((l) => l === 'PASS oauth:renewed1'), 4000)
    expect(server.received.filter((l) => l === 'PASS oauth:tok').length).toBe(1)
  })

  it('the IRC layer itself refuses command-like text and rapid-fire sends', async () => {
    await boot('auto', true)
    expect(irc.say('alpha', '/ban someone').ok).toBe(false)
    expect(irc.say('alpha', '.me waves').ok).toBe(false)
    expect(irc.say('alpha', 'hello').ok).toBe(true)
    expect(irc.say('alpha', 'hello again').ok).toBe(false) // < 5 s since last
    expect(irc.say('charlie', 'hi').ok).toBe(false) // not joined
  })
})
