import { clearNs, ns } from './helpers'
import { join, kv } from '../src/worker/kv'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SentHistory } from '../src/worker/sentHistory'
import type { SentMessage } from '../src/shared/types'

const msg = (i: number, account = 'me'): SentMessage => ({ id: `s${i}`, ts: i, channel: 'alpha', text: `hello ${i}`, account, approved: false })

describe('sent history', () => {
  let dir: string
  beforeEach(() => (dir = ns('sent')))
  afterEach(() => clearNs(dir))

  it('persists across launches, oldest first, and records which account sent each message', () => {
    const a = new SentHistory(dir)
    a.add(msg(1))
    a.add(msg(2, 'other'))
    a.flush()
    const b = new SentHistory(dir)
    expect(b.list().map((m) => [m.id, m.account])).toEqual([['s1', 'me'], ['s2', 'other']])
  })

  it('keeps only the latest 300 and survives a corrupt or foreign file', () => {
    const a = new SentHistory(dir)
    for (let i = 0; i < 320; i++) a.add(msg(i))
    expect(a.list().length).toBe(300)
    expect(a.list()[0].id).toBe('s20')
    kv().set(join(dir, 'sent-history.json'), '{ nope')
    expect(new SentHistory(dir).list()).toEqual([])
    kv().set(join(dir, 'sent-history.json'), JSON.stringify([msg(1), { bad: true }, 5]))
    expect(new SentHistory(dir).list().map((m) => m.id)).toEqual(['s1'])
  })
})
