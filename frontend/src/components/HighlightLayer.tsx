import { useHighlightStore } from '../stores/highlights';

/**
 * Highlights of one page in one pane, drawn under the text (multiply blend) so
 * selecting text over a highlight still works. Rects are stored in page pt.
 */
export function HighlightLayer({ pageNo, pane, zoom }: { pageNo: number; pane: 'src' | 'tgt'; zoom: number }) {
  const items = useHighlightStore((s) => s.items);
  const activeId = useHighlightStore((s) => s.activeId);
  const mine = items.filter((h) => h.page_no === pageNo && h.pane === pane);
  if (mine.length === 0) return null;
  return (
    <div className="hl-layer" aria-hidden="true">
      {mine.map((h) =>
        h.rects.map((r, i) => (
          <div
            key={`${h.id}-${i}`}
            className={`hl-rect hl-${h.color} ${activeId === h.id ? 'active' : ''} ${h.note ? 'has-note' : ''}`}
            data-hl-id={h.id}
            style={{ left: r[0] * zoom, top: r[1] * zoom, width: (r[2] - r[0]) * zoom, height: (r[3] - r[1]) * zoom }}
          />
        )),
      )}
    </div>
  );
}
