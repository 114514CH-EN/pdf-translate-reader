/**
 * 桌宠的外观。
 *
 * 默认是随程序附带的小页（frontend/public/pet/page.svg），但桌宠穿的是
 * 哪张图完全由读者决定：
 *   builtin 随程序附带的小页
 *   url     一个外部图片地址（gif 也行），浏览器自己加载，不经过后端
 *   upload  本地文件，存到后端 data/pet/avatar.*，换浏览器也还在
 *
 * 除了主形象，每个动作（走路 / 思考 / 说话 / 倾听 / 睡觉）还可以各导入一张图，
 * 存成 data/pet/avatar-<动作>.*；没有单独图片的动作就用主形象加动效。
 *
 * 除了默认的小页，程序不附带任何角色素材。
 */

export type AppearanceKind = 'builtin' | 'url' | 'upload';

/** 可以单独换图的动作 */
export type PoseSlot = 'walk' | 'think' | 'talk' | 'listen' | 'sleep';

export const POSE_SLOTS: { slot: PoseSlot; label: string; hint: string }[] = [
  { slot: 'walk', label: '走路', hint: '沿着窗口下沿走动时' },
  { slot: 'think', label: '思考', hint: '等 AI 回答、还没出字时' },
  { slot: 'talk', label: '说话', hint: '回答正在一个字一个字出来时' },
  { slot: 'listen', label: '倾听', hint: '你在划词或者打字时' },
  { slot: 'sleep', label: '睡觉', hint: '很久没动静、或者让它睡觉时' },
];

/**
 * 原图里角色朝哪边。走路时按方向水平翻转：往左走就让它朝左。
 * front = 正面朝前（对称的形象），不翻转。
 */
export type Facing = 'left' | 'right' | 'front';

export interface Appearance {
  kind: AppearanceKind;
  url: string;
  /** 桌宠的边长（px）—— 立绘类的图需要更大 */
  size: number;
  /** 原图朝向 */
  faces: Facing;
  /** 各动作单独的图（地址），没有的动作用主形象 */
  poses: Partial<Record<PoseSlot, string>>;
  /** upload 时的原文件名 */
  name?: string;
}

const KEY = 'pdftr.pet.appearance';

/** 默认形象：小页，见 frontend/public/pet/page.svg */
export const PAGE_URL = '/pet/page.svg';

export const PET_SIZE_MIN = 64;
export const PET_SIZE_MAX = 200;
export const PET_SIZE_DEFAULT = 112;

export const DEFAULT_APPEARANCE: Appearance = {
  kind: 'builtin',
  url: PAGE_URL,
  size: PET_SIZE_DEFAULT,
  // 小页 looks straight at the reader: walking never mirrors it
  faces: 'front',
  poses: {},
};

/** 图片直链的常见后缀 —— 只用来给个即时的输入提示，不限制保存 */
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif|bmp)(\?.*)?$/i;

export function looksLikeImageUrl(raw: string): boolean {
  const s = raw.trim();
  if (!s) return false;
  return /^https?:\/\//i.test(s) || s.startsWith('data:image/') || IMAGE_EXT.test(s);
}

function clampSize(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : PET_SIZE_DEFAULT;
  return Math.min(Math.max(Math.round(n), PET_SIZE_MIN), PET_SIZE_MAX);
}

function cleanFacing(v: unknown, fallback: Facing): Facing {
  return v === 'left' || v === 'right' || v === 'front' ? v : fallback;
}

function cleanPoses(v: unknown): Partial<Record<PoseSlot, string>> {
  const out: Partial<Record<PoseSlot, string>> = {};
  if (!v || typeof v !== 'object') return out;
  for (const { slot } of POSE_SLOTS) {
    const u = (v as Record<string, unknown>)[slot];
    if (typeof u === 'string' && u) out[slot] = u;
  }
  return out;
}

export function loadAppearance(): Appearance {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_APPEARANCE;
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (v && typeof v.url === 'string' && v.url) {
      const kind: AppearanceKind = v.kind === 'upload' ? 'upload' : v.kind === 'builtin' ? 'builtin' : 'url';
      return {
        kind,
        url: kind === 'builtin' ? PAGE_URL : v.url,
        size: clampSize(v.size),
        faces: cleanFacing(v.faces, kind === 'builtin' ? 'front' : 'right'),
        poses: cleanPoses(v.poses),
        ...(typeof v.name === 'string' ? { name: v.name } : {}),
      };
    }
  } catch {
    /* first run, or storage blocked */
  }
  return DEFAULT_APPEARANCE;
}

export function saveAppearance(a: Appearance): void {
  try {
    const clean: Appearance = {
      kind: a.kind,
      url: a.url,
      size: clampSize(a.size),
      faces: a.faces,
      poses: cleanPoses(a.poses),
      ...(a.name ? { name: a.name } : {}),
    };
    const isDefault =
      a.kind === 'builtin' &&
      clean.size === PET_SIZE_DEFAULT &&
      clean.faces === DEFAULT_APPEARANCE.faces &&
      Object.keys(clean.poses).length === 0;
    if (isDefault) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(clean));
  } catch {
    /* not remembered */
  }
}

/** 上传到后端的形象带上时间戳，免得浏览器拿旧缓存。 */
export function uploadedUrl(bust: number, slot?: PoseSlot): string {
  return slot ? `/api/pet/avatar?slot=${slot}&v=${bust}` : `/api/pet/avatar?v=${bust}`;
}
