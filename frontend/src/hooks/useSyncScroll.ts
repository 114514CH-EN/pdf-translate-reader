import { useEffect, useRef, type RefObject } from 'react';
import { useViewStore } from '../stores/view';

/** Scroll a page element ([data-page-no]) into view inside a scroll container. */
export function scrollPageIntoView(
  container: HTMLElement,
  pageNo: number,
  behavior: ScrollBehavior = 'smooth',
  frac: number = useViewStore.getState().navFrac,
): boolean {
  const target = container.querySelector<HTMLElement>(`[data-page-no="${pageNo}"]`);
  if (!target) return false;
  const r = target.getBoundingClientRect();
  const delta = r.top - container.getBoundingClientRect().top;
  // frac > 0: a remembered position inside the page; 0: page top with a little margin
  const offset = frac > 0 ? frac * r.height : -8;
  container.scrollTo({ top: container.scrollTop + delta + offset, behavior });
  return true;
}

/** Outermost [data-page-no] elements of a pane (PdfPane nests a page inside its slot). */
function pageElements(container: HTMLElement): HTMLElement[] {
  // use the innermost page box (slot padding/margins would skew the fraction)
  return Array.from(container.querySelectorAll<HTMLElement>('[data-page-no]'))
    .filter((el) => !el.parentElement?.closest('[data-page-no]'))
    .map((el) => el.querySelector<HTMLElement>('[data-page-no]') ?? el);
}

/** Page under the viewport's top edge (+ fractional position inside that page). */
export function pageAtTop(container: HTMLElement): { page: string; frac: number; above: number } | null {
  const top = container.getBoundingClientRect().top + 1;
  for (const el of pageElements(container)) {
    const r = el.getBoundingClientRect();
    if (r.bottom > top) {
      const frac = r.height > 0 ? Math.min(Math.max((top - r.top) / r.height, 0), 1) : 0;
      // viewport top inside the gap above this page: keep that pixel offset too
      return { page: el.dataset.pageNo ?? '', frac, above: Math.max(0, r.top - top) };
    }
  }
  return null;
}

/** Page whose box contains the point `frac` of the way down the viewport. */
function pageAtFraction(container: HTMLElement, frac: number): string | null {
  const c = container.getBoundingClientRect();
  const y = c.top + c.height * frac;
  let best: HTMLElement | null = null;
  let bestDist = Infinity;
  for (const el of pageElements(container)) {
    const r = el.getBoundingClientRect();
    if (r.top <= y && r.bottom >= y) return el.dataset.pageNo ?? null;
    const d = Math.min(Math.abs(r.top - y), Math.abs(r.bottom - y));
    if (d < bestDist) {
      bestDist = d;
      best = el;
    }
  }
  return best?.dataset.pageNo ?? null;
}

/**
 * Bidirectional scroll sync between two scroll containers.
 *
 * Primary mapping is geometric: the page under the top edge of the source pane
 * and the fraction scrolled through it are reproduced in the target pane. Both
 * panes in 整页预览 render pages with the same aspect ratio and zoom, so this is
 * exact (the old block-anchor mapping drifted wherever blocks were missing).
 * In 逐句对照 (page heights differ) the topmost shared block anchor refines it.
 */
export function useSyncScroll(
  leftRef: RefObject<HTMLElement | null>,
  rightRef: RefObject<HTMLElement | null>,
  enabled: boolean,
  rebind?: unknown,
): void {
  const lockUntil = useRef(0);
  const lockedTarget = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let raf = 0;

    const topAnchor = (container: HTMLElement): HTMLElement | null => {
      const cRect = container.getBoundingClientRect();
      let best: HTMLElement | null = null;
      let bestDist = Infinity;
      container.querySelectorAll<HTMLElement>('[data-block-id]').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.bottom <= cRect.top + 2 || r.top >= cRect.bottom - 2) return;
        const dist = r.top - cRect.top;
        if (dist >= -2 && dist < bestDist) {
          bestDist = dist;
          best = el;
        }
      });
      return best;
    };

    const sync = (src: HTMLElement, dst: HTMLElement) => {
      // ignore the scroll event produced by our own programmatic scroll
      if (Date.now() < lockUntil.current && lockedTarget.current === src) return;
      const pos = pageAtTop(src);
      if (!pos) return;
      const pick = (root: HTMLElement) =>
        pageElements(root).find((el) => el.dataset.pageNo === pos.page) ?? null;
      const dstPage = pick(dst);
      const srcPage = pick(src);
      if (!dstPage || !srcPage) return;
      const dRect = dst.getBoundingClientRect();
      const sr = srcPage.getBoundingClientRect();
      const dr = dstPage.getBoundingClientRect();
      const sameShape = Math.abs(sr.height / Math.max(sr.width, 1) - dr.height / Math.max(dr.width, 1)) < 0.03;

      let targetTop: number | null = null;
      if (!sameShape) {
        // flow view: align the topmost block both panes know about
        const anchor = topAnchor(src);
        const id = anchor?.dataset.blockId;
        const dAnchor = id ? dst.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(id)}"]`) : null;
        if (anchor && dAnchor) {
          const off = anchor.getBoundingClientRect().top - src.getBoundingClientRect().top;
          targetTop = dAnchor.getBoundingClientRect().top - dRect.top + dst.scrollTop - off;
        }
      }
      if (targetTop === null) {
        targetTop = dr.top - dRect.top + dst.scrollTop + pos.frac * dr.height - pos.above - 1;
      }
      const next = Math.max(0, Math.round(targetTop));
      if (Math.abs(dst.scrollTop - next) < 1) return;
      lockUntil.current = Date.now() + 80;
      lockedTarget.current = dst;
      dst.scrollTop = next;
    };

    // Delegated (capture) listener: pane elements are swapped when the PDF
    // finishes loading or the view mode changes, so refs are resolved per event.
    const onScroll = (e: Event) => {
      const left = leftRef.current;
      const right = rightRef.current;
      if (!left || !right) return;
      const src = e.target === left ? left : e.target === right ? right : null;
      if (!src || raf) return;
      const dst = src === left ? right : left;
      raf = requestAnimationFrame(() => {
        raf = 0;
        sync(src, dst);
        // either pane drives the current page (lazy loading/virtualisation follow it)
        const mid = pageAtFraction(src, 0.5);
        if (mid) {
          const n = Number(mid);
          if (n > 0 && n !== useViewStore.getState().currentPage) useViewStore.getState().setPage(n);
        }
      });
    };

    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => {
      document.removeEventListener('scroll', onScroll, { capture: true });
      if (raf) cancelAnimationFrame(raf);
    };
  }, [enabled, leftRef, rightRef, rebind]);
}
