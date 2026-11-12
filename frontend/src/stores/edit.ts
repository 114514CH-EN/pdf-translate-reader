import { create } from 'zustand';
import { api } from '../api/client';
import { SRC_LANG, type Block, type BlockLayout, type EditSide } from '../types';
import { useTranslationStore } from './translation';
import { useViewStore } from './view';

/**
 * Edit mode (工具栏「编辑译文」): which block is selected, and an undo history.
 *
 * Every edit — retyped text, formatting, moving or resizing a block, hiding it,
 * find & replace across the document — is one step of history that 撤销 / 重做
 * (Ctrl+Z / Ctrl+Y) walks through. Each step records what the blocks were before
 * and after, so undoing simply writes the old state back.
 */

export interface Snap {
  /** undefined: the text is not part of this change */
  text?: string | null;
  /** undefined: the formatting is not part of this change */
  layout?: BlockLayout | null;
}

export interface Change {
  blockId: string;
  /** the translation (default) or the original text */
  side?: EditSide;
  before: Snap;
  after: Snap;
}

interface EditState {
  selectedId: string | null;
  undoStack: Change[][];
  redoStack: Change[][];
  select: (id: string | null, side?: EditSide) => void;
  setText: (blockId: string, text: string, side?: EditSide) => Promise<void>;
  /** merge a patch into the block's formatting; null clears all of it */
  setLayout: (blockId: string, patch: Partial<BlockLayout> | null, side?: EditSide) => Promise<void>;
  /** record edits the server already made (find & replace) */
  pushDone: (changes: Change[]) => void;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  clearHistory: () => void;
}

const LIMIT = 200;

export function findBlock(blockId: string): Block | undefined {
  const pages = useTranslationStore.getState().pages;
  for (const key of Object.keys(pages)) {
    const b = pages[Number(key)].blocks.find((x) => String(x.id) === String(blockId));
    if (b) return b;
  }
  return undefined;
}

function tidy(layout: BlockLayout | null | undefined): BlockLayout | null {
  if (!layout) return null;
  const out: BlockLayout = {};
  if (layout.scale !== undefined && Math.abs(layout.scale - 1) > 0.001) out.scale = layout.scale;
  if (layout.bold !== undefined) out.bold = layout.bold;
  if (layout.color !== undefined) out.color = layout.color;
  if (layout.align !== undefined) out.align = layout.align;
  if (layout.bbox) out.bbox = layout.bbox;
  if (layout.hidden) out.hidden = true;
  return Object.keys(out).length ? out : null;
}

/** "tgt:12" / "src:12": the same block can be selected in either pane */
export const selKey = (id: string | number, side: EditSide = 'tgt') => `${side}:${id}`;

/** Write one side of a change to the page and the server. */
async function apply(blockId: string, snap: Snap, side: EditSide = 'tgt'): Promise<void> {
  const tr = useTranslationStore.getState();
  if (side === 'src') {
    // edits of the original are stored like a translation into the pseudo language "__src__"
    tr.setBlockSource(blockId, snap);
    if (snap.text !== undefined) await api.putTranslation(blockId, snap.text ?? '', SRC_LANG);
    if (snap.layout !== undefined) await api.putLayout(blockId, snap.layout, SRC_LANG);
    return;
  }
  if (snap.text !== undefined) {
    tr.setBlockTranslation(blockId, snap.text ?? '');
    await api.putTranslation(blockId, snap.text ?? '');
  }
  if (snap.layout !== undefined) {
    tr.setBlockLayout(blockId, snap.layout);
    await api.putLayout(blockId, snap.layout);
  }
}

async function applyAll(changes: Change[], side: 'before' | 'after'): Promise<void> {
  try {
    for (const c of changes) await apply(c.blockId, c[side], c.side);
    window.dispatchEvent(new Event('pdftr:translations-changed'));
  } catch (e) {
    useViewStore.getState().toast(`保存失败：${e instanceof Error ? e.message : String(e)}`, 'error');
  }
}

export const useEditStore = create<EditState>((set, get) => ({
  selectedId: null,
  undoStack: [],
  redoStack: [],

  select: (id, side = 'tgt') => set({ selectedId: id === null ? null : selKey(id, side) }),

  async setText(blockId, text, side = 'tgt') {
    const block = findBlock(blockId);
    const before = (side === 'src' ? block?.src_edit?.text : block?.translation) ?? null;
    if ((before ?? '') === text) return;
    const change: Change = { blockId, side, before: { text: before }, after: { text } };
    set((s) => ({ undoStack: [...s.undoStack, [change]].slice(-LIMIT), redoStack: [] }));
    await applyAll([change], 'after');
  },

  async setLayout(blockId, patch, side = 'tgt') {
    const block = findBlock(blockId);
    const before = tidy(side === 'src' ? block?.src_edit?.layout : block?.layout);
    const after = patch === null ? null : tidy({ ...(before ?? {}), ...patch });
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    const change: Change = { blockId, side, before: { layout: before }, after: { layout: after } };
    if (side === 'src' && block && !block.src_edit?.text && after) {
      // formatting the original for the first time: from now on the block is drawn as text
      // (its own text, formulas kept as placeholders) instead of a picture of the page
      change.before.text = null;
      change.after.text = block.meta?.ph ?? block.text;
    }
    set((s) => ({ undoStack: [...s.undoStack, [change]].slice(-LIMIT), redoStack: [] }));
    await applyAll([change], 'after');
  },

  pushDone(changes) {
    if (changes.length) set((s) => ({ undoStack: [...s.undoStack, changes].slice(-LIMIT), redoStack: [] }));
  },

  async undo() {
    const step = get().undoStack[get().undoStack.length - 1];
    if (!step) return;
    set((s) => ({ undoStack: s.undoStack.slice(0, -1), redoStack: [...s.redoStack, step] }));
    await applyAll(step, 'before');
  },

  async redo() {
    const step = get().redoStack[get().redoStack.length - 1];
    if (!step) return;
    set((s) => ({ redoStack: s.redoStack.slice(0, -1), undoStack: [...s.undoStack, step] }));
    await applyAll(step, 'after');
  },

  clearHistory: () => set({ undoStack: [], redoStack: [], selectedId: null }),
}));
