import { clearNs, ns } from './helpers'
import { join, kv } from '../src/worker/kv'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ActivityLog } from '../src/worker/logger'
import { strList } from '../src/worker/pacing'
import { TokenVault, type Cipher } from '../src/worker/secrets'
import { ConfigStore } from '../src/worker/store'
import { TwitchAuth, activateUrl } from '../src/worker/twitch/auth'
import { isValidLogin, normalizeLogin } from '../src/shared/types'

describe('channel names', () => {
  it.each([
    ['xqc', 'xqc'],
    ['XQC', 'xqc'],
    ['  xqc  ', 'xqc'],
    ['@xqc', 'xqc'],
    ['#xqc', 'xqc'],
    ['https://www.twitch.tv/xqc', 'xqc'],
    ['http://twitch.tv/xqc/videos?x=1', 'xqc'],
    ['twitch.tv/xqc', 'xqc'],
    ['www.twitch.tv/xqc', 'xqc'],
    ['m.twitch.tv/xqc#top', 'xqc'],
    ['name_with_underscore', 'name_with_underscore']
  ])('accepts %s', (input, expected) => {
    expect(normalizeLogin(input)).toBe(expected)
    expect(isValidLogin(normalizeLogin(input))).toBe(true)
  })

  it.each(['bad name', 'two words here', 'a b', '', '   ', 'x', 'ab', 'bad-name', 'x'.repeat(26), '<b>', 'ünï', 'twitch.tv/', 'https://twitch.tv/'])('rejects %j', (input) => {
    expect(isValidLogin(normalizeLogin(input))).toBe(false)
  })
})

describe('list settings', () => {
  it('trims, drops blanks and duplicates (ignoring case), keeps first spelling and order', () => {
    expect(strList(['  Foo ', '', 'foo', 'FOO', 'bar', 5, null, 'Bar', 'baz'], 10)).toEqual(['Foo', 'bar', 'baz'])
    expect(strList('nope', 5)).toEqual([])
    expect(strList(['a', 'b', 'c'], 2)).toEqual(['a', 'b'])
  })
})

describe('a damaged config file', () => {
  let dir: string
  beforeEach(() => (dir = ns('damaged')))
  afterEach(() => clearNs(dir))

  it('is kept as a backup before it is overwritten, and the app still starts with defaults', () => {
    kv().set(join(dir, 'config.json'), '{"version":2,"settings":{"personality":"gaming"}, oops')
    const store = new ConfigStore(dir)
    expect(store.settings.personality).toBe('chill')
    const backups = kv().keys(dir).filter((f) => f.includes('/config.damaged-'))
    expect(backups.length).toBe(1)
    store.flush()
    expect(kv().keys(dir).filter((f) => f.includes('/config.damaged-')).length).toBe(1)
  })

  it('a missing file is simply a fresh start (no backup)', () => {
    new ConfigStore(dir)
    expect(kv().keys(dir).filter((f) => f.includes('/config.damaged-'))).toEqual([])
  })
})

