import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import type { SettingsSection } from '@shared/ipc'
import { DENSITY_INFO, PERSONALITY_INFO, type ActivityEntry, type AppSettings, type EmoteDensity, type Personality, type SendMode, type ThemeSetting } from '@shared/types'
import { EMOTE_NAME_RE, ListBox, MENTION_RE } from '../components/ListBox'
import { actions, useStore } from '../store'
import { Confirm, NumberField, Row, Segmented, Switch } from '../ui'

type Section = SettingsSection
const SECTIONS: { id: Section; label: string }[] = [
  { id: 'messages', label: 'Messages' },
  { id: 'greetings', label: 'Greetings' },
  { id: 'pacing', label: 'Pacing' },
  { id: 'account', label: 'Account' },
  { id: 'app', label: 'App' }
]

const set = (p: Partial<AppSettings>): void => void window.api.updateSettings(p)
const BIG = 1_000_000

function Messages(): JSX.Element {
  const s = useStore((x) => x.config.settings)
  return (
    <>
      <div className="group">
        <Row label="Mode" hint="Approval asks first. Auto sends on its own.">
          <Segmented<SendMode>
            value={s.sendMode}
            onChange={(m) => set({ sendMode: m })}
            options={[
              { value: 'approval', label: 'Approval' },
              { value: 'auto', label: 'Auto' }
            ]}
          />
        </Row>
        <div className="card-pick" style={{ borderTop: '1px solid var(--line)' }}>
          {(Object.keys(PERSONALITY_INFO) as Personality[]).map((p) => (
            <button key={p} className={s.personality === p ? 'on' : ''} onClick={() => set({ personality: p })}>
              <div className="t">{PERSONALITY_INFO[p].label}</div>
              <div className="d">{PERSONALITY_INFO[p].blurb}</div>
            </button>
          ))}
        </div>
        <Row label="Emotes">
          <Segmented<EmoteDensity> value={s.density} onChange={(d) => set({ density: d })} options={(Object.keys(DENSITY_INFO) as EmoteDensity[]).map((d) => ({ value: d, label: DENSITY_INFO[d].label }))} />
        </Row>
        <Row label="Chat when quiet" hint="Occasional filler lines in busy chats.">
          <Switch on={s.fillerWhenQuiet} onChange={(v) => set({ fillerWhenQuiet: v })} label="Chat when quiet" />
        </Row>
      </div>
      <h2>Lists</h2>
      <div className="group lists">
        <ListBox title="Laugh emotes" hint="Only these are used for laughs, and only if the channel has them. Separate with line breaks, commas or spaces." value={s.laughEmotes} onSave={(v) => set({ laughEmotes: v })} rows={3} kind="words" validate={(n) => EMOTE_NAME_RE.test(n)} invalidHint="Emote names are letters, numbers and symbols without spaces." />
        <ListBox title="Favorite emotes" hint="Used more often." value={s.favoriteEmotes} onSave={(v) => set({ favoriteEmotes: v })} kind="words" />
        <ListBox title="Never use emotes containing" hint="One per line." value={s.avoidEmoteWords} onSave={(v) => set({ avoidEmoteWords: v })} rows={2} />
        <ListBox title="Blocked words" hint="One per line." value={s.blocklist} onSave={(v) => set({ blocklist: v })} rows={2} />
      </div>
    </>
  )
}

function Greetings(): JSX.Element {
  const s = useStore((x) => x.config.settings)
  return (
    <div className="group">
      <Row label="Reply to greetings" hint="When someone says hi and mentions you.">
        <Switch on={s.answerGreetings} onChange={(v) => set({ answerGreetings: v })} label="Reply to greetings" />
      </Row>
      <ListBox title="Extra names" hint="Nicknames that count as mentioning you. Your username always does. Separate with line breaks, commas or spaces." value={s.customMentions} onSave={(v) => set({ customMentions: v })} kind="words" normalize={(n) => n.replace(/^@/, '')} validate={(n) => MENTION_RE.test(n)} invalidHint="Names are letters, numbers and underscores." />
      <ListBox title="Reply emotes" hint="One is picked for each reply." value={s.greetingReplyEmotes} onSave={(v) => set({ greetingReplyEmotes: v })} kind="words" validate={(n) => EMOTE_NAME_RE.test(n)} invalidHint="Emote names have no spaces." />
      <Row label="Same person again after">
        <NumberField value={s.greetingCooldownSec} min={0} max={BIG} suffix="sec" onCommit={(v) => v !== null && set({ greetingCooldownSec: v })} />
      </Row>
    </div>
  )
}

