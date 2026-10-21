import { memo, useState } from 'react'
import type { ChannelConfig, ChannelRuntime, SendMode } from '@shared/types'
import { AllowSendSwitch } from '../components/AllowSend'
import { Feed, FeedFilterBar, filterEntries, MessageText, type FeedFilter } from '../components/Feed'
import { actions, useStore } from '../store'
import { Dot, Pill, Segmented, Switch } from '../ui'

function ConnectionTile(): JSX.Element {
  const conn = useStore((s) => s.snap.connection)
  const auth = useStore((s) => s.snap.auth)
  const login = auth.status === 'logged-in' ? auth.login : null
  let v = 'Offline'
  let tone: 'good' | 'warn' | undefined
  if (conn.state === 'connected') {
    v = login ? 'Connected' : 'Read-only'
    tone = 'good'
  } else if (conn.state === 'reconnecting' || conn.state === 'connecting') {
    v = conn.state === 'connecting' ? 'Connecting' : 'Reconnecting'
    tone = 'warn'
  }
  return (
    <div className="tile">
      <div className="k">Twitch</div>
      <div className="v" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Dot tone={tone} />
        {v}
      </div>
      <div className="s">{login ?? ' '}</div>
    </div>
  )
}

function ChannelsTile(): JSX.Element {
  const channels = useStore((s) => s.config.channels)
  const rts = useStore((s) => s.snap.channels)
  const state = useStore((s) => s.snap.automation.state)
  const enabled = channels.filter((c) => c.enabled)
  const joined = rts.filter((c) => c.conn === 'joined' && enabled.some((e) => e.login === c.login)).length
  return (
    <div className="tile">
      <div className="k">Channels</div>
      <div className="v">
        {state === 'stopped' ? enabled.length : joined}
        <span className="muted" style={{ fontSize: 14, fontWeight: 500 }}> / {channels.length}</span>
      </div>
      <div className="s">{enabled.filter((c) => c.allowSend).length} can send</div>
    </div>
  )
}

function ModeTile(): JSX.Element {
  const mode = useStore((s) => s.config.settings.sendMode)
  return (
    <div className="tile">
      <div className="k">Mode</div>
      <Segmented<SendMode>
        value={mode}
        onChange={(m) => void window.api.updateSettings({ sendMode: m })}
        options={[
          { value: 'approval', label: 'Approval' },
          { value: 'auto', label: 'Auto' }
        ]}
      />
      <div className="s" style={{ marginTop: 6 }}>{mode === 'approval' ? 'Asks before sending' : 'Sends on its own'}</div>
    </div>
  )
}

function SessionTile(): JSX.Element {
  const counters = useStore((s) => s.snap.counters)
  return (
    <div className="tile">
      <div className="k">Sent</div>
      <div className="v">{counters.sentSession}</div>
      <div className="s">of {counters.sessionLimit} this session</div>
    </div>
  )
}

function Banners(): JSX.Element | null {
  const state = useStore((s) => s.snap.automation.state)
  const hasEnabled = useStore((s) => s.config.channels.some((c) => c.enabled))
  const warnings = useStore((s) => s.snap.warnings)
  const auth = useStore((s) => s.snap.auth)
  return (
    <>
      {auth.status !== 'logged-in' && (
        <div className="banner">
          Not logged in — nothing will be sent.{' '}
          <a className="link" onClick={() => actions.setPage('account')}>
            Log in
          </a>
        </div>
      )}
      {state === 'stopped' && hasEnabled && <div className="banner info">Press Start to connect.</div>}
      {warnings.map((w) => (
        <div key={w} className="banner">
          {w}
        </div>
      ))}
      {auth.status === 'logged-out' && auth.error && auth.errorKind === 'session' && <div className="banner bad">{auth.error}</div>}
    </>
  )
}

const PendingRow = memo(function PendingRow({ id, channel, text, reason, paused }: { id: string; channel: string; text: string; reason: string; paused: boolean }): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(text)
  const [err, setErr] = useState<string | null>(null)
  const approve = async (): Promise<void> => {
    const r = await window.api.approve(id, editing ? draft : undefined)
    if (!r.ok) setErr(r.error ?? 'Could not send.')
  }
  return (
    <div className="row" style={{ alignItems: 'flex-start' }}>
      <div className="grow">
        <div className="msg selectable" style={{ fontWeight: 500, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4, minWidth: 0 }}>
          <span className="chan-tag">#{channel}</span>
          {editing ? <input
              className="input"
              style={{ flex: 1, minWidth: 220 }}
              value={draft}
              maxLength={500}
              aria-label="Edit message"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setEditing(false)
                else if (e.key === 'Enter' && !paused && draft.trim()) void approve()
              }}
              autoFocus
            /> : <MessageText text={text} channel={channel} />}
        </div>
        <div className="hint">{err ?? reason}</div>
      </div>
      <div className="btn-cluster">
        <button className="btn sm" onClick={() => setEditing((e) => !e)}>{editing ? 'Cancel' : 'Edit'}</button>
        <button className="btn sm" onClick={() => void window.api.reject(id)}>Reject</button>
        <button className="btn sm primary" disabled={paused} title={paused ? 'Resume to send' : ''} onClick={() => void approve()}>Send</button>
      </div>
    </div>
  )
})

