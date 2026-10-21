import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import type { InitPayload, NavTarget, Page, SettingsSection, UiEvent } from '@shared/ipc'
import type { ActivityEntry, ChatLine, ConfigPayload, Emote, SentMessage, Snapshot } from '@shared/types'

/**
 * A tiny external store. Components subscribe to just the slice they read, so a new chat line or a countdown
 * tick never re-renders the whole app. While the window is hidden nothing is re-rendered at all; the state is
 * kept current and the UI catches up the moment the window is shown again.
 */
export interface State {
  snap: Snapshot
  config: ConfigPayload
  activity: ActivityEntry[]
  sent: SentMessage[]
  platform: InitPayload['platform']
  page: Page
  settingsSection: SettingsSection
  selectedChannel: string | null
  sidebarHidden: boolean
  /** Bumped whenever main reports that emote data changed. */
  emoteVersion: number
}

let state: State | null = null
const listeners = new Set<() => void>()
let dirty = false

const SIDEBAR_KEY = 'chatterly.sidebarHidden'
/** Below this width the sidebar floats over the page instead of taking space from it. */
export const NARROW_PX = 760
function readSidebar(): boolean {
  if (window.innerWidth <= NARROW_PX) return true
  try {
    return localStorage.getItem(SIDEBAR_KEY) === '1'
  } catch {
    return false
  }
}

function notify(): void {
  if (document.hidden) {
    dirty = true
    return
  }
  dirty = false
  for (const l of [...listeners]) l()
}

function set(patch: Partial<State>): void {
  if (!state) return
  state = { ...state, ...patch }
  notify()
}

export function isReady(): boolean {
  return state !== null
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Equal by identity, or two arrays holding the same items (selectors that filter/map build a fresh array each time). */
function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) return a.every((x, i) => Object.is(x, b[i]))
  return false
}

export function useStore<T>(selector: (s: State) => T): T {
  const sel = useRef(selector)
  sel.current = selector
  const cache = useRef<{ s: State; v: T } | null>(null)
  const get = useCallback((): T => {
    const s = state as State
    if (cache.current && cache.current.s === s) return cache.current.v
    const v = sel.current(s)
    if (cache.current && sameValue(cache.current.v, v)) {
      cache.current.s = s
      return cache.current.v
    }
    cache.current = { s, v }
    return v
  }, [])
  return useSyncExternalStore(subscribe, get)
}

// ---- actions ----
export const actions = {
  /** On a narrow screen the floating sidebar closes after you pick something (without changing the saved preference). */
  closeSidebarIfNarrow: (): void => {
    if (state && window.innerWidth <= NARROW_PX && !state.sidebarHidden) set({ sidebarHidden: true })
  },
  /** Current state, for event handlers outside React. */
  state: (): State => state!,
  /** 'account' opens Settings on the Account section. */
  setPage: (target: NavTarget): void => (target === 'account' ? set({ page: 'settings', settingsSection: 'account' }) : set({ page: target })),
  setSettingsSection: (settingsSection: SettingsSection): void => set({ settingsSection }),
  selectChannel: (selectedChannel: string | null): void => set({ selectedChannel }),
  openChannel: (login: string): void => set({ selectedChannel: login, page: 'channels' }),
  toggleSidebar: (): void => {
    if (!state) return
    const sidebarHidden = !state.sidebarHidden
    try {
      if (window.innerWidth > NARROW_PX) localStorage.setItem(SIDEBAR_KEY, sidebarHidden ? '1' : '0')
    } catch {
      // not critical
    }
    set({ sidebarHidden })
  }
}

async function load(): Promise<void> {
  const p = await window.api.init()
  const prev = state
  state = {
    snap: p.snapshot,
    config: p.config,
    activity: p.activity.slice(-300),
    sent: p.recentSent,
    platform: p.platform,
    page: prev?.page ?? 'dashboard',
    settingsSection: prev?.settingsSection ?? 'messages',
    selectedChannel: prev?.selectedChannel ?? null,
    sidebarHidden: prev?.sidebarHidden ?? readSidebar(),
    emoteVersion: prev?.emoteVersion ?? 0
  }
  notify()
}

