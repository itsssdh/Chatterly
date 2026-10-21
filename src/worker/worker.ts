/// <reference lib="webworker" />
import { boot, type Controller } from './controller'
import { IdbKv } from './idbKv'
import { openDb } from './idbKv'
import { MemoryKv, setKv } from './kv'
import { WebCipher, noCipher } from './webCipher'

declare const __APP_VERSION__: string

type Handler = (...args: unknown[]) => unknown
const handlers = new Map<string, Handler>()
const ctx = self as unknown as DedicatedWorkerGlobalScope

const post = (m: unknown): void => ctx.postMessage(m)

let controller: Controller | null = null
let ready: Promise<void> | null = null

async function start(): Promise<void> {
  let persistent = true
  try {
    setKv(await IdbKv.open(await openDb()))
  } catch {
    // IndexedDB is blocked (some private windows): run from memory, say so in the UI.
    setKv(new MemoryKv())
    persistent = false
  }
  const cipher = persistent ? ((await WebCipher.create()) ?? noCipher) : noCipher
  controller = await boot(
    {
      send: (channel, payload) => post({ t: 'event', channel, payload }),
      register: (channel, fn) => void handlers.set(channel, fn as Handler),
      openUrl: (url) => post({ t: 'openUrl', url })
    },
    { cipher, version: __APP_VERSION__, persistent }
  )
}

// A stray error goes to the log instead of silently stopping the engine.
const logUnexpected = (what: string): void => controller?.log.error(`Unexpected error: ${what}`.slice(0, 800))
ctx.addEventListener('error', (e) => logUnexpected(e.message))
ctx.addEventListener('unhandledrejection', (e) => logUnexpected(e.reason instanceof Error ? (e.reason.stack ?? e.reason.message) : String(e.reason)))

ctx.addEventListener('message', (e: MessageEvent) => {
  const m = e.data as { t: string; id?: number; channel?: string; args?: unknown[] }
  if (m.t === 'start') {
    ready ??= start().then(
      () => post({ t: 'ready' }),
      (err) => post({ t: 'fatal', message: err instanceof Error ? err.message : String(err) })
    )
  } else if (m.t === 'flush') {
    controller?.flush()
  } else if (m.t === 'invoke' && m.id !== undefined && m.channel) {
    const id = m.id
    void (ready ?? Promise.resolve())
      .then(async () => {
        const fn = handlers.get(m.channel!)
        if (!fn) throw new Error(`No handler for ${m.channel}`)
        return await fn(...(m.args ?? []))
      })
      .then(
        (value) => post({ t: 'result', id, value }),
        (err) => post({ t: 'result', id, error: err instanceof Error ? err.message : String(err) })
      )
  }
})
