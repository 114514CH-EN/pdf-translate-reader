/**
 * Playing with the pet: things to do with it that are not reading help.
 *
 *   零食与亲密度 — reading earns treats (a page, the day's goal, a focus round); feeding
 *                  them raises the bond, which has levels with names and unlocks small
 *                  charms that float over the pet's head.
 *   扔球         — a ball that can be thrown around the window; the pet walks over and
 *                  kicks it back (see PetBall.tsx).
 *   猜拳         — rock–paper–scissors.
 *   考术语       — multiple choice from this document's glossary; no model is called.
 *   今日签       — one draw a day, the same all day.
 *
 * Everything is kept in this browser's localStorage; nothing is sent anywhere.
 */
import { dayOf } from './companion';

export const BOND_KEY = 'pdftr.pet.bond';

export type CharmId = 'none' | 'sprout' | 'star' | 'bow' | 'crown' | 'halo';

export interface Bond {
  xp: number;
  treats: number;
  /** local date the daily counters below belong to */
  day: string;
  /** treats eaten today */
  fed: number;
  /** treats won from games today */
  won: number;
  /** today's fortune has been drawn */
  drawn: boolean;
  rps: { win: number; lose: number; draw: number };
  quiz: { right: number; total: number };
  charm: CharmId;
}

export const FULL_AT = 6;
export const FEED_XP = 8;
export const WIN_CAP = 5;

export const LEVELS: { at: number; title: string; charm: CharmId; charmName: string }[] = [
  { at: 0, title: '初次见面', charm: 'none', charmName: '不戴' },
  { at: 30, title: '有点熟了', charm: 'sprout', charmName: '嫩芽' },
  { at: 80, title: '读书搭子', charm: 'star', charmName: '星星' },
  { at: 160, title: '老朋友', charm: 'bow', charmName: '蝴蝶结' },
  { at: 280, title: '形影不离', charm: 'crown', charmName: '小皇冠' },
  { at: 450, title: '灵魂书友', charm: 'halo', charmName: '光环' },
];

function fresh(day: string): Bond {
  return { xp: 0, treats: 2, day, fed: 0, won: 0, drawn: false, rps: { win: 0, lose: 0, draw: 0 }, quiz: { right: 0, total: 0 }, charm: 'none' };
}

/** Daily counters start over on a new day. */
export function today(b: Bond, now = Date.now()): Bond {
  const day = dayOf(now);
  return b.day === day ? b : { ...b, day, fed: 0, won: 0, drawn: false };
}

export function loadBond(now = Date.now()): Bond {
  const base = fresh(dayOf(now));
  try {
    const raw = window.localStorage.getItem(BOND_KEY);
    if (!raw) return base;
    const b = JSON.parse(raw) as Partial<Bond>;
    const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : d);
    return today(
      {
        xp: num(b.xp),
        treats: num(b.treats),
        day: typeof b.day === 'string' ? b.day : base.day,
        fed: num(b.fed),
        won: num(b.won),
        drawn: b.drawn === true,
        rps: { win: num(b.rps?.win), lose: num(b.rps?.lose), draw: num(b.rps?.draw) },
        quiz: { right: num(b.quiz?.right), total: num(b.quiz?.total) },
        charm: LEVELS.some((l) => l.charm === b.charm) ? (b.charm as CharmId) : 'none',
      },
      now,
    );
  } catch {
    return base;
  }
}

export function saveBond(b: Bond): void {
  try {
    window.localStorage.setItem(BOND_KEY, JSON.stringify(b));
  } catch {
    /* private window: lasts for this page only */
  }
}

/** 1-based level, its name, and how far along to the next one (0…1; 1 at the top). */
export function levelOf(xp: number): { level: number; title: string; into: number; next: number | null } {
  let i = 0;
  while (i + 1 < LEVELS.length && xp >= LEVELS[i + 1].at) i += 1;
  const next = LEVELS[i + 1]?.at ?? null;
  const into = next === null ? 1 : (xp - LEVELS[i].at) / (next - LEVELS[i].at);
  return { level: i + 1, title: LEVELS[i].title, into, next };
}

