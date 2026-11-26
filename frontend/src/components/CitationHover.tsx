import { useEffect, useRef, useState } from 'react';
import { useDocStore } from '../stores/doc';
import { pageImageUrl, usePaperIndex, usePaperIndexStore } from '../stores/paperIndex';
import { useTranslationStore } from '../stores/translation';
import { useViewStore } from '../stores/view';
import type { PaperFig, PaperIndex, PaperRef } from '../types';
import { jumpTo } from './OutlineTab';

/*
 * References and figure mentions in the text, looked up under the pointer. Both panes are
 * plain DOM text (pdf.js's text layer on the left, the translation on the right), so the
 * pointer's text position (caretRangeFromPoint) and a look at the text around it are all it
 * takes — neither pane's rendering is touched.
 */

const NUMERIC = /\[(\d{1,3}(?:\s*[-–,，、]\s*\d{1,3})*)\]/g;
const AUTHOR_YEAR =
  /([A-Z][A-Za-zÀ-ɏ'’-]+)(?:\s+et\s+al\.?|\s+(?:and|&)\s+[A-Z][A-Za-zÀ-ɏ'’-]+)?,?\s*\(?((?:19|20)\d{2}[a-z]?)\)?/g;
const FIGURE = /\b(Fig(?:ure)?s?\.?|Tables?|Tab\.)\s*(\d{1,3})|(图|表)\s*(\d{1,3})/g;

interface Hit {
  kind: 'ref' | 'fig';
  keys: string[];
  start: number;
  end: number;
}

function expand(list: string): string[] {
  const out: string[] = [];
  for (const part of list.split(/[,，、]/)) {
    const m = part.trim().match(/^(\d+)\s*[-–]\s*(\d+)$/);
    if (m) {
      const a = Number(m[1]);
      const b = Number(m[2]);
      for (let i = a; i <= b && i - a < 30; i++) out.push(String(i));
    } else if (part.trim()) out.push(part.trim());
  }
  return out;
}

