export interface IrcMessage {
  raw: string
  tags: Record<string, string>
  prefix: string | null
  command: string
  params: string[]
  /** Last parameter (the part after " :"), if any. */
  trailing: string | null
}

const TAG_ESCAPES: Record<string, string> = { ':': ';', s: ' ', r: '\r', n: '\n', '\\': '\\' }

function unescapeTag(v: string): string {
  return v.replace(/\\(.)/g, (_, c: string) => TAG_ESCAPES[c] ?? c)
}

export function parseIrc(line: string): IrcMessage | null {
  let rest = line.replace(/[\r\n]+$/, '')
  if (!rest) return null
  const tags: Record<string, string> = {}
  if (rest.startsWith('@')) {
    const sp = rest.indexOf(' ')
    if (sp < 0) return null
    for (const part of rest.slice(1, sp).split(';')) {
      const eq = part.indexOf('=')
      if (eq < 0) tags[part] = ''
      else tags[part.slice(0, eq)] = unescapeTag(part.slice(eq + 1))
    }
    rest = rest.slice(sp + 1).trimStart()
  }
  let prefix: string | null = null
  if (rest.startsWith(':')) {
    const sp = rest.indexOf(' ')
    if (sp < 0) return null
    prefix = rest.slice(1, sp)
    rest = rest.slice(sp + 1).trimStart()
  }
  let trailing: string | null = null
  const ti = rest.indexOf(' :')
  if (ti >= 0) {
    trailing = rest.slice(ti + 2)
    rest = rest.slice(0, ti)
  }
  const parts = rest.split(' ').filter(Boolean)
  const command = parts.shift()
  if (!command) return null
  const params = parts
  if (trailing !== null) params.push(trailing)
  return { raw: line, tags, prefix, command, params, trailing }
}

export interface ChatMessage {
  id: string
  channel: string
  userId: string
  login: string
  displayName: string
  text: string
  ts: number
  isAction: boolean
  badges: string[]
  /** Twitch-native emote names used in this message (from the emotes tag ranges). */
  nativeEmotes: string[]
}

export function toChatMessage(m: IrcMessage, now = Date.now()): ChatMessage | null {
  if (m.command !== 'PRIVMSG' || m.params.length < 2) return null
  const channel = m.params[0].replace(/^#/, '').toLowerCase()
  let text = m.params[1]
  let isAction = false
  // eslint-disable-next-line no-control-regex
  const action = /^\u0001ACTION (.*?)\u0001?$/.exec(text)
  if (action) {
    isAction = true
    text = action[1]
  }
  const login = (m.prefix ?? '').split('!')[0].toLowerCase()
  const nativeEmotes: string[] = []
  const emoteTag = m.tags['emotes']
  if (emoteTag) {
    for (const group of emoteTag.split('/')) {
      const range = group.split(':')[1]?.split(',')[0]
      if (!range) continue
      const [s, e] = range.split('-').map(Number)
      const name = text.slice(s, e + 1)
      if (name && !nativeEmotes.includes(name)) nativeEmotes.push(name)
    }
  }
  return {
    id: m.tags['id'] || `${login}-${now}`,
    channel,
    userId: m.tags['user-id'] ?? '',
    login,
    displayName: m.tags['display-name'] || login,
    text,
    // Local receive time is used so context windows aren't skewed by clock drift.
    ts: now,
    isAction,
    badges: (m.tags['badges'] ?? '').split(',').filter(Boolean).map((b) => b.split('/')[0]),
    nativeEmotes
  }
}
