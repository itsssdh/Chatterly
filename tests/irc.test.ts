import { WebSocketServer, type WebSocket } from 'ws'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TwitchIrc } from '../src/worker/twitch/irc'
import { parseIrc, toChatMessage } from '../src/worker/twitch/parser'
import { mulberry32 } from './helpers'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timed out')
    await sleep(10)
  }
}

describe('parser robustness', () => {
  it('never throws on garbage, and never yields a message from junk', () => {
    const rng = mulberry32(99)
    const alphabet = ['@', ':', ' ', ';', '=', '\\', 'PRIVMSG', '#', '\u0001', 'ACTION', '\r', '\n', 'a', 'é', '😀', '\u0000', '!', 'tags', 'emotes=', '0-3', ',', '/', '999999-1']
    for (let i = 0; i < 20_000; i++) {
      const line = Array.from({ length: Math.floor(rng() * 30) }, () => alphabet[Math.floor(rng() * alphabet.length)]).join('')
      expect(() => {
        const m = parseIrc(line)
        if (m) toChatMessage(m, 1)
      }).not.toThrow()
    }
    expect(parseIrc('')).toBeNull()
    expect(parseIrc('@only=tags')).toBeNull()
  })

  it('handles emote ranges that are out of bounds or reversed', () => {
    const m = parseIrc('@emotes=25:0-4,99-120/1902:50-3 :u!u@u.tmi.twitch.tv PRIVMSG #c :Kappa hi')!
    const c = toChatMessage(m, 1)!
    expect(c.text).toBe('Kappa hi')
    expect(c.nativeEmotes.every((e) => typeof e === 'string')).toBe(true)
  })
})

