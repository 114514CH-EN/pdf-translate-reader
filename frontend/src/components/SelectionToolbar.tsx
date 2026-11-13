import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { useChatStore } from '../stores/chat';
import { useDocStore } from '../stores/doc';
import { useHighlightStore } from '../stores/highlights';
import { useViewStore } from '../stores/view';
import type { AssistantMode, Highlight, HighlightColor } from '../types';
import { isPetMode, summonPet } from '../pet/mode';
import { Icon } from './Icon';
import { Markdown } from './Markdown';

/**
 * 划词工具条: select text in either pane → look up / translate (translation
 * API), explain / walk through a formula (reading assistant), highlight in
 * five colours, attach a note, add to the glossary, copy.
 * Clicking an existing highlight opens the same card to edit its note/colour.
 */

const COLORS: { id: HighlightColor; label: string }[] = [
  { id: 'yellow', label: '黄色' },
  { id: 'green', label: '绿色' },
  { id: 'blue', label: '蓝色' },
  { id: 'pink', label: '粉色' },
  { id: 'orange', label: '橙色' },
];

interface Sel {
  text: string;
  pageNo: number;
  pane: 'src' | 'tgt';
  /** rects in page pt — null when the selection cannot be highlighted (逐句对照 view) */
  rects: number[][] | null;
  /** viewport box of the selection */
  box: { left: number; top: number; bottom: number; right: number };
}

type Panel = null | 'lookup' | 'term' | 'note';

function pageBoxOf(node: Node | null): HTMLElement | null {
  const el = node instanceof HTMLElement ? node : node?.parentElement ?? null;
  return el?.closest<HTMLElement>('.pdf-page[data-page-no], .abs-page[data-page-no]') ?? null;
}

function paneOf(node: Node | null): 'src' | 'tgt' | null {
  const el = node instanceof HTMLElement ? node : node?.parentElement ?? null;
  if (el?.closest('.pdf-pane')) return 'src';
  if (el?.closest('.translation-pane')) return 'tgt';
  return null;
}

/** Client rects of a range → merged line boxes in page pt. */
function rangeRects(range: Range, page: HTMLElement, zoom: number): number[][] {
  const pr = page.getBoundingClientRect();
  const raw = Array.from(range.getClientRects())
    .filter((r) => r.width > 1 && r.height > 2)
    .map((r) => [
      (Math.max(r.left, pr.left) - pr.left) / zoom,
      (Math.max(r.top, pr.top) - pr.top) / zoom,
      (Math.min(r.right, pr.right) - pr.left) / zoom,
      (Math.min(r.bottom, pr.bottom) - pr.top) / zoom,
    ])
    .filter((r) => r[2] > r[0] && r[3] > r[1])
    .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const out: number[][] = [];
  for (const r of raw) {
    const last = out[out.length - 1];
    const sameLine = last && Math.abs((last[1] + last[3]) / 2 - (r[1] + r[3]) / 2) < Math.min(last[3] - last[1], r[3] - r[1]) * 0.6;
    if (last && sameLine && r[0] <= last[2] + 4) {
      last[0] = Math.min(last[0], r[0]);
      last[1] = Math.min(last[1], r[1]);
      last[2] = Math.max(last[2], r[2]);
      last[3] = Math.max(last[3], r[3]);
    } else {
      out.push([...r]);
    }
  }
  return out.map((r) => r.map((v) => Math.round(v * 100) / 100));
}