export function charmUnlocked(xp: number, charm: CharmId): boolean {
  const l = LEVELS.find((x) => x.charm === charm);
  return !!l && xp >= l.at;
}

export function gain(b: Bond, add: { xp?: number; treats?: number }): Bond {
  return { ...b, xp: b.xp + (add.xp ?? 0), treats: Math.min(99, b.treats + (add.treats ?? 0)) };
}

export type FeedResult = { ok: true; bond: Bond; levelUp: number | null } | { ok: false; why: 'empty' | 'full' };

export function feed(b0: Bond, now = Date.now()): FeedResult {
  const b = today(b0, now);
  if (b.treats < 1) return { ok: false, why: 'empty' };
  if (b.fed >= FULL_AT) return { ok: false, why: 'full' };
  const before = levelOf(b.xp).level;
  const bond = { ...b, treats: b.treats - 1, fed: b.fed + 1, xp: b.xp + FEED_XP };
  const after = levelOf(bond.xp).level;
  return { ok: true, bond, levelUp: after > before ? after : null };
}

// ------------------------------------------------------------------ rock–paper–scissors

export type Hand = 'rock' | 'scissors' | 'paper';
export const HANDS: Hand[] = ['rock', 'scissors', 'paper'];
export const HAND_NAME: Record<Hand, string> = { rock: '石头', scissors: '剪刀', paper: '布' };
export const HAND_FACE: Record<Hand, string> = { rock: '✊', scissors: '✌️', paper: '🖐️' };

/** From the player's side. */
export function judge(mine: Hand, theirs: Hand): 'win' | 'lose' | 'draw' {
  if (mine === theirs) return 'draw';
  const beats: Record<Hand, Hand> = { rock: 'scissors', scissors: 'paper', paper: 'rock' };
  return beats[mine] === theirs ? 'win' : 'lose';
}

/** A game result: wins pay a treat, up to a few a day. */
export function playedRps(b0: Bond, result: 'win' | 'lose' | 'draw', now = Date.now()): { bond: Bond; treat: boolean } {
  const b = today(b0, now);
  const rps = { ...b.rps, [result]: b.rps[result] + 1 };
  const treat = result === 'win' && b.won < WIN_CAP;
  return { bond: { ...b, rps, xp: b.xp + 1, treats: treat ? Math.min(99, b.treats + 1) : b.treats, won: treat ? b.won + 1 : b.won }, treat };
}

// ------------------------------------------------------------------ glossary quiz

export interface QuizTerm {
  src: string;
  tgt: string;
}
export interface QuizCard {
  ask: string;
  /** which side is shown: the source term or its translation */
  side: 'src' | 'tgt';
  options: string[];
  answer: number;
}

export const QUIZ_MIN = 4;
export const QUIZ_LEN = 5;

