import { clearNs, ns } from './helpers'
import { join, kv } from '../src/worker/kv'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ActivityLog } from '../src/worker/logger'
import { TokenVault, type Cipher } from '../src/worker/secrets'
import { ConfigStore } from '../src/worker/store'
import { TwitchAuth } from '../src/worker/twitch/auth'
import { DEFAULT_OVERRIDES } from '../src/shared/types'

const fakeCipher = (available = true): Cipher => ({
  isAvailable: () => available,
  encrypt: async (s) => `ENC:${btoa(s)}`,
  decrypt: async (b) => atob(b.slice(4))
})

describe('config store', () => {
  let dir: string
  beforeEach(() => (dir = ns('store')))
  afterEach(() => clearNs(dir))

  it('persists settings, channels and the sending mode', () => {
    const a = new ConfigStore(dir)
    a.settings.sendMode = 'auto'
    a.settings.personality = 'gaming'
    a.channels.push({ login: 'abc', displayName: 'Abc', twitchId: '1', enabled: true, allowSend: true, onlyWhenLive: true, blocklist: ['x'], overrides: { ...DEFAULT_OVERRIDES }, addedAt: 1 })
    a.flush()
    const b = new ConfigStore(dir)
    expect(b.settings.personality).toBe('gaming')
    expect(b.settings.sendMode).toBe('auto')
    expect(b.channels[0]).toMatchObject({ login: 'abc', enabled: true, allowSend: true, blocklist: ['x'] })
    // channels saved before the per-channel list existed load with an empty one
    kv().set(join(dir, 'config.json'), JSON.stringify({ version: 2, settings: {}, channels: [{ login: 'old' }] }))
    expect(new ConfigStore(dir).channels[0].blocklist).toEqual([])
  })

  it('moves the old default of 3 messages per reaction to 1 once, and keeps custom values', () => {
    expect(new ConfigStore(dir).settings.pacing.maxPerReaction).toBe(1) // new installs
    kv().set(join(dir, 'config.json'), JSON.stringify({ version: 1, settings: { pacing: { maxPerReaction: 3 } }, channels: [] }))
    const migrated = new ConfigStore(dir)
    expect(migrated.settings.pacing.maxPerReaction).toBe(1)
    migrated.flush()
    // already on v2: a deliberate 3 stays
    const v2 = JSON.parse(kv().get(join(dir, 'config.json'))!)
    expect(v2.version).toBe(2)
    v2.settings.pacing.maxPerReaction = 3
    kv().set(join(dir, 'config.json'), JSON.stringify(v2))
    expect(new ConfigStore(dir).settings.pacing.maxPerReaction).toBe(3)
    kv().set(join(dir, 'config.json'), JSON.stringify({ version: 1, settings: { pacing: { maxPerReaction: 5 } }, channels: [] }))
    expect(new ConfigStore(dir).settings.pacing.maxPerReaction).toBe(5)
  })

  it('an old config that still has the removed "priority" field loads fine and the field is dropped', () => {
    kv().set(join(dir, 'config.json'), JSON.stringify({ version: 2, settings: {}, channels: [{ login: 'a', priority: true, enabled: true }, { login: 'b', priority: true }] }))
    const store = new ConfigStore(dir)
    expect(store.channels.map((c) => c.login)).toEqual(['a', 'b'])
    expect(store.channels.every((c) => !('priority' in c))).toBe(true)
    expect(store.channels[0].enabled).toBe(true)
  })

  it('defaults to approval, and maps the removed preview mode (or junk) to approval', () => {
    expect(new ConfigStore(dir).settings.sendMode).toBe('approval')
    for (const legacy of ['preview', 'nonsense', 42]) {
      kv().set(join(dir, 'config.json'), JSON.stringify({ version: 1, settings: { sendMode: legacy }, channels: [] }))
      expect(new ConfigStore(dir).settings.sendMode).toBe('approval')
    }
  })

  it('survives a corrupt file and fills in defaults for missing fields', () => {
    const a = new ConfigStore(dir)
    a.flush()
    kv().set(join(dir, 'config.json'), '{ not json')
    const b = new ConfigStore(dir)
    expect(b.settings.pacing.minDelaySec).toBeGreaterThan(0)
    expect(b.channels).toEqual([])
  })
})

