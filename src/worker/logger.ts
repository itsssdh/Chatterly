import type { ActivityEntry, ActivityKind, LogLevel } from '@shared/types'
import { readJson, writeJsonAtomic } from './kv'

const MAX_ENTRIES = 1000
/** How much of the log is kept in the browser between visits. */
const MAX_SAVED = 500

type Listener = (entry: ActivityEntry) => void

/** Everything the app decides or observes ends up here: the live feed, the log viewer and the saved log. */
export class ActivityLog {
  private entries: ActivityEntry[] = []
  private nextId = 1
  private listeners = new Set<Listener>()
  private key: string | null
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  /** Whether the log is kept in the browser between visits. */
  fileEnabled = true
  verbose = false

  constructor(storageKey?: string) {
    this.key = storageKey ?? null
    if (this.key) {
      const saved = readJson<ActivityEntry[]>(this.key)
      if (Array.isArray(saved)) {
        this.entries = saved.filter((e) => e && typeof e.id === 'number' && typeof e.reason === 'string').slice(-MAX_SAVED)
        this.nextId = this.entries.reduce((m, e) => Math.max(m, e.id), 0) + 1
      }
    }
  }

  onEntry(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  all(): ActivityEntry[] {
    return this.entries.slice()
  }

  add(level: LogLevel, kind: ActivityKind, reason: string, extra: { channel?: string; text?: string; detail?: string } = {}): ActivityEntry | null {
    if (level === 'debug' && !this.verbose) return null
    const entry: ActivityEntry = { id: this.nextId++, ts: Date.now(), level, kind, reason, ...extra }
    this.entries.push(entry)
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES)
    this.write()
    for (const fn of this.listeners) fn(entry)
    return entry
  }

  debug(reason: string, channel?: string): void {
    this.add('debug', 'info', reason, { channel })
  }
  info(reason: string, channel?: string): void {
    this.add('info', 'info', reason, { channel })
  }
  warn(reason: string, channel?: string): void {
    this.add('warn', 'warning', reason, { channel })
  }
  error(reason: string, channel?: string): void {
    this.add('error', 'error', reason, { channel })
  }

  private write(): void {
    if (!this.key || !this.fileEnabled || this.saveTimer) return
    this.saveTimer = setTimeout(() => this.flush(), 2000)
  }

  flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    if (!this.key || !this.fileEnabled) return
    try {
      writeJsonAtomic(this.key, this.entries.slice(-MAX_SAVED))
    } catch {
      // Logging must never take the app down.
    }
  }
}
