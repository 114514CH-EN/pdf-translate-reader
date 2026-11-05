/**
 * 桌宠的外观。
 *
 * 默认是随程序附带的一条大肥鱼（frontend/public/pet/fatfish.svg），但桌宠穿的是
 * 哪张图完全由读者决定：
 *   builtin 随程序附带的大肥鱼
 *   url     一个外部图片地址（gif 也行），浏览器自己加载，不经过后端
 *   upload  本地文件，存到后端 data/pet/avatar.*，换浏览器也还在
 *
 * 除了那条 CC-BY 的鱼，程序不附带任何角色素材。
 */

export type AppearanceKind = 'builtin' | 'url' | 'upload';

export interface Appearance {
  kind: AppearanceKind;
  url: string;
  /** 桌宠的边长（px）—— 立绘类的图需要更大 */
  size: number;
  /** upload 时的原文件名 */
  name?: string;
}

const KEY = 'pdftr.pet.appearance';

/** 这条鱼是 Twemoji 的 🐳，CC-BY 4.0，见 frontend/public/pet/fatfish.svg */
export const FISH_URL = '/pet/fatfish.svg';

export const PET_SIZE_MIN = 64;
export const PET_SIZE_MAX = 200;
export const PET_SIZE_DEFAULT = 112;

export const DEFAULT_APPEARANCE: Appearance = {
  kind: 'builtin',
  url: FISH_URL,
  size: PET_SIZE_DEFAULT,
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

export function loadAppearance(): Appearance {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_APPEARANCE;
    const v = JSON.parse(raw) as { kind?: unknown; url?: unknown; size?: unknown; name?: unknown };
    if (v && typeof v.url === 'string' && v.url) {
      const kind: AppearanceKind = v.kind === 'upload' ? 'upload' : v.kind === 'builtin' ? 'builtin' : 'url';
      return {
        kind,
        url: v.url,
        size: clampSize(v.size),
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
    const clean: Appearance = { kind: a.kind, url: a.url, size: clampSize(a.size) };
    if (a.kind === 'builtin') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(clean));
  } catch {
    /* not remembered */
  }
}

/** 上传到后端的形象带上时间戳，免得浏览器拿旧缓存。 */
export function uploadedUrl(bust: number): string {
  return `/api/pet/avatar?v=${bust}`;
}
