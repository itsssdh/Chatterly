import { join, kv, removeKey } from './kv'

export interface StoredToken {
  accessToken: string
  refreshToken: string
  /** ms epoch when the access token stops working */
  expiresAt: number
  login: string
  userId: string
  scopes: string[]
  clientId: string
  /** When the refresh token was last exchanged (each exchange restarts Twitch's 30-day idle window). */
  refreshedAt?: number
}

export interface Cipher {
  isAvailable(): boolean
  encrypt(plain: string): Promise<string>
  decrypt(data: string): Promise<string>
}

/**
 * The Twitch login is encrypted (AES-GCM, with a key the browser keeps non-extractable) before it is stored.
 * If encryption is unavailable the login is kept in memory only and never written in plain text.
 */
export class TokenVault {
  private key: string
  private memory: StoredToken | null = null
  /** Writes happen one after another, and a clear() overrides any save still in flight. */
  private chain: Promise<void> = Promise.resolve()
  private version = 0

  constructor(
    dir: string,
    private cipher: Cipher,
    /** Called when a saved login exists but can't be read. */
    private onUnreadable?: (why: string) => void
  ) {
    this.key = join(dir, 'twitch-token')
  }

  get persistent(): boolean {
    return this.cipher.isAvailable()
  }

  /** Decrypts the saved login (if any) into memory. Call once before `load()`. */
  async init(): Promise<void> {
    const stored = kv().get(this.key)
    if (this.memory || !this.cipher.isAvailable() || stored === null) return
    try {
      this.memory = JSON.parse(await this.cipher.decrypt(stored)) as StoredToken
    } catch (err) {
      this.onUnreadable?.(err instanceof Error ? err.message : String(err))
    }
  }

  load(): StoredToken | null {
    return this.memory
  }

  save(token: StoredToken): void {
    this.memory = token
    if (!this.cipher.isAvailable()) return
    const v = ++this.version
    const plain = JSON.stringify(token)
    this.chain = this.chain.then(async () => {
      try {
        const sealed = await this.cipher.encrypt(plain)
        if (v === this.version) kv().set(this.key, sealed)
      } catch (err) {
        this.onUnreadable?.(`could not save the login: ${err instanceof Error ? err.message : err}`)
      }
    })
  }

  /** Resolves once everything handed to save() is stored. */
  settled(): Promise<void> {
    return this.chain
  }

  clear(): void {
    this.memory = null
    this.version++
    removeKey(this.key)
  }
}
