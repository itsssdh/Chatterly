import { useEffect, useLayoutEffect, useRef, useState } from 'react'

/** Words (nicknames, emote names) can be separated by line breaks, commas or spaces; phrases keep their spaces. */
type Kind = 'words' | 'phrases'

const split = (t: string, kind: Kind): string[] =>
  t
    .split(kind === 'words' ? /[\s,;]+/ : /[\n,;]+/)
    .map((x) => x.trim())
    .filter(Boolean)

export const MENTION_RE = /^[\p{L}\p{N}_]{1,30}$/u
export const EMOTE_NAME_RE = /^[\w()\-:.!?]{1,50}$/

/**
 * A list setting that saves when the box loses focus. What you type is never rewritten while you are typing; on
 * leaving the box it shows exactly what was kept, and says so when an entry couldn't be (and why).
 */
export function ListBox({
  title,
  hint,
  value,
  onSave,
  rows = 2,
  placeholder,
  kind = 'phrases',
  normalize,
  validate,
  invalidHint
}: {
  title: string
  hint?: string
  value: string[]
  onSave: (v: string[]) => void
  rows?: number
  placeholder?: string
  kind?: Kind
  normalize?: (s: string) => string
  validate?: (s: string) => boolean
  invalidHint?: string
}): JSX.Element {
  const [text, setText] = useState(value.join('\n'))
  const [rejected, setRejected] = useState<string[]>([])
  const focused = useRef(false)
  const area = useRef<HTMLTextAreaElement>(null)
  const saved = useRef(value.join('\n'))

  // A change that didn't come from this box (a restored backup, another page) shows up, but never mid-typing.
  const key = value.join('\n')
  useEffect(() => {
    if (key === saved.current || focused.current) return
    saved.current = key
    setText(key)
    setRejected([])
  }, [key])

  // The box grows with its content instead of scrolling or being dragged.
  useLayoutEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight + 2}px`
  }, [text])

  const commit = (): void => {
    focused.current = false
    const seen = new Set<string>()
    const ok: string[] = []
    const bad: string[] = []
    for (const raw of split(text, kind)) {
      const v = normalize ? normalize(raw) : raw
      if (validate && !validate(v)) bad.push(raw)
      else if (!seen.has(v)) {
        seen.add(v)
        ok.push(v)
      }
    }
    saved.current = ok.join('\n')
    setText(ok.join('\n'))
    setRejected(bad)
    if (saved.current !== key) onSave(ok)
  }

  return (
    <div className="pad" style={{ borderTop: '1px solid var(--line)' }}>
      <div className="label" style={{ fontWeight: 500 }}>{title}</div>
      {hint && <div className="hint muted" style={{ marginBottom: 6 }}>{hint}</div>}
      <textarea
        ref={area}
        className="textarea selectable mono"
        style={{ marginTop: hint ? 0 : 8 }}
        rows={rows}
        placeholder={placeholder}
        value={text}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        autoComplete="off"
        aria-label={title}
        onFocus={() => (focused.current = true)}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
      />
      {rejected.length > 0 && (
        <div className="hint" style={{ color: 'var(--bad)', marginTop: 4 }}>
          Not saved: {rejected.join(', ')}. {invalidHint}
        </div>
      )}
    </div>
  )
}