describe('token vault', () => {
  let dir: string
  beforeEach(() => (dir = ns('vault')))
  afterEach(() => clearNs(dir))
  const tok = { accessToken: 'SECRET_ACCESS', refreshToken: 'SECRET_REFRESH', expiresAt: 1, login: 'me', userId: '1', scopes: ['chat:edit'], clientId: 'cid' }

  it('never writes the token in plain text', async () => {
    const a = new TokenVault(dir, fakeCipher())
    a.save(tok)
    await a.settled()
    const raw = kv().get(join(dir, 'twitch-token'))!
    expect(raw).not.toContain('SECRET_ACCESS')
    const b = new TokenVault(dir, fakeCipher())
    await b.init()
    expect(b.load()?.accessToken).toBe('SECRET_ACCESS')
  })

  it('a later logout wins over a save that is still being written', async () => {
    const v = new TokenVault(dir, fakeCipher())
    v.save(tok)
    v.clear()
    await v.settled()
    expect(kv().get(join(dir, 'twitch-token'))).toBeNull()
  })

  it('keeps the token in memory only when encryption is unavailable', async () => {
    const v = new TokenVault(dir, fakeCipher(false))
    v.save(tok)
    await v.settled()
    expect(kv().keys(dir)).toEqual([])
    expect(v.load()?.login).toBe('me')
    v.clear()
    expect(v.load()).toBeNull()
  })
})

