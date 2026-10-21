/* eslint-disable @typescript-eslint/no-explicit-any */
type Handler = (...args: any[]) => void

/**
 * The browser WebSocket behind the small Node-style interface the chat client was written against
 * (`on`, `removeAllListeners`, `terminate`), so the client itself is unchanged.
 */
export default class NodeStyleSocket {
  static readonly OPEN = 1
  private ws: WebSocket
  private handlers = new Map<string, EventListener>()
  private closeFns: Handler[] = []
  private closed = false

  constructor(url: string) {
    this.ws = new WebSocket(url)
    this.ws.addEventListener('close', () => (this.closed = true))
  }

  get readyState(): number {
    return this.ws.readyState
  }

  on(event: 'open' | 'message' | 'error' | 'close', fn: Handler): this {
    const listener: EventListener = (e) => {
      if (event === 'message') fn((e as MessageEvent).data)
      else if (event === 'error') fn(new Error('connection error'))
      else fn()
    }
    if (event === 'close') this.closeFns.push(fn)
    this.ws.addEventListener(event, listener)
    this.handlers.set(`${event}:${this.handlers.size}`, listener)
    return this
  }

  removeAllListeners(event?: string): this {
    for (const [k, l] of [...this.handlers]) {
      const name = k.split(':')[0]
      if (event && name !== event) continue
      this.ws.removeEventListener(name, l)
      this.handlers.delete(k)
    }
    return this
  }

  send(data: string): void {
    this.ws.send(data)
  }

  close(): void {
    this.ws.close()
  }

  /**
   * There is no hard-kill in browsers. A dead connection can take a long time to finish closing, so if the
   * `close` event hasn't arrived shortly, listeners are told the connection is gone.
   */
  terminate(): void {
    this.ws.close()
    setTimeout(() => {
      if (this.closed) return
      this.closed = true
      for (const fn of this.closeFns) fn()
    }, 3000)
  }
}
