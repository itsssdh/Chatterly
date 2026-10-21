import { memo } from 'react'
import type { ActivityEntry, Emote } from '@shared/types'
import { useEmoteMap } from '../store'
import { Ago, EmoteImg } from '../ui'

const ICON: Record<string, string> = { sent: '↑', pending: '…', skipped: '–', info: 'i', warning: '!', error: '!', chat: '·' }
export type FeedFilter = 'all' | 'messages' | 'skipped' | 'issues'

/** A message with emote names swapped for their (still) images, from an already-resolved name -> emote map. */
export function MessageTextWith({ text, emotes }: { text: string; emotes: Map<string, Emote> }): JSX.Element {
  const parts = text.split(' ')
  return (
    <>
      {parts.map((p, i) => {
        const e = emotes.get(p)
        return (
          <span key={i}>
            {i > 0 && ' '}
            {e ? <EmoteImg emote={e} cls="sm" /> : p}
          </span>
        )
      })}
    </>
  )
}

/** A message belonging to `channel`: its emotes are looked up in that channel's own 7TV set. */
export function MessageText({ text, channel, personal = true }: { text: string; channel?: string; personal?: boolean }): JSX.Element {
  return <MessageTextWith text={text} emotes={useEmoteMap(channel, personal)} />
}

const FeedItem = memo(function FeedItem({ e, showChannel }: { e: ActivityEntry; showChannel: boolean }): JSX.Element {
  return (
    <div className={`feed-item ${e.kind}`}>
      <div className="ico">{ICON[e.kind] ?? 'i'}</div>
      <div className="body">
        {e.text ? (
          <div className="msg selectable">
            {showChannel && e.channel && <span className="chan-tag">#{e.channel}</span>}
            <MessageText text={e.text} channel={e.channel} />
          </div>
        ) : null}
        <div className="why selectable" title={e.detail}>
          {!e.text && showChannel && e.channel ? <span className="chan-tag">#{e.channel} </span> : null}
          {e.reason}
        </div>
      </div>
      <div className="time">
        <Ago ts={e.ts} />
      </div>
    </div>
  )
})

/** Newest first. Only the latest `limit` entries are rendered. */
export function Feed({ entries, empty, showChannel = true, limit = 60 }: { entries: ActivityEntry[]; empty: string; showChannel?: boolean; limit?: number }): JSX.Element {
  if (!entries.length) return <div className="empty">{empty}</div>
  const shown = entries.slice(-limit).reverse()
  return (
    <div className="feed">
      {shown.map((e) => (
        <FeedItem key={e.id} e={e} showChannel={showChannel} />
      ))}
    </div>
  )
}

export function FeedFilterBar({ value, onChange }: { value: FeedFilter; onChange: (v: FeedFilter) => void }): JSX.Element {
  const opts: { value: FeedFilter; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'messages', label: 'Messages' },
    { value: 'skipped', label: 'Skipped' },
    { value: 'issues', label: 'Issues' }
  ]
  return (
    <div className="seg">
      {opts.map((o) => (
        <button key={o.value} className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function filterEntries(entries: ActivityEntry[], f: FeedFilter, channel?: string): ActivityEntry[] {
  return entries.filter((e) => {
    if (channel && e.channel !== channel) return false
    // "All" leaves out routine skips (they have their own tab) so the feed stays about what actually happened.
    if (f === 'all') return e.kind !== 'skipped'
    if (f === 'messages') return e.kind === 'sent' || e.kind === 'pending'
    if (f === 'skipped') return e.kind === 'skipped'
    if (f === 'issues') return e.kind === 'warning' || e.kind === 'error'
    return true
  })
}
