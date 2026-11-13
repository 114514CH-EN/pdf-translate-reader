/**
 * The pet as a study companion: a focus timer and a small reading log.
 *
 *   专注计时 — 15 / 25 / 45 minutes of quiet (no wandering, no tips), then a 5-minute
 *              break; the pet carries the countdown and tells you when either ends.
 *   今日阅读 — pages opened and minutes spent reading today, and how many days in a
 *              row something was read. Round numbers of pages get a small cheer.
 *
 * Everything lives in this browser's localStorage; nothing is sent anywhere.
 */

export const FOCUS_KEY = 'pdftr.pet.focus';
export const STATS_KEY = 'pdftr.pet.stats';
export const FOCUS_CHOICES = [15, 25, 45] as const;
export const BREAK_MIN = 5;
export const MILESTONES = [10, 25, 50, 100] as const;
export const GOAL_CHOICES = [5, 10, 20, 30] as const;
export const DEFAULT_GOAL = 10;

export interface FocusState {
  phase: 'focus' | 'break';
  /** epoch ms */
  endsAt: number;
  minutes: number;
}

export interface Stats {
  /** local date, YYYY-MM-DD */
  day: string;
  /** "doc:page" opened today (each counted once) */
  pages: string[];
  minutes: number;
  focus: number;
  /** days in a row with at least one page, including `day` when pages is not empty */
  streak: number;
  /** the last day a page was read */
  lastRead: string;
  /** pages read on earlier days (the last six that had any), by date */
  week?: Record<string, number>;
  /** pages to read in a day */
  goal?: number;
}

function read<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private window: lasts for this page only */
  }
}

export function dayOf(now: number): string {
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ------------------------------------------------------------------ focus timer

export function loadFocus(now = Date.now()): FocusState | null {
  const f = read<FocusState>(FOCUS_KEY);
  if (!f || (f.phase !== 'focus' && f.phase !== 'break') || !(f.endsAt > now)) return null;
  return f;
}

export function saveFocus(f: FocusState | null): void {
  write(FOCUS_KEY, f);
}

export function startFocus(minutes: number, now = Date.now()): FocusState {
  return { phase: 'focus', endsAt: now + minutes * 60_000, minutes };
}

export function startBreak(now = Date.now()): FocusState {
  return { phase: 'break', endsAt: now + BREAK_MIN * 60_000, minutes: BREAK_MIN };
}

/** "24:59" */
export function clock(msLeft: number): string {
  const s = Math.max(0, Math.ceil(msLeft / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ------------------------------------------------------------------ reading log

const EMPTY: Stats = { day: '', pages: [], minutes: 0, focus: 0, streak: 0, lastRead: '' };

/** Today's log; a log from another day is rolled over (the streak survives one night, not two). */
export function rollOver(stats: Stats | null, now: number): Stats {
  const today = dayOf(now);
  const s = stats ?? EMPTY;
  if (s.day === today) return s;
  const yesterday = dayOf(now - 86_400_000);
  const alive = s.lastRead === yesterday || s.lastRead === today;
  // the day that ended goes into the week's record; only the last six days are kept
  const week: Record<string, number> = {};
  const from = dayOf(now - 6 * 86_400_000);
  for (const [d, n] of Object.entries({ ...(s.week ?? {}), ...(s.day && s.pages.length ? { [s.day]: s.pages.length } : {}) })) {
    if (d >= from && d < today) week[d] = n;
  }
  return { day: today, pages: [], minutes: 0, focus: 0, streak: alive ? s.streak : 0, lastRead: s.lastRead, week, goal: s.goal };
}

export function loadStats(now = Date.now()): Stats {
  const s = read<Stats>(STATS_KEY);
  const ok = s && typeof s.day === 'string' && Array.isArray(s.pages);
  return rollOver(ok ? { ...EMPTY, ...s } : null, now);
}

export function saveStats(s: Stats): void {
  write(STATS_KEY, s);
}

export interface PageResult {
  stats: Stats;
  /** a round number of pages was just reached today */
  milestone?: number;
  /** first page of the day and the streak is at least 2 */
  streakDay?: number;
  /** today's goal was just reached */
  goal?: number;
}

/** A page was opened and stayed open long enough to count as read. */
export function recordPage(stats: Stats, docId: string, page: number, now = Date.now()): PageResult {
  const s = rollOver(stats, now);
  const key = `${docId}:${page}`;
  if (s.pages.includes(key)) return { stats: s };
  const first = s.pages.length === 0;
  const pages = [...s.pages, key].slice(-2000);
  const streak = first ? s.streak + 1 : s.streak;
  const next: Stats = { ...s, pages, streak, lastRead: s.day };
  const milestone = MILESTONES.find((m) => m === pages.length);
  const goal = goalOf(next);
  return { stats: next, milestone, streakDay: first && streak >= 2 ? streak : undefined, goal: pages.length === goal ? goal : undefined };
}

export function addMinute(stats: Stats, now = Date.now()): Stats {
  const s = rollOver(stats, now);
  return { ...s, minutes: s.minutes + 1 };
}

export function addFocus(stats: Stats, now = Date.now()): Stats {
  const s = rollOver(stats, now);
  return { ...s, focus: s.focus + 1 };
}

export function goalOf(s: Stats): number {
  return s.goal && s.goal > 0 ? s.goal : DEFAULT_GOAL;
}

/** The last seven days, oldest first, today last: pages read on each. */
export function weekOf(s: Stats, now = Date.now()): { day: string; label: string; pages: number; today: boolean }[] {
  const names = ['日', '一', '二', '三', '四', '五', '六'];
  const out = [];
  for (let i = 6; i >= 0; i--) {
    const t = now - i * 86_400_000;
    const day = dayOf(t);
    out.push({ day, label: names[new Date(t).getDay()], pages: i === 0 ? s.pages.length : (s.week?.[day] ?? 0), today: i === 0 });
  }
  return out;
}

/** "今天 12 页 · 35 分钟 · 连续 3 天" */
export function summary(s: Stats): string {
  const parts = [`今天 ${s.pages.length} 页`];
  if (s.minutes > 0) parts.push(s.minutes >= 60 ? `${Math.floor(s.minutes / 60)} 小时 ${s.minutes % 60} 分` : `${s.minutes} 分钟`);
  if (s.focus > 0) parts.push(`专注 ${s.focus} 次`);
  if (s.streak >= 2) parts.push(`连续 ${s.streak} 天`);
  return parts.join(' · ');
}
