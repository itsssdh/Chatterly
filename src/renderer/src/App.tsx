import { Suspense, lazy, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { NavTarget, Page } from '@shared/ipc'
import { ErrorBoundary } from './components/ErrorBoundary'
import { Dashboard } from './pages/Dashboard'
import { MiniPanel } from './pages/MiniPanel'
import { actions, useStore } from './store'
import { Dot, Icons } from './ui'

const Channels = lazy(() => import('./pages/Channels').then((m) => ({ default: m.Channels })))
const Settings = lazy(() => import('./pages/Settings').then((m) => ({ default: m.Settings })))

const NAV: { id: Page; label: string; icon: JSX.Element; key: string }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: Icons.dashboard, key: 'Alt+1' },
  { id: 'channels', label: 'Channels', icon: Icons.channels, key: 'Alt+2' },
  { id: 'settings', label: 'Settings', icon: Icons.settings, key: 'Alt+3' }
]

function Sidebar(): JSX.Element {
  const page = useStore((s) => s.page)
  const channels = useStore((s) => s.config.channels)
  const pending = useStore((s) => s.snap.pending.length)
  const auth = useStore((s) => s.snap.auth)
  const mode = useStore((s) => s.config.settings.sendMode)
  const enabled = channels.filter((c) => c.enabled).length
  return (
    <nav className="sidebar" aria-label="Main">
      <div className="brand">Chatterly</div>
      {NAV.map((n) => (
        <button key={n.id} className={`nav-item${page === n.id ? ' active' : ''}`} onClick={() => { actions.setPage(n.id); actions.closeSidebarIfNarrow() }} title={`${n.label} (${n.key})`}>
          {n.icon}
          <span>{n.label}</span>
          {n.id === 'channels' && channels.length > 0 && <span className="count">{enabled}/{channels.length}</span>}
          {n.id === 'dashboard' && pending > 0 && <span className="count hot">{pending}</span>}
        </button>
      ))}
      <div className="sidebar-foot">
        <button className="acct" onClick={() => { actions.setPage('account'); actions.closeSidebarIfNarrow() }} title="Twitch account">
          <Dot tone={auth.status === 'logged-in' ? 'good' : undefined} />
          <span>{auth.status === 'logged-in' ? auth.login : 'Not logged in'}</span>
        </button>
        <div className="faint">{mode === 'approval' ? 'Approval mode' : 'Auto mode'}</div>
      </div>
    </nav>
  )
}

const TITLES: Record<Page, string> = { dashboard: 'Dashboard', channels: 'Channels', settings: 'Settings' }

/** Window toolbar: sidebar toggle, page title, and the run controls — reachable from every page. */
function Topbar({ mini, toggleMini }: { mini: boolean; toggleMini: () => void }): JSX.Element {
  const page = useStore((s) => s.page)
  const state = useStore((s) => s.snap.automation.state)
  const pauseReason = useStore((s) => s.snap.automation.pauseReason)
  const pending = useStore((s) => s.snap.pending.length)
  const hasChannels = useStore((s) => s.config.channels.some((c) => c.enabled))
  const hidden = useStore((s) => s.sidebarHidden)

  const primary = (): void => void (state === 'stopped' ? window.api.start() : state === 'running' ? window.api.pause() : window.api.resume())
  return (
    <header className="topbar">
      <button className="icon-btn sb-toggle" onClick={actions.toggleSidebar} title={`${hidden ? 'Show' : 'Hide'} sidebar (Alt+\\)`} aria-label="Toggle sidebar">
        {Icons.sidebar}
      </button>
      <h1 className="top-title">{TITLES[page]}</h1>
      <div className="top-spacer" />
      {pending > 0 && page !== 'dashboard' && (
        <button className="pill accent as-btn" onClick={() => actions.setPage('dashboard')} title="Messages waiting for your approval">
          {pending} waiting
        </button>
      )}
      <button data-mini-toggle className={`btn${mini ? ' primary' : ''}`} onClick={toggleMini} title="Compact panel with play / pause and your latest sent messages">
        Mini
      </button>
      <span className="top-status" title={state === 'paused' ? pauseReason : undefined}>
        <Dot tone={state === 'running' ? 'good' : state === 'paused' ? 'warn' : undefined} />
        {state === 'running' ? 'Running' : state === 'paused' ? 'Paused' : 'Stopped'}
      </span>
      <button
        className="btn primary"
        onClick={primary}
        disabled={state === 'stopped' && !hasChannels}
        title={state === 'stopped' ? (hasChannels ? 'Start (Alt+Enter)' : 'Enable a channel first') : state === 'running' ? 'Pause sending (Alt+P)' : 'Resume sending (Alt+P)'}
      >
        {state === 'running' ? Icons.pause : Icons.play}
        {state === 'stopped' ? 'Start' : state === 'running' ? 'Pause' : 'Resume'}
      </button>
      <button className="btn" onClick={() => void window.api.stop()} disabled={state === 'stopped'} title="Stop and disconnect (Alt+.)">
        {Icons.stop} Stop
      </button>
    </header>
  )
}

