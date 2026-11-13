import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { useDocStore } from '../stores/doc';
import { findBlock, useEditStore, type Change } from '../stores/edit';
import { useTranslationStore } from '../stores/translation';
import { useViewStore } from '../stores/view';
import type { EditSide, ReplaceResult } from '../types';
import { blockBox } from './PageAbsoluteView';
import { Icon } from './Icon';

/**
 * Toolbar tools that appear in edit mode: 撤销 / 重做 and 查找替换.
 *
 * Find & replace works on every translation of the document, not only the pages
 * on screen — for making a term consistent after the fact. It counts first
 * (查找), then replaces everything in one undoable step.
 */
export default function EditTools() {
  const docId = useDocStore((s) => s.activeId);
  const canUndo = useEditStore((s) => s.undoStack.length > 0);
  const canRedo = useEditStore((s) => s.redoStack.length > 0);
  const undo = useEditStore((s) => s.undo);
  const redo = useEditStore((s) => s.redo);
  const toast = useViewStore((s) => s.toast);
  const [open, setOpen] = useState(false);
  const [find, setFind] = useState('');
  const [replace, setReplace] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(true);
  const [found, setFound] = useState<ReplaceResult | null>(null);
  const [busy, setBusy] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  // history belongs to one document; leaving edit mode only lets go of the selection
  const lastDoc = useRef(docId);
  useEffect(() => {
    if (lastDoc.current !== docId) useEditStore.getState().clearHistory();
    lastDoc.current = docId;
  }, [docId]);
  useEffect(() => () => useEditStore.getState().select(null), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
      if (e.key === 'Escape' && t?.isContentEditable && t.closest('.abs-block')) {
        t.blur(); // first Esc: stop typing (the text is saved), the block stays selected for the arrow keys
        return;
      }
      if (e.key === 'Escape' && !typing) {
        useEditStore.getState().select(null);
        return;
      }
      // the selected block from the keyboard: arrows nudge it (Shift: 10× further), Delete hides it
      const sel = useEditStore.getState().selectedId;
      if (sel && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const cut = sel.indexOf(':');
        const side = sel.slice(0, cut) as EditSide;
        const id = sel.slice(cut + 1);
        const block = findBlock(id);
        const move: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
        if (block && move[e.key]) {
          e.preventDefault();
          const layout = side === 'src' ? block.src_edit?.layout : block.layout;
          const [x0, y0, x1, y1] = layout?.bbox ?? blockBox(block);
          const k = e.shiftKey ? 10 : 1;
          const [dx, dy] = move[e.key];
          const r = (v: number) => Math.round(v * 100) / 100;
          void useEditStore.getState().setLayout(id, { bbox: [r(x0 + dx * k), r(y0 + dy * k), r(x1 + dx * k), r(y1 + dy * k)] }, side);
          return;
        }
        if (block && (e.key === 'Delete' || e.key === 'Backspace')) {
          e.preventDefault();
          void useEditStore.getState().setLayout(id, { hidden: true }, side);
          return;
        }
      }
      if (!(e.ctrlKey || e.metaKey)) return;
      if (typing) {
        // while typing, Ctrl+Z is the text field's own undo — unless nothing has been typed
        // into the block since it was last saved (the cursor is merely parked in it)
        const id = t?.isContentEditable ? t.closest<HTMLElement>('[data-block-id]')?.dataset.blockId : undefined;
        const block = id ? findBlock(id) : undefined;
        if (!block || t?.classList.contains('abs-cell') || (t?.textContent ?? '') !== (block.translation ?? block.text)) return;
      }
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        void undo();
      } else if (k === 'y' || (k === 'z' && e.shiftKey)) {
        e.preventDefault();
        void redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', away);
    return () => window.removeEventListener('mousedown', away);
  }, [open]);

  const run = async (dry: boolean) => {
    if (!docId || !find || busy) return;
    setBusy(true);
    try {
      const r = await api.replaceInTranslations(docId, { find, replace, dry_run: dry, case_sensitive: caseSensitive });
      if (dry) {
        setFound(r);
      } else {
        const tr = useTranslationStore.getState();
        const changes: Change[] = r.changed.map((c) => ({
          blockId: String(c.block_id),
          before: { text: c.before },
          after: { text: c.after },
        }));
        for (const c of r.changed) tr.setBlockTranslation(String(c.block_id), c.after);
        useEditStore.getState().pushDone(changes);
        window.dispatchEvent(new Event('pdftr:translations-changed'));
        setFound(null);
        toast(r.blocks ? `已替换 ${r.hits} 处（${r.blocks} 个段落），可以撤销` : '没有找到', r.blocks ? 'success' : 'info');
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  // 从零编辑: a text box of one's own on the page being read, and more pages
  const addBox = async () => {
    const docId = useDocStore.getState().activeId;
    if (!docId) return;
    const pageNo = useViewStore.getState().currentPage;
    const tr = useTranslationStore.getState();
    const page = tr.pages[pageNo];
    const w = page?.width ?? 595;
    const mine = (page?.blocks ?? []).filter((b) => (b.meta as { user?: boolean } | undefined)?.user).length;
    const top = 96 + (mine % 12) * 44;
    try {
      const { block_id } = await api.addTextBlock(docId, pageNo, [72, top, w - 72, top + 34], '在这里输入文字');
      await tr.refreshPage(docId, pageNo);
      useEditStore.getState().select(String(block_id), 'src');
      window.dispatchEvent(new Event('pdftr:translations-changed'));
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    }
  };
  const addPage = async () => {
    const docId = useDocStore.getState().activeId;
    if (!docId) return;
    try {
      const r = await api.addPage(docId);
      useViewStore.getState().setPageCount(r.page_count);
      await useDocStore.getState().loadDocuments();
      window.setTimeout(() => useViewStore.getState().requestPageNav(r.page_no), 200);
      toast(`已添加第 ${r.page_no} 页`, 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  return (
    <>
      <button type="button" className="btn btn-icon-text" title="在这一页放一个文本框，自己写内容（放在原文一侧，可以拖动、改大小、设格式）" onClick={() => void addBox()}>
        <Icon name="textbox" size={15} />
        <span className="btn-label">文本框</span>
      </button>
      <button type="button" className="btn btn-icon-text" title="在文档末尾加一张空白页" onClick={() => void addPage()}>
        <Icon name="docPlus" size={15} />
        <span className="btn-label">加一页</span>
      </button>
      <button type="button" className="btn btn-icon-text" disabled={!canUndo} title="撤销（Ctrl+Z）" onClick={() => void undo()}>
        撤销
      </button>
      <button type="button" className="btn btn-icon-text" disabled={!canRedo} title="重做（Ctrl+Y）" onClick={() => void redo()}>
        重做
      </button>
      <div className="export-menu" ref={boxRef}>
        <button type="button" className={`btn ${open ? 'active' : ''}`} disabled={!docId} aria-expanded={open} onClick={() => setOpen(!open)}>
          查找替换
        </button>
        {open && (
          <form
            className="menu replace-pop"
            onSubmit={(e) => {
              e.preventDefault();
              void run(true);
            }}
          >
            <label className="replace-field">
              <span>查找</span>
              <input
                autoFocus
                value={find}
                onChange={(e) => {
                  setFind(e.target.value);
                  setFound(null);
                }}
                placeholder="译文里的文字"
              />
            </label>
            <label className="replace-field">
              <span>替换为</span>
              <input value={replace} onChange={(e) => setReplace(e.target.value)} placeholder="留空 = 删除" />
            </label>
            <label className="inline-check replace-case">
              <input
                type="checkbox"
                checked={caseSensitive}
                onChange={(e) => {
                  setCaseSensitive(e.target.checked);
                  setFound(null);
                }}
              />
              区分大小写
            </label>
            <p className="replace-status" role="status">
              {found
                ? found.hits
                  ? `找到 ${found.hits} 处，在 ${found.blocks} 个段落里（第 ${found.pages.slice(0, 8).join('、')}${found.pages.length > 8 ? '…' : ''} 页）`
                  : '没有找到'
                : '在整篇文档的译文里查找；公式占位符不会被改动。'}
            </p>
            <div className="replace-actions">
              <button type="submit" className="btn btn-sm" disabled={!find || busy}>
                查找
              </button>
              <button type="button" className="btn btn-sm btn-primary" disabled={!find || busy || (found !== null && found.hits === 0)} onClick={() => void run(false)}>
                全部替换
              </button>
            </div>
          </form>
        )}
      </div>
    </>
  );
}
