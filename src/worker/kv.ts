/**
 * Everything Chatterly keeps (settings, channels, sent history, emote caches, the encrypted login) lives in one
 * small string key/value store. Reads are synchronous (served from memory); writes reach the browser's IndexedDB
 * in the background. Tests use the in-memory backend.
 */
export interface KvBackend {
  get(key: string): string | null
  set(key: string, value: string): void
  delete(key: string): void
  keys(prefix?: string): string[]
  /** Push pending writes to durable storage now; resolves once they are committed. */
  flush(): Promise<void>
}

export class MemoryKv implements KvBackend {
  private map = new Map<string, string>()
  get(key: string): string | null {
    return this.map.get(key) ?? null
  }
  set(key: string, value: string): void {
    this.map.set(key, value)
  }
  delete(key: string): void {
    this.map.delete(key)
  }
  keys(prefix = ''): string[] {
    return [...this.map.keys()].filter((k) => k.startsWith(prefix))
  }
  flush(): Promise<void> {
    return Promise.resolve()
  }
}

let backend: KvBackend = new MemoryKv()

export function setKv(b: KvBackend): void {
  backend = b
}

/** After an erase nothing may write again (a timer firing late would bring old data back). */
export function freezeKv(): void {
  const inner = backend
  backend = {
    get: (k) => inner.get(k),
    keys: (p) => inner.keys(p),
    set: () => undefined,
    delete: () => undefined,
    flush: () => inner.flush()
  }
}
export function kv(): KvBackend {
  return backend
}

/** `dir` is a namespace (a prefix), kept so callers read like they did with folders. */
export function join(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name
}

export function writeJsonAtomic(key: string, data: unknown): void {
  backend.set(key, JSON.stringify(data))
}

export function readJson<T>(key: string): T | null {
  try {
    const raw = backend.get(key)
    return raw === null ? null : (JSON.parse(raw) as T)
  } catch {
    return null
  }
}

export function removeKey(key: string): void {
  backend.delete(key)
}
