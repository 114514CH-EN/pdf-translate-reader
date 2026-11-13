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

  // 从零编辑: arm a tool, then click (or drag) on a page of the original to place it — components/PlaceTool.tsx
  const tool = useEditStore((s) => s.tool);
  const setTool = useEditStore((s) => s.setTool);
  const imgRef = useRef<HTMLInputElement>(null);
  const arm = (kind: 'text' | 'line') => {
    if (tool?.kind === kind) return setTool(null);
    setTool({ kind });
    toast(kind === 'text' ? '在左边的页面上点一下放文本框，或拖出想要的大小（Esc 取消）' : '在左边的页面上拖出一条线（Esc 取消）', 'info');
  };
  // 页面: add / delete / reorder
  const [pagesOpen, setPagesOpen] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const pagesRef = useRef<HTMLDivElement>(null);
  const currentPage = useViewStore((s) => s.currentPage);
  const pageCount = useViewStore((s) => s.pageCount);
  useEffect(() => {
    if (!pagesOpen) return;
    const onDown = (e: MouseEvent) => {
      if (pagesRef.current && !pagesRef.current.contains(e.target as Node)) setPagesOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [pagesOpen]);
  /** the pages changed places: everything shown per page number is read again */
  const reloadPages = async (docId: string, count: number, goTo: number) => {
    const tr = useTranslationStore.getState();
    tr.reset();
    useEditStore.getState().clearHistory(); // the steps recorded so far name pages that have moved
    useViewStore.getState().setPageCount(count);
    await useDocStore.getState().loadDocuments();
    for (let n = Math.max(1, goTo - 1); n <= Math.min(count, goTo + 1); n++) void tr.refreshPage(docId, n);
    window.setTimeout(() => useViewStore.getState().requestPageNav(goTo), 150);
  };
  const pageOp = async (op: 'add' | 'delete' | 'up' | 'down') => {
    const docId = useDocStore.getState().activeId;
    if (!docId) return;
    setPagesOpen(false);
    setConfirmDel(false);
    try {
      if (op === 'add') {
        const r = await api.addPage(docId);
        await reloadPages(docId, r.page_count, r.page_no);
        toast(`已添加第 ${r.page_no} 页`, 'success');
      } else if (op === 'delete') {
        const r = await api.deletePage(docId, currentPage);
        await reloadPages(docId, r.page_count, Math.min(currentPage, r.page_count));
        toast('这一页已删除', 'success');
      } else {
        const r = await api.movePage(docId, currentPage, currentPage + (op === 'up' ? -1 : 1));
        await reloadPages(docId, r.page_count, r.page_no);
        toast(`这一页现在是第 ${r.page_no} 页`, 'success');
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  return (
    <>
      <button type="button" className={`btn btn-icon-text ${tool?.kind === 'text' ? 'active' : ''}`} aria-pressed={tool?.kind === 'text'} title="文本框：点一下这里，再到左边的页面上点一下（或拖出大小）" onClick={() => arm('text')}>
        <Icon name="textbox" size={15} />
        <span className="btn-label">文本框</span>
      </button>
      <button type="button" className={`btn btn-icon-text ${tool?.kind === 'image' ? 'active' : ''}`} aria-pressed={tool?.kind === 'image'} title="图片：选一张图，再到左边的页面上点一下（或拖出大小）" onClick={() => (tool?.kind === 'image' ? setTool(null) : imgRef.current?.click())}>
        <Icon name="picture" size={15} />
        <span className="btn-label">图片</span>
      </button>
      <input
        ref={imgRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/bmp,image/webp"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          setTool({ kind: 'image', file });
          toast('在左边的页面上点一下放这张图，或拖出想要的大小（Esc 取消）', 'info');
        }}
      />
      <button type="button" className={`btn btn-icon-text ${tool?.kind === 'line' ? 'active' : ''}`} aria-pressed={tool?.kind === 'line'} title="线条：点一下这里，再到左边的页面上拖出一条线" onClick={() => arm('line')}>
        <Icon name="line" size={15} />
        <span className="btn-label">线条</span>
      </button>
      <div className="export-menu" ref={pagesRef}>
        <button type="button" className="btn btn-icon-text" aria-expanded={pagesOpen} title="页面：加一页、删除这一页、调整顺序" onClick={() => { setPagesOpen(!pagesOpen); setConfirmDel(false); }}>
          <Icon name="docPlus" size={15} />
          <span className="btn-label">页面</span>
          <Icon name="chevronDown" size={13} className="caret" />
        </button>
        {pagesOpen && (
          <div className="menu" role="menu">
            <button type="button" className="menu-item" onClick={() => void pageOp('add')}>
              在末尾加一张空白页
            </button>
            <div className="menu-sep" />
            <button type="button" className="menu-item" disabled={currentPage <= 1} onClick={() => void pageOp('up')}>
              把第 {currentPage} 页往前移
            </button>
            <button type="button" className="menu-item" disabled={currentPage >= pageCount} onClick={() => void pageOp('down')}>
              把第 {currentPage} 页往后移
            </button>
            <div className="menu-sep" />
            {confirmDel ? (
              <button type="button" className="menu-item is-danger" onClick={() => void pageOp('delete')}>
                确认删除第 {currentPage} 页（不能撤销）
              </button>
            ) : (
              <button type="button" className="menu-item" disabled={pageCount <= 1} onClick={() => setConfirmDel(true)}>
                删除第 {currentPage} 页…
              </button>
            )}
          </div>
        )}
      </div>
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
