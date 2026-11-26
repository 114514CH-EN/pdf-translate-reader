import { useEffect, useState } from 'react';
import { useChatStore } from '../stores/chat';
import { useDocStore } from '../stores/doc';
import { usePaperIndex, usePaperIndexStore } from '../stores/paperIndex';
import { useViewStore } from '../stores/view';
import { Icon } from './Icon';

/** Go to a place in the document and outline the block there. */
export function jumpTo(page: number, y: number, blockId: number | null, pageHeight?: number) {
  const view = useViewStore.getState();
  const frac = pageHeight ? Math.max(0, y / pageHeight - 0.04) : 0;
  view.requestPageNav(page, frac);
  if (blockId != null) window.setTimeout(() => view.flashBlock(String(blockId)), 260);
}

function Section({ title, count, children, initial = true }: { title: string; count?: number; children: React.ReactNode; initial?: boolean }) {
  const [open, setOpen] = useState(initial);
  return (
    <section className="ol-section">
      <button type="button" className="ol-section-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name={open ? 'chevronDown' : 'next'} size={13} />
        <span>{title}</span>
        {count != null && <span className="ol-count">{count}</span>}
      </button>
      {open && children}
    </section>
  );
}

/**
 * 目录: the paper (when it was found as one), its sections, figures and tables, and its
 * references — each a place to jump to; a reference can be looked up and imported.
 */
export function OutlineTab({ docId }: { docId: string | null }) {
  const detail = useDocStore((s) => s.detail);
  const idx = usePaperIndex(docId);
  const state = usePaperIndexStore((s) => (docId ? s.byDoc[docId] : undefined));
  const load = usePaperIndexStore((s) => s.load);
  const openPaperSearch = useViewStore((s) => s.openPaperSearch);
  const currentPage = useViewStore((s) => s.currentPage);
  const [absOpen, setAbsOpen] = useState(false);
  const send = useChatStore((s) => s.send);
  const streaming = useChatStore((s) => s.streaming);
  const setSidebarTab = useViewStore((s) => s.setSidebarTab);

  useEffect(() => {
    if (docId) void load(docId, true);
  }, [docId, load]);

  const [byDom, setByDom] = useState<number | null>(null);
  useEffect(() => {
    if (!idx) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const pane = document.querySelector('.pane-right:not([aria-hidden]) .translation-pane');
      if (!pane) return setByDom(null);
      const line = pane.getBoundingClientRect().top + pane.clientHeight / 3;
      let found: number | null = null;
      let seen = false;
      idx.outline.forEach((o, i) => {
        if (o.block_id == null) return;
        const el = pane.querySelector(`[data-block-id="${o.block_id}"]`);
        if (!el) return;
        seen = true;
        if (el.getBoundingClientRect().top <= line) found = i;
      });
      setByDom(seen ? found : null);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    measure();
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('scroll', onScroll, true);
      cancelAnimationFrame(raf);
    };
  }, [idx, currentPage]);

  if (!docId) return <div className="ol-empty">打开一份文档后，这里会列出它的章节、图表和参考文献。</div>;
  const paper = detail && String(detail.id) === docId ? detail.paper : null;
  const h = (page: number) => idx?.page_sizes?.[String(page)]?.[1];
  const figs = idx ? Object.values(idx.figs).sort((a, b) => a.page - b.page || a.y - b.y) : [];
  const refs = idx ? Object.values(idx.refs) : [];
  // the section being read: the last heading at or before the current page …
  const byPage = idx ? idx.outline.reduce((acc, o, i) => (o.page <= currentPage ? i : acc), -1) : -1;
  // … or, with its heading on screen, the last one scrolled past the top third of the text
  const here = byDom ?? byPage;

  return (
    <div className="ol-tab">
      {paper && (
        <div className="ol-paper">
          <div className="ol-paper-title">{paper.title}</div>
          {paper.authors?.length > 0 && <div className="ol-paper-authors">{paper.authors.join(', ')}</div>}
          <div className="ol-paper-meta">
            {[paper.year, paper.venue].filter(Boolean).join(' · ')}
            {paper.doi && !paper.doi.toLowerCase().startsWith('10.48550/') && (
              <a href={`https://doi.org/${paper.doi}`} target="_blank" rel="noreferrer">
                DOI
              </a>
            )}
            {paper.arxiv && (
              <a href={`https://arxiv.org/abs/${paper.arxiv}`} target="_blank" rel="noreferrer">
                arXiv
              </a>
            )}
          </div>
          {paper.abstract && (
            <button type="button" className={`ol-paper-abs ${absOpen ? 'open' : ''}`} onClick={() => setAbsOpen(!absOpen)}>
              {paper.abstract}
            </button>
          )}
        </div>
      )}
      {state === 'loading' && !idx && <div className="ol-empty">正在整理目录…</div>}
      {state === 'error' && <div className="ol-empty">目录没能读出来，稍后再打开这一页试试。</div>}
      {idx && (
        <>
          <Section title="章节" count={idx.outline.length}>
            {idx.outline.length === 0 ? (
              <div className="ol-empty">这份文档没有识别出章节标题。</div>
            ) : (
              <ul className="ol-list">
                {idx.outline.map((o, i) => (
                  <li key={`${o.page}-${i}`} className="ol-row">
                    <button
                      type="button"
                      className={`ol-item lv${o.level} ${i === here ? 'here' : ''}`}
                      onClick={() => jumpTo(o.page, o.y, o.block_id, h(o.page))}
                    >
                      <span className="ol-item-text">
                        {o.title}
                        {o.title_zh && o.title_zh !== o.title && <span className="ol-item-zh">{o.title_zh}</span>}
                      </span>
                      <span className="ol-page">{o.page}</span>
                    </button>
                    {o.block_id != null && (
                      <button
                        type="button"
                        className="ol-explain"
                        title="让阅读助手讲解这一节"
                        disabled={streaming}
                        onClick={() => {
                          setSidebarTab('assistant');
                          void send(`讲解这一节：${o.title}`, o.page, { mode: 'section', sectionId: o.block_id! });
                        }}
                      >
                        讲解
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Section>
          {figs.length > 0 && (
            <Section title="图表" count={figs.length}>
              <ul className="ol-list">
                {figs.map((f) => (
                  <li key={f.key}>
                    <button type="button" className="ol-item ol-fig" onClick={() => jumpTo(f.page, f.y, f.block_id, h(f.page))}>
                      <span className="ol-item-text">
                        <b>{f.label}</b> {f.caption.slice(f.label.length).replace(/^[\s.:：\-—|]+/, '')}
                      </span>
                      <span className="ol-page">{f.page}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </Section>
          )}
          {refs.length > 0 && (
            <Section title="参考文献" count={refs.length} initial={refs.length <= 40}>
              <ul className="ol-list ol-refs">
                {refs.map((r) => (
                  <li key={r.key} className="ol-ref">
                    <button type="button" className="ol-ref-text" onClick={() => jumpTo(r.page, r.y, r.block_id, h(r.page))}>
                      {r.text}
                    </button>
                    <button
                      type="button"
                      className="link-btn ol-ref-find"
                      title={`查找这篇论文：${r.query}`}
                      onClick={() => openPaperSearch(r.query)}
                    >
                      找这篇
                    </button>
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </>
      )}
    </div>
  );
}
