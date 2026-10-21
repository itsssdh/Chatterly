import { useEffect, useLayoutEffect, useRef } from 'react'
import type { NavTarget } from '@shared/ipc'
import { MessageText } from '../components/Feed'
import { useStore } from '../store'
import { Ago, Dot, Icons } from '../ui'

/**
 * The compact panel: play / pause the sending of messages from the logged-in account, and the messages it sent
 * most recently (the latest three in view, older ones by scrolling). It opens from the top bar, and can be
 * popped out into a small always-on-top window (Chrome/Edge) so it stays visible over other apps.
 */
export function MiniPanel({ go, popOut, onClose }: { go: (page: NavTarget) => void; popOut?: () => void; onClose?: () => void }): JSX.Element {
  const state = useStore((s) => s.snap.automation.state)
  const pending = useStore((s) => s.snap.pending)
  const warning = useStore((s) => s.snap.warnings[0])
  const sentCount = useStore((s) => s.snap.counters.sentSession)
  const auth = useStore((s) => s.snap.auth)
  const mode = useStore((s) => s.config.settings.sendMode)
  const enabled = useStore((s) => s.config.channels.filter((c) => c.enabled).length)
  const sent = useStore((s) => s.sent)
  const list = useRef<HTMLDivElement>(null)

  const account = auth.status === 'logged-in' ? auth.login : null
  // Newest first, only what the logged-in account sent.
  const mine = account ? [...sent].reverse().filter((m) => m.account === account) : []

  // The newest message is always in view: the list jumps back to the top whenever a message is sent, and every time
  // the popover is opened, so older messages never have to be scrolled past to see the latest one.
  const newest = mine[0]?.id
  useLayoutEffect(() => {
    if (list.current) list.current.scrollTop = 0
  }, [newest, mine.length])
  useEffect(() => {
    const top = (): void => {
      if (!document.hidden && list.current) list.current.scrollTop = 0
    }
    document.addEventListener('visibilitychange', top)
    window.addEventListener('focus', top)
    return () => {
      document.removeEventListener('visibilitychange', top)
      window.removeEventListener('focus', top)
    }
  }, [])

  const primary = (): void => void (state === 'stopped' ? window.api.start() : state === 'running' ? window.api.pause() : window.api.resume())
  const statusText = state === 'running' ? 'Running' : state === 'paused' ? 'Paused' : 'Stopped'
  const tip = state === 'stopped' ? 'Start' : state === 'running' ? 'Pause' : 'Resume'

  return (
    <div className="mb">
      <div className="mb-head">
        <button className="mb-play" onClick={primary} disabled={state === 'stopped' && !enabled} title={tip} aria-label={tip}>
          {state === 'running' ? Icons.pause : Icons.play}
        </button>
        <div className="mb-title">
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
            <Dot tone={state === 'running' ? 'good' : state === 'paused' ? 'warn' : undefined} />
            {statusText}
          </div>
          <div className="sub">
            {account ?? 'Not logged in'} · {mode === 'approval' ? 'Approval' : 'Auto'} · {sentCount} sent
          </div>
        </div>
        {state !== 'stopped' && (
          <button className="btn sm" onClick={() => void window.api.stop()} title="Stop">
            {Icons.stop} Stop
          </button>
        )}
      </div>

      {warning && <div className="mb-warn">{warning}</div>}

      {pending.map((p) => (
        <div key={p.id} className="mb-pending">
          <div className="mb-pending-text">
            <span className="chan-tag">#{p.channel}</span> <MessageText text={p.text} channel={p.channel} />
          </div>
          <button className="btn sm" onClick={() => void window.api.reject(p.id)}>
            Reject
          </button>
          <button className="btn sm primary" disabled={state === 'paused'} title={state === 'paused' ? 'Resume to send' : ''} onClick={() => void window.api.approve(p.id)}>
            Send
          </button>
        </div>
      ))}

      <div className="mb-label">Recent{mine.length > 3 ? ` · ${mine.length} total` : ''}</div>
      <div className="mb-list selectable" ref={list}>
        {mine.length === 0 && (
          <div className="empty" style={{ padding: '22px 12px' }}>
            {account ? 'Nothing sent yet.' : <a className="link" onClick={() => go('account')}>Log in to send</a>}
          </div>
        )}
        {mine.map((m) => (
          <div key={m.id} className="mb-msg">
            <div className="mb-meta">
              <span className="chan-tag">#{m.channel}</span>
              <span className="faint">
                <Ago ts={m.ts} />
              </span>
            </div>
            <div className="mb-text">
              <MessageText text={m.text} channel={m.channel} />
            </div>
          </div>
        ))}
      </div>

      <div className="mb-foot">
        <button className="btn sm ghost" onClick={() => go('dashboard')}>
          Dashboard
        </button>
        <button className="btn sm ghost" onClick={() => go('settings')}>
          Settings
        </button>
        <span style={{ flex: 1 }} />
        {popOut && (
          <button className="btn sm ghost" onClick={popOut} title="Keep this panel in a small window on top of other apps">
            Pop out
          </button>
        )}
        {onClose && (
          <button className="btn sm ghost" onClick={onClose}>
            Close
          </button>
        )}
      </div>
    </div>
  )
}