type DocPip = { requestWindow(o?: { width?: number; height?: number }): Promise<Window>; window: Window | null }
const docPip = (): DocPip | undefined => (window as unknown as { documentPictureInPicture?: DocPip }).documentPictureInPicture

/** Renders the mini panel into a small always-on-top window (Document Picture-in-Picture). */
async function popOutMini(go: (p: NavTarget) => void): Promise<boolean> {
  const api = docPip()
  if (!api) return false
  const w = await api.requestWindow({ width: 360, height: 400 })
  for (const sheet of [...document.styleSheets]) {
    try {
      const css = [...sheet.cssRules].map((r) => r.cssText).join('\n')
      const el = w.document.createElement('style')
      el.textContent = css
      w.document.head.appendChild(el)
    } catch {
      if (sheet.href) {
        const link = w.document.createElement('link')
        link.rel = 'stylesheet'
        link.href = sheet.href
        w.document.head.appendChild(link)
      }
    }
  }
  w.document.documentElement.classList.add('pip')
  const host = w.document.createElement('div')
  host.id = 'root'
  w.document.body.appendChild(host)
  const r = createRoot(host)
  r.render(<MiniPanel go={(p) => { window.focus(); go(p) }} />)
  w.addEventListener('pagehide', () => r.unmount())
  return true
}

function useShortcuts(): void {
  useEffect(() => {
    // Alt-based, so they never collide with the browser's own shortcuts.
    const k = (e: KeyboardEvent): void => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return
      const st = window.api
      const snap = actions.state().snap
      const state = snap.automation.state
      switch (e.code) {
        case 'Digit1': actions.setPage('dashboard'); break
        case 'Digit2': actions.setPage('channels'); break
        case 'Digit3': actions.setPage('settings'); break
        case 'Backslash': actions.toggleSidebar(); break
        case 'Enter': if (state === 'stopped') void st.start(); break
        case 'KeyP': void (state === 'running' ? st.pause() : state === 'paused' ? st.resume() : st.start()); break
        case 'Period': if (state !== 'stopped') void st.stop(); break
        default: return
      }
      e.preventDefault()
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [])
}

/** The theme setting: System follows the browser; Light / Dark override it. */
function useTheme(): void {
  const theme = useStore((s) => s.config.settings.theme)
  useEffect(() => {
    if (theme === 'system') delete document.documentElement.dataset.theme
    else document.documentElement.dataset.theme = theme
  }, [theme])
}

/** Closing the tab stops everything, so ask first while Chatterly is running (a stray Cmd+W shouldn't do that). */
function useLeaveGuard(): void {
  const state = useStore((s) => s.snap.automation.state)
  useEffect(() => {
    if (state === 'stopped') return
    const guard = (e: BeforeUnloadEvent): void => e.preventDefault()
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [state])
}

/** The tab title shows what Chatterly is doing, so it can be read from another tab. */
function useTabTitle(): void {
  const on = useStore((s) => s.config.settings.menuBarIcon)
  const state = useStore((s) => s.snap.automation.state)
  const pending = useStore((s) => s.snap.pending.length)
  useEffect(() => {
    document.title = on ? `${state === 'running' ? '▶ ' : state === 'paused' ? '⏸ ' : ''}${pending ? `(${pending}) ` : ''}Chatterly` : 'Chatterly'
  }, [on, state, pending])
}

export function App(): JSX.Element {
  const page = useStore((s) => s.page)
  const hidden = useStore((s) => s.sidebarHidden)
  const [mini, setMini] = useState(false)
  useShortcuts()
  useTabTitle()
  useTheme()
  useLeaveGuard()
  useEffect(() => {
    if (!mini) return
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMini(false)
    }
    const outside = (e: MouseEvent): void => {
      const el = e.target as Element
      if (!el.closest('.mini-pop') && !el.closest('[data-mini-toggle]')) setMini(false)
    }
    window.addEventListener('keydown', esc)
    window.addEventListener('mousedown', outside)
    return () => {
      window.removeEventListener('keydown', esc)
      window.removeEventListener('mousedown', outside)
    }
  }, [mini])
  const go = (t: NavTarget): void => {
    actions.setPage(t)
    setMini(false)
  }
  return (
    <div className={`app${hidden ? ' sb-hidden' : ''}`}>
      <Topbar mini={mini} toggleMini={() => setMini((m) => !m)} />
      {mini && (
        <div className="mini-pop">
          <MiniPanel
            go={go}
            onClose={() => setMini(false)}
            popOut={docPip() ? () => void popOutMini(go).then((ok) => ok && setMini(false)).catch(() => undefined) : undefined}
          />
        </div>
      )}
      <div className="sb-backdrop" onClick={actions.toggleSidebar} aria-hidden />
      <aside className="sb-wrap" aria-hidden={hidden} {...(hidden ? { inert: true } : {})}>
        <Sidebar />
      </aside>
      <main className="main">
        <div className="scroll">
          <ErrorBoundary resetKey={page}>
          <Suspense fallback={null}>
            {page === 'dashboard' && <Dashboard />}
            {page === 'channels' && <Channels />}
            {page === 'settings' && <Settings />}
          </Suspense>
          </ErrorBoundary>
        </div>
      </main>
    </div>
  )
}