function Approvals(): JSX.Element | null {
  const pending = useStore((s) => s.snap.pending)
  const paused = useStore((s) => s.snap.automation.state === 'paused')
  if (!pending.length) return null
  return (
    <>
      <h2>Approvals</h2>
      <div className="group">
        {pending.map((p) => (
          <PendingRow key={p.id} id={p.id} channel={p.channel} text={p.text} reason={p.reason} paused={paused} />
        ))}
      </div>
    </>
  )
}

/** Only says something when there is something to say. */
function problemOf(c: ChannelConfig, r: ChannelRuntime | undefined): string | null {
  if (!c.enabled) return null
  if (r?.halted) return r.haltReason ?? 'Stopped'
  if (r?.conn === 'unavailable') return r.connDetail ?? 'Unavailable'
  return null
}

const ChannelRow = memo(function ChannelRow({ c, r, running, mode }: { c: ChannelConfig; r: ChannelRuntime | undefined; running: boolean; mode: SendMode }): JSX.Element {
  const problem = problemOf(c, r)
  return (
    <div className="chan-row">
      <div className="avatar">{c.login[0]}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <a className="link name" title={c.displayName} onClick={() => actions.openChannel(c.login)}>
          {c.displayName}
        </a>
        {problem && <div className="sub" style={{ color: 'var(--warn)' }}>{problem}</div>}
      </div>
      {r?.live === 'live' && <Pill tone="good">Live</Pill>}
      <label className="mini-toggle">
        <span>On</span>
        <Switch on={c.enabled} onChange={(v) => void window.api.updateChannel(c.login, { enabled: v })} label={`Enable ${c.login}`} />
      </label>
      <label className="mini-toggle">
        <span>Send</span>
        <AllowSendSwitch cfg={c} mode={mode} />
      </label>
      <span className="tnum muted sent-count">{r?.sent ?? 0}</span>
      {c.enabled && running ? (
        <button className="btn sm" onClick={() => void (r?.halted ? window.api.resumeChannel(c.login) : window.api.haltChannel(c.login))}>
          {r?.halted ? 'Resume' : 'Stop'}
        </button>
      ) : (
        <span style={{ width: 52 }} />
      )}
    </div>
  )
})

function ChannelList(): JSX.Element {
  const channels = useStore((s) => s.config.channels)
  const rts = useStore((s) => s.snap.channels)
  const running = useStore((s) => s.snap.automation.state !== 'stopped')
  const mode = useStore((s) => s.config.settings.sendMode)
  return (
    <div className="group">
      {channels.length === 0 && (
        <div className="empty">
          No channels.{' '}
          <a className="link" onClick={() => actions.setPage('channels')}>
            Add one
          </a>
        </div>
      )}
      {channels.map((c) => (
        <ChannelRow key={c.login} c={c} r={rts.find((r) => r.login === c.login)} running={running} mode={mode} />
      ))}
    </div>
  )
}

function Activity(): JSX.Element {
  const activity = useStore((s) => s.activity)
  // Channels that are offline and set to "Only when live" stay out of the feed (warnings and errors still show).
  const quiet = useStore((s) =>
    s.config.channels.filter((c) => c.onlyWhenLive && s.snap.channels.find((r) => r.login === c.login)?.live === 'offline').map((c) => c.login)
  )
  const shown = quiet.length ? activity.filter((e) => !e.channel || !quiet.includes(e.channel) || e.kind === 'warning' || e.kind === 'error') : activity
  const [filter, setFilter] = useState<FeedFilter>('all')
  return (
    <>
      <div className="toolbar">
        <FeedFilterBar value={filter} onChange={setFilter} />
      </div>
      <div className="group">
        <Feed entries={filterEntries(shown, filter)} empty="Nothing yet." />
      </div>
    </>
  )
}

export function Dashboard(): JSX.Element {
  return (
    <div className="page">
      <Banners />
      <div className="tiles">
        <ConnectionTile />
        <ChannelsTile />
        <ModeTile />
        <SessionTile />
      </div>
      <Approvals />
      <h2>Channels</h2>
      <ChannelList />
      <h2>Activity</h2>
      <Activity />
    </div>
  )
}
