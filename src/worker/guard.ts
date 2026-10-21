import type { AutomationState, ChannelConnState, LiveState, RoomState, SendMode } from '@shared/types'

export interface SendCheckInput {
  mode: SendMode
  automation: AutomationState
  /** The user clicked "approve" on this exact message (skips pacing, never skips safety checks). */
  userApproved: boolean
  channel: { enabled: boolean; allowSend: boolean; onlyWhenLive: boolean }
  runtime: { halted: boolean; haltReason?: string; conn: ChannelConnState; live: LiveState; sent: number; room: RoomState; badges: string[] }
  authenticated: boolean
  connected: boolean
  sessionSent: number
  limits: { maxPerSession: number; maxPerChannel: number }
  globalBackoffActive: boolean
}

export type SendCheck = { ok: true } | { ok: false; reason: string }

const PRIVILEGED_BADGES = ['subscriber', 'founder', 'moderator', 'vip', 'broadcaster', 'staff', 'admin']

/**
 * The single decision point for whether a message may leave the app. Every send path goes through it,
 * and `TwitchIrc.say` enforces a further hard rate limit underneath.
 */
export function checkSend(i: SendCheckInput): SendCheck {
  if (!i.channel.enabled) return { ok: false, reason: 'channel is disabled' }
  if (!i.channel.allowSend) return { ok: false, reason: 'sending is not enabled for this channel' }
  if (i.runtime.halted) return { ok: false, reason: `channel is halted${i.runtime.haltReason ? ` (${i.runtime.haltReason})` : ''}` }
  // Pause means nothing leaves the app, including messages you approved before pausing.
  if (i.automation === 'paused') return { ok: false, reason: 'sending is paused' }
  if (!i.userApproved && i.automation !== 'running') return { ok: false, reason: `automation is ${i.automation}` }
  if (!i.authenticated) return { ok: false, reason: 'not logged in to Twitch (read-only connection)' }
  if (!i.connected || i.runtime.conn !== 'joined') return { ok: false, reason: 'not connected to this channel' }
  if (i.globalBackoffActive) return { ok: false, reason: 'backing off after a rate-limit warning' }
  if (i.channel.onlyWhenLive && i.runtime.live !== 'live') {
    return { ok: false, reason: i.runtime.live === 'offline' ? 'channel is offline' : 'live status unknown, only sending when confirmed live' }
  }
  if (i.sessionSent >= i.limits.maxPerSession) return { ok: false, reason: `session limit reached (${i.limits.maxPerSession})` }
  if (i.runtime.sent >= i.limits.maxPerChannel) return { ok: false, reason: `channel limit reached (${i.limits.maxPerChannel})` }
  if (i.runtime.room.subsOnly && !i.runtime.badges.some((b) => PRIVILEGED_BADGES.includes(b))) {
    return { ok: false, reason: 'subscribers-only chat and this account is not a subscriber or mod' }
  }
  return { ok: true }
}
