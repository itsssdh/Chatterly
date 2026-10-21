import { beforeEach, describe, expect, it } from 'vitest'
import { registerIpc } from '../src/worker/ipc'
import { MemoryKv, kv, setKv } from '../src/worker/kv'
import { ActivityLog } from '../src/worker/logger'
import { ConfigStore } from '../src/worker/store'
import { isValidLogin, normalizeLogin } from '../src/shared/types'

type Handler = (...args: unknown[]) => unknown

function setup() {
  setKv(new MemoryKv())
  const store = new ConfigStore('')
  const handlers = new Map<string, Handler>()
  const calls: string[] = []
  registerIpc({
    store,
    log: new ActivityLog(),
    auth: { clearError: () => calls.push('clearError'), logout: async () => void calls.push('logout') } as never,
    automation: { syncChannels: () => undefined, onSettingsChanged: () => undefined, stop: () => calls.push('stop') } as never,
    emotes: {} as never,
    initPayload: () => ({}) as never,
    broadcastConfig: () => undefined,
    resolveChannel: async () => undefined,
    refreshLive: async () => undefined,
    applySettings: () => undefined,
    validLogin: (raw) => {
      const l = normalizeLogin(raw)
      return isValidLogin(l) ? l : null
    },
    onAutomationChange: () => undefined,
    register: (c, fn) => void handlers.set(c, fn),
    history: () => [],
    watchChat: () => []
  })
  const call = <T>(channel: string, ...args: unknown[]): Promise<T> => Promise.resolve(handlers.get(channel)!(...args)) as Promise<T>
  return { store, call, calls }
}

describe('settings page rules', () => {
  it('keeps valid greeting names (without @) and drops ones that can never match', async () => {
    const { store, call } = setup()
    await call('settings:update', { customMentions: ['@Dh', 'itsdh', 'bad!name', 'two words'] })
    expect(store.settings.customMentions).toEqual(['Dh', 'itsdh'])
  })
})

describe('restoring a backup', () => {
  beforeEach(() => setKv(new MemoryKv()))

  it('follows the same rules as the settings page and never switches sending on', async () => {
    const { store, call } = setup()
    const backup = {
      app: 'chatterly-web',
      settings: { personality: 'playful', customMentions: ['@Zed', 'bad!name'], sendMode: 'auto', density: 'nope' },
      channels: [{ login: 'summit1g', enabled: true, allowSend: true }, { login: 'summit1g' }, { login: 'not valid!' }, { login: 'lirik' }]
    }
    const r = await call<{ ok: boolean }>('data:import', JSON.stringify(backup))
    expect(r.ok).toBe(true)
    expect(store.settings.customMentions).toEqual(['Zed'])
    expect(store.settings.personality).toBe('playful')
    expect(store.settings.density).toBe('medium') // an unknown value falls back to the default
    expect(store.channels.map((c) => [c.login, c.enabled, c.allowSend])).toEqual([['summit1g', true, false], ['lirik', false, false]])
  })

  it('rejects files that are not a Chatterly export', async () => {
    const { call } = setup()
    expect(await call('data:import', 'nope')).toMatchObject({ ok: false })
    expect(await call('data:import', '{"hello":1}')).toMatchObject({ ok: false })
  })
})

describe('erase everything', () => {
  it('logs out, removes every stored key, and nothing can write afterwards', async () => {
    const { store, call, calls } = setup()
    await call('channels:add', 'xqc')
    store.flush()
    kv().set('sent-history.json', '[]')
    expect(kv().keys().length).toBeGreaterThan(0)
    await call('data:reset')
    expect(calls).toEqual(expect.arrayContaining(['stop', 'logout']))
    expect(kv().keys()).toEqual([])
    store.save()
    store.flush() // a timer firing late must not bring the old data back
    expect(kv().keys()).toEqual([])
  })
})
