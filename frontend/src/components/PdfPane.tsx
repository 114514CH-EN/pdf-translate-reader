import { useEffect, useRef, useState, type RefObject } from 'react';
import * as pdfjs from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';
import { api } from '../api/client';
import { scrollPageIntoView } from '../hooks/useSyncScroll';
import { useViewStore } from '../stores/view';
import { HighlightLayer } from './HighlightLayer';
import { useTranslationStore } from '../stores/translation';
import type { Block } from '../types';

pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorker;

interface PageDims {
  width: number; // pt
  height: number; // pt
}

const DEFAULT_DIMS: PageDims = { width: 595, height: 842 };
const VIRTUAL_PAD = 2; // render current ± 2

function bboxStyle(b: Block, zoom: number): React.CSSProperties {
  const [x0, y0, x1, y1] = b.bbox;
  return {
    left: x0 * zoom,
    top: y0 * zoom,
    width: Math.max(1, (x1 - x0) * zoom),
    height: Math.max(1, (y1 - y0) * zoom),
  };
}

/** Translucent overlay rect over a source block (highlight + sync anchor). */
function BlockOverlay({
  block,
  zoom,
  hovered,
  flash,
}: {
  block: Block;
  zoom: number;
  hovered: boolean;
  flash: boolean;
}) {
  const flashSeq = useViewStore((s) => s.flashSeq);
  return (
    <div
      key={flash ? `f${flashSeq}` : undefined}
      className={`block-overlay ${hovered ? 'hovered' : ''} ${flash ? 'flash' : ''}`}
      data-block-id={block.id}
      style={bboxStyle(block, zoom)}
    />
  );
}

