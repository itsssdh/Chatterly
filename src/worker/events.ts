/* eslint-disable @typescript-eslint/no-explicit-any */
type Listener = (...args: any[]) => void

/** The small part of Node's EventEmitter the engine uses (browsers have no `node:events`). */
export class EventEmitter {
  private handlers = new Map<string, Listener[]>()

  on(event: string, listener: Listener): this {
    const list = this.handlers.get(event)
    if (list) list.push(listener)
    else this.handlers.set(event, [listener])
    return this
  }

  once(event: string, listener: Listener): this {
    const wrapper: Listener = (...args) => {
      this.off(event, wrapper)
      listener(...args)
    }
    return this.on(event, wrapper)
  }

  off(event: string, listener: Listener): this {
    const list = this.handlers.get(event)
    if (list) {
      const i = list.indexOf(listener)
      if (i >= 0) list.splice(i, 1)
      if (!list.length) this.handlers.delete(event)
    }
    return this
  }

  removeListener(event: string, listener: Listener): this {
    return this.off(event, listener)
  }

  removeAllListeners(event?: string): this {
    if (event === undefined) this.handlers.clear()
    else this.handlers.delete(event)
    return this
  }

  listenerCount(event: string): number {
    return this.handlers.get(event)?.length ?? 0
  }

  emit(event: string, ...args: any[]): boolean {
    const list = this.handlers.get(event)
    if (!list?.length) return false
    for (const l of [...list]) l(...args)
    return true
  }
}
