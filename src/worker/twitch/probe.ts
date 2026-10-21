import { TwitchIrc } from './irc'

/** Briefly joins a channel anonymously to learn its Twitch id from ROOMSTATE. Resolves null on timeout. */
export function probeRoomId(login: string, timeoutMs = 12_000, url?: string): Promise<string | null> {
  return new Promise((resolve) => {
    const irc = new TwitchIrc({ url, joinGapMs: 0 })
    const done = (id: string | null): void => {
      clearTimeout(timer)
      irc.disconnect()
      resolve(id)
    }
    const timer = setTimeout(() => done(null), timeoutMs)
    irc.on('roomstate', (_c, _r, id) => done(id))
    irc.on('status', (s) => {
      if (s === 'connected') irc.join(login)
    })
    irc.connect(null)
  })
}
