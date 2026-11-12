import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { useDocStore } from '../stores/doc';
import { useTranslationStore } from '../stores/translation';
import { useViewStore } from '../stores/view';
import type { PageProgress } from '../types';

/**
 * 翻译进度条: one bar across the window, one segment per page — grey untranslated, light
 * partly translated, solid translated, red with failed blocks — and a round marker on
 * the page being read, which glides along as you scroll. Click a segment to jump there.
 */
export function ProgressStrip() {
  const docId = useDocStore((s) => s.activeId);
  const job = useTranslationStore((s) => s.job);
  const currentPage = useViewStore((s) => s.currentPage);
  const requestPageNav = useViewStore((s) => s.requestPageNav);
  const [pages, setPages] = useState<PageProgress[]>([]);
  const [hover, setHover] = useState<PageProgress | null>(null);
  const lastFetch = useRef(0);

  const refresh = useCallback(async () => {
    if (!docId) return;
    lastFetch.current = Date.now();
    try {
      const r = await api.progress(docId);
      if (useDocStore.getState().activeId === docId) setPages(r.pages);
    } catch {
      /* the strip is informational only */
    }
  }, [docId]);

  useEffect(() => {
    setPages([]);
    void refresh();
  }, [refresh]);

  // follow a running job (throttled) and refresh once it ends
  const jobDone = job?.done ?? -1;
  const jobStatus = job?.status ?? 'none';
  useEffect(() => {
    if (Date.now() - lastFetch.current > 1500 || jobStatus !== 'running') void refresh();
  }, [jobDone, jobStatus, refresh]);
  useEffect(() => {
    const on = () => void refresh();
    window.addEventListener('pdftr:translations-changed', on);
    return () => window.removeEventListener('pdftr:translations-changed', on);
  }, [refresh]);

  if (!docId || pages.length === 0) return null;
  const total = pages.reduce((a, p) => a + p.total, 0);
  const done = pages.reduce((a, p) => a + p.done, 0);
  const failed = pages.reduce((a, p) => a + p.failed, 0);
  const pct = total ? Math.round((done / total) * 100) : 100;
  const state = (p: PageProgress) =>
    p.failed > 0 ? 'failed' : p.total === 0 ? 'empty' : p.done >= p.total ? 'done' : p.done > 0 ? 'partial' : 'none';

  return (
    <div className="progress-strip" aria-label={`翻译进度 ${pct}%`}>
      <span className="progress-label" title={`已翻译 ${done}/${total} 个文本块${failed ? `，${failed} 个失败` : ''}`}>
        {hover
          ? `第 ${hover.page_no} 页 · ${hover.total ? `${hover.done}/${hover.total}` : '无文字'}${hover.failed ? ` · ${hover.failed} 失败` : ''}`
          : `已译 ${pct}%${failed ? ` · ${failed} 失败` : ''}`}
      </span>
      <div
        className={`progress-track ${pages.length > 150 ? 'is-packed' : pages.length > 60 ? 'is-dense' : ''}`}
        onMouseLeave={() => setHover(null)}
      >
        {pages.map((p) => (
          <button
            key={p.page_no}
            type="button"
            className={`progress-seg ${state(p)} ${p.page_no === currentPage ? 'current' : ''}`}
            aria-label={`第 ${p.page_no} 页：${p.total ? `已译 ${p.done}/${p.total}` : '无文字'}${p.failed ? `，${p.failed} 个失败` : ''}`}
            onMouseEnter={() => setHover(p)}
            onFocus={() => setHover(p)}
            onClick={() => requestPageNav(p.page_no)}
          />
        ))}
        {currentPage >= 1 && currentPage <= pages.length && (
          <span className="progress-thumb" style={{ left: `${((currentPage - 0.5) / pages.length) * 100}%` }} aria-hidden="true" />
        )}
      </div>
    </div>
  );
}
