import type { SentMessage } from '@shared/types'
import { join, readJson, writeJsonAtomic } from './kv'

const MAX = 300

/** Messages the app has posted, kept in the browser so the menu bar can show past ones after a restart. */
export class SentHistory {
  private file: string
  private items: SentMessage[]
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(dir: string) {
    this.file = join(dir, 'sent-history.json')
    const raw = readJson<SentMessage[]>(this.file)
    this.items = Array.isArray(raw)
      ? raw.filter((m) => m && typeof m.text === 'string' && typeof m.channel === 'string' && typeof m.account === 'string').slice(-MAX)
      : []
  }

  /** Oldest first. */
  list(): SentMessage[] {
    return this.items.slice()
  }

  add(m: SentMessage): void {
    this.items.push(m)
    if (this.items.length > MAX) this.items.splice(0, this.items.length - MAX)
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), 500)
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    try {
      writeJsonAtomic(this.file, this.items)
    } catch {
      // history is a convenience; never fail on it
    }
  }
}