function Pacing(): JSX.Element {
  const p = useStore((x) => x.config.settings.pacing)
  const setP = (patch: Partial<typeof p>): void => set({ pacing: { ...p, ...patch } })
  const num = (key: keyof typeof p, min: number, suffix?: string): JSX.Element => (
    <NumberField value={p[key]} min={min} max={BIG} suffix={suffix} onCommit={(v) => v !== null && setP({ [key]: v })} />
  )
  return (
    <>
      <div className="group">
        <Row label="Min delay" hint="Per channel. A channel's slow mode still applies.">{num('minDelaySec', 0, 'sec')}</Row>
        <Row label="Max delay">{num('maxDelaySec', 0, 'sec')}</Row>
        <Row label="Cooldown">{num('cooldownSec', 0, 'sec')}</Row>
        <Row label="Gap between channels">{num('globalGapSec', 0, 'sec')}</Row>
        <Row label="Session limit">{num('maxPerSession', 1)}</Row>
        <Row label="Limit per channel">{num('maxPerChannel', 1)}</Row>
        <Row label="Messages per reaction" hint="0 = no cap.">{num('maxPerReaction', 0)}</Row>
        <Row label="Rest after a reaction">{num('reactionRestSec', 0, 'sec')}</Row>
        <Row label="Chance to react" hint={`${Math.round(p.reactChance * 100)}%`}>
          <input type="range" min={0} max={100} step={5} value={Math.round(p.reactChance * 100)} onChange={(e) => setP({ reactChance: Number(e.target.value) / 100 })} />
        </Row>
      </div>
      <h2>Send guard</h2>
      <div className="group">
        <Row label="Min gap between sends" hint="0 = off.">{num('guardMinGapSec', 0, 'sec')}</Row>
        <Row label="Max sends per 30s" hint="0 = off.">{num('guardMaxPer30s', 0)}</Row>
      </div>
      <div className="sub" style={{ margin: '10px 4px' }}>Twitch's own limits (slow mode, rate-limit warnings, bans) are always respected.</div>
    </>
  )
}

function Account(): JSX.Element {
  const s = useStore((x) => x.config.settings)
  const auth = useStore((x) => x.snap.auth)
  const [clientId, setClientId] = useState(s.twitchClientId)
  useEffect(() => setClientId(s.twitchClientId), [s.twitchClientId])
  return (
    <div className="group">
      {auth.status === 'logged-in' && (
        <>
          <Row label={auth.login} hint={auth.storedSecurely ? 'Saved encrypted in this browser' : 'This session only (storage unavailable)'}>
            <button className="btn" onClick={() => void window.api.logout()}>Log out</button>
          </Row>
        </>
      )}
      {auth.status === 'pending' && (
        <div className="pad" style={{ textAlign: 'center' }}>
          <div className="muted">Approve this code on twitch.tv/activate</div>
          <div className="code">{auth.userCode}</div>
          <div className="btn-cluster" style={{ justifyContent: 'center' }}>
            <button className="btn" onClick={() => void window.api.openExternal(auth.verificationUri)}>Open Twitch</button>
            <button className="btn" onClick={() => void navigator.clipboard.writeText(auth.userCode)}>Copy</button>
            <button className="btn ghost" onClick={() => void window.api.cancelLogin()}>Cancel</button>
          </div>
          <div className="hint" style={{ marginTop: 8 }}>If Twitch asks you to sign in first, press “Open Twitch” again afterwards.</div>
        </div>
      )}
      {auth.status === 'logged-out' && (
        <>
          <Row label="Client ID" hint="Free, from dev.twitch.tv. See below.">
            <input className="input selectable" style={{ width: 260 }} value={clientId} maxLength={64} aria-label="Client ID" autoComplete="off" autoCorrect="off" autoCapitalize="off" onChange={(e) => setClientId(e.target.value.replace(/\s/g, ''))} onBlur={() => clientId !== s.twitchClientId && set({ twitchClientId: clientId })} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} spellCheck={false} />
          </Row>
          <Row label="Log in">
            <button
              className="btn primary"
              disabled={!clientId.trim()}
              onClick={async () => {
                if (clientId !== s.twitchClientId) await window.api.updateSettings({ twitchClientId: clientId })
                void window.api.login()
              }}
            >
              Log in with Twitch
            </button>
          </Row>
          {auth.error && <div className="pad" style={{ color: 'var(--bad)', borderTop: '1px solid var(--line)' }}>{auth.error}</div>}
          <div className="pad" style={{ borderTop: '1px solid var(--line)' }}>
            <details>
              <summary>Get a Client ID</summary>
              <ol className="muted selectable" style={{ lineHeight: 1.7, paddingLeft: 18 }}>
                <li>Go to <a className="link" onClick={() => void window.api.openExternal('https://dev.twitch.tv/console/apps')}>dev.twitch.tv/console/apps</a> and register an application.</li>
                <li>Redirect URL <span className="mono">http://localhost</span>, category <b>Chat Bot</b>, type <b>Public</b>.</li>
                <li>Copy the Client ID here. No secret needed.</li>
              </ol>
            </details>
          </div>
        </>
      )}
    </div>
  )
}

