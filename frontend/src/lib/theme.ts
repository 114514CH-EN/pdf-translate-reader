/**
 * Interface styles, applied as <html data-theme="…" data-scheme="light|dark">.
 * Every style only re-defines the design tokens in styles.css (plus a few
 * signature rules), so all components follow automatically.
 * Styles marked #NN are adapted from github.com/joshhu/uitest.
 */
export type ThemeId = 'light' | 'dark' | 'eink' | 'mint' | 'swiss' | 'glass' | 'oled' | 'brutal' | 'organic';
export type ThemeMode = 'system' | ThemeId;

export interface ThemeInfo {
  id: ThemeMode;
  name: string;
  note: string;
  /** three preview colours: surface, ink, accent */
  swatch: [string, string, string];
  dark?: boolean;
}

export const THEMES: ThemeInfo[] = [
  { id: 'system', name: '跟随系统', note: '默认亮色 / 暗色自动切换', swatch: ['#f3f4f7', '#17181c', '#2557d6'] },
  { id: 'light', name: '默认亮色', note: '冷灰桌面、白色面板、钴蓝', swatch: ['#f3f4f7', '#16181d', '#2557d6'] },
  { id: 'dark', name: '默认暗色', note: '夜间使用，层次靠明暗区分', swatch: ['#17181c', '#e7e8ec', '#7aa2ff'], dark: true },
  { id: 'eink', name: '电子墨水 / 纸张', note: '墨黑纸白、衬线、无动画', swatch: ['#f5f1eb', '#1a1a1a', '#1a1a1a'] },
  { id: 'mint', name: '护眼豆沙绿', note: '页面和界面都是柔和的淡绿，适合久读', swatch: ['#d6ecd6', '#223328', '#2c7a53'] },
  { id: 'swiss', name: '瑞士现代主义', note: '网格、无衬线、信号红', swatch: ['#ffffff', '#000000', '#e4002b'] },
  { id: 'glass', name: '液态玻璃（晨雾）', note: '淡渐变背景、磨砂白面板、深色文字', swatch: ['#e9ecf8', '#1e2233', '#4753d1'] },
  { id: 'oled', name: 'OLED 深色', note: '纯黑省电、薄荷绿点缀', swatch: ['#000000', '#ececec', '#6fe0b2'], dark: true },
  { id: 'brutal', name: '新粗野主义', note: '粗黑边框、硬阴影', swatch: ['#fff8e7', '#000000', '#ffe66d'] },
  { id: 'organic', name: '有机自然', note: '米色与鼠尾草绿', swatch: ['#f5f1e8', '#3e4a32', '#5d6b4d'] },
];

let mql: MediaQueryList | null = null;
let listener: (() => void) | null = null;

export function resolveTheme(mode: ThemeMode): ThemeId {
  if (mode !== 'system') return THEMES.some((t) => t.id === mode) ? (mode as ThemeId) : 'light';
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export type PageTone = 'soft' | 'night' | 'paper';

/** How the PDF page looks inside a dark interface (no effect in light themes). */
export function applyPageTone(tone: PageTone | undefined): void {
  document.documentElement.dataset.pageTone = tone === 'night' || tone === 'paper' ? tone : 'soft';
}

export function applyTheme(mode: ThemeMode): void {
  const root = document.documentElement;
  if (mql && listener) mql.removeEventListener('change', listener);
  const set = () => {
    const id = resolveTheme(mode);
    if (root.dataset.theme && root.dataset.theme !== id) {
      // colours cross-fade for a moment instead of snapping (motion.css)
      root.classList.add('theme-switching');
      window.setTimeout(() => root.classList.remove('theme-switching'), 380);
    }
    root.dataset.theme = id;
    root.dataset.scheme = THEMES.find((t) => t.id === id)?.dark ? 'dark' : 'light';
  };
  mql = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  listener = set;
  if (mode === 'system' && mql) mql.addEventListener('change', listener);
  set();
}

/** Shift+D: flip between light and dark. */
export function nextTheme(cur: ThemeMode): ThemeMode {
  const id = resolveTheme(cur);
  return THEMES.find((t) => t.id === id)?.dark ? 'light' : 'dark';
}
