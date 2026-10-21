import type { InitPayload } from '@shared/ipc'
import { isValidLogin, normalizeLogin, type AppSettings, type ChannelConfig, type ChatLine, type ConfigPayload, type SentMessage, type Snapshot } from '@shared/types'
import { Automation } from './automation'
import { EmoteManager } from './emotes/manager'
import { SevenTv } from './emotes/seventv'
import { registerIpc } from './ipc'
import { kv } from './kv'
import { ActivityLog } from './logger'
import { SentHistory } from './sentHistory'
import { TokenVault, type Cipher } from './secrets'
import { ConfigStore } from './store'
import { TwitchAuth } from './twitch/auth'
import { Helix } from './twitch/helix'
import { TwitchIrc } from './twitch/irc'
import { probeRoomId } from './twitch/probe'

const LIVE_POLL_MS = 90_000
/** If the engine's clock jumps by more than this, the computer was asleep (or the tab was frozen). */
const SLEEP_GAP_MS = 45_000

/** What the engine needs from the page that hosts it. */
export interface Host {
  /** Push an event to the page. */
  send(channel: string, payload?: unknown): void
  /** Answer requests from the page. */
  register(channel: string, fn: (...args: unknown[]) => unknown): void
  /** Ask the page to open a link in a new tab (only the page may open tabs). */
  openUrl(url: string): void
}

export interface BootOptions {
  cipher: Cipher
  version: string
  /** False when the browser can't keep data between visits (private window, blocked storage). */
  persistent: boolean
}

export interface Controller {
  automation: Automation
  store: ConfigStore
  log: ActivityLog
  /** Write everything pending to storage (the page is going away). */
  flush(): void
  dispose(): void
}

/**
 * The engine: everything that used to be the desktop app's main process. It runs in a Web Worker, so chat
 * connections and timers keep their pace even when the tab is in the background, and the page only draws.
 */
