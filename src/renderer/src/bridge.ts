import type { ChatterlyApi, InitPayload, NavTarget, Result, UiEvent } from '@shared/ipc'
import type { ActivityEntry, AppSettings, ChatLine, ConfigPayload, SentMessage, Snapshot } from '@shared/types'

/** Only a short list of https hosts may be opened in a new tab. */
export function openAllowed(url: string): boolean {
  try {
    const u = new URL(url)
    const ok = u.protocol === 'https:' && /(^|\.)(twitch\.tv|7tv\.app|github\.com)$/.test(u.hostname)
    if (ok) window.open(url, '_blank', 'noopener,noreferrer')
    return ok
  } catch {
    return false
  }
}

function download(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

type Listener = (v: never) => void

export interface Bridge {
  api: ChatterlyApi
  /** Resolves when the engine has loaded its saved data. Rejects if it can't start. */
  ready: Promise<void>
}

/**
 * The page's side of the engine: the same ChatterlyApi the desktop app exposed over IPC, here carried over
 * messages to the Web Worker that runs the engine.
 */
export function createBridge(): Bridge {
  const worker = new Worker(new URL('../../worker/worker.ts', import.meta.url), { type: 'module' })
  const listeners = new Map<string, Set<Listener>>()
  const pending = new Map<number, { resolve: (v: never) => void; reject: (e: Error) => void }>()
  let nextId = 1
  /** A tab opened at the moment of the click (so the browser allows it) that the login link is sent to later. */
  let loginTab: Window | null = null

  let resolveReady!: () => void
  let rejectReady!: (e: Error) => void
  const ready = new Promise<void>((res, rej) => {
    resolveReady = res
    rejectReady = rej
  })

  const emit = (channel: string, payload: unknown): void => {
    for (const l of [...(listeners.get(channel) ?? [])]) (l as (v: unknown) => void)(payload)
  }
  const on = <T>(channel: string, cb: (v: T) => void): (() => void) => {
    let set = listeners.get(channel)
    if (!set) listeners.set(channel, (set = new Set()))
    set.add(cb as Listener)
    return () => set!.delete(cb as Listener)
  }
  const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve: resolve as (v: never) => void, reject })
      worker.postMessage({ t: 'invoke', id, channel, args })
    })

  const closeLoginTab = (): void => {
    try {
      loginTab?.close()
    } catch {
      // already gone
    }
    loginTab = null
  }

  worker.addEventListener('message', (e: MessageEvent) => {
    const m = e.data as { t: string; id?: number; value?: unknown; error?: string; channel?: string; payload?: unknown; url?: string; message?: string }
    if (m.t === 'ready') resolveReady()
    else if (m.t === 'fatal') rejectReady(new Error(m.message ?? 'The engine could not start.'))
    else if (m.t === 'result' && m.id !== undefined) {
      const p = pending.get(m.id)
      pending.delete(m.id)
      if (m.error !== undefined) p?.reject(new Error(m.error))
      else p?.resolve(m.value as never)
    } else if (m.t === 'event' && m.channel) {
      if (m.channel === 'snapshot' && (m.payload as Snapshot).auth.status !== 'pending') closeLoginTab()
      emit(m.channel, m.payload)
    } else if (m.t === 'openUrl' && m.url) {
      try {
        const host = new URL(m.url).hostname
        if (!/(^|\.)twitch\.tv$/.test(host)) return
        if (loginTab && !loginTab.closed) {
          loginTab.location.href = m.url
          loginTab = null
        } else {
          // Without a click to point at, the browser may block this; the Account page has an “Open Twitch” button.
          window.open(m.url, '_blank', 'noopener,noreferrer')
        }
      } catch {
        // blocked: the button on the Account page does the same
      }
    }
  })
  worker.addEventListener('error', (e) => rejectReady(new Error(e.message || 'The engine crashed.')))

  // Whatever is still waiting to be saved goes out when the tab is hidden or closed.
  const flush = (): void => worker.postMessage({ t: 'flush' })
  document.addEventListener('visibilitychange', () => document.hidden && flush())
  window.addEventListener('pagehide', flush)

  worker.postMessage({ t: 'start' })

  const api: ChatterlyApi = {
    init: () => invoke<InitPayload>('init'),
    updateSettings: (p) => invoke<AppSettings>('settings:update', p),
    addChannel: (l) => invoke<Result>('channels:add', l),
    removeChannel: (l) => invoke('channels:remove', l),
    updateChannel: (l, p) => invoke('channels:update', l, p),
    start: () => invoke('automation:start'),
    pause: () => invoke('automation:pause'),
    resume: () => invoke('automation:resume'),
    stop: () => invoke('automation:stop'),
    haltChannel: (l) => invoke('channel:halt', l),
    resumeChannel: (l) => invoke('channel:resume', l),
    approve: (id, t) => invoke<Result>('approval:approve', id, t),
    reject: (id) => invoke('approval:reject', id),
    login: () => {
      // Opened right here, in the click, so the browser doesn't treat it as a pop-up; the engine sends it the link.
      closeLoginTab()
      try {
        loginTab = window.open('about:blank', '_blank')
        if (loginTab) loginTab.opener = null
      } catch {
        loginTab = null
      }
      setTimeout(closeLoginTab, 20_000)
      return invoke('auth:login')
    },
    cancelLogin: () => {
      closeLoginTab()
      return invoke('auth:cancel')
    },
    logout: () => invoke('auth:logout'),
    listEmotes: (c, o) => invoke('emotes:list', c, o),
    refreshEmotes: (c) => invoke('emotes:refresh', c),
    getLogs: () => invoke<ActivityEntry[]>('logs:get'),
    downloadLog: async () => {
      const entries = await invoke<ActivityEntry[]>('logs:get')
      const lines = entries.map(
        (e) => `${new Date(e.ts).toISOString()} ${e.level.toUpperCase()} ${e.kind}${e.channel ? ` #${e.channel}` : ''}${e.text ? ` "${e.text}"` : ''} — ${e.reason}${e.detail ? ` — ${e.detail}` : ''}`
      )
      download('chatterly.log', lines.join('\n') + '\n', 'text/plain')
    },
    exportData: async () => {
      const json = await invoke<string>('data:export')
      download(`chatterly-backup-${new Date().toISOString().slice(0, 10)}.json`, json, 'application/json')
    },
    importData: (json) => invoke<Result>('data:import', json),
    resetData: async () => {
      await invoke('data:reset')
      worker.terminate() // nothing may write again before the reload
      location.reload()
    },
    openExternal: async (url) => {
      if (!openAllowed(String(url))) console.warn('Blocked attempt to open', url)
    },
    reportError: (m) => invoke('logs:report', m),
    onSnapshot: (cb) => on<Snapshot>('snapshot', cb),
    onConfig: (cb) => on<ConfigPayload>('config', cb),
    onActivity: (cb) => on<ActivityEntry>('activity', cb),
    onEmotes: (cb) => on<string | null>('emotes', cb),
    watchChat: (l) => invoke<ChatLine[]>('chat:watch', l),
    onChat: (cb) => on<ChatLine[]>('chat', cb),
    onUi: (cb) => on<UiEvent>('ui', cb),
    onSent: (cb) => on<SentMessage>('sent', cb),
    onNav: (cb) => on<NavTarget>('nav', cb)
  }
  return { api, ready }
}
