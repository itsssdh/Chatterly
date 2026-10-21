import { describe, expect, it } from 'vitest'
import { parseIrc, toChatMessage } from '../src/worker/twitch/parser'

describe('IRC parser', () => {
  it('parses tags, prefix, command and trailing', () => {
    const m = parseIrc(
      '@badges=subscriber/12;display-name=Some\\sUser;emotes=25:0-4;user-id=42 :someuser!someuser@someuser.tmi.twitch.tv PRIVMSG #chan :Kappa hello there\r\n'
    )!
    expect(m.command).toBe('PRIVMSG')
    expect(m.tags['display-name']).toBe('Some User')
    expect(m.params).toEqual(['#chan', 'Kappa hello there'])
    const c = toChatMessage(m, 1000)!
    expect(c.channel).toBe('chan')
    expect(c.login).toBe('someuser')
    expect(c.nativeEmotes).toEqual(['Kappa'])
    expect(c.badges).toEqual(['subscriber'])
  })

  it('parses NOTICE with msg-id and ROOMSTATE', () => {
    const n = parseIrc('@msg-id=msg_ratelimit :tmi.twitch.tv NOTICE #chan :Your message was not sent because you are sending messages too quickly.')!
    expect(n.tags['msg-id']).toBe('msg_ratelimit')
    expect(n.params[0]).toBe('#chan')
    const r = parseIrc('@room-id=123;slow=30;emote-only=0 :tmi.twitch.tv ROOMSTATE #chan')!
    expect(r.tags['room-id']).toBe('123')
    expect(r.params).toEqual(['#chan'])
  })

  it('handles PING and ACTION', () => {
    expect(parseIrc('PING :tmi.twitch.tv')!.command).toBe('PING')
    const a = toChatMessage(parseIrc(':u!u@u.tmi.twitch.tv PRIVMSG #c :\u0001ACTION waves\u0001')!)!
    expect(a.isAction).toBe(true)
    expect(a.text).toBe('waves')
  })
})
