import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import { useDocStore } from '../stores/doc';
import { useViewStore } from '../stores/view';
import type { SearchHit } from '../types';
import { Icon } from './Icon';

/**
 * Ctrl+F: search the source text and the translation of the whole document.
 * Enter / ↓ next, Shift+Enter / ↑ previous; picking a hit scrolls both panes
 * to it and outlines the block.
 */
export function SearchBar() {
  const open = useViewStore((s) => s.searchOpen);
  const setOpen = useViewStore((s) => s.setSearchOpen);
  const requestPageNav = useViewStore((s) => s.requestPageNav);
  const flashBlock = useViewStore((s) => s.flashBlock);
  const docId = useDocStore((s) => s.activeId);
  const [q, setQ] = useState('');
  const [scope, setScope] = useState<'all' | 'src' | 'tgt'>('all');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [total, setTotal] = useState(0);
  const [idx, setIdx] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [listOpen, setListOpen] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const focus = () => window.setTimeout(() => inputRef.current?.select(), 0);
    window.addEventListener('pdftr:focus-search', focus);
    return () => window.removeEventListener('pdftr:focus-search', focus);
  }, []);
  useEffect(() => {
    if (open) window.setTimeout(() => inputRef.current?.select(), 0);
  }, [open]);
  useEffect(() => {
    setHits([]);
    setTotal(0);
    setIdx(-1);
  }, [docId]);

  // debounced query
  useEffect(() => {
    if (!open || !docId) return;
    const term = q.trim();
    if (!term) {
      setHits([]);
      setTotal(0);
      setIdx(-1);
      return;
    }
    let live = true;
    const t = window.setTimeout(async () => {
      setBusy(true);
      try {
        const r = await api.search(docId, term);
        if (!live) return;
        setHits(r.results);
        setTotal(r.total);
        setIdx(-1);
        setListOpen(true);
      } catch {
        if (live) {
          setHits([]);
          setTotal(0);
        }
      } finally {
        if (live) setBusy(false);
      }
    }, 220);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [q, open, docId]);

  const shown = useMemo(() => (scope === 'all' ? hits : hits.filter((h) => h.field === scope)), [hits, scope]);

  const go = (i: number) => {
    if (shown.length === 0) return;
    const n = (i + shown.length) % shown.length;
    setIdx(n);
    const h = shown[n];
    requestPageNav(h.page_no, Math.max(0, h.y - 0.06));
    // outline the block once its page has rendered
    window.setTimeout(() => flashBlock(String(h.block_id)), 260);
    listRef.current?.querySelector(`[data-hit="${n}"]`)?.scrollIntoView({ block: 'nearest' });
  };

  if (!open || !docId) return null;
  const nSrc = hits.filter((h) => h.field === 'src').length;
  const nTgt = hits.length - nSrc;

  return (
    <div className="search-bar" role="search">
      <div className="search-row">
        <Icon name="search" size={15} />
        <input
          ref={inputRef}
          className="search-input"
          type="search"
          placeholder="搜索原文和译文…"
          aria-label="搜索原文和译文"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === 'ArrowDown') {
              e.preventDefault();
              go(e.shiftKey ? idx - 1 : idx + 1);
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              go(idx - 1);
            } else if (e.key === 'Escape') {
              setOpen(false);
            }
          }}
        />
        <span className="search-count" aria-live="polite">
          {busy ? '…' : q.trim() ? (shown.length ? `${idx >= 0 ? idx + 1 : 0}/${shown.length}${total > hits.length ? '+' : ''}` : '无结果') : ''}
        </span>
        <div className="seg seg-sm" role="radiogroup" aria-label="搜索范围">
          {(
            [
              ['all', '全部'],
              ['src', `原文 ${q.trim() ? nSrc : ''}`],
              ['tgt', `译文 ${q.trim() ? nTgt : ''}`],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={scope === id}
              className={scope === id ? 'active' : ''}
              onClick={() => {
                setScope(id);
                setIdx(-1);
              }}
            >
              {label.trim()}
            </button>
          ))}
        </div>
        <button type="button" className="icon-btn" title="上一个（Shift+Enter）" aria-label="上一个" disabled={!shown.length} onClick={() => go(idx - 1)}>
          <Icon name="up" size={15} />
        </button>
        <button type="button" className="icon-btn" title="下一个（Enter）" aria-label="下一个" disabled={!shown.length} onClick={() => go(idx + 1)}>
          <Icon name="down" size={15} />
        </button>
        <button
          type="button"
          className="icon-btn"
          title={listOpen ? '收起结果列表' : '展开结果列表'}
          aria-label="结果列表"
          aria-expanded={listOpen}
          disabled={!shown.length}
          onClick={() => setListOpen((o) => !o)}
        >
          <Icon name="rows" size={15} />
        </button>
        <button type="button" className="icon-btn" title="关闭（Esc）" aria-label="关闭搜索" onClick={() => setOpen(false)}>
          <Icon name="close" size={15} />
        </button>
      </div>
      {listOpen && shown.length > 0 && (
        <div className="search-results" ref={listRef}>
          {shown.map((h, i) => (
            <button
              key={`${h.block_id}-${h.field}-${i}`}
              type="button"
              data-hit={i}
              className={`search-hit ${i === idx ? 'current' : ''}`}
              onClick={() => go(i)}
            >
              <span className="search-hit-meta">
                {h.field === 'src' ? '原文' : '译文'}第 {h.page_no} 页
              </span>
              <span className="search-hit-text">
                {h.pre}
                <mark>{h.match}</mark>
                {h.post}
              </span>
            </button>
          ))}
          {total > hits.length && <div className="search-more">只显示前 {hits.length} 条，共 {total} 条，请输入更具体的关键词</div>}
        </div>
      )}
    </div>
  );
}