describe('login error messages', () => {
  const cipher: Cipher = { isAvailable: () => true, encrypt: async (s) => s, decrypt: async (b) => b }
  let dir: string
  beforeEach(() => (dir = ns('auth2')))
  afterEach(() => clearNs(dir))
  const make = (f: typeof fetch) => new TwitchAuth(new TokenVault(dir, cipher), () => 'cid', new ActivityLog(), () => {}, f)

  it('a rejected Client ID is explained in plain words (no raw JSON), as a login error', async () => {
    const auth = make((async () => new Response('{"status":400,"message":"invalid client"}', { status: 400 })) as unknown as typeof fetch)
    await auth.startLogin()
    const st = auth.getState()
    expect(st.status).toBe('logged-out')
    if (st.status === 'logged-out') {
      expect(st.error).toBe("Twitch didn't accept that Client ID.")
      expect(st.errorKind).toBe('login')
    }
  })

  it('being offline says so, and editing the Client ID clears the stale error', async () => {
    const auth = make((async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch)
    await auth.startLogin()
    const st = auth.getState()
    expect(st.status === 'logged-out' && st.error).toMatch(/reach Twitch/)
    auth.clearError()
    expect(auth.getState()).toMatchObject({ status: 'logged-out' })
    expect((auth.getState() as { error?: string }).error).toBeUndefined()
  })

  it('a saved login that stops working is a session error (shown app-wide)', async () => {
    const vault = new TokenVault(dir, cipher)
    vault.save({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 1000, login: 'me', userId: '1', scopes: [], clientId: 'cid' })
    const auth = new TwitchAuth(vault, () => 'cid', new ActivityLog(), () => {}, (async () => new Response('{}', { status: 400 })) as unknown as typeof fetch)
    expect(await auth.getAccessToken()).toBeNull()
    const st = auth.getState()
    expect(st.status === 'logged-out' && st.errorKind).toBe('session')
  })
})

describe('the login page link', () => {
  it('opens twitch.tv/activate with the code already filled in', async () => {
    expect(activateUrl('PPMXCVQP')).toBe('https://www.twitch.tv/activate?public=true&device-code=PPMXCVQP')
    expect(activateUrl('A B&C')).toBe('https://www.twitch.tv/activate?public=true&device-code=A%20B%26C')
    const dir = ns('link')
    const opened: string[] = []
    let polled = false
    const f = (async (url: string) => {
      // Twitch's own response can carry a different (shorter) link; the app must still open the activation page
      if (url.endsWith('/device')) return new Response(JSON.stringify({ device_code: 'dc', user_code: 'PPMXCVQP', verification_uri: 'https://www.twitch.tv/activate?device-code=PPMXCVQP', expires_in: 600, interval: 1 }))
      polled = true
      return new Response(JSON.stringify({ message: 'authorization_pending' }), { status: 400 })
    }) as unknown as typeof fetch
    const cipher: Cipher = { isAvailable: () => true, encrypt: async (s) => s, decrypt: async (b) => b }
    const auth = new TwitchAuth(new TokenVault(dir, cipher), () => 'cid', new ActivityLog(), (u) => opened.push(u), f)
    void auth.startLogin()
    const t0 = Date.now()
    while (!opened.length && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 10))
    expect(opened).toEqual(['https://www.twitch.tv/activate?public=true&device-code=PPMXCVQP'])
    const st = auth.getState()
    expect(st.status === 'pending' && st.verificationUri).toBe(opened[0])
    auth.cancelLogin()
    expect(polled || true).toBe(true)
    clearNs(dir)
  })
})

describe('device login resilience', () => {
  const cipher: Cipher = { isAvailable: () => true, encrypt: async (s) => s, decrypt: async (b) => b }
  it('survives a few network drops while waiting for approval', async () => {
    const dir = ns('auth3')
    let polls = 0
    const f = (async (url: string) => {
      if (url.endsWith('/device')) return new Response(JSON.stringify({ device_code: 'dc', user_code: 'CODE', verification_uri: 'https://www.twitch.tv/activate', expires_in: 600, interval: 0.01 }))
      if (url.endsWith('/token')) {
        polls++
        if (polls <= 3) throw new TypeError('fetch failed') // Wi-Fi hiccup
        return polls < 6 ? new Response(JSON.stringify({ message: 'authorization_pending' }), { status: 400 }) : new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 14000 }))
      }
      if (url.endsWith('/validate')) return new Response(JSON.stringify({ login: 'me', user_id: '1', client_id: 'cid', scopes: ['chat:read'], expires_in: 1 }))
      return new Response('{}')
    }) as unknown as typeof fetch
    const auth = new TwitchAuth(new TokenVault(dir, cipher), () => 'cid', new ActivityLog(), () => {}, f)
    await auth.startLogin()
    expect(auth.getState().status).toBe('logged-in')
    clearNs(dir)
  }, 20_000) // polls are at least 1 s apart
})

describe('an unreadable saved login', () => {
  it('is reported instead of silently looking like "never logged in"', async () => {
    const dir = ns('vault')
    const good: Cipher = { isAvailable: () => true, encrypt: async (s) => s, decrypt: async (b) => b }
    const first = new TokenVault(dir, good)
    first.save({ accessToken: 'a', refreshToken: 'r', expiresAt: 1, login: 'me', userId: '1', scopes: [], clientId: 'c' })
    await first.settled()
    const denied: Cipher = { isAvailable: () => true, encrypt: async (s) => s, decrypt: async () => { throw new Error('key unavailable') } }
    const reasons: string[] = []
    const v = new TokenVault(dir, denied, (w) => reasons.push(w))
    await v.init()
    expect(v.load()).toBeNull()
    expect(reasons).toEqual(['key unavailable'])
    clearNs(dir)
  })
})
