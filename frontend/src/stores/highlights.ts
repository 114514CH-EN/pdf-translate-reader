import { create } from 'zustand';
import { api, ApiError } from '../api/client';
import type { Highlight, HighlightColor } from '../types';
import { useViewStore } from './view';

interface HighlightState {
  docId: string | null;
  items: Highlight[];
  /** highlight whose note editor is open (popover) */
  activeId: number | null;
  loadFor: (docId: string) => Promise<void>;
  add: (h: { page_no: number; pane: 'src' | 'tgt'; rects: number[][]; text: string; color: HighlightColor; note?: string }) => Promise<Highlight | null>;
  update: (id: number, patch: { note?: string; color?: HighlightColor }) => Promise<void>;
  remove: (id: number) => Promise<void>;
  setActive: (id: number | null) => void;
}

function errMsg(e: unknown): string {
  return e instanceof ApiError || e instanceof Error ? e.message : String(e);
}

export const useHighlightStore = create<HighlightState>((set, get) => ({
  docId: null,
  items: [],
  activeId: null,

  async loadFor(docId) {
    set({ docId, items: get().docId === docId ? get().items : [], activeId: null });
    try {
      const items = await api.listHighlights(docId);
      if (get().docId === docId) set({ items });
    } catch {
      /* highlights are optional — the reader keeps working */
    }
  },

  async add(h) {
    const docId = get().docId;
    if (!docId) return null;
    try {
      const created = await api.createHighlight({ doc_id: docId, ...h });
      set({ items: [...get().items, created] });
      return created;
    } catch (e) {
      useViewStore.getState().toast(`高亮失败：${errMsg(e)}`, 'error');
      return null;
    }
  },

  async update(id, patch) {
    try {
      const upd = await api.updateHighlight(id, patch);
      set({ items: get().items.map((h) => (h.id === id ? upd : h)) });
    } catch (e) {
      useViewStore.getState().toast(`保存失败：${errMsg(e)}`, 'error');
    }
  },

  async remove(id) {
    try {
      await api.deleteHighlight(id);
      set({ items: get().items.filter((h) => h.id !== id), activeId: get().activeId === id ? null : get().activeId });
    } catch (e) {
      useViewStore.getState().toast(`删除失败：${errMsg(e)}`, 'error');
    }
  },

  setActive: (id) => set({ activeId: id }),
}));