function findHits(text: string, idx: PaperIndex): Hit[] {
  const hits: Hit[] = [];
  if (idx.style === 'numeric') {
    for (const m of text.matchAll(NUMERIC)) {
      const keys = expand(m[1]).filter((k) => idx.refs[k]);
      if (keys.length) hits.push({ kind: 'ref', keys, start: m.index!, end: m.index! + m[0].length });
    }
  } else if (idx.style === 'author-year') {
    for (const m of text.matchAll(AUTHOR_YEAR)) {
      const key = (m[1] + m[2]).toLowerCase().replace(/[’']/g, "'");
      if (idx.refs[key]) hits.push({ kind: 'ref', keys: [key], start: m.index!, end: m.index! + m[0].length });
    }
  }
  for (const m of text.matchAll(FIGURE)) {
    const word = (m[1] || m[3] || '').toLowerCase();
    const kind = word.startsWith('tab') || word === '表' ? 'tab' : 'fig';
    const key = `${kind}:${m[2] || m[4]}`;
    if (idx.figs[key]) hits.push({ kind: 'fig', keys: [key], start: m.index!, end: m.index! + m[0].length });
  }
  return hits;
}

function caretAt(x: number, y: number): { node: Text; offset: number } | null {
  const d = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  if (d.caretPositionFromPoint) {
    const p = d.caretPositionFromPoint(x, y);
    if (p && p.offsetNode.nodeType === Node.TEXT_NODE) return { node: p.offsetNode as Text, offset: p.offset };
  }
  const r = document.caretRangeFromPoint?.(x, y);
  if (r && r.startContainer.nodeType === Node.TEXT_NODE) return { node: r.startContainer as Text, offset: r.startOffset };
  return null;
}

/** The mention under (x, y) in a pane, with the boxes it occupies on screen. */
function hitAt(x: number, y: number, pane: Element, idx: PaperIndex): { hit: Hit; rects: DOMRect[] } | null {
  const at = caretAt(x, y);
  if (!at || !pane.contains(at.node)) return null;
  // the text nodes around it: a mention can be split across spans ("[2," | "3]")
  const walker = document.createTreeWalker(pane, NodeFilter.SHOW_TEXT);
  walker.currentNode = at.node;
  const before: Text[] = [];
  for (let i = 0; i < 4 && walker.previousNode(); i++) before.unshift(walker.currentNode as Text);
  walker.currentNode = at.node;
  const after: Text[] = [];
  for (let i = 0; i < 4 && walker.nextNode(); i++) after.push(walker.currentNode as Text);
  const nodes = [...before, at.node, ...after];
  const starts: number[] = [];
  let text = '';
  for (const n of nodes) {
    starts.push(text.length);
    text += n.data;
  }
  const pos = starts[before.length] + at.offset;
  const hit = findHits(text, idx).find((h) => h.start <= pos && pos <= h.end);
  if (!hit) return null;
  const place = (p: number): [Text, number] => {
    for (let i = nodes.length - 1; i >= 0; i--) if (p >= starts[i]) return [nodes[i], Math.min(p - starts[i], nodes[i].data.length)];
    return [nodes[0], 0];
  };
  const range = document.createRange();
  range.setStart(...place(hit.start));
  range.setEnd(...place(hit.end));
  const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
  // the caret is the nearest text even off the end of a line: the pointer must be on it
  if (!rects.some((r) => x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2)) return null;
  return { hit, rects };
}

function sameHit(a: Hit | undefined, b: Hit): boolean {
  return !!a && a.kind === b.kind && a.keys.join() === b.keys.join();
}

function FigCrop({ docId, fig, idx }: { docId: string; fig: PaperFig; idx: PaperIndex }) {
  const loaded = useTranslationStore((s) => s.pages[fig.page]?.original);
  const size = idx.page_sizes[String(fig.page)];
  if (!fig.area || !size) return null;
  const [x0, y0, x1, y1] = fig.area;
  const w = x1 - x0;
  const h = y1 - y0;
  const scale = Math.min(300 / w, 200 / h, 2);
  return (
    <div
      className="cite-crop"
      style={{
        width: w * scale,
        height: h * scale,
        backgroundImage: `url("${pageImageUrl(docId, fig.page, loaded)}")`,
        backgroundSize: `${size[0] * scale}px ${size[1] * scale}px`,
        backgroundPosition: `${-x0 * scale}px ${-y0 * scale}px`,
      }}
      aria-label={fig.label}
    />
  );
}

export function CitationHover() {
  const docId = useDocStore((s) => s.activeId);
  const idx = usePaperIndex(docId);
  const load = usePaperIndexStore((s) => s.load);
  const editMode = useViewStore((s) => s.editMode);
  const openPaperSearch = useViewStore((s) => s.openPaperSearch);
  const [shown, setShown] = useState<{ hit: Hit; rects: DOMRect[] } | null>(null);
  const shownRef = useRef(shown);
  shownRef.current = shown;

  useEffect(() => {
    if (docId) void load(docId);
  }, [docId, load]);

  const active = !!idx && !editMode && (Object.keys(idx.refs).length > 0 || Object.keys(idx.figs).length > 0);

  useEffect(() => {
    if (!active || !idx) {
      setShown(null);
      return;
    }
    let raf = 0;
    let last: PointerEvent | null = null;
    let showT = 0;
    let hideT = 0;
    const hide = (ms: number) => {
      window.clearTimeout(showT);
      if (!hideT) hideT = window.setTimeout(() => ((hideT = 0), setShown(null)), ms);
    };
    const check = () => {
      raf = 0;
      const e = last;
      if (!e || e.buttons) return; // selecting text
      const target = e.target as Element | null;
      if (target?.closest?.('.cite-pop')) {
        window.clearTimeout(hideT);
        hideT = 0;
        return;
      }
      const pane = target?.closest?.('.pdf-pane, .translation-pane');
      const found = pane ? hitAt(e.clientX, e.clientY, pane, idx) : null;
      if (!found) {
        if (shownRef.current) hide(260);
        else window.clearTimeout(showT);
        return;
      }
      window.clearTimeout(hideT);
      hideT = 0;
      if (sameHit(shownRef.current?.hit, found.hit)) return;
      window.clearTimeout(showT);
      showT = window.setTimeout(() => setShown(found), shownRef.current ? 60 : 180);
    };
    const onMove = (e: PointerEvent) => {
      last = e;
      if (!raf) raf = requestAnimationFrame(check);
    };
    const onScroll = () => setShown(null);
    document.addEventListener('pointermove', onMove, { passive: true });
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('scroll', onScroll, true);
      cancelAnimationFrame(raf);
      window.clearTimeout(showT);
      window.clearTimeout(hideT);
    };
  }, [active, idx]);

  if (!shown || !idx || !docId) return null;
  const { hit, rects } = shown;
  const anchor = rects[rects.length - 1];
  const left = Math.min(Math.max(8, anchor.left), window.innerWidth - 380);
  const below = anchor.bottom + 8 + 260 < window.innerHeight;
  const style = below ? { left, top: anchor.bottom + 6 } : { left, bottom: window.innerHeight - anchor.top + 6 };
  const h = (page: number) => idx.page_sizes[String(page)]?.[1];
  const go = (page: number, y: number, block: number) => {
    setShown(null);
    jumpTo(page, y, block, h(page));
  };

  return (
    <>
      {rects.map((r, i) => (
        <div key={i} className="cite-mark" style={{ left: r.left, top: r.top, width: r.width, height: r.height }} />
      ))}
      <div className="cite-pop" style={style} role="dialog" aria-label={hit.kind === 'ref' ? '参考文献' : '图表'}>
        {hit.kind === 'ref'
          ? hit.keys
              .slice(0, 6)
              .map((k) => idx.refs[k])
              .filter((r): r is PaperRef => !!r)
              .map((r) => (
                <div key={r.key} className="cite-ref">
                  <div className="cite-ref-text">{r.text}</div>
                  <div className="cite-actions">
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => {
                        setShown(null);
                        openPaperSearch(r.query);
                      }}
                    >
                      找这篇论文
                    </button>
                    <button type="button" className="link-btn" onClick={() => go(r.page, r.y, r.block_id)}>
                      跳到参考文献
                    </button>
                  </div>
                </div>
              ))
          : hit.keys
              .map((k) => idx.figs[k])
              .filter((f): f is PaperFig => !!f)
              .map((f) => (
                <div key={f.key} className="cite-fig">
                  <FigCrop docId={docId} fig={f} idx={idx} />
                  <div className="cite-ref-text">{f.caption_zh || f.caption}</div>
                  <div className="cite-actions">
                    <button type="button" className="link-btn" onClick={() => go(f.page, f.y, f.block_id)}>
                      跳到{f.key.startsWith('tab') ? '表' : '图'}（第 {f.page} 页）
                    </button>
                  </div>
                </div>
              ))}
        {hit.kind === 'ref' && hit.keys.length > 6 && <div className="cite-more">还有 {hit.keys.length - 6} 条，见「目录」里的参考文献</div>}
      </div>
    </>
  );
}
