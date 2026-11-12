/**
 * The pet's mood and the little things it does on its own.
 *
 * The mood follows what is going on — just petted, a milestone, a new page, a long
 * quiet stretch, the middle of the night — and decides which actions it picks from
 * when, every so often, it does something by itself: a hop, a spin, a stretch, a
 * look around, a yawn… with a small emote over its head and now and then a line.
 */

export type Mood = 'happy' | 'calm' | 'sleepy' | 'bored' | 'excited' | 'curious';

export const MOOD_NAME: Record<Mood, string> = {
  happy: '开心',
  calm: '平静',
  sleepy: '犯困',
  bored: '无聊',
  excited: '兴奋',
  curious: '好奇',
};

export type ActName = 'hop' | 'hop2' | 'spin' | 'flip' | 'sway' | 'nod' | 'look' | 'stretch' | 'yawn' | 'shiver';

/** how long each action's animation runs (ms) — keep in step with pet.css */
export const ACT_MS: Record<ActName, number> = {
  hop: 700,
  hop2: 1100,
  spin: 900,
  flip: 900,
  sway: 1600,
  nod: 1000,
  look: 1800,
  stretch: 1500,
  yawn: 2000,
  shiver: 900,
};

export const ACT_NAME: Record<ActName, string> = {
  hop: '跳一下',
  hop2: '蹦两下',
  spin: '转个圈',
  flip: '翻跟头',
  sway: '摇摆',
  nod: '点头',
  look: '左右张望',
  stretch: '伸懒腰',
  yawn: '打哈欠',
  shiver: '抖一抖',
};

export interface MoodContext {
  /** local hour, 0–23 */
  hour: number;
  /** ms since the reader last moved, typed or scrolled */
  idleMs: number;
  pagesToday: number;
  /** ms since it was petted / since something was celebrated / since the page changed */
  pettedAgo: number;
  cheeredAgo: number;
  pageAgo: number;
}

export function moodOf(c: MoodContext): Mood {
  if (c.cheeredAgo < 3 * 60_000) return 'excited';
  if (c.pettedAgo < 4 * 60_000) return 'happy';
  if (c.hour >= 23 || c.hour < 6) return 'sleepy';
  if (c.idleMs > 4 * 60_000) return 'bored';
  if (c.pageAgo < 60_000) return 'curious';
  if (c.pagesToday >= 10) return 'happy';
  return 'calm';
}

interface Repertoire {
  acts: ActName[];
  emotes: string[];
  lines: string[];
}

const REPERTOIRE: Record<Mood, Repertoire> = {
  happy: { acts: ['hop', 'sway', 'spin'], emotes: ['♪', '(•ᴗ•)', '♥'], lines: ['今天读得真顺', '有你在真好', '再摸摸我嘛'] },
  excited: { acts: ['flip', 'hop2', 'spin'], emotes: ['!!', '✦', '\\(^o^)/'], lines: ['太棒了！', '继续继续！'] },
  calm: { acts: ['nod', 'sway', 'look'], emotes: ['…', '(・ω・)', '~'], lines: ['我在这儿陪你', '慢慢读，不着急'] },
  sleepy: { acts: ['yawn', 'stretch', 'nod'], emotes: ['哈~', 'zZ', '(－ω－)'], lines: ['有点困了…', '夜深了，早点休息吧'] },
  bored: { acts: ['look', 'stretch', 'shiver'], emotes: ['?', '(¬_¬)', '…'], lines: ['翻一页给我看看嘛', '要不要我总结一下这页？'] },
  curious: { acts: ['look', 'nod', 'hop'], emotes: ['?', '!', '(°o°)'], lines: ['这页讲什么呀', '看到不懂的可以划词问我'] },
};

export interface Performance {
  act: ActName;
  emote: string;
  /** said only now and then */
  line?: string;
}

const pick = <T,>(xs: T[], r: number): T => xs[Math.min(xs.length - 1, Math.floor(r * xs.length))];

/** What it does next in this mood. `rand` yields numbers in [0, 1). */
export function perform(mood: Mood, rand: () => number = Math.random, last?: ActName): Performance {
  const rep = REPERTOIRE[mood];
  const acts = rep.acts.length > 1 ? rep.acts.filter((a) => a !== last) : rep.acts;
  const act = pick(acts, rand());
  const emote = pick(rep.emotes, rand());
  const line = rand() < 0.3 ? pick(rep.lines, rand()) : undefined;
  return { act, emote, line };
}

/** A trick on request: anything showy, never the same twice in a row. */
export function trick(rand: () => number = Math.random, last?: ActName): Performance {
  const acts = (['flip', 'spin', 'hop2', 'sway', 'stretch'] as ActName[]).filter((a) => a !== last);
  return { act: pick(acts, rand()), emote: pick(['♪', '✦', '(•ᴗ•)'], rand()) };
}
