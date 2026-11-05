import type { CSSProperties, ReactNode } from 'react';
import type { MathRun } from '../types';

/**
 * Formulas are never re-typeset from extracted text (PDF math fonts frequently
 * carry broken Unicode maps, and sub/superscripts lose their position). They
 * are shown as crops of the page's original rendering instead, so they look
 * exactly like the PDF.
 */

export interface PageImage {
  /** URL of the full original render of the page */
  url: string | null | undefined;
  /** page size in PDF pt */
  width: number;
  height: number;
}

const PH = /\{\{(m\d+)\}\}/g;

export function hasMath(text: string | null | undefined): boolean {
  return !!text && text.includes('{{m');
}

/** Inline sprite of one formula, sized in em relative to `basePt` so it scales with the text. */
function InlineFormula({ run, page, basePt }: { run: MathRun; page: PageImage; basePt: number }) {
  const e = 1 / Math.max(basePt, 1);
  const [x0, y0, x1, y1] = run.bbox;
  const style: CSSProperties = {
    display: 'inline-block',
    width: `${(x1 - x0) * e}em`,
    height: `${(y1 - y0) * e}em`,
    verticalAlign: `${-(y1 - run.baseline) * e}em`,
    backgroundImage: page.url ? `url("${page.url}")` : undefined,
    backgroundRepeat: 'no-repeat',
    backgroundSize: `${page.width * e}em ${page.height * e}em`,
    backgroundPosition: `${-x0 * e}em ${-y0 * e}em`,
  };
  return <span className="inline-formula" style={style} aria-label="公式" />;
}

/** Render text whose formulas are {{mN}} placeholders. */
export function MathText({
  text,
  runs,
  page,
  basePt,
}: {
  text: string;
  runs: MathRun[] | undefined;
  page: PageImage;
  basePt: number;
}): JSX.Element {
  if (!hasMath(text) || !runs?.length) return <>{text}</>;
  const byId = new Map(runs.map((r) => [r.id, r]));
  const out: ReactNode[] = [];
  let pos = 0;
  let k = 0;
  for (const m of text.matchAll(PH)) {
    const idx = m.index ?? 0;
    if (idx > pos) out.push(text.slice(pos, idx));
    const run = byId.get(m[1]);
    if (run) out.push(<InlineFormula key={k++} run={run} page={page} basePt={basePt} />);
    pos = idx + m[0].length;
  }
  if (pos < text.length) out.push(text.slice(pos));
  return <>{out}</>;
}

/**
 * Absolutely positioned crop of the original page rendering at `bbox`
 * (page pt). `offset` is the pt origin of the positioned parent.
 */
export function OrigCrop({
  page,
  bbox,
  zoom,
  offset = [0, 0],
  pad = 1.5,
  className = '',
  title,
}: {
  page: PageImage;
  bbox: [number, number, number, number];
  zoom: number;
  offset?: [number, number];
  pad?: number;
  className?: string;
  title?: string;
}) {
  if (!page.url) return null;
  const x0 = Math.max(0, bbox[0] - pad);
  const y0 = Math.max(0, bbox[1] - pad);
  const x1 = Math.min(page.width, bbox[2] + pad);
  const y1 = Math.min(page.height, bbox[3] + pad);
  return (
    <div
      className={`orig-crop ${className}`}
      title={title}
      style={{
        position: 'absolute',
        left: (x0 - offset[0]) * zoom,
        top: (y0 - offset[1]) * zoom,
        width: (x1 - x0) * zoom,
        height: (y1 - y0) * zoom,
        backgroundImage: `url("${page.url}")`,
        backgroundRepeat: 'no-repeat',
        backgroundSize: `${page.width * zoom}px ${page.height * zoom}px`,
        backgroundPosition: `${-x0 * zoom}px ${-y0 * zoom}px`,
      }}
    />
  );
}

/** Static image of a region of the original page (flow view: formula blocks). */
export function OrigFigure({
  page,
  bbox,
  scale = 1.3,
}: {
  page: PageImage;
  bbox: [number, number, number, number];
  scale?: number;
}) {
  if (!page.url) return null;
  const [x0, y0, x1, y1] = bbox;
  return (
    <div
      className="orig-figure"
      role="img"
      aria-label="公式"
      style={{
        width: (x1 - x0 + 4) * scale,
        height: (y1 - y0 + 4) * scale,
        backgroundImage: `url("${page.url}")`,
        backgroundRepeat: 'no-repeat',
        backgroundSize: `${page.width * scale}px ${page.height * scale}px`,
        backgroundPosition: `${-(x0 - 2) * scale}px ${-(y0 - 2) * scale}px`,
      }}
    />
  );
}
