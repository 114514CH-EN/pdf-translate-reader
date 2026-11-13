import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { katexNow, loadKatex, texHtml } from '../lib/katex';

/**
 * A formula the reader rewrote (LaTeX), drawn in the place of the original one:
 * a white patch over the old formula, the new one centred on it and shrunk if it
 * would not fit.
 */
export function FormulaTex({
  tex,
  bbox,
  zoom,
  fontPt,
  blockId,
  title,
  onClick,
}: {
  tex: string;
  bbox: [number, number, number, number] | number[];
  zoom: number;
  fontPt: number;
  blockId: string;
  title?: string;
  onClick?: () => void;
}) {
  const [, setReady] = useState(katexNow() !== null);
  const inner = useRef<HTMLSpanElement>(null);
  const [fit, setFit] = useState(1);
  useEffect(() => {
    let alive = true;
    if (!katexNow()) void loadKatex().then(() => alive && setReady(true));
    return () => {
      alive = false;
    };
  }, []);
  const k = katexNow();
  let html = '';
  if (k) {
    try {
      html = texHtml(k, tex);
    } catch {
      html = '';
    }
  }
  const w = (bbox[2] - bbox[0]) * zoom;
  const h = (bbox[3] - bbox[1]) * zoom;
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el || !html) return;
    const natural = { w: el.scrollWidth, h: el.scrollHeight };
    if (!natural.w || !natural.h) return;
    setFit(Math.min(1, (w - 2) / natural.w, (h - 1) / natural.h));
  }, [html, w, h]);
  // a numbered formula (\tag) keeps its number at the right edge of the place it stands in
  const tagged = /\\tag\b/.test(tex);

  return (
    <div
      className={`abs-block abs-formula-tex ${onClick ? 'is-editable' : ''}`}
      data-block-id={blockId}
      title={title}
      onClick={onClick}
      style={{ left: bbox[0] * zoom, top: bbox[1] * zoom, width: w, height: h, fontSize: (fontPt / 1.21) * zoom }}
    >
      {html ? (
        <span
          ref={inner}
          className={tagged ? 'is-tagged' : undefined}
          style={{ transform: fit < 1 ? `scale(${fit})` : undefined }}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <code>{tex}</code>
      )}
    </div>
  );
}
