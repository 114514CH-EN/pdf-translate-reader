import { useLayoutEffect, type DependencyList, type RefObject } from 'react';

/**
 * Fit-to-box: if the element's content is taller than its box, binary-search a
 * font-size scale factor in [0.6 .. 1.0] (relative to `baseFontSize`) until it
 * fits. Mutates style directly (no re-render).
 */
export function useFitBox(
  ref: RefObject<HTMLElement | null>,
  baseFontSize: number,
  deps: DependencyList,
): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || baseFontSize <= 0) return;

    const apply = (scale: number): boolean => {
      el.style.fontSize = `${(baseFontSize * scale).toFixed(2)}px`;
      return el.scrollHeight <= el.clientHeight + 1;
    };

    if (apply(1)) return; // already fits at full size

    let lo = 0.6;
    let hi = 1.0;
    // 8 iterations -> ~0.15% precision on the scale factor
    for (let i = 0; i < 8; i++) {
      const mid = (lo + hi) / 2;
      if (apply(mid)) lo = mid;
      else hi = mid;
    }
    apply(lo);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
