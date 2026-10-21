import type { KvBackend } from './kv'

const DB_NAME = 'chatterly'
const STORE = 'kv'
const FLUSH_MS = 40

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
      if (!db.objectStoreNames.contains('keys')) db.createObjectStore('keys')
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** IndexedDB-backed store: everything is loaded into memory once, so reads stay synchronous. */
export class IdbKv implements KvBackend {
  private map = new Map<string, string>()
  private pending = new Map<string, string | null>()
  private timer: ReturnType<typeof setTimeout> | null = null

  private constructor(private db: IDBDatabase) {}

  static async open(db: IDBDatabase): Promise<IdbKv> {
    const kv = new IdbKv(db)
    const tx = db.transaction(STORE, 'readonly')
    const store = tx.objectStore(STORE)
    const [keys, values] = await Promise.all([promisify(store.getAllKeys()), promisify(store.getAll())])
    keys.forEach((k, i) => kv.map.set(String(k), String(values[i])))
    return kv
  }

  get(key: string): string | null {
    return this.map.get(key) ?? null
  }
  set(key: string, value: string): void {
    this.map.set(key, value)
    this.pending.set(key, value)
    this.schedule()
  }
  delete(key: string): void {
    this.map.delete(key)
    this.pending.set(key, null)
    this.schedule()
  }
  keys(prefix = ''): string[] {
    return [...this.map.keys()].filter((k) => k.startsWith(prefix))
  }

  private schedule(): void {
    if (!this.timer) this.timer = setTimeout(() => this.flush(), FLUSH_MS)
  }

  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!this.pending.size) return Promise.resolve()
    const batch = this.pending
    this.pending = new Map()
    return new Promise<void>((resolve) => {
      try {
        const tx = this.db.transaction(STORE, 'readwrite')
        const store = tx.objectStore(STORE)
        for (const [k, v] of batch) {
          if (v === null) store.delete(k)
          else store.put(v, k)
        }
        tx.oncomplete = () => resolve()
        tx.onabort = tx.onerror = () => {
          console.error('Could not save to the browser database', tx.error)
          resolve()
        }
      } catch (err) {
        console.error('Could not save to the browser database', err)
        resolve()
      }
    })
  }
}
