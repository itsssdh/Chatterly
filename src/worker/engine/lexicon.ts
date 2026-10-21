import type { Personality } from '@shared/types'

/**
 * Moods the engine can react to. Each is detected from what *other chatters* just wrote,
 * so a reaction is only ever generated when chat itself shows that moment happened.
 */
export type Mood = 'laugh' | 'hype' | 'win' | 'loss' | 'shock' | 'greet' | 'filler'
export const REACTIVE_MOODS: Mood[] = ['laugh', 'hype', 'win', 'loss', 'shock', 'greet']

/** What a chat message looks like when it expresses a mood. Matched per message, counted per distinct user. */
export const CHAT_PATTERNS: Record<Exclude<Mood, 'filler'>, RegExp> = {
  laugh: /\b(l+u+l+w?|kek\w*|omegalul|lmf?ao+|lol+|ha(ha)+|icant|dead|xd+)\b|😂|🤣/i,
  hype: /\b(pog\w*|poggers|let'?s ?go+|hype\w*|insane|clutch|sheesh|goat(ed)?|cracked|crazy|nuts|w{2,}|ayo+)\b|!{3,}/i,
  win: /\b(ggs?|gz|ez|congrats?|congratulations|victory|winner|wins?|won|first try)\b/i,
  loss: /^f+$|\b(rip|oof|unlucky|sadge|rekt|ff|wiped?|died|lost|pepehands|feelsbadman)\b/i,
  shock: /\b(wtf|no way|omg|monka\w*|holy|bruh|wow|what the|pausechamp|huh)\b/i,
  greet: /^(hi+|hello+|hey+|yo+|sup|gm|good (morning|evening|afternoon))\b|\bhello chat\b|\bhey chat\b/i
}

/** Topics where jumping in with a reaction would be tone-deaf. Reactions are suppressed while these are fresh. */
export const SENSITIVE_PATTERN =
  /\b(died|dying|death|passed away|funeral|cancer|suicid\w*|kill (myself|yourself)|self.?harm|overdose|sorry for your loss|rip (to|in)|my (dad|mom|mum|grandma|grandpa|dog|cat) (died|passed))\b/i

/** Names that must never be posted, whether they come from our own text or a channel's emote list. */
export const DEFAULT_BLOCKED =
  /n[i1!]gg|f[a4]gg?[o0]t|retard|tr[a4]nn(y|ies)|k[i1]ke|ch[i1]nk|sp[i1]c\b|c[u]nt|rape|r[a4]p[i1]st|nazi|hitler|suicide|kys\b|kill yourself/i

/** Chatters that are infrastructure, not people. Their lines never count as context. */
export const BOT_LOGINS = new Set([
  'nightbot',
  'streamelements',
  'streamlabs',
  'moobot',
  'fossabot',
  'wizebot',
  'sery_bot',
  'soundalerts',
  'commanderroot',
  'streamlabsbot',
  'pretzelrocks'
])

/** Emote-name classification. Names are matched against *real* emotes fetched from 7TV; nothing here is an ID. */
export const EMOTE_MOOD_PATTERNS: Record<Exclude<Mood, 'filler'>, RegExp> = {
  laugh: /(kek|lul|lmao|laugh|icant|ahaha|haha|4head|jebaited|omegalul|lulw)/i,
  hype: /^(pog\w*|letsgo\w*|lets?go\w*|hype\w*|yippee|gigachad|widehard\w*|catjam|pepejam|ez|sheesh|based\w*|clap\w*|peepoclap|ayaya|oooo|poggies|pogu)$/i,
  win: /^(ez\w*|gg\w*|clap\w*|gigachad|winner|peepoclap|yippee|pog\w*|based\w*|gz|w|feelsgoodman|feelsstrongman|ez ?clap)$/i,
  loss: /^(sadge|f|rip|pepehands|feelsbadman|peeposad|widepeeposad|sadcat|cry\w*|copium|despair|madge|oof|sadge\w*|feelsweirdman|bedge)$/i,
  shock: /(monka|pausechamp|ohno|omg|wtf|^huh|bruh|susge|clueless|^aware$|^stare$|shocked|widepog|^ooo)/i,
  greet: /^(peepohey|wave\w*|hello\w*|hi+|hey\w*|catwave|modcheck|dinkdonk|hellow|peepowave|yo)$/i
}

/** Mild positive emotes that fit almost any low-stakes moment. */
export const GENERIC_EMOTE_PATTERN =
  /^(peepohappy|widepeepohappy|okayge|clap|catjam|gladge|peepoclap|noted|chatting|comfy|peepocomfy|heart\w*|pepelove|blush\w*|ayaya|yippee|nice|thumbsup)$/i

/** Common single-emote reactions, used only when that emote exists in the channel's real emote pool. */
export const STARTER_COMBOS: Record<Exclude<Mood, 'filler'>, string[][]> = {
  laugh: [['KEKW'], ['LMFAO'], ['LMAO'], ['LOL'], ['ROFL']],
  hype: [['LETSGO'], ['Clap'], ['catJAM'], ['YIPPEE'], ['GIGACHAD']],
  win: [['EZ'], ['Clap'], ['GIGACHAD'], ['peepoClap'], ['YIPPEE']],
  loss: [['Sadge'], ['F'], ['widepeepoSad'], ['peepoSad'], ['FeelsBadMan'], ['PepeHands']],
  shock: [['monkaS'], ['monkaW'], ['PauseChamp'], ['OMEGALUL'], ['Aware'], ['Stare'], ['Susge'], ['Clueless']],
  greet: [['peepoHey'], ['HELLO'], ['Wave'], ['catWave'], ['hello'], ['peepoHappy']]
}

type Bank = Record<Mood, string[]>

const CHILL: Bank = {
  laugh: ['lmao', 'lol', 'that got me', 'ok that was funny', 'lmaooo', 'dead', 'haha nice', "can't stop laughing", 'ok lol', 'bro'],
  hype: ['lets go', 'W', "ok that's hype", 'nice', 'sheesh', 'ayo', 'lets goo', 'this is good', "chat's up", 'ok ok ok'],
  win: ['gg', 'gg gg', 'nice one', 'W', 'well deserved', 'ez', 'gz', 'ggs'],
  loss: ['F', 'oof', 'rip', 'unlucky', 'pain', 'it happens', 'ah man', 'o7'],
  shock: ['wait what', 'huh', 'bruh', 'no way', 'ayo?', 'wait', 'what happened', 'ok wow'],
  greet: ['hey chat', 'hello chat', 'yo', 'hi chat', 'hey all', 'sup chat', 'hello'],
  filler: ['nice vibes in here', 'pretty chill in here', 'ok this is comfy', 'good times', 'chat is good today', 'this is nice', 'solid']
}

const PERSONALITY_BANKS: Record<Personality, Partial<Bank>> = {
  chill: {},
  playful: {
    laugh: ['I cant', 'stoppp', 'im weak', 'ok that was actually good', 'chat is unwell', 'help', 'why is that so funny'],
    hype: ['hold on this is getting good', 'we are so back', 'ok ok OK', 'actual chaos', 'chat we are feasting', 'oh we are cooking'],
    win: ['we take those', 'gg no re', 'easy money', 'clean', 'big W energy', 'that is a W'],
    loss: ['pain.', 'we go again', 'a moment of silence', 'F in chat', 'its fine. were fine', 'big oof'],
    shock: ['hold on', 'excuse me??', 'wait wait wait', 'ok what', 'did that just happen', 'hello??'],
    greet: ['hi chat, behave', 'hello besties', 'evening chat', 'hellooo', 'whats up chat']
  },
  supportive: {
    laugh: ['that was great', 'ok that made me smile', 'love this chat', 'haha so good', 'you guys are funny'],
    hype: ['love to see it', 'so good', 'amazing', "that's awesome", 'proud of that', 'this is great'],
    win: ['congrats!', 'well done!', 'so deserved', 'great job', 'nice work', 'gg, well played'],
    loss: ['you got this', "next one's yours", 'happens to everyone', 'shake it off', 'still a good run', 'no worries'],
    shock: ['oh wow', 'wait really', 'whoa', 'oh no, hope all good', 'that was wild'],
    greet: ['hi everyone', 'hello chat, hope you are well', 'hey friends', 'good to be here', 'hi chat']
  },
  gaming: {
    laugh: ['that was a throw', 'bro what was that', 'lmao the play', 'ok that was bad', 'bot play'],
    hype: ['lets gooo', 'cracked', 'clutch', 'insane play', 'ok he is him', 'diff', 'that was clean'],
    win: ['gg wp', 'ggs', 'gg ez', 'well played', 'gg go next', 'clean win'],
    loss: ['unlucky', 'gg next', 'rip run', 'lag?', 'we go again', 'so close'],
    shock: ['how', 'no shot', 'bro what', 'wait what was that', 'that cant be real', 'huh how'],
    greet: ['gl hf', 'hey chat, gl today', 'yo whats the plan', 'hello chat', 'o/']
  },
  emotes: {
    laugh: ['lmao', 'lol'],
    hype: ['W', 'lets go', 'nice'],
    win: ['gg', 'W', 'ez'],
    loss: ['F', 'oof'],
    shock: ['wait', 'huh', 'bruh'],
    greet: ['hi', 'yo', 'hello'],
    filler: ['nice', 'vibes']
  }
}

/** Lines for a mood. Personality lines are listed twice so they outweigh the shared chill baseline. */
export function textBank(personality: Personality, mood: Mood): string[] {
  const own = PERSONALITY_BANKS[personality][mood] ?? []
  if (personality === 'emotes') return own.length ? own : CHILL[mood].slice(0, 3)
  return [...CHILL[mood].slice(0, personality === 'chill' ? undefined : 4), ...own, ...own]
}

/** Per-personality style knobs for the final "sound like a person" pass. */
export const STYLE: Record<Personality, { lower: number; dropPunct: number; elongate: number; interject: number }> = {
  chill: { lower: 0.85, dropPunct: 0.85, elongate: 0.15, interject: 0.12 },
  playful: { lower: 0.55, dropPunct: 0.5, elongate: 0.2, interject: 0.1 },
  supportive: { lower: 0.3, dropPunct: 0.25, elongate: 0.05, interject: 0 },
  gaming: { lower: 0.7, dropPunct: 0.8, elongate: 0.12, interject: 0.08 },
  emotes: { lower: 0.9, dropPunct: 0.95, elongate: 0.1, interject: 0 }
}

export const INTERJECTIONS = ['ok ', 'ngl ', 'yo ', 'lowkey ', 'honestly ']
