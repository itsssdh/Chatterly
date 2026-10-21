import { memo, useEffect, useState, type ReactNode } from 'react'
import type { Emote } from '@shared/types'
import { useSlowClock } from './store'

export function Switch({ on, onChange, disabled, accent, label }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; accent?: boolean; label?: string }): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      className={`switch${on ? ' on' : ''}${accent ? ' accent' : ''}`}
      onClick={() => onChange(!on)}
    />
  )
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }): JSX.Element {
  return (
    <div className="seg" role="radiogroup">
      {options.map((o) => (
        <button key={o.value} role="radio" aria-checked={o.value === value} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** Horizontal tab strip used inside pages. */
export function Tabs<T extends string>({ value, tabs, onChange }: { value: T; tabs: { value: T; label: string; badge?: string | number }[]; onChange: (v: T) => void }): JSX.Element {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.value} role="tab" aria-selected={t.value === value} className={t.value === value ? 'on' : ''} onClick={() => onChange(t.value)}>
          {t.label}
          {t.badge !== undefined && <span className="badge">{t.badge}</span>}
        </button>
      ))}
    </div>
  )
}

export function Row({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children?: ReactNode }): JSX.Element {
  return (
    <div className="row">
      <div className="grow">
        <div className="label">{label}</div>
        {hint && <div className="hint">{hint}</div>}
      </div>
      {children}
    </div>
  )
}

export function Dot({ tone }: { tone?: 'good' | 'warn' | 'bad' | 'accent' }): JSX.Element {
  return <span className={`dot ${tone ?? ''}`} />
}

export function Pill({ tone, children }: { tone?: 'good' | 'warn' | 'bad' | 'accent'; children: ReactNode }): JSX.Element {
  return <span className={`pill ${tone ?? ''}`}>{children}</span>
}

export function NumberField({ value, onCommit, min, max, suffix, placeholder, allowEmpty }: { value: number | null; onCommit: (v: number | null) => void; min: number; max: number; suffix?: string; placeholder?: string; /** Empty means “use the default” (stored as null). Otherwise an empty box goes back to the current value. */ allowEmpty?: boolean }): JSX.Element {
  const [text, setText] = useState(value === null ? '' : String(value))
  useEffect(() => setText(value === null ? '' : String(value)), [value])
  const commit = (): void => {
    const back = (): void => setText(value === null ? '' : String(value))
    if (text.trim() === '') return allowEmpty ? onCommit(null) : back()
    const n = Number(text.trim().replace(',', '.'))
    if (!Number.isFinite(n)) return back()
    const clamped = Math.min(max, Math.max(min, n))
    setText(String(clamped)) // show what was kept (e.g. a value above the maximum)
    if (clamped !== value) onCommit(clamped)
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center' }}>
      <input
        className="input num"
        value={text}
        placeholder={placeholder}
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      {suffix && <span className="field-suffix">{suffix}</span>}
    </span>
  )
}

export function Confirm({ title, body, confirmLabel, danger, onConfirm, onCancel }: { title: string; body: ReactNode; confirmLabel: string; danger?: boolean; onConfirm: () => void; onCancel: () => void }): JSX.Element {
  useEffect(() => {
    const k = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onCancel])
  return (
    <div className="modal-back" onMouseDown={onCancel}>
      <div className="modal" role="dialog" aria-modal onMouseDown={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <p>{body}</p>
        <div className="btn-cluster">
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className={`btn ${danger ? 'danger' : 'primary'}`} onClick={onConfirm} autoFocus>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

type Px = '1x' | '2x' | '3x' | '4x'
/** 7TV serves the animated file for animated emotes; the browser caches it after the first download. */
export const emoteUrl = (id: string, size: Px = '2x'): string => `https://cdn.7tv.app/emote/${id}/${size}.webp`

/** An emote image. Animated emotes play as animations. */
export const EmoteImg = memo(function EmoteImg({ emote, size, cls }: { emote: Pick<Emote, 'id' | 'name'>; size?: Px; cls?: string }): JSX.Element {
  // A failed download (offline, CDN hiccup) shows a placeholder and is tried again a few times, a little later each time.
  const [tries, setTries] = useState(0)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!failed || tries >= 3) return
    const t = setTimeout(() => {
      setTries((n) => n + 1)
      setFailed(false)
    }, 6000 * (tries + 1))
    return () => clearTimeout(t)
  }, [failed, tries])
  if (failed) return <div className="emote-ph" title={emote.name} />
  return <img key={tries} className={`emote-img ${cls ?? ''}`} src={emoteUrl(emote.id, size)} alt={emote.name} title={emote.name} loading="lazy" decoding="async" draggable={false} onError={() => setFailed(true)} />
})

export function timeAgo(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 5) return 'now'
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function Ago({ ts }: { ts: number }): JSX.Element {
  useSlowClock()
  return <>{timeAgo(ts)}</>
}

const P = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' } as const
export const Icons = {
  dashboard: <svg viewBox="0 0 16 16" {...P}><rect x="2" y="2" width="5" height="6" rx="1.2" /><rect x="9" y="2" width="5" height="3.5" rx="1.2" /><rect x="9" y="7.5" width="5" height="6.5" rx="1.2" /><rect x="2" y="10" width="5" height="4" rx="1.2" /></svg>,
  channels: <svg viewBox="0 0 16 16" {...P}><path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h7" /></svg>,
  settings: <svg viewBox="0 0 16 16" {...P}><path d="M3 4.5h5M11 4.5h2M3 11.5h2M8 11.5h5" /><circle cx="9.5" cy="4.5" r="1.5" /><circle cx="6.5" cy="11.5" r="1.5" /></svg>,
  sidebar: <svg viewBox="0 0 16 16" {...P}><rect x="1.8" y="2.5" width="12.4" height="11" rx="2.2" /><path d="M6 2.8v10.4" /></svg>,
  play: <svg viewBox="0 0 16 16" fill="currentColor"><path d="M4.5 2.8v10.4a.6.6 0 0 0 .9.5l8.2-5.2a.6.6 0 0 0 0-1L5.4 2.3a.6.6 0 0 0-.9.5z" /></svg>,
  pause: <svg viewBox="0 0 16 16" fill="currentColor"><rect x="3.5" y="2.5" width="3.2" height="11" rx="1" /><rect x="9.3" y="2.5" width="3.2" height="11" rx="1" /></svg>,
  stop: <svg viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="3" width="10" height="10" rx="2" /></svg>
}
