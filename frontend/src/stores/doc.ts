import { create } from 'zustand';
import { api, ApiError } from '../api/client';
import type { DocDetail, DocumentRow } from '../types';
import { useViewStore } from './view';

const OPEN_KEY = 'pdftr.openTabs';

function readOpen(): string[] | null {
  try {
    const raw = localStorage.getItem(OPEN_KEY);
    const v: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(v) ? v.map(String) : null;
  } catch {
    return null;
  }
}

function writeOpen(ids: string[]): void {
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify(ids));
  } catch {
    /* storage unavailable: tabs just aren't remembered */
  }
}

interface DocState {
  /** every document in the library */
  documents: DocumentRow[];
  /** ids shown as tabs (closing a tab removes it here; the document stays in the library) */
  openIds: string[];
  activeId: string | null;
  detail: DocDetail | null;
  loading: boolean;
  uploading: boolean;
  error: string | null;

  loadDocuments: () => Promise<void>;
  openDocument: (id: string) => Promise<void>;
  closeDocument: (id: string) => void;
  ensureOpen: (id: string) => void;
  uploadFile: (file: File) => Promise<string | null>;
  deleteDocument: (id: string) => Promise<void>;
  setActive: (id: string | null) => void;
  patchDetail: (patch: Partial<DocDetail>) => void;
}

function errMsg(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

export const useDocStore = create<DocState>((set, get) => ({
  documents: [],
  openIds: readOpen() ?? [],
  activeId: null,
  detail: null,
  loading: false,
  uploading: false,
  error: null,

  async loadDocuments() {
    set({ loading: true, error: null });
    try {
      const documents = await api.listDocuments();
      const ids = new Set(documents.map((d) => String(d.id)));
      const stored = readOpen();
      // first run (nothing remembered yet): open the most recent document
      const openIds = (stored ?? (documents[0] ? [String(documents[0].id)] : [])).filter((id) => ids.has(id));
      set({ documents, openIds, loading: false });
      writeOpen(openIds);
      const { activeId } = get();
      if (activeId && !ids.has(String(activeId))) {
        set({ activeId: null, detail: null });
      }
    } catch (e) {
      set({ loading: false, error: errMsg(e) });
    }
  },

  async openDocument(id) {
    // reset paging *before* panes re-render for the new doc (child effects run
    // before App's, so they would otherwise request the old doc's page range)
    if (get().activeId !== id) useViewStore.setState({ currentPage: 1, pageCount: 0 });
    get().ensureOpen(id);
    set({ activeId: id, error: null });
    try {
      const detail = await api.getDocument(id);
      set({ detail });
    } catch (e) {
      set({ error: errMsg(e) });
    }
  },

  ensureOpen(id) {
    const sid = String(id);
    if (get().openIds.includes(sid)) return;
    const openIds = [...get().openIds, sid];
    set({ openIds });
    writeOpen(openIds);
  },

  closeDocument(id) {
    const sid = String(id);
    const { activeId, openIds } = get();
    const idx = openIds.indexOf(sid);
    const rest = openIds.filter((x) => x !== sid);
    set({ openIds: rest });
    writeOpen(rest);
    if (String(activeId) === sid) {
      // activate the neighbouring tab, or show the empty state
      const next = rest[idx] ?? rest[idx - 1] ?? null;
      if (next) get().setActive(next);
      else set({ activeId: null, detail: null });
    }
  },

  async uploadFile(file) {
    set({ uploading: true, error: null });
    try {
      const { doc_id, warning } = await api.uploadDocument(file);
      if (warning) useViewStore.getState().toast(warning, 'error');
      await get().loadDocuments();
      await get().openDocument(doc_id);
      set({ uploading: false });
      return doc_id;
    } catch (e) {
      set({ uploading: false, error: errMsg(e) });
      return null;
    }
  },

  async deleteDocument(id) {
    try {
      await api.deleteDocument(id);
      get().closeDocument(id);
      await get().loadDocuments();
      useViewStore.getState().toast('文档已删除', 'success');
    } catch (e) {
      set({ error: errMsg(e) });
    }
  },

  setActive(id) {
    if (get().activeId !== id) useViewStore.setState({ currentPage: 1, pageCount: 0 });
    if (id) get().ensureOpen(id);
    set({ activeId: id });
    if (id) void get().openDocument(id);
    else set({ detail: null });
  },

  patchDetail(patch) {
    const { detail } = get();
    if (detail) set({ detail: { ...detail, ...patch } });
  },
}));