describe('IRC client against a misbehaving server', () => {
  let wss: WebSocketServer
  let socks: WebSocket[]
  let received: string[]
  let onConn: (ws: WebSocket) => void
  let irc: TwitchIrc
  const url = () => `ws://127.0.0.1:${(wss.address() as { port: number }).port}`

  beforeEach(() => {
    socks = []
    received = []
    onConn = (ws) => {
      let nick = ''
      ws.on('message', (d) => {
        for (const line of d.toString().split('\r\n')) {
          received.push(line)
          if (line.startsWith('NICK ')) {
            nick = line.slice(5)
            ws.send(`:tmi.twitch.tv 001 ${nick} :Welcome`)
          }
          const j = /^JOIN #(\w+)/.exec(line)
          if (j) {
            ws.send(`:${nick}!${nick}@${nick}.tmi.twitch.tv JOIN #${j[1]}`) // Twitch echoes the join
            ws.send(`@room-id=5 :tmi.twitch.tv ROOMSTATE #${j[1]}`)
          }
        }
      })
    }
    wss = new WebSocketServer({ port: 0 })
    wss.on('connection', (ws) => {
      socks.push(ws)
      onConn(ws)
    })
  })
  afterEach(() => {
    irc?.disconnect()
    wss.close()
  })

  const make = () => (irc = new TwitchIrc({ url: url(), baseBackoffMs: 20, maxBackoffMs: 200, joinGapMs: 1, rng: () => 0.5 }))

  it('survives junk lines, a huge line and binary frames, and keeps working', async () => {
    make()
    const got: string[] = []
    irc.on('message', (m) => got.push(m.text))
    irc.connect(null)
    await waitFor(() => irc.status === 'connected')
    irc.join('chan')
    await waitFor(() => received.some((l) => l.startsWith('JOIN #chan')))
    const s = socks[0]
    s.send(':weird\r\n@\r\n:: ::\r\nPRIVMSG\r\n@x=y\r\n' + ':x!x@x PRIVMSG #chan :' + 'A'.repeat(500_000) + '\r\n')
    s.send(Buffer.from([0, 1, 2, 255, 254]))
    s.send(':ok!ok@ok.tmi.twitch.tv PRIVMSG #chan :still alive\r\n')
    await waitFor(() => got.includes('still alive'))
    expect(irc.status).toBe('connected')
  })

  it('answers PING, and reconnects immediately when the server says RECONNECT', async () => {
    make()
    irc.connect(null)
    await waitFor(() => irc.status === 'connected')
    socks[0].send('PING :tmi.twitch.tv\r\n')
    await waitFor(() => received.includes('PONG :tmi.twitch.tv'))
    irc.join('chan')
    await waitFor(() => received.filter((l) => l.startsWith('JOIN #chan')).length === 1)
    socks[0].send(':tmi.twitch.tv RECONNECT\r\n')
    await waitFor(() => socks.length >= 2)
    await waitFor(() => received.filter((l) => l.startsWith('JOIN #chan')).length === 2) // rejoined after reconnecting
    expect(irc.status).toBe('connected')
  })

  it('an authentication failure is reported once and does not cause a reconnect loop', async () => {
    onConn = (ws) => {
      ws.on('message', (d) => {
        if (d.toString().includes('NICK ')) ws.send(':tmi.twitch.tv NOTICE * :Login authentication failed\r\n')
      })
    }
    make()
    let failed = 0
    irc.on('authfailed', () => failed++)
    irc.connect({ login: 'me', token: 'bad' })
    await waitFor(() => failed === 1)
    await sleep(400)
    expect(failed).toBe(1)
    expect(socks.length).toBe(1) // no retries with a rejected token
    expect(irc.status).toBe('disconnected')
  })

  it('backs off between reconnects when the server keeps dropping us, and stops for good after disconnect()', async () => {
    onConn = (ws) => ws.close()
    make()
    const times: number[] = []
    wss.on('connection', () => times.push(Date.now()))
    irc.connect(null)
    await waitFor(() => times.length >= 4, 5000)
    const gaps = times.slice(1).map((t, i) => t - times[i])
    expect(gaps[gaps.length - 1]).toBeGreaterThanOrEqual(gaps[0]) // backoff grows (or stays at the cap)
    irc.disconnect()
    const n = times.length
    await sleep(500)
    expect(times.length).toBe(n) // nothing reconnects after an intentional disconnect
  })

  it('joins queued before the connection is up are sent once connected, exactly once each', async () => {
    make()
    irc.join('one')
    irc.join('two')
    irc.join('one')
    irc.connect(null)
    await waitFor(() => received.some((l) => l.startsWith('JOIN #two')))
    expect(received.filter((l) => l.startsWith('JOIN #one')).length).toBe(1)
    irc.part('two')
    await waitFor(() => received.some((l) => l === 'PART #two'))
  })

  it('say() refuses while disconnected, mid-reconnect, or for channels it has not joined', async () => {
    make()
    expect(irc.say('chan', 'hi').ok).toBe(false)
    irc.connect({ login: 'me', token: 't' })
    await waitFor(() => irc.status === 'connected')
    expect(irc.say('chan', 'hi').ok).toBe(false) // not joined yet
    irc.join('chan')
    await waitFor(() => irc.isJoined('chan'))
    expect(irc.say('chan', 'hi there').ok).toBe(true)
    socks[0].terminate()
    await waitFor(() => irc.status !== 'connected')
    expect(irc.say('chan', 'again').ok).toBe(false)
  })
})

describe('channels are only joined if currently wanted', () => {
  it('after disconnect(), a channel dropped from the list is not rejoined on the next connect', async () => {
    const wss = new WebSocketServer({ port: 0 })
    const joins: string[] = []
    wss.on('connection', (ws) => {
      let nick = ''
      ws.on('message', (d) => {
        for (const line of d.toString().split('\r\n')) {
          if (line.startsWith('NICK ')) {
            nick = line.slice(5)
            ws.send(`:tmi.twitch.tv 001 ${nick} :Welcome`)
          }
          const j = /^JOIN #(\w+)/.exec(line)
          if (j) {
            joins.push(j[1])
            ws.send(`:${nick}!${nick}@${nick}.tmi.twitch.tv JOIN #${j[1]}`)
          }
        }
      })
    })
    const irc = new TwitchIrc({ url: `ws://127.0.0.1:${(wss.address() as { port: number }).port}`, joinGapMs: 1 })
    irc.connect(null)
    await waitFor(() => irc.status === 'connected')
    irc.join('keep')
    irc.join('dropped')
    await waitFor(() => joins.length === 2)
    irc.disconnect() // Stop
    joins.length = 0
    irc.connect(null) // Start again; the host only re-joins what is still enabled
    await waitFor(() => irc.status === 'connected')
    irc.join('keep')
    await sleep(300)
    expect(joins).toEqual(['keep'])
    irc.disconnect()
    wss.close()
  })
})
