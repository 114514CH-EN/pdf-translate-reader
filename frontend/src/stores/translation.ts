import { create } from 'zustand';
import { api, ApiError } from '../api/client';
import type { Block, JobInfo, PageFigure, TranslateRequest } from '../types';
import { useViewStore } from './view';

export interface PageData {
  pageNo: number;
  width: number; // PDF pt
  height: number; // PDF pt
  blocks: Block[];
  /** absolute URL of the text-free page background, if any */
  background?: string | null;
  original?: string | null;
  figures?: PageFigure[];
  loading: boolean;
  loaded: boolean;
}

interface TranslationState {
  /** page number -> page block data */
  pages: Record<number, PageData>;
  /** running job (translate / extract-terms) */
  job: JobInfo | null;
  /** block ids that failed in the last completed job */
  failedBlockIds: string[];
  busy: boolean;

  loadPage: (docId: string, pageNo: number) => Promise<void>;
  getPage: (pageNo: number) => PageData | undefined;
  getBlock: (blockId: string) => Block | undefined;
  setBlockTranslation: (blockId: string, text: string) => void;
  saveBlockTranslation: (blockId: string, text: string) => Promise<void>;
  startTranslate: (body: TranslateRequest) => Promise<string | null>;
  startRetranslateBlock: (blockId: string) => Promise<string | null>;
  setJob: (job: JobInfo | null) => void;
  patchJob: (patch: Partial<JobInfo>) => void;
  setFailedBlockIds: (ids: string[]) => void;
  refreshPage: (docId: string, pageNo: number) => Promise<void>;
  reset: () => void;
}

function errMsg(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

export const useTranslationStore = create<TranslationState>((set, get) => ({
  pages: {},
  job: null,
  failedBlockIds: [],
  busy: false,

  async loadPage(docId, pageNo) {
    const existing = get().pages[pageNo];
    if (existing?.loading || existing?.loaded) return;
    set({
      pages: {
        ...get().pages,
        [pageNo]: {
          pageNo,
          width: existing?.width ?? 595,
          height: existing?.height ?? 842,
          blocks: existing?.blocks ?? [],
          background: existing?.background ?? null,
          original: existing?.original ?? null,
          figures: existing?.figures ?? [],
          loading: true,
          loaded: false,
        },
      },
    });
    try {
      const data = await api.getPageBlocks(docId, pageNo);
      set({
        pages: {
          ...get().pages,
          [pageNo]: {
            pageNo,
            width: data.width,
            height: data.height,
            blocks: data.blocks,
            background: data.background ?? null,
            original: data.original ?? null,
            figures: data.figures ?? [],
            loading: false,
            loaded: true,
          },
        },
      });
    } catch (e) {
      const notFound = e instanceof ApiError && e.status === 404;
      if (!notFound) {
        useViewStore.getState().toast(`第 ${pageNo} 页加载失败：${errMsg(e)}`, 'error');
      }
      set({
        pages: {
          ...get().pages,
          [pageNo]: {
            pageNo,
            width: existing?.width ?? 595,
            height: existing?.height ?? 842,
            blocks: existing?.blocks ?? [],
            loading: false,
            loaded: true,
          },
        },
      });
    }
  },

  getPage: (pageNo) => get().pages[pageNo],

  getBlock(blockId) {
    for (const p of Object.values(get().pages)) {
      const b = p.blocks.find((x) => x.id === blockId);
      if (b) return b;
    }
    return undefined;
  },

  setBlockTranslation(blockId, text) {
    const pages = { ...get().pages };
    for (const key of Object.keys(pages)) {
      const p = pages[Number(key)];
      const idx = p.blocks.findIndex((b) => b.id === blockId);
      if (idx >= 0) {
        const blocks = p.blocks.slice();
        blocks[idx] = {
          ...blocks[idx],
          translation: text,
          translated: true,
          translation_edited: 1,
        };
        pages[Number(key)] = { ...p, blocks };
        set({ pages });
        return;
      }
    }
  },

  async saveBlockTranslation(blockId, text) {
    get().setBlockTranslation(blockId, text);
    try {
      await api.putTranslation(blockId, text);
      window.dispatchEvent(new Event('pdftr:translations-changed'));
    } catch (e) {
      useViewStore.getState().toast(`保存译文失败：${errMsg(e)}`, 'error');
    }
  },

  async startTranslate(body) {
    set({ busy: true });
    try {
      const { job_id } = await api.translate(body);
      set({ busy: false });
      return job_id;
    } catch (e) {
      set({ busy: false });
      useViewStore.getState().toast(`发起翻译失败：${errMsg(e)}`, 'error');
      return null;
    }
  },

  async startRetranslateBlock(blockId) {
    set({ busy: true });
    try {
      const { job_id } = await api.retranslateBlock(blockId);
      set({ busy: false });
      return job_id;
    } catch (e) {
      set({ busy: false });
      useViewStore.getState().toast(`重新翻译失败：${errMsg(e)}`, 'error');
      return null;
    }
  },

  setJob: (job) => set({ job }),

  patchJob(patch) {
    const { job } = get();
    if (job) set({ job: { ...job, ...patch } });
  },

  setFailedBlockIds: (ids) => set({ failedBlockIds: ids }),

  async refreshPage(docId, pageNo) {
    const existing = get().pages[pageNo];
    set({
      pages: {
        ...get().pages,
        [pageNo]: {
          pageNo,
          width: existing?.width ?? 595,
          height: existing?.height ?? 842,
          blocks: existing?.blocks ?? [],
          background: existing?.background ?? null,
          original: existing?.original ?? null,
          figures: existing?.figures ?? [],
          loading: true,
          loaded: existing?.loaded ?? false,
        },
      },
    });
    try {
      const data = await api.getPageBlocks(docId, pageNo);
      set({
        pages: {
          ...get().pages,
          [pageNo]: {
            pageNo,
            width: data.width,
            height: data.height,
            blocks: data.blocks,
            background: data.background ?? null,
            original: data.original ?? null,
            figures: data.figures ?? [],
            loading: false,
            loaded: true,
          },
        },
      });
    } catch (e) {
      useViewStore.getState().toast(`刷新第 ${pageNo} 页失败：${errMsg(e)}`, 'error');
      const cur = get().pages[pageNo];
      if (cur) set({ pages: { ...get().pages, [pageNo]: { ...cur, loading: false } } });
    }
  },

  reset() {
    set({ pages: {}, job: null, failedBlockIds: [], busy: false });
  },
}));