let started = false
export async function startStore(): Promise<void> {
  if (started) return
  started = true
  await load()
  const api = window.api
  api.onSnapshot((snap) => set({ snap }))
  api.onConfig((config) => set({ config }))
  api.onActivity((e) => state && set({ activity: [...state.activity.slice(-299), e] }))
  api.onSent((m) => state && set({ sent: [...state.sent.slice(-299), m] }))
  api.onEmotes(() => state && set({ emoteVersion: state.emoteVersion + 1 }))
  api.onNav((target) => actions.setPage(target))
  api.onUi((e: UiEvent) => {
    if (e === 'toggleSidebar') actions.toggleSidebar()
    else void load() // 'resync': the window was hidden and may have missed updates
  })
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      if (dirty) notify()
      void load()
    }
  })
}

// ---- live chat: streamed only for the channel being watched ----
let chatLines: ChatLine[] = []
const chatListeners = new Set<() => void>()
let chatDirty = false
let chatHooked = false

function chatNotify(): void {
  if (document.hidden) {
    chatDirty = true
    return
  }
  chatDirty = false
  for (const l of [...chatListeners]) l()
}

export function watchChat(login: string | null): () => void {
  if (!chatHooked) {
    chatHooked = true
    window.api.onChat((lines) => {
      chatLines = [...chatLines, ...lines].slice(-100)
      chatNotify()
    })
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && chatDirty) chatNotify()
    })
  }
  chatLines = []
  chatNotify()
  let live = true
  void window.api.watchChat(login).then((history) => {
    if (!live) return
    chatLines = [...history, ...chatLines].slice(-100)
    chatNotify()
  })
  return () => {
    live = false
    void window.api.watchChat(null)
  }
}

export function useChatLines(): ChatLine[] {
  return useSyncExternalStore(
    (fn) => {
      chatListeners.add(fn)
      return () => chatListeners.delete(fn)
    },
    () => chatLines
  )
}

// ---- one shared clock: ticks only while something displays a countdown and the window is visible ----
function makeClock(ms: number): () => number {
  let n = 0
  let timer: ReturnType<typeof setInterval> | null = null
  const subs = new Set<() => void>()
  const sync = (): void => {
    if (subs.size && !document.hidden) {
      if (!timer)
        timer = setInterval(() => {
          n++
          for (const f of [...subs]) f()
        }, ms)
    } else if (timer) {
      clearInterval(timer)
      timer = null
    }
  }
  document.addEventListener('visibilitychange', () => {
    sync()
    if (!document.hidden && subs.size) {
      n++
      for (const f of [...subs]) f()
    }
  })
  return () =>
    useSyncExternalStore(
      (fn) => {
        subs.add(fn)
        sync()
        return () => {
          subs.delete(fn)
          sync()
        }
      },
      () => n
    )
}
/** Re-renders its component every 15 seconds ("2m ago" style labels). */
export const useSlowClock = makeClock(15_000)

// ---- emote name lookup, per channel ----
// The same name can be a different emote in different channels (a channel's own "KEKW" overrides the global one), so a
// message is always resolved against the set of the channel it belongs to, never against a merged list.
const emoteMaps = new Map<string, { version: number; map: Map<string, Emote> }>()
const emoteLoading = new Set<string>()
const emoteListeners = new Set<() => void>()
const NO_EMOTES = new Map<string, Emote>()

function ensureEmoteMap(key: string, channel: string | null, personal: boolean, version: number): void {
  const cur = emoteMaps.get(key)
  const tag = `${key}#${version}`
  if ((cur && cur.version === version) || emoteLoading.has(tag)) return
  emoteLoading.add(tag)
  void window.api
    .listEmotes(channel, { personal })
    .then((p) => {
      emoteMaps.set(key, { version, map: new Map(p.emotes.map((e) => [e.name, e])) })
      for (const l of [...emoteListeners]) l()
    })
    .finally(() => emoteLoading.delete(tag))
}

/**
 * name -> emote for one channel. `personal` adds your own 7TV personal emotes (right for messages you send,
 * wrong for other people's chat lines, which can't contain them).
 */
export function useEmoteMap(channel?: string | null, personal = true): Map<string, Emote> {
  const version = useStore((s) => s.emoteVersion)
  const key = `${channel ?? ''}|${personal ? 1 : 0}`
  useEffect(() => ensureEmoteMap(key, channel ?? null, personal, version), [key, channel, personal, version])
  return useSyncExternalStore(
    (fn) => {
      emoteListeners.add(fn)
      return () => emoteListeners.delete(fn)
    },
    () => emoteMaps.get(key)?.map ?? NO_EMOTES
  )
}

export { type NavTarget }