function PdfPageView({
  doc,
  pageNo,
  zoom,
  dims,
  blocks,
  hoverId,
}: {
  doc: PDFDocumentProxy;
  pageNo: number;
  zoom: number;
  dims: PageDims;
  blocks: Block[];
  hoverId: string | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const flashId = useViewStore((s) => s.flashBlockId);
  const [rendering, setRendering] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let task: RenderTask | null = null;
    let page: PDFPageProxy | null = null;
    setRendering(true);

    (async () => {
      try {
        page = await doc.getPage(pageNo);
        if (cancelled || !canvasRef.current || !textLayerRef.current) return;
        const viewport = page.getViewport({ scale: zoom });
        const dpr = window.devicePixelRatio || 1;
        const canvas = canvasRef.current;
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const transform = dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined;
        task = page.render({ canvasContext: ctx, viewport, transform });
        await task.promise;
        if (cancelled) return;

        const tl = textLayerRef.current;
        tl.replaceChildren();
        const layer = new pdfjs.TextLayer({
          textContentSource: page.streamTextContent(),
          container: tl,
          viewport,
        });
        await layer.render();
        if (!cancelled) setRendering(false);
      } catch (e) {
        if (!cancelled && (e as Error)?.name !== 'RenderingCancelledException') {
          console.warn(`第 ${pageNo} 页渲染失败`, e);
          setRendering(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      try {
        task?.cancel();
      } catch {
        /* already finished */
      }
    };
  }, [doc, pageNo, zoom]);

  return (
    <div
      className="pdf-page"
      data-page-no={pageNo}
      style={{
        width: dims.width * zoom,
        height: dims.height * zoom,
        '--scale-factor': zoom,
      } as React.CSSProperties}
    >
      <canvas ref={canvasRef} className="pdf-canvas" />
      <HighlightLayer pageNo={pageNo} pane="src" zoom={zoom} />
      <div ref={textLayerRef} className="textLayer" aria-hidden="false" />
      {blocks.map((b) => (
        <BlockOverlay key={b.id} block={b} zoom={zoom} hovered={hoverId === b.id} flash={flashId !== null && flashId === String(b.id)} />
      ))}
      {rendering && <div className="page-rendering">渲染中…</div>}
    </div>
  );
}

/**
 * Left pane: PDF pages rendered with pdf.js canvas + text layer (selectable),
 * continuous vertical column, canvas virtualization around the current page.
 */
export function PdfPane({
  scrollRef,
  docId,
}: {
  scrollRef: RefObject<HTMLDivElement>;
  docId: string | null;
}) {
  const zoom = useViewStore((s) => s.zoom);
  const currentPage = useViewStore((s) => s.currentPage);
  const setPage = useViewStore((s) => s.setPage);
  const setPageCount = useViewStore((s) => s.setPageCount);
  const pageNavSeq = useViewStore((s) => s.pageNavSeq);
  const hoverId = useViewStore((s) => s.hoverBlockId);
  const toast = useViewStore((s) => s.toast);
  const pagesMap = useTranslationStore((s) => s.pages);
  const loadPage = useTranslationStore((s) => s.loadPage);

  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [dims, setDims] = useState<Record<number, PageDims>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ---- load PDF document bytes from backend ----
  useEffect(() => {
    if (!docId) {
      setPdfDoc(null);
      setDims({});
      setError(null);
      return;
    }
    let cancelled = false;
    let task: ReturnType<typeof pdfjs.getDocument> | null = null;
    setLoading(true);
    setError(null);
    setPdfDoc(null);

    (async () => {
      try {
        const res = await fetch(api.documentFileUrl(docId));
        if (!res.ok) throw new Error(`获取 PDF 失败 (${res.status})`);
        const data = await res.arrayBuffer();
        if (cancelled) return;
        task = pdfjs.getDocument({ data });
        const doc = await task.promise;
        if (cancelled) return;
        setPdfDoc(doc);
        setPageCount(doc.numPages);
        // pre-fetch first-page dims so layout has real sizes quickly
        const p1 = await doc.getPage(1);
        if (cancelled) return;
        const v1 = p1.getViewport({ scale: 1 });
        setDims((d) => ({ ...d, 1: { width: v1.width, height: v1.height } }));
        // fill remaining page dims lazily in background
        void (async () => {
          const next: Record<number, PageDims> = {};
          for (let i = 2; i <= doc.numPages; i++) {
            if (cancelled) return;
            try {
              const vp = (await doc.getPage(i)).getViewport({ scale: 1 });
              next[i] = { width: vp.width, height: vp.height };
            } catch {
              next[i] = DEFAULT_DIMS;
            }
          }
          if (!cancelled) setDims((d) => ({ ...d, ...next }));
        })();
        setLoading(false);
      } catch (e) {
        if (!cancelled) {
          setLoading(false);
          setError(e instanceof Error ? e.message : String(e));
          toast('PDF 加载失败', 'error');
        }
      }
    })();

    return () => {
      cancelled = true;
      try {
        void task?.destroy();
      } catch {
        /* noop */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // reload only when the document changes (a ref-based token used to change one
    // render late and reloaded the PDF on the first page navigation)
  }, [docId]);

  // ---- track current page from scroll position ----
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !pdfDoc) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const nodes = el.querySelectorAll<HTMLElement>('.pdf-page');
        const top = el.getBoundingClientRect().top;
        let best = 1;
        let bestDist = Infinity;
        nodes.forEach((n) => {
          const r = n.getBoundingClientRect();
          const dist = Math.abs(r.top + r.height / 2 - (top + el.clientHeight / 2));
          if (dist < bestDist) {
            bestDist = dist;
            best = Number(n.dataset.pageNo ?? 1);
          }
        });
        if (best !== useViewStore.getState().currentPage) setPage(best);
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
    // `loading` matters: while it is true the pane renders a placeholder without the
    // scroll ref, so binding on pdfDoc alone attached to nothing and the current page
    // never followed scrolling (later pages then never rendered / loaded).
  }, [pdfDoc, loading, scrollRef, setPage]);

  // ---- scroll to page on nav request ----
  useEffect(() => {
    if (pageNavSeq === 0) return;
    const el = scrollRef.current;
    if (!el) return;
    // react to explicit nav requests only — not to scroll-driven page changes
    scrollPageIntoView(el, useViewStore.getState().currentPage, 'auto');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageNavSeq, scrollRef]);

  // ---- virtualization: which pages to render ----
  const pageCount = pdfDoc?.numPages ?? 0;
  const first = Math.max(1, currentPage - VIRTUAL_PAD);
  const last = Math.min(pageCount, currentPage + VIRTUAL_PAD);

  // ---- lazy-load block data for rendered pages (anchors + overlays) ----
  useEffect(() => {
    if (!docId) return;
    for (let n = first; n <= last; n++) {
      void loadPage(docId, n);
    }
  }, [docId, first, last, loadPage]);

  if (!docId) {
    return (
      <div className="pdf-pane pane-empty">
        <div className="empty-hint">请先上传 PDF</div>
      </div>
    );
  }
  if (loading) {
    return (
      <div className="pdf-pane pane-empty">
        <div className="empty-hint">正在加载 PDF…</div>
      </div>
    );
  }
  if (error || !pdfDoc) {
    return (
      <div className="pdf-pane pane-empty">
        <div className="empty-hint">PDF 加载失败{error ? `：${error}` : ''}</div>
      </div>
    );
  }

  return (
    <div className="pdf-pane" ref={scrollRef}>
      <div className="pdf-column">
        {Array.from({ length: pageCount }, (_, i) => i + 1).map((n) => {
          const d = dims[n] ?? DEFAULT_DIMS;
          const near = n >= first && n <= last;
          const pageBlocks = pagesMap[n]?.blocks ?? [];
          return (
            <div key={n} className="pdf-page-slot" data-page-no={n}>
              {near && pdfDoc ? (
                <PdfPageView
                  doc={pdfDoc}
                  pageNo={n}
                  zoom={zoom}
                  dims={d}
                  blocks={pageBlocks}
                  hoverId={hoverId}
                />
              ) : (
                <div
                  className="pdf-page pdf-page-placeholder"
                  data-page-no={n}
                  style={{ width: d.width * zoom, height: d.height * zoom }}
                >
                  <div className="page-placeholder-label">第 {n} 页</div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
