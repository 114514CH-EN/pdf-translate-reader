import { create } from 'zustand';
import { api } from '../api/client';
import type { PaperIndex } from '../types';

/**
 * References, figures and sections of each open document, fetched once and kept: they come
 * from the original text, which does not change while one reads. `refresh` fetches again
 * (after translating, the outline gains the translated headings).
 */
interface PaperIndexState {
  byDoc: Record<string, PaperIndex | 'loading' | 'error'>;
  load: (docId: string, refresh?: boolean) => Promise<void>;
}

export const usePaperIndexStore = create<PaperIndexState>((set, get) => ({
  byDoc: {},
  async load(docId, refresh = false) {
    const cur = get().byDoc[docId];
    if (cur === 'loading' || (cur && cur !== 'error' && !refresh)) return;
    if (!cur || cur === 'error') set({ byDoc: { ...get().byDoc, [docId]: 'loading' } });
    try {
      const idx = await api.getPaperIndex(docId);
      set({ byDoc: { ...get().byDoc, [docId]: idx } });
    } catch {
      set({ byDoc: { ...get().byDoc, [docId]: 'error' } });
    }
  },
}));

/** The index of a document once it is there (null while loading or when it failed). */
export function usePaperIndex(docId: string | null): PaperIndex | null {
  const v = usePaperIndexStore((s) => (docId ? s.byDoc[docId] : undefined));
  return v && v !== 'loading' && v !== 'error' ? v : null;
}

/** Original page image (for crops of figures): the one the page view already loaded, else the API. */
export function pageImageUrl(docId: string, page: number, loaded?: string | null): string {
  return loaded || `/api/documents/${encodeURIComponent(docId)}/pages/${page}/original.png`;
}