function plainFirstLine(md: string): string {
  const line = md.split('\n').find((l) => l.trim() && !l.startsWith('#')) ?? '';
  const bold = /\*\*([^*]+)\*\*/.exec(line);
  return (bold ? bold[1] : line).replace(/[*`_>#]/g, '').replace(/^[-•\d.)\s]+/, '').trim().slice(0, 60);
}

export function SelectionToolbar() {
  const docId = useDocStore((s) => s.activeId);
  const zoom = useViewStore((s) => s.zoom);
  const toast = useViewStore((s) => s.toast);
  const setSidebarTab = useViewStore((s) => s.setSidebarTab);
  const addHighlight = useHighlightStore((s) => s.add);
  const updateHighlight = useHighlightStore((s) => s.update);
  const removeHighlight = useHighlightStore((s) => s.remove);
  const setActiveHl = useHighlightStore((s) => s.setActive);

  const [sel, setSel] = useState<Sel | null>(null);
  const [hl, setHl] = useState<Highlight | null>(null); // highlight being edited
  const [panel, setPanel] = useState<Panel>(null);
  const [lookup, setLookup] = useState<{ loading: boolean; md: string; error: string }>({ loading: false, md: '', error: '' });
  const [term, setTerm] = useState({ src: '', tgt: '' });
  const [note, setNote] = useState('');
  const [anchor, setAnchor] = useState<{ left: number; top: number; bottom: number; right: number } | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setAnchor(null);
    setSel(null);
    setHl(null);
    setPanel(null);
    setActiveHl(null);
    setLookup({ loading: false, md: '', error: '' });
  }, [setActiveHl]);

  useEffect(() => {
    if (docId) void useHighlightStore.getState().loadFor(docId);
    close();
  }, [docId, close]);

  // read the selection after mouse / keyboard selection ends
  useEffect(() => {
    const onUp = (e: MouseEvent | KeyboardEvent) => {
      if (cardRef.current?.contains(e.target as Node)) return;
      window.setTimeout(() => {
        const s = window.getSelection();
        const text = s && !s.isCollapsed ? s.toString().replace(/\s+/g, ' ').trim() : '';
        if (!s || !text || s.rangeCount === 0) {
          // plain click: on an existing highlight → edit it, elsewhere → close
          if (e instanceof MouseEvent) {
            const target = e.target as HTMLElement;
            const page = pageBoxOf(target);
            const pane = paneOf(target);
            if (page && pane) {
              const pr = page.getBoundingClientRect();
              const x = (e.clientX - pr.left) / useViewStore.getState().zoom;
              const y = (e.clientY - pr.top) / useViewStore.getState().zoom;
              const n = Number(page.dataset.pageNo);
              const hit = useHighlightStore
                .getState()
                .items.find(
                  (h) => h.page_no === n && h.pane === pane && h.rects.some((r) => x >= r[0] && x <= r[2] && y >= r[1] - 1 && y <= r[3] + 1),
                );
              if (hit) {
                setSel(null);
                setHl(hit);
                setNote(hit.note);
                setPanel('note');
                setActiveHl(hit.id);
                setLookup({ loading: false, md: '', error: '' });
                const rr = hit.rects[hit.rects.length - 1];
                const z = useViewStore.getState().zoom;
                setAnchor({ left: pr.left + rr[0] * z, top: pr.top + hit.rects[0][1] * z, bottom: pr.top + rr[3] * z, right: pr.left + rr[2] * z });
                return;
              }
            }
          }
          if (!cardRef.current?.contains(document.activeElement)) close();
          return;
        }
        const range = s.getRangeAt(0);
        const pane = paneOf(range.commonAncestorContainer);
        if (!pane) return;
        const page = pageBoxOf(range.startContainer) ?? pageBoxOf(range.commonAncestorContainer);
        const flowPage = (range.startContainer.parentElement ?? null)?.closest<HTMLElement>('.flow-page[data-page-no]');
        const pageNo = Number(page?.dataset.pageNo ?? flowPage?.dataset.pageNo ?? useViewStore.getState().currentPage);
        const z = useViewStore.getState().zoom;
        const rects = page ? rangeRects(range, page, z) : null;
        const b = range.getBoundingClientRect();
        setHl(null);
        setActiveHl(null);
        setPanel(null);
        setLookup({ loading: false, md: '', error: '' });
        setSel({ text: text.slice(0, 3000), pageNo, pane, rects: rects && rects.length ? rects : null, box: b });
        setAnchor({ left: b.left, top: b.top, bottom: b.bottom, right: b.right });
      }, 0);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      else if (e.shiftKey) onUp(e);
    };
    const onScroll = (e: Event) => {
      // the card is positioned in the viewport; scrolling a pane moves the text away
      if (!cardRef.current?.contains(e.target as Node)) close();
    };
    document.addEventListener('mouseup', onUp);
    document.addEventListener('keyup', onKey);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('keyup', onKey);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [close, setActiveHl]);

  useEffect(() => {
    if (zoom) close(); // geometry changed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom]);

  if (!docId || !anchor || (!sel && !hl)) return null;

  const text = sel?.text ?? hl?.text ?? '';
  const pageNo = sel?.pageNo ?? hl?.page_no ?? 1;
  const isShort = text.split(/\s+/).length <= 3 && text.length <= 40;

  const doLookup = async () => {
    setPanel('lookup');
    setLookup({ loading: true, md: '', error: '' });
    try {
      const r = await api.lookup(docId, text, pageNo);
      setLookup({ loading: false, md: r.result_md, error: '' });
    } catch (e) {
      setLookup({ loading: false, md: '', error: e instanceof Error ? e.message : String(e) });
    }
  };

  const ask = async (mode: AssistantMode) => {
    const chat = useChatStore.getState();
    if (isPetMode()) summonPet();
    else setSidebarTab('assistant');
    await chat.loadFor(docId);
    const label = mode === 'formula' ? '讲解这个公式' : mode === 'translate' ? '翻译并解释术语' : '解释这段内容';
    close();
    window.getSelection()?.removeAllRanges();
    if (useChatStore.getState().notConfigured) {
      toast('阅读助手还没有配置 API：请先在侧栏或 设置 → 阅读助手 中配置', 'error');
      return;
    }
    void useChatStore.getState().send(label, pageNo, { mode, quote: text });
  };

  const doHighlight = async (color: HighlightColor, withNote = false) => {
    if (!sel?.rects) return;
    const h = await addHighlight({ page_no: sel.pageNo, pane: sel.pane, rects: sel.rects, text: sel.text, color });
    window.getSelection()?.removeAllRanges();
    if (!h) return;
    if (withNote) {
      setSel(null);
      setHl(h);
      setNote('');
      setPanel('note');
      setActiveHl(h.id);
    } else {
      close();
      toast('已高亮', 'success');
    }
  };

  const saveTerm = async () => {
    if (!term.src.trim() || !term.tgt.trim()) {
      toast('请填写原文术语和译法', 'error');
      return;
    }
    try {
      await api.createGlossary({ doc_id: docId, src_term: term.src.trim(), tgt_term: term.tgt.trim(), status: 'approved' });
      window.dispatchEvent(new Event('pdftr:glossary-changed'));
      toast(`已加入术语库：${term.src.trim()} → ${term.tgt.trim()}`, 'success');
      close();
    } catch (e) {
      toast(`加入术语库失败：${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制', 'success');
    } catch {
      toast('复制失败：浏览器不允许访问剪贴板', 'error');
    }
  };

  // place above the selection when there is room, otherwise below; keep inside the viewport
  const W = panel ? 452 : 0;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = Math.min(Math.max(8, anchor.left), vw - Math.max(W, 340) - 8);
  const below = anchor.top < (panel ? 300 : 60);
  const style: React.CSSProperties = below
    ? { left, top: Math.min(anchor.bottom + 8, vh - 80) }
    : { left, bottom: vh - anchor.top + 8 };

  return (
    <div
      ref={cardRef}
      className={`sel-card ${panel ? 'with-panel' : ''}`}
      style={style}
      role="dialog"
      aria-label={hl ? '编辑高亮' : '选中文字操作'}
      onMouseDown={(e) => {
        // keep the text selection while clicking buttons (inputs still focus normally)
        const t = e.target as HTMLElement;
        if (!t.closest('input, textarea, select')) e.preventDefault();
      }}
    >
      {sel && (
        <div className="sel-bar">
          <button type="button" className="sel-btn" title={isShort ? '查词（语境释义）' : '翻译选中内容'} onClick={() => void doLookup()}>
            <Icon name="lookup" size={14} />
            {isShort ? '查词' : '翻译'}
          </button>
          <button type="button" className="sel-btn" title="让阅读助手解释这段" onClick={() => void ask('explain')}>
            <Icon name="help" size={14} />
            解释
          </button>
          <button type="button" className="sel-btn" title="让阅读助手讲解公式 / 推导" onClick={() => void ask('formula')}>
            <Icon name="sigma" size={14} />
            讲公式
          </button>
          {sel.rects && (
            <>
              <span className="sel-sep" />
              {COLORS.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={`sel-color hl-${c.id}`}
                  title={`${c.label}高亮`}
                  aria-label={`${c.label}高亮`}
                  onClick={() => void doHighlight(c.id)}
                />
              ))}
              <button type="button" className="sel-btn icon-only" title="高亮并写笔记" aria-label="高亮并写笔记" onClick={() => void doHighlight('yellow', true)}>
                <Icon name="note" size={14} />
              </button>
            </>
          )}
          <span className="sel-sep" />
          <button
            type="button"
            className="sel-btn icon-only"
            title="加入术语库"
            aria-label="加入术语库"
            onClick={() => {
              setTerm({ src: text.slice(0, 80), tgt: lookup.md ? plainFirstLine(lookup.md) : '' });
              setPanel('term');
            }}
          >
            <Icon name="addTerm" size={14} />
          </button>
          <button type="button" className="sel-btn icon-only" title="复制" aria-label="复制" onClick={() => void copy()}>
            <Icon name="copy" size={14} />
          </button>
        </div>
      )}

      {panel === 'lookup' && (
        <div className="sel-panel">
          <div className="sel-quote">{text.length > 160 ? text.slice(0, 160) + '…' : text}</div>
          {lookup.loading && <div className="sel-loading">查询中…</div>}
          {lookup.error && <div className="test-result bad">{lookup.error}</div>}
          {lookup.md && (
            <div className="sel-result">
              <Markdown text={lookup.md} />
            </div>
          )}
          {lookup.md && (
            <div className="card-actions">
              <button
                type="button"
                className="btn btn-xs"
                onClick={() => {
                  setTerm({ src: text.slice(0, 80), tgt: plainFirstLine(lookup.md) });
                  setPanel('term');
                }}
              >
                加入术语库
              </button>
              <button type="button" className="btn btn-xs" onClick={() => void ask('explain')}>
                问助手
              </button>
            </div>
          )}
        </div>
      )}

      {panel === 'term' && (
        <div className="sel-panel">
          <div className="sel-form">
            <label>
              原文
              <input value={term.src} onChange={(e) => setTerm({ ...term, src: e.target.value })} />
            </label>
            <label>
              译法
              <input
                autoFocus
                value={term.tgt}
                placeholder="例如 频谱泄漏"
                onChange={(e) => setTerm({ ...term, tgt: e.target.value })}
                onKeyDown={(e) => e.key === 'Enter' && void saveTerm()}
              />
            </label>
          </div>
          <div className="card-actions">
            <button type="button" className="btn btn-xs" onClick={() => setPanel(null)}>
              取消
            </button>
            <button type="button" className="btn btn-primary btn-xs" onClick={() => void saveTerm()}>
              加入术语库
            </button>
          </div>
        </div>
      )}

      {panel === 'note' && hl && (
        <div className="sel-panel">
          <div className="sel-hl-head">
            {COLORS.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`sel-color hl-${c.id} ${hl.color === c.id ? 'current' : ''}`}
                title={`改成${c.label}`}
                aria-label={`改成${c.label}`}
                onClick={() => {
                  void updateHighlight(hl.id, { color: c.id });
                  setHl({ ...hl, color: c.id });
                }}
              />
            ))}
            <span className="sel-hl-page">{hl.pane === 'src' ? '原文' : '译文'}第 {hl.page_no} 页</span>
          </div>
          <div className="sel-quote">{hl.text.length > 160 ? hl.text.slice(0, 160) + '…' : hl.text}</div>
          <textarea
            className="sel-note"
            rows={3}
            autoFocus
            placeholder="写点笔记…（Ctrl+Enter 保存）"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                void updateHighlight(hl.id, { note });
                close();
              }
            }}
          />
          <div className="card-actions">
            <button
              type="button"
              className="btn btn-xs danger"
              onClick={() => {
                void removeHighlight(hl.id);
                close();
              }}
            >
              删除高亮
            </button>
            <button type="button" className="btn btn-xs" onClick={() => void ask('explain')}>
              问助手
            </button>
            <button
              type="button"
              className="btn btn-primary btn-xs"
              onClick={() => {
                void updateHighlight(hl.id, { note });
                close();
              }}
            >
              保存笔记
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