describe('Twitch device-code login', () => {
  let dir: string
  beforeEach(() => (dir = ns('auth')))
  afterEach(() => clearNs(dir))

  it('runs the device flow, stores the token, and logs out with revocation', async () => {
    const calls: { url: string; body: string }[] = []
    let polls = 0
    const f = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: String(init?.body ?? '') })
      if (url.endsWith('/device')) return new Response(JSON.stringify({ device_code: 'dc', user_code: 'ABCD1234', verification_uri: 'https://www.twitch.tv/activate?device-code=ABCD1234', expires_in: 600, interval: 0.01 }))
      if (url.endsWith('/token')) {
        return ++polls < 2
          ? new Response(JSON.stringify({ status: 400, message: 'authorization_pending' }), { status: 400 })
          : new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 14000, scope: ['chat:read', 'chat:edit'] }))
      }
      if (url.endsWith('/validate')) return new Response(JSON.stringify({ login: 'viewer', user_id: '77', client_id: 'cid', scopes: ['chat:read', 'chat:edit'], expires_in: 14000 }))
      return new Response('{}')
    }) as unknown as typeof fetch
    const opened: string[] = []
    const vault = new TokenVault(dir, fakeCipher())
    const auth = new TwitchAuth(vault, () => 'cid', new ActivityLog(), (u) => opened.push(u), f)
    await auth.startLogin()
    expect(opened[0]).toContain('twitch.tv/activate')
    expect(auth.getState()).toMatchObject({ status: 'logged-in', login: 'viewer' })
    expect(calls[0].body).toContain('scopes=chat%3Aread+chat%3Aedit') // only the two chat scopes
    expect(calls.some((c) => c.body.includes('client_secret'))).toBe(false)
    expect(await auth.getAccessToken()).toBe('at')
    await auth.logout()
    expect(auth.getState().status).toBe('logged-out')
    expect(vault.load()).toBeNull()
    expect(calls.some((c) => c.url.endsWith('/revoke'))).toBe(true)
  })

  it('refuses to start without a Client ID and surfaces a denied login', async () => {
    const auth = new TwitchAuth(new TokenVault(dir, fakeCipher()), () => '', new ActivityLog(), () => {}, (async () => new Response('{}')) as unknown as typeof fetch)
    await auth.startLogin()
    expect(auth.getState()).toMatchObject({ status: 'logged-out', clientIdSet: false })
  })

  it('refreshes an expiring token and drops the session if refresh is rejected', async () => {
    const vault = new TokenVault(dir, fakeCipher())
    vault.save({ accessToken: 'old', refreshToken: 'r1', expiresAt: Date.now() + 1000, login: 'me', userId: '1', scopes: [], clientId: 'cid' })
    let ok = true
    const f = (async (url: string) => {
      if (url.endsWith('/token')) return ok ? new Response(JSON.stringify({ access_token: 'new', refresh_token: 'r2', expires_in: 14000 })) : new Response('{}', { status: 400 })
      return new Response('{}')
    }) as unknown as typeof fetch
    const auth = new TwitchAuth(vault, () => 'cid', new ActivityLog(), () => {}, f)
    expect(await auth.getAccessToken()).toBe('new')
    expect(vault.load()?.refreshToken).toBe('r2')
    ok = false
    vault.save({ ...vault.load()!, expiresAt: Date.now() + 1000 })
    expect(await auth.getAccessToken()).toBeNull()
    expect(auth.getState().status).toBe('logged-out')
  })

  it('keeps the saved session when Twitch is merely unavailable (5xx / network)', async () => {
    const vault = new TokenVault(dir, fakeCipher())
    vault.save({ accessToken: 'old', refreshToken: 'r1', expiresAt: Date.now() + 1000, login: 'me', userId: '1', scopes: [], clientId: 'cid' })
    let mode: 'down' | 'throw' = 'down'
    const f = (async () => {
      if (mode === 'throw') throw new Error('offline')
      return new Response('{}', { status: 503 })
    }) as unknown as typeof fetch
    const auth = new TwitchAuth(vault, () => 'cid', new ActivityLog(), () => {}, f)
    await auth.getAccessToken()
    expect(vault.load()?.refreshToken).toBe('r1')
    mode = 'throw'
    await auth.getAccessToken()
    expect(vault.load()?.refreshToken).toBe('r1')
    expect(auth.getState().status).toBe('logged-in')
  })

  it('renews the refresh token at least every 12 h, even if the access token is still valid', async () => {
    const vault = new TokenVault(dir, fakeCipher())
    const day = 24 * 3600_000
    vault.save({ accessToken: 'a1', refreshToken: 'r1', expiresAt: Date.now() + 3 * 3600_000, login: 'me', userId: '1', scopes: [], clientId: 'cid', refreshedAt: Date.now() - day })
    let calls = 0
    const f = (async (url: string) => {
      if (url.endsWith('/token')) {
        calls++
        return new Response(JSON.stringify({ access_token: `a${calls + 1}`, refresh_token: `r${calls + 1}`, expires_in: 14000 }))
      }
      return new Response('{}')
    }) as unknown as typeof fetch
    const auth = new TwitchAuth(vault, () => 'cid', new ActivityLog(), () => {}, f)
    expect(await auth.getAccessToken()).toBe('a1') // plain use doesn't force a renewal
    expect(calls).toBe(0)
    await auth.restore() // launching does
    expect(calls).toBe(1)
    expect(vault.load()?.refreshToken).toBe('r2')
    expect(Date.now() - (vault.load()?.refreshedAt ?? 0)).toBeLessThan(5000)
    await auth.restore() // renewed moments ago: no second exchange
    expect(calls).toBe(1)
    // background maintenance renews once the 12 h mark passes
    vault.save({ ...vault.load()!, refreshedAt: Date.now() - day })
    await auth.maintain()
    expect(calls).toBe(2)
  })

  it('a rejected token is renewed once instead of logging the user out', async () => {
    const vault = new TokenVault(dir, fakeCipher())
    vault.save({ accessToken: 'stale', refreshToken: 'r1', expiresAt: Date.now() + 3 * 3600_000, login: 'me', userId: '1', scopes: [], clientId: 'cid', refreshedAt: Date.now() })
    const f = (async (url: string) =>
      url.endsWith('/token') ? new Response(JSON.stringify({ access_token: 'fresh', refresh_token: 'r2', expires_in: 14000 })) : new Response('{}')) as unknown as typeof fetch
    const auth = new TwitchAuth(vault, () => 'cid', new ActivityLog(), () => {}, f)
    expect(await auth.handleUnauthorized()).toBe('fresh')
    expect(auth.getState().status).toBe('logged-in')
  })
})
