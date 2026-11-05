import { useEffect, useRef, type RefObject } from 'react';
import { api } from '../api/client';
import { useDocStore } from '../stores/doc';
import { useViewStore } from '../stores/view';
import { pageAtTop } from './useSyncScroll';

/**
 * 最近阅读位置: restore where the reader left a document (page + position in
 * the page) once its pages exist, and remember the position while reading.
 */
export function useReadingPosition(leftRef: RefObject<HTMLElement | null>): void {
  const docId = useDocStore((s) => s.activeId);
  const detail = useDocStore((s) => s.detail);
  const pageCount = useViewStore((s) => s.pageCount);
  const restored = useRef<string | null>(null);

  // restore (once per opened document)
  useEffect(() => {
    if (!docId || !detail || String(detail.id) !== String(docId) || pageCount === 0) return;
    if (restored.current === docId) return;
    restored.current = docId;
    const page = detail.last_page ?? 0;
    if (page > 1 || (detail.last_frac ?? 0) > 0.02) {
      const target = Math.min(page || 1, pageCount);
      // let the panes lay out their pages first
      window.setTimeout(() => {
        useViewStore.getState().requestPageNav(target, detail.last_frac ?? 0);
        if (target > 1) useViewStore.getState().toast(`已回到上次阅读的第 ${target} 页`, 'info');
      }, 350);
    }
  }, [docId, detail, pageCount]);

  // remember (debounced) — also on tab close
  useEffect(() => {
    if (!docId) return;
    let t = 0;
    let last = '';
    const save = () => {
      const el = leftRef.current;
      if (!el || restored.current !== docId) return; // do not overwrite before restoring
      const pos = pageAtTop(el);
      if (!pos) return;
      const key = `${pos.page}:${pos.frac.toFixed(3)}`;
      if (key === last) return;
      last = key;
      void api.savePosition(docId, Number(pos.page), pos.frac).catch(() => undefined);
    };
    const onScroll = (e: Event) => {
      if (e.target !== leftRef.current) return;
      window.clearTimeout(t);
      t = window.setTimeout(save, 900);
    };
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('beforeunload', save);
    return () => {
      window.clearTimeout(t);
      save();
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('beforeunload', save);
    };
  }, [docId, leftRef]);
}
