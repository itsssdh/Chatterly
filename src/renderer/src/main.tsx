import { StrictMode } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { createBridge } from './bridge'
import { startStore } from './store'
import './styles.css'

const root = createRoot(document.getElementById('root')!)

function Splash({ title, children }: { title: string; children?: ReactNode }): JSX.Element {
  return (
    <div className="splash">
      <div>
        <h1>{title}</h1>
        {children && <p>{children}</p>}
      </div>
    </div>
  )
}

// Ask the browser to keep Chatterly's data even when disk space runs low (it may decline; that is fine).
void navigator.storage?.persist?.().catch(() => undefined)
// Offline shell: after one visit the app opens without the server running.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => void navigator.serviceWorker.register('./sw.js').catch(() => undefined))
}

async function run(): Promise<void> {
  const { api, ready } = createBridge()
  window.api = api
  root.render(<Splash title="Chatterly" />)
  try {
    await ready
    await startStore()
  } catch (err) {
    root.render(<Splash title="Chatterly couldn't start">{err instanceof Error ? err.message : String(err)}</Splash>)
    return
  }
  root.render(
    <StrictMode>
      <App />
    </StrictMode>
  )
}

// Only one tab may run Chatterly at a time: two would fight over the same chat connections and could double-post.
if (navigator.locks) {
  void navigator.locks.request('chatterly-running', { ifAvailable: true }, (lock) => {
    if (!lock) {
      root.render(
        <Splash title="Chatterly is already open in another tab">
          Close that tab (or this one). Running it twice would send every message twice. This page picks up automatically once the other tab is closed.
        </Splash>
      )
      // Wait for the other tab to go away, then start.
      return navigator.locks.request('chatterly-running', () => {
        void run()
        return new Promise<void>(() => undefined) // held until this tab closes
      })
    }
    void run()
    return new Promise<void>(() => undefined)
  })
} else {
  void run()
}
