import { useEffect, useRef, useState } from 'react'
import { DENSITY_INFO, PERSONALITY_INFO, type ChannelConfig, type ChannelOverrides, type ChannelRuntime, type EmoteDensity, type EmoteListPayload, type Personality } from '@shared/types'
import { AllowSendSwitch } from '../components/AllowSend'
import { ListBox } from '../components/ListBox'
import { Feed, FeedFilterBar, filterEntries, MessageTextWith, type FeedFilter } from '../components/Feed'
import { actions, useChatLines, useEmoteMap, useStore, watchChat } from '../store'
import { Confirm, Dot, EmoteImg, NumberField, Pill, Row, Switch, Tabs } from '../ui'

/** Minutes as the shortest readable span (1440 -> 1d). */
function span(min: number): string {
  if (min >= 1440 && min % 1440 === 0) return `${min / 1440}d`
  if (min >= 60 && min % 60 === 0) return `${min / 60}h`
  return `${min}m`
}

function statusOf(cfg: ChannelConfig, r: ChannelRuntime | undefined): { tone?: 'good' | 'warn' | 'bad'; text: string } {
  if (!r) return { text: 'Unknown' }
  if (r.conn === 'unavailable') return { tone: 'bad', text: 'Unavailable' }
  if (r.conn === 'connecting') return { tone: 'warn', text: 'Connecting' }
  if (r.live === 'live') return { tone: 'good', text: 'Live' }
  if (r.live === 'offline') return { text: 'Offline' }
  return { text: cfg.enabled ? (r.conn === 'joined' ? 'Connected' : 'Idle') : 'Idle' }
}

