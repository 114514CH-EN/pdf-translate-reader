import { flushSync } from 'react-dom';

/**
 * Change the screen as one movement instead of a cut (View Transitions): what is shared
 * between the two states — the sheet being read — travels from its old place to its new
 * one, the rest cross-fades. Without support, or when the reader asked for less motion,
 * the change simply happens.
 */
export function withTransition(change: () => void): void {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || document.documentElement.dataset.theme === 'eink';
  if (!doc.startViewTransition || calm) {
    change();
    return;
  }
  try {
    doc.startViewTransition(() => flushSync(change));
  } catch {
    change();
  }
}
