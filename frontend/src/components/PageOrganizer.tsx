import { useEffect, useState } from 'react';
import type { PageBlocks } from '../types';
import { api } from '../api/client';
import { useDocStore } from '../stores/doc';
import { useViewStore } from '../stores/view';
import { Icon } from './Icon';

/**
 * 整理页面: every page as a small sheet; drag one onto another place to move it there.
 * Each drop is carried out at once (the PDF is rewritten, everything that names a page
 * follows), so what you see is always what the document is.
 */
export function PageOrganizer({ onClose, reload }: { onClose: () => void; reload: (docId: string, count: number, goTo: number) => Promise<void> }) {
  const docId = useDocStore((s) => s.activeId);
  const count = useViewStore((s) => s.pageCount);
  const toast = useViewStore((s) => s.toast);
  const [rev, setRev] = useState(0); // the pictures of the pages change with every move
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<number | null>(null);
  // what the reader put on the pages themselves is not in the page pictures: it is drawn over them
  const [own, setOwn] = useState<Record<number, PageBlocks>>({});
  useEffect(() => {
    if (!docId) return;
    let alive = true;
    setOwn({});
    void (async () => {
      for (let n = 1; n <= Math.min(count, 80) && alive; n++) {
        try {
          const pg = await api.getPageBlocks(docId, n);
          if (alive && pg.blocks.some((b) => b.meta?.user)) setOwn((o) => ({ ...o, [n]: pg }));
        } catch {
          /* the sheet is shown without it */
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [docId, count, rev]);
  if (!docId) return null;

  const move = async (from: number, to: number) => {
    if (from === to || busy) return;
    setBusy(true);
    try {
      const r = await api.movePage(docId, from, to);
      await reload(docId, r.page_count, r.page_no);
      setRev((n) => n + 1);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  const remove = async (n: number) => {
    setBusy(true);
    setConfirm(null);
    try {
      const r = await api.deletePage(docId, n);
      await reload(docId, r.page_count, Math.min(n, r.page_count));
      setRev((x) => x + 1);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal page-organizer" role="dialog" aria-label="整理页面">
        <div className="modal-head">
          <h2>整理页面</h2>
          <span className="organizer-hint">把一页拖到另一页的位置上，它就排到那里</span>
          <button type="button" className="icon-btn" aria-label="关闭" onClick={onClose}>
            <Icon name="close" size={15} />
          </button>
        </div>
        <div className={`organizer-grid ${busy ? 'is-busy' : ''}`}>
          {Array.from({ length: count }, (_, i) => i + 1).map((n) => (
            <div
              key={n}
              className={`organizer-page ${drag === n ? 'is-dragged' : ''} ${over === n && drag !== null && drag !== n ? (drag < n ? 'drop-after' : 'drop-before') : ''}`}
              draggable={!busy}
              onDragStart={(e) => {
                setDrag(n);
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', String(n));
              }}
              onDragEnd={() => {
                setDrag(null);
                setOver(null);
              }}
              onDragOver={(e) => {
                if (drag === null) return;
                e.preventDefault();
                setOver(n);
              }}
              onDrop={(e) => {
                e.preventDefault();
                const from = drag;
                setDrag(null);
                setOver(null);
                if (from !== null) void move(from, n);
              }}
            >
              <div className="organizer-sheet">
                <img src={`/api/documents/${encodeURIComponent(docId)}/pages/${n}/original.png?k=${rev}`} alt="" draggable={false} loading="lazy" />
                {own[n] && <OwnSketch page={own[n]} docId={docId} />}
              </div>
              <div className="organizer-foot">
                <span className="organizer-no">{n}</span>
                <button type="button" className="organizer-btn" title="往前一位" aria-label={`第 ${n} 页往前一位`} disabled={busy || n <= 1} onClick={() => void move(n, n - 1)}>
                  <Icon name="prev" size={13} />
                </button>
                <button type="button" className="organizer-btn" title="往后一位" aria-label={`第 ${n} 页往后一位`} disabled={busy || n >= count} onClick={() => void move(n, n + 1)}>
                  <Icon name="next" size={13} />
                </button>
                {confirm === n ? (
                  <button type="button" className="organizer-btn is-danger" title="确认删除（不能撤销）" onClick={() => void remove(n)}>
                    确认
                  </button>
                ) : (
                  <button type="button" className="organizer-btn" title="删除这一页" aria-label={`删除第 ${n} 页`} disabled={busy || count <= 1} onClick={() => setConfirm(n)}>
                    <Icon name="trash" size={13} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** A small drawing of the text boxes, pictures and shapes the reader added to a page. */
function OwnSketch({ page, docId }: { page: PageBlocks; docId: string }) {
  return (
    <svg className="organizer-own" viewBox={`0 0 ${page.width} ${page.height}`} preserveAspectRatio="xMidYMin slice" aria-hidden="true">
      {page.blocks
        .filter((b) => b.meta?.user && !b.src_edit?.layout?.hidden)
        .map((b) => {
          const [x0, y0, x1, y1] = b.bbox;
          const look = b.src_edit?.layout;
          const colour = `#${(look?.color ?? 0x1a1a1a).toString(16).padStart(6, '0')}`;
          const sw = ((b.meta as { width?: number }).width ?? 1.5) * (look?.scale ?? 1) * 1.6;
          if (b.type !== 'image') {
            const size = (b.style?.size || b.font_size || 12) * (look?.scale ?? 1);
            return (
              <text key={b.id} x={x0} y={y0 + size} fontSize={size} fill={colour} fontWeight={look?.bold ? 700 : 400}>
                {(b.src_edit?.text ?? b.text).slice(0, 80)}
              </text>
            );
          }
          const shape = b.meta?.shape;
          if (!shape) return <image key={b.id} href={api.imageUrl(docId, String(b.meta?.file ?? ''))} x={x0} y={y0} width={x1 - x0} height={y1 - y0} preserveAspectRatio="none" />;
          if (shape === 'rect') return <rect key={b.id} x={x0} y={y0} width={x1 - x0} height={y1 - y0} fill="none" stroke={colour} strokeWidth={sw} />;
          if (shape === 'ellipse') return <ellipse key={b.id} cx={(x0 + x1) / 2} cy={(y0 + y1) / 2} rx={(x1 - x0) / 2} ry={(y1 - y0) / 2} fill="none" stroke={colour} strokeWidth={sw} />;
          const d = b.meta?.dir ?? 'h';
          const mx = (x0 + x1) / 2;
          const my = (y0 + y1) / 2;
          const p = d === 'h' ? [x0, my, x1, my] : d === 'v' ? [mx, y0, mx, y1] : d === 'd2' ? [x0, y1, x1, y0] : [x0, y0, x1, y1];
          return <line key={b.id} x1={p[0]} y1={p[1]} x2={p[2]} y2={p[3]} stroke={colour} strokeWidth={sw} strokeLinecap="round" />;
        })}
    </svg>
  );
}