function ChannelListPane(): JSX.Element {
  const channels = useStore((s) => s.config.channels)
  const rts = useStore((s) => s.snap.channels)
  const selected = useStore((s) => s.selectedChannel)
  const current = channels.find((c) => c.login === selected) ?? channels[0]
  const [input, setInput] = useState('')
  const [err, setErr] = useState<string | null>(null)

  const add = async (): Promise<void> => {
    if (!input.trim()) return
    const r = await window.api.addChannel(input)
    if (r.ok) {
      actions.selectChannel(input.trim().toLowerCase().replace(/^#|^@/, '').replace(/^https?:\/\/(www\.)?twitch\.tv\//, ''))
      setInput('')
      setErr(null)
    } else setErr(r.error ?? 'Could not add channel.')
  }

  return (
    <div className="side-list">
      <div className="toolbar" style={{ marginBottom: 8 }}>
        <input className="input" style={{ flex: 1 }} placeholder="Add a channel" aria-label="Add a channel" autoComplete="off" autoCorrect="off" autoCapitalize="off" value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void add()} spellCheck={false} />
        <button className="btn" onClick={() => void add()} disabled={!input.trim()}>
          Add
        </button>
      </div>
      {err && <div className="sub" style={{ color: 'var(--bad)', marginBottom: 8 }}>{err}</div>}
      <div className="group">
        {channels.length === 0 && <div className="empty">No channels yet.</div>}
        {channels.map((c) => {
          const st = statusOf(c, rts.find((r) => r.login === c.login))
          return (
            <div key={c.login} className={`list-row${current?.login === c.login ? ' on' : ''}`}>
              <button className="list-item" onClick={() => actions.selectChannel(c.login)}>
                <Dot tone={st.tone} />
                <span className="t" title={c.displayName}>{c.displayName}</span>
                {c.enabled && c.allowSend ? <Pill tone="accent">send</Pill> : !c.enabled ? <span className="faint">off</span> : null}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

type Tab = 'overview' | 'behavior' | 'emotes' | 'chat'

export function Channels(): JSX.Element {
  const channels = useStore((s) => s.config.channels)
  const selected = useStore((s) => s.selectedChannel)
  const current = channels.find((c) => c.login === selected) ?? channels[0]
  return (
    <div className="page">
      <div className="split">
        <ChannelListPane />
        {current ? <Detail key={current.login} login={current.login} /> : <div className="empty">No channel selected.</div>}
      </div>
    </div>
  )
}

function Detail({ login }: { login: string }): JSX.Element | null {
  const cfg = useStore((s) => s.config.channels.find((c) => c.login === login))
  const r = useStore((s) => s.snap.channels.find((c) => c.login === login))
  const authIn = useStore((s) => s.snap.auth.status === 'logged-in')
  const [tab, setTab] = useState<Tab>('overview')
  const [confirmRemove, setConfirmRemove] = useState(false)
  if (!cfg) return null
  const st = statusOf(cfg, r)
  const room = r?.room
  const rules = room
    ? [room.slow > 0 && `slow ${room.slow}s`, room.followersOnly >= 0 && `followers${room.followersOnly ? ` ${span(room.followersOnly)}` : ''}`, room.subsOnly && 'subs only', room.emoteOnly && 'emote only', room.r9k && 'unique only'].filter(Boolean)
    : []
  return (
    <div>
      <div className="group">
        <div className="row">
          <div className="avatar" style={{ width: 40, height: 40, fontSize: 17 }}>{cfg.login[0]}</div>
          <div className="grow">
            <div style={{ fontSize: 17, fontWeight: 650 }}>{cfg.displayName}</div>
            <div className="hint">
              {r?.live === 'live' ? `Live${r.game ? ` · ${r.game}` : ''}${r.viewers !== undefined ? ` · ${r.viewers.toLocaleString()}` : ''}` : r?.live === 'offline' ? 'Offline' : authIn ? '' : <a className="link" onClick={() => actions.setPage('account')}>Log in to see live status</a>}
            </div>
          </div>
          <Pill tone={st.tone}>{st.text}</Pill>
          <button className="btn sm danger" onClick={() => setConfirmRemove(true)}>Remove</button>
        </div>
        {r?.conn === 'unavailable' && <div className="pad" style={{ color: 'var(--bad)' }}>{r.connDetail}</div>}
        {rules.length > 0 && <div className="pad muted" style={{ borderTop: '1px solid var(--line)' }}>{rules.join(' · ')}</div>}
      </div>
      <div style={{ margin: '8px 0' }}>
        <Tabs<Tab>
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'overview', label: 'Overview' },
            { value: 'behavior', label: 'Behavior' },
            { value: 'emotes', label: 'Emotes' },
            { value: 'chat', label: 'Chat' }
          ]}
        />
      </div>
      {tab === 'overview' && <OverviewTab cfg={cfg} r={r} />}
      {tab === 'behavior' && <BehaviorTab cfg={cfg} />}
      {tab === 'emotes' && <EmotesTab cfg={cfg} />}
      {tab === 'chat' && <ChatTab login={cfg.login} />}
      {confirmRemove && (
        <Confirm
          title={`Remove #${cfg.login}?`}
          danger
          confirmLabel="Remove"
          body="This can't be undone."
          onCancel={() => setConfirmRemove(false)}
          onConfirm={() => {
            void window.api.removeChannel(cfg.login)
            setConfirmRemove(false)
          }}
        />
      )}
    </div>
  )
}

function OverviewTab({ cfg, r }: { cfg: ChannelConfig; r: ChannelRuntime | undefined }): JSX.Element {
  const mode = useStore((s) => s.config.settings.sendMode)
  const running = useStore((s) => s.snap.automation.state !== 'stopped')
  const patch = (p: Parameters<typeof window.api.updateChannel>[1]): void => void window.api.updateChannel(cfg.login, p)
  return (
    <>
      <div className="group">
        <Row label="Enabled">
          <Switch on={cfg.enabled} onChange={(v) => patch({ enabled: v })} label="Enabled" />
        </Row>
        <Row label="Allow sending">
          <AllowSendSwitch cfg={cfg} mode={mode} />
        </Row>
        <Row label="Only when live">
          <Switch on={cfg.onlyWhenLive} onChange={(v) => patch({ onlyWhenLive: v })} label="Only when live" />
        </Row>
        <Row label="Sent this session" hint={r?.halted ? r.haltReason : undefined}>
          <span className="tnum muted">{r?.sent ?? 0}</span>
          {cfg.enabled && running && (
            <button className="btn sm" onClick={() => void (r?.halted ? window.api.resumeChannel(cfg.login) : window.api.haltChannel(cfg.login))}>
              {r?.halted ? 'Resume' : 'Stop'}
            </button>
          )}
        </Row>
      </div>
    </>
  )
}

function BehaviorTab({ cfg }: { cfg: ChannelConfig }): JSX.Element {
  const settings = useStore((s) => s.config.settings)
  const ov = cfg.overrides
  const setOv = (o: Partial<ChannelOverrides>): void => void window.api.updateChannel(cfg.login, { overrides: o })
  return (
    <div className="group">
      <Row label="Personality">
        <select className="select" value={ov.personality ?? ''} onChange={(e) => setOv({ personality: (e.target.value || null) as Personality | null })}>
          <option value="">Default ({PERSONALITY_INFO[settings.personality].label})</option>
          {(Object.keys(PERSONALITY_INFO) as Personality[]).map((p) => (
            <option key={p} value={p}>{PERSONALITY_INFO[p].label}</option>
          ))}
        </select>
      </Row>
      <Row label="Emote density">
        <select className="select" value={ov.density ?? ''} onChange={(e) => setOv({ density: (e.target.value || null) as EmoteDensity | null })}>
          <option value="">Default ({DENSITY_INFO[settings.density].label})</option>
          {(Object.keys(DENSITY_INFO) as EmoteDensity[]).map((d) => (
            <option key={d} value={d}>{DENSITY_INFO[d].label}</option>
          ))}
        </select>
      </Row>
      <Row label="Min delay">
        <NumberField value={ov.minDelaySec} min={0} max={1_000_000} suffix="sec" placeholder={String(settings.pacing.minDelaySec)} allowEmpty onCommit={(v) => setOv({ minDelaySec: v })} />
      </Row>
      <Row label="Max delay">
        <NumberField value={ov.maxDelaySec} min={0} max={1_000_000} suffix="sec" placeholder={String(settings.pacing.maxDelaySec)} allowEmpty onCommit={(v) => setOv({ maxDelaySec: v })} />
      </Row>
      <Row label="Message limit">
        <NumberField value={ov.maxMessages} min={1} max={1_000_000} placeholder={String(settings.pacing.maxPerChannel)} allowEmpty onCommit={(v) => setOv({ maxMessages: v })} />
      </Row>
      <ListBox title="Blocked words" hint="Never used in this channel, on top of the global list." value={cfg.blocklist} onSave={(v) => void window.api.updateChannel(cfg.login, { blocklist: v })} rows={3} />
    </div>
  )
}

function EmotesTab({ cfg }: { cfg: ChannelConfig }): JSX.Element {
  const settings = useStore((s) => s.config.settings)
  const version = useStore((s) => s.emoteVersion)
  const [data, setData] = useState<EmoteListPayload | null>(null)
  useEffect(() => {
    let alive = true
    void window.api.listEmotes(cfg.login).then((d) => alive && setData(d))
    return () => {
      alive = false
    }
  }, [cfg.login, version])
  const have = data ? settings.laughEmotes.filter((n) => data.emotes.some((e) => !e.zeroWidth && e.source !== 'personal' && e.name.toLowerCase() === n.toLowerCase())) : []
  const preview = data ? data.emotes.filter((e) => e.source === 'channel').slice(0, 36).concat(data.emotes.filter((e) => e.source === 'global').slice(0, 12)) : []
  return (
    <div className="group">
      <Row
        label={data ? (data.info.status === 'loading' ? 'Loading…' : data.info.status === 'ready' ? `${data.info.channelCount} channel · ${data.info.globalCount} global` : `${data.info.globalCount} global`) : 'Loading…'}
        hint={data?.info.status === 'unavailable' ? 'No 7TV set for this channel' : undefined}
      >
        <button className="btn sm" onClick={() => void window.api.refreshEmotes(cfg.login)}>Refresh</button>
      </Row>
      {data && (
        <div className="pad muted" style={{ borderTop: '1px solid var(--line)' }}>
          Laugh emotes: {have.length ? have.join(', ') : 'none here (text only)'}
        </div>
      )}
      {preview.length > 0 && (
        <div className="pad" style={{ borderTop: '1px solid var(--line)', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {preview.map((e) => (
            <EmoteImg key={e.id} emote={e} cls="sm" />
          ))}
        </div>
      )}
    </div>
  )
}

function ChatTab({ login }: { login: string }): JSX.Element {
  const activity = useStore((s) => s.activity)
  const [filter, setFilter] = useState<FeedFilter>('all')
  const emotes = useEmoteMap(login, false)
  const lines = useChatLines()
  const box = useRef<HTMLDivElement>(null)
  const cfg = useStore((s) => s.config.channels.find((c) => c.login === login))
  const r = useStore((s) => s.snap.channels.find((c) => c.login === login))
  const state = useStore((s) => s.snap.automation.state)

  // Chat is streamed from the main process only while this tab is open.
  useEffect(() => watchChat(login), [login])
  useEffect(() => {
    const el = box.current
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight
  }, [lines])

  let status: string | null = null
  if (!cfg?.enabled) status = 'Enable this channel and press Start.'
  else if (state === 'stopped') status = 'Press Start to read chat.'
  else if (!r || r.conn === 'connecting' || r.conn === 'idle') status = 'Connecting…'
  else if (r.conn === 'unavailable') status = r.connDetail ?? 'This channel is unavailable.'

  return (
    <>
      <div className="group">
        {status && <div className="pad muted">{status}</div>}
        {!status && lines.length === 0 && <div className="empty">Waiting for chat…</div>}
        {lines.length > 0 && (
          <div className="feed selectable" ref={box} style={{ maxHeight: 280 }}>
            {lines.map((l, i) => (
              <div key={`${l.ts}-${i}`} className="chat-line">
                <span className="chat-name">{l.name}</span>
                <span className="muted">: </span>
                <MessageTextWith text={l.text} emotes={emotes} />
              </div>
            ))}
          </div>
        )}
      </div>
      <h2>Activity</h2>
      <div className="toolbar"><FeedFilterBar value={filter} onChange={setFilter} /></div>
      <div className="group">
        <Feed entries={filterEntries(activity, filter, login)} showChannel={false} empty="Nothing yet." />
      </div>
    </>
  )
}
