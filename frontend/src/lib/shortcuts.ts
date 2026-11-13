/** Configurable keyboard shortcuts (stored in settings.ui.shortcuts). */

export type ShortcutAction =
  | 'prevPage'
  | 'nextPage'
  | 'toggleMode'
  | 'toggleEdit'
  | 'translateDoc'
  | 'translatePage'
  | 'zoomIn'
  | 'zoomOut'
  | 'fitWidth'
  | 'toggleTheme'
  | 'openSettings'
  | 'search'
  | 'focusMode';

export const SHORTCUT_LABELS: Record<ShortcutAction, string> = {
  prevPage: '上一页',
  nextPage: '下一页',
  toggleMode: '切换 整页预览 / 逐句对照',
  toggleEdit: '编辑译文 开/关',
  translateDoc: '翻译全文',
  translatePage: '翻译本页',
  zoomIn: '放大',
  zoomOut: '缩小',
  fitWidth: '适合宽度',
  toggleTheme: '切换暗色模式',
  openSettings: '打开设置',
  search: '在文档中搜索',
  focusMode: '专注阅读 开/关',
};

export const DEFAULT_SHORTCUTS: Record<ShortcutAction, string> = {
  prevPage: 'ArrowLeft',
  nextPage: 'ArrowRight',
  toggleMode: 'M',
  toggleEdit: 'E',
  translateDoc: 'Ctrl+Shift+T',
  translatePage: 'T',
  zoomIn: '=',
  zoomOut: '-',
  fitWidth: 'W',
  toggleTheme: 'Shift+D',
  openSettings: 'Ctrl+,',
  search: 'Ctrl+F',
  focusMode: 'F',
};

/** Canonical combo string for a keyboard event, e.g. "Ctrl+Shift+T". null for bare modifiers. */
export function comboFromEvent(e: KeyboardEvent | React.KeyboardEvent): string | null {
  const k = e.key;
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(k)) return null;
  const key = k === ' ' ? 'Space' : k.length === 1 ? k.toUpperCase() : k;
  const mods: string[] = [];
  if (e.ctrlKey || e.metaKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  // Shift is implied by the produced character for symbols ("+" vs "="); keep it for letters/named keys
  if (e.shiftKey && (key.length > 1 || /[A-Z]/.test(key))) mods.push('Shift');
  return [...mods, key].join('+');
}

export function resolveShortcuts(stored: unknown): Record<ShortcutAction, string> {
  const out = { ...DEFAULT_SHORTCUTS };
  if (stored && typeof stored === 'object') {
    for (const [k, v] of Object.entries(stored as Record<string, unknown>)) {
      if (k in out && typeof v === 'string' && v) out[k as ShortcutAction] = v;
    }
  }
  return out;
}

export function actionFor(combo: string, map: Record<ShortcutAction, string>): ShortcutAction | null {
  for (const [action, c] of Object.entries(map)) {
    if (c.toLowerCase() === combo.toLowerCase()) return action as ShortcutAction;
  }
  // "+" on most layouts is Shift+= → accept as zoom-in too
  if (combo === '+' && map.zoomIn === '=') return 'zoomIn';
  return null;
}

/** Actions implemented by the Toolbar (it owns translate / fit-width logic). */
export const TOOLBAR_EVENT = 'pdftr:action';
