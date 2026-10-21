import type { Cipher } from './secrets'
import { openDb } from './idbKv'

const KEY_ID = 'token-key'

const toB64 = (b: Uint8Array): string => {
  let s = ''
  for (const x of b) s += String.fromCharCode(x)
  return btoa(s)
}
const fromB64 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

/** WebCrypto AES-GCM with a random, non-extractable key that lives in IndexedDB (never in exported data). */
export class WebCipher implements Cipher {
  private constructor(private key: CryptoKey) {}

  static async create(): Promise<WebCipher | null> {
    try {
      if (!globalThis.crypto?.subtle) return null
      const db = await openDb()
      const existing = await new Promise<CryptoKey | undefined>((resolve, reject) => {
        const r = db.transaction('keys', 'readonly').objectStore('keys').get(KEY_ID)
        r.onsuccess = () => resolve(r.result as CryptoKey | undefined)
        r.onerror = () => reject(r.error)
      })
      if (existing) return new WebCipher(existing)
      const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('keys', 'readwrite')
        tx.objectStore('keys').put(key, KEY_ID)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
      return new WebCipher(key)
    } catch {
      return null
    }
  }

  isAvailable(): boolean {
    return true
  }

  async encrypt(plain: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this.key, new TextEncoder().encode(plain)))
    const out = new Uint8Array(iv.length + ct.length)
    out.set(iv)
    out.set(ct, iv.length)
    return toB64(out)
  }

  async decrypt(data: string): Promise<string> {
    const raw = fromB64(data)
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, this.key, raw.slice(12))
    return new TextDecoder().decode(pt)
  }
}

/** Used when the browser offers no WebCrypto/IndexedDB: the login stays in memory only. */
export const noCipher: Cipher = {
  isAvailable: () => false,
  encrypt: () => Promise.reject(new Error('no secure storage')),
  decrypt: () => Promise.reject(new Error('no secure storage'))
}
