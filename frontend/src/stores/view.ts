import { create } from 'zustand';
import type { SidebarTab, ToastItem, ViewMode } from '../types';

export type SettingsTab = 'translate' | 'assistant' | 'usage' | 'ui' | 'data';

interface ViewState {
  /** 整页预览 | 逐句对照 */
  mode: ViewMode;
  currentPage: number;
  pageCount: number;
  zoom: number;
  /** true: zoom follows the pane width (适合宽度) until the user zooms manually */
  zoomFit: boolean;
  editMode: boolean;
  sidebarOpen: boolean;
  /** the home page is shown over the open documents */
  homeOpen: boolean;
  setHomeOpen: (on: boolean) => void;
  sidebarTab: SidebarTab;
  settingsOpen: boolean;
  settingsTab: SettingsTab;
  searchOpen: boolean;
  /** Block briefly outlined in both panes (search result / jump target). */
  flashBlockId: string | null;
  flashSeq: number;
  /** fraction (0..1) into the target page for the next nav request (restored reading position) */
  navFrac: number;
  /** Block id currently hovered — cross-pane highlight. */
  hoverBlockId: string | null;
  /** Left pane width in percent (resizable divider). */
  leftPanePct: number;
  toasts: ToastItem[];
  /** Bumped to request both panes scroll to currentPage. */
  pageNavSeq: number;

  setMode: (mode: ViewMode) => void;
  setPage: (page: number) => void;
  setPageCount: (n: number) => void;
  setZoom: (z: number, fit?: boolean) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  setEditMode: (on: boolean) => void;
  setSidebarOpen: (on: boolean) => void;
  setSidebarTab: (tab: SidebarTab) => void;
  setSettingsOpen: (on: boolean) => void;
  openSettings: (tab?: SettingsTab) => void;
  setSearchOpen: (on: boolean) => void;
  flashBlock: (id: string | null) => void;
  setHoverBlock: (id: string | null) => void;
  setLeftPanePct: (pct: number) => void;
  requestPageNav: (page: number, frac?: number) => void;
  toast: (text: string, kind?: ToastItem['kind']) => void;
  dismissToast: (id: number) => void;
}

let toastSeq = 1;

const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
function stepZoom(z: number, dir: 1 | -1): number {
  if (dir > 0) return ZOOM_STEPS.find((s) => s > z + 0.005) ?? 4;
  return [...ZOOM_STEPS].reverse().find((s) => s < z - 0.005) ?? 0.25;
}

export const useViewStore = create<ViewState>((set, get) => ({
  mode: 'page',
  currentPage: 1,
  pageCount: 0,
  zoom: 1,
  zoomFit: true,
  editMode: false,
  sidebarOpen: true,
  homeOpen: false,
  setHomeOpen: (on) => set({ homeOpen: on }),
  sidebarTab: 'assistant',
  settingsOpen: false,
  settingsTab: 'translate',
  searchOpen: false,
  flashBlockId: null,
  flashSeq: 0,
  navFrac: 0,
  hoverBlockId: null,
  leftPanePct: 48,
  toasts: [],
  pageNavSeq: 0,

  setMode: (mode) => set({ mode }),
  setPage: (page) => {
    const { pageCount } = get();
    const clamped = pageCount > 0 ? Math.min(Math.max(1, page), pageCount) : Math.max(1, page);
    if (clamped !== get().currentPage) set({ currentPage: clamped });
  },
  setPageCount: (pageCount) => set({ pageCount }),
  setZoom: (zoom, fit = false) => set({ zoom: Math.min(Math.max(0.25, zoom), 4), zoomFit: fit }),
  // round to clean 10% steps so the label reads 80% → 90% → 100%
  zoomIn: () => set({ zoom: Math.min(stepZoom(get().zoom, +1), 4), zoomFit: false }),
  zoomOut: () => set({ zoom: Math.max(stepZoom(get().zoom, -1), 0.25), zoomFit: false }),
  setEditMode: (on) => set({ editMode: on }),
  setSidebarOpen: (on) => set({ sidebarOpen: on }),
  setSidebarTab: (tab) => set({ sidebarTab: tab, sidebarOpen: true }),
  setSettingsOpen: (on) => set({ settingsOpen: on }),
  openSettings: (tab) => set({ settingsOpen: true, ...(tab ? { settingsTab: tab } : {}) }),
  setSearchOpen: (on) => set({ searchOpen: on }),
  flashBlock: (id) => {
    const seq = get().flashSeq + 1;
    set({ flashBlockId: id, flashSeq: seq });
    // clear afterwards so flashing the same block again restarts the animation
    if (id) window.setTimeout(() => get().flashSeq === seq && set({ flashBlockId: null }), 1800);
  },
  setHoverBlock: (id) => set({ hoverBlockId: id }),
  setLeftPanePct: (pct) => set({ leftPanePct: Math.min(Math.max(25, pct), 72) }),
  requestPageNav: (page, frac = 0) => {
    get().setPage(page);
    set({ pageNavSeq: get().pageNavSeq + 1, navFrac: Math.min(Math.max(frac, 0), 1) });
  },
  toast: (text, kind = 'info') => {
    const id = toastSeq++;
    set({ toasts: [...get().toasts, { id, kind, text }] });
    window.setTimeout(() => get().dismissToast(id), kind === 'error' ? 6000 : 3500);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));