function shuffle<T>(list: T[], rnd: () => number): T[] {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Terms worth asking about: both sides filled in, each side unique. */
export function quizPool(terms: { src_term: string; tgt_term: string; status: string }[]): QuizTerm[] {
  const seenS = new Set<string>();
  const seenT = new Set<string>();
  const out: QuizTerm[] = [];
  for (const t of terms) {
    const src = (t.src_term ?? '').trim();
    const tgt = (t.tgt_term ?? '').trim();
    if (!src || !tgt || t.status === 'rejected' || src.toLowerCase() === tgt.toLowerCase()) continue;
    if (seenS.has(src.toLowerCase()) || seenT.has(tgt.toLowerCase())) continue;
    seenS.add(src.toLowerCase());
    seenT.add(tgt.toLowerCase());
    out.push({ src, tgt });
  }
  return out;
}

export function buildQuiz(pool: QuizTerm[], rnd: () => number = Math.random, n = QUIZ_LEN): QuizCard[] {
  if (pool.length < QUIZ_MIN) return [];
  return shuffle(pool, rnd)
    .slice(0, n)
    .map((t) => {
      const side: 'src' | 'tgt' = rnd() < 0.5 ? 'src' : 'tgt';
      const others = shuffle(pool.filter((p) => p !== t), rnd).slice(0, 3);
      const options = shuffle([t, ...others], rnd);
      return {
        ask: side === 'src' ? t.src : t.tgt,
        side,
        options: options.map((o) => (side === 'src' ? o.tgt : o.src)),
        answer: options.indexOf(t),
      };
    });
}

export function quizDone(b0: Bond, right: number, total: number, now = Date.now()): { bond: Bond; treat: boolean } {
  const b = today(b0, now);
  const treat = total >= QUIZ_MIN && right >= total - 1 && b.won < WIN_CAP;
  return {
    bond: {
      ...b,
      quiz: { right: b.quiz.right + right, total: b.quiz.total + total },
      xp: b.xp + right * 2,
      treats: treat ? Math.min(99, b.treats + 1) : b.treats,
      won: treat ? b.won + 1 : b.won,
    },
    treat,
  };
}

// ------------------------------------------------------------------ fortune of the day

export interface Fortune {
  grade: string;
  line: string;
  good: string;
  pages: number;
  minutes: number;
}

const GRADES = ['上上签', '上签', '上签', '中吉', '中吉', '小吉', '小吉', '平签'];
const LINES = [
  '今天读到的那句难懂的话，过两页就会自己解释清楚。',
  '慢一点没关系，看懂一页胜过翻过十页。',
  '有一个你一直绕开的公式，今天适合正面碰一碰。',
  '先看图再看字，今天图表会特别好懂。',
  '把不认识的词丢进术语表，明天的你会感谢今天的你。',
  '今天适合把上次没读完的那篇收个尾。',
  '读累了就站起来走两步，回来会发现卡住的地方松动了。',
  '试着用自己的话把一段讲给我听，讲得出来就是真的懂了。',
  '今天的灵感藏在脚注和参考文献里。',
  '开头最难，读过第一页后面就顺了。',
  '今天适合做笔记：写下来的东西才是你的。',
  '遇到长句别慌，先找主语和谓语。',
];
const GOODS = ['精读一小节', '整理术语表', '开一轮专注', '回看昨天的笔记', '读摘要和结论', '做一次本页自测', '把高亮过一遍', '先读图表'];
const PAGES = [5, 8, 10, 12, 15, 20];
const MINUTES = [15, 25, 25, 45];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** The same draw all day; a different one tomorrow. */
export function fortuneOf(day: string): Fortune {
  const pick = <T,>(list: T[], salt: string) => list[hash(`${day}/${salt}`) % list.length];
  return {
    grade: pick(GRADES, 'grade'),
    line: pick(LINES, 'line'),
    good: pick(GOODS, 'good'),
    pages: pick(PAGES, 'pages'),
    minutes: pick(MINUTES, 'minutes'),
  };
}

export function drewFortune(b0: Bond, now = Date.now()): { bond: Bond; first: boolean } {
  const b = today(b0, now);
  if (b.drawn) return { bond: b, first: false };
  return { bond: { ...b, drawn: true, treats: Math.min(99, b.treats + 1) }, first: true };
}

// ------------------------------------------------------------------ things it says

export const YUM = ['好吃！', '嚼嚼嚼……', '还要还要', '谢谢款待～', '(๑´ڡ`๑)'];
export const FULL = ['吃不下啦，明天再喂吧', '肚子圆了……', '饱了饱了'];
export const KICK = ['看我的！', '接着！', '嘿！', '再来！'];
export const TIRED = ['呼……歇一会儿，你再扔我就再踢', '跑不动啦，歇会儿'];

export function pick<T>(list: T[], rnd: () => number = Math.random): T {
  return list[Math.floor(rnd() * list.length)];
}