function Appearance(): JSX.Element {
  const s = useStore((x) => x.config.settings)
  return (
    <div className="group">
      <Row label="Theme">
        <Segmented<ThemeSetting> value={s.theme} onChange={(t) => set({ theme: t })} options={[{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
      </Row>
      <Row label="Tab status" hint="Shows ▶ / ⏸ and waiting approvals in the tab title.">
        <Switch on={s.menuBarIcon} onChange={(v) => set({ menuBarIcon: v })} label="Tab status" />
      </Row>
    </div>
  )
}

function Data(): JSX.Element {
  const s = useStore((x) => x.config.settings)
  const platform = useStore((x) => x.platform)
  const [logs, setLogs] = useState<ActivityEntry[] | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const restore = async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const r = await window.api.importData(await file.text())
    setNote(r.ok ? { ok: true, text: 'Restored. Sending is off for every channel; switch it on per channel.' } : { ok: false, text: r.error ?? 'Could not restore that file.' })
  }
  return (
    <div className="group">
      <Row label="Keep log" hint="Saved in this browser between visits.">
        <Switch on={s.logToFile} onChange={(v) => set({ logToFile: v })} label="Keep log" />
      </Row>
      <Row label="Verbose">
        <Switch on={s.verboseLog} onChange={(v) => set({ verboseLog: v })} label="Verbose logging" />
      </Row>
      <Row label="Your data" hint={platform.persistent ? 'Everything stays in this browser.' : 'Storage is blocked here (private window?): nothing is kept after closing.'}>
        <button className="btn sm" onClick={() => void window.api.downloadLog()}>Download log</button>
        <button className="btn sm" onClick={() => void window.api.exportData()}>Back up</button>
        <button className="btn sm" onClick={() => fileRef.current?.click()}>Restore</button>
        <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={restore} />
      </Row>
      {note && <div className="pad" style={{ borderTop: '1px solid var(--line)', color: note.ok ? 'var(--good)' : 'var(--bad)' }}>{note.text}</div>}
      <Row label="Erase everything" hint="Logs out and removes all Chatterly data from this browser.">
        <button className="btn sm danger" onClick={() => setConfirm(true)}>Erase…</button>
      </Row>
      {confirm && (
        <Confirm
          title="Erase all Chatterly data?"
          body="This logs you out of Twitch and deletes your channels, settings and history from this browser. A backup file is the only way to get them back."
          confirmLabel="Erase"
          danger
          onCancel={() => setConfirm(false)}
          onConfirm={() => void window.api.resetData()}
        />
      )}
      <div className="pad" style={{ borderTop: '1px solid var(--line)' }}>
        <button className="btn sm" onClick={async () => setLogs(await window.api.getLogs())}>{logs ? 'Reload' : 'Show recent log'}</button>
        {logs && (
          <div className="logbox" style={{ marginTop: 10 }}>
            {logs.slice(-150).map((e) => `${new Date(e.ts).toLocaleTimeString()} ${e.level.toUpperCase().padEnd(5)} ${e.channel ? '#' + e.channel + ' ' : ''}${e.text ? `"${e.text}" ` : ''}${e.reason}${e.detail ? ` — ${e.detail}` : ''}`).join('\n') || 'Empty'}
          </div>
        )}
      </div>
      <div className="pad faint" style={{ borderTop: '1px solid var(--line)' }}>Chatterly {platform.version}</div>
    </div>
  )
}

export function Settings(): JSX.Element {
  const section = useStore((x) => x.settingsSection)
  const setSection = actions.setSettingsSection
  return (
    <div className="page">
      <div className="split settings-split">
        <nav className="subnav" aria-label="Settings sections">
          {SECTIONS.map((x) => (
            <button key={x.id} className={section === x.id ? 'on' : ''} onClick={() => setSection(x.id)}>
              <span className="t">{x.label}</span>
            </button>
          ))}
        </nav>
        <div>
          {section === 'messages' && <Messages />}
          {section === 'greetings' && <Greetings />}
          {section === 'pacing' && <Pacing />}
          {section === 'account' && <Account />}
          {section === 'app' && (
            <>
              <Appearance />
              <h2>Logs</h2>
              <Data />
            </>
          )}
        </div>
      </div>
    </div>
  )
}