export async function boot(host: Host, opts: BootOptions): Promise<Controller> {
  const { send } = host
  const log = new ActivityLog('activity-log')
  const store = new ConfigStore('')
  log.fileEnabled = store.settings.logToFile
  log.verbose = store.settings.verboseLog

  const vault = new TokenVault('', opts.cipher, (why) => log.warn(`Couldn't read the saved Twitch login (${why}). Log in again.`))
  await vault.init()
  const clientId = (): string => store.settings.twitchClientId.trim()
  const auth = new TwitchAuth(vault, clientId, log, (url) => host.openUrl(url))
  const helix = new Helix(
    () => auth.getAccessToken(),
    clientId,
    () => auth.handleUnauthorized(),
    log
  )
  const irc = new TwitchIrc({ log })
  const ircAuth = async (): Promise<{ login: string; token: string } | null> => {
    const token = await auth.getAccessToken()
    const login = auth.login
    return token && login ? { login, token } : null
  }
  irc.setAuthProvider(ircAuth)
  let lastAuthRetry = 0
  const seventv = new SevenTv('emote-cache', log)
  const emotes = new EmoteManager(seventv, log)

  const broadcastConfig = (): void => send('config', { settings: store.settings, channels: store.channels } satisfies ConfigPayload)

  const automation = new Automation({
    store,
    log,
    irc,
    emotes,
    getIrcAuth: ircAuth,
    authState: () => auth.getState(),
    onAuthRejected: async () => {
      // A reconnect with an expired access token is the usual cause: renew once and reconnect before giving up.
      if (Date.now() - lastAuthRetry < 2 * 60_000) {
        auth.invalidate() // a freshly renewed token was refused too (e.g. revoked in Twitch settings)
        return
      }
      lastAuthRetry = Date.now()
      await auth.forceRefresh()
      await automation.reconnect()
    },
    onRoomId: (login, id) => {
      const cfg = store.channels.find((c) => c.login === login)
      if (cfg && cfg.twitchId !== id) {
        cfg.twitchId = id
        store.save()
        broadcastConfig()
      }
      if (emotes.info(login).status === 'none') void emotes.loadChannel(login, id)
    }
  })

  // ---------- channel helpers ----------

  // Anonymous channel look-ups run one at a time (adding many channels must not open many connections at once).
  let probeChain: Promise<unknown> = Promise.resolve()
  const queueProbe = (login: string): Promise<string | null> => {
    const run = probeChain.then(() => probeRoomId(login))
    probeChain = run.catch(() => undefined)
    return run
  }

  async function resolveChannel(cfg: ChannelConfig): Promise<void> {
    if (!cfg.twitchId) {
      const users = await helix.users([cfg.login]).catch(() => null)
      const u = users?.get(cfg.login)
      if (u) {
        cfg.twitchId = u.id
        cfg.displayName = u.displayName
      } else if (users) {
        automation.markUnavailable(cfg.login, 'Twitch has no channel with this name.')
        log.warn('Channel not found', cfg.login)
        return
      } else {
        const id = await queueProbe(cfg.login)
        if (id) cfg.twitchId = id
        else log.debug(`Could not look up #${cfg.login} yet`, cfg.login)
      }
      store.save()
      broadcastConfig()
    }
    if (cfg.twitchId) await emotes.loadChannel(cfg.login, cfg.twitchId)
  }

  const resolving = new Set<string>()
  async function refreshLive(): Promise<void> {
    if (!store.channels.length) return
    // Channels whose id couldn't be looked up yet (e.g. no network at launch) are retried on every poll.
    for (const c of store.channels) {
      if (!c.twitchId && !resolving.has(c.login)) {
        resolving.add(c.login)
        void resolveChannel(c).finally(() => resolving.delete(c.login))
      }
    }
    const logins = store.channels.map((c) => c.login)
    const loggedIn = auth.getState().status === 'logged-in'
    const streams = loggedIn ? await helix.streams(logins).catch(() => null) : null
    // A failed lookup (network blip) keeps the last known status instead of flipping every channel to "unknown".
    if (loggedIn && !streams) return
    for (const l of logins) automation.setStream(l, streams?.get(l) ?? null)
  }

  const syncPersonal = (force = false): void => {
    const a = auth.getState()
    void emotes.loadPersonal(a.status === 'logged-in' ? a.userId : null, force)
  }

  async function onAuthChange(): Promise<void> {
    send('snapshot', automation.snapshot())
    syncPersonal()
    if (auth.getState().status === 'logged-in') {
      void refreshLive()
      for (const c of store.channels) if (!c.twitchId) void resolveChannel(c)
    }
    await automation.reconnect()
  }
  let lastAuthStatus = auth.getState().status
  auth.on('state', () => {
    const status = auth.getState().status
    if (status !== lastAuthStatus && (status === 'logged-in' || lastAuthStatus === 'logged-in')) void onAuthChange()
    lastAuthStatus = status
    automation.snapshotSoon()
  })

  // ---------- wiring to the page ----------

  // Recent chat per channel stays here; the page only receives the channel it is showing.
  const chatRings = new Map<string, ChatLine[]>()
  let watchedChat: string | null = null
  const sentHistory = new SentHistory('')
  automation.on('sent', (m: SentMessage) => {
    sentHistory.add(m)
    send('sent', m)
  })
  automation.on('snapshot', (s: Snapshot) => send('snapshot', s))
  let chatBatch: ChatLine[] = []
  automation.on('chat', (line: ChatLine) => {
    let ring = chatRings.get(line.channel)
    if (!ring) chatRings.set(line.channel, (ring = []))
    ring.push(line)
    if (ring.length > 100) ring.shift()
    if (line.channel !== watchedChat) return
    chatBatch.push(line)
    if (chatBatch.length === 1) {
      setTimeout(() => {
        send('chat', chatBatch)
        chatBatch = []
      }, 250)
    }
  })
  log.onEntry((e) => {
    if (e.level !== 'debug') send('activity', e)
  })
  emotes.on('changed', (channel: string | null) => {
    send('emotes', channel)
    automation.snapshotSoon()
  })

  const initPayload = (): InitPayload => ({
    snapshot: automation.snapshot(),
    config: { settings: store.settings, channels: store.channels },
    activity: log.all().filter((e) => e.level !== 'debug'),
    recentSent: sentHistory.list(),
    platform: { version: opts.version, secureStorage: vault.persistent, persistent: opts.persistent }
  })

  registerIpc({
    store,
    log,
    auth,
    automation,
    emotes,
    initPayload,
    broadcastConfig,
    resolveChannel,
    refreshLive,
    register: host.register,
    history: () => sentHistory.list(),
    applySettings: (prev: AppSettings) => {
      const s = store.settings
      log.fileEnabled = s.logToFile
      log.verbose = s.verboseLog
      if (s.sendMode !== prev.sendMode) log.info(s.sendMode === 'approval' ? 'Approval mode' : 'Auto mode')
      automation.onSettingsChanged()
    },
    validLogin: (raw: string) => {
      const login = normalizeLogin(raw)
      return isValidLogin(login) ? login : null
    },
    onAutomationChange: () => undefined,
    watchChat: (login) => {
      watchedChat = login
      chatBatch = []
      return login ? (chatRings.get(login) ?? []).slice() : []
    }
  })

  // A computer that went to sleep cannot have been chatting: pause instead of resuming with stale state.
  let lastBeat = Date.now()
  const beat = setInterval(() => {
    const now = Date.now()
    if (now - lastBeat > SLEEP_GAP_MS && automation.automationState === 'running') automation.pause('your computer went to sleep')
    lastBeat = now
  }, 5000)

  // ---------- startup work ----------

  emotes.start()
  for (const c of store.channels) {
    if (c.twitchId) void emotes.loadChannel(c.login, c.twitchId)
  }
  await auth.restore().catch((err) => log.warn(`Could not restore Twitch login: ${err}`))
  syncPersonal()
  for (const c of store.channels) if (!c.twitchId) void resolveChannel(c)
  void refreshLive()
  const poll = setInterval(() => void refreshLive(), LIVE_POLL_MS)
  log.info(`Chatterly ${opts.version} ready`)

  const flush = (): void => {
    store.flush()
    sentHistory.flush()
    log.flush()
    void kv().flush()
  }
  return {
    automation,
    store,
    log,
    flush,
    dispose: () => {
      clearInterval(poll)
      clearInterval(beat)
      automation.dispose()
      emotes.stop()
      flush()
    }
  }
}
