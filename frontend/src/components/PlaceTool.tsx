import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useDocStore } from '../stores/doc';
import { useEditStore } from '../stores/edit';
import { useTranslationStore } from '../stores/translation';
import { useViewStore } from '../stores/view';

/**
 * 文本框 / 图片 / 线条: with one of them armed (edit mode toolbar), the next click on a page of
 * the original puts it there; dragging gives it its size (a line: its two ends). Esc cancels.
 */
export function PlaceTool() {
  const tool = useEditStore((s) => s.tool);
  const [band, setBand] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

  useEffect(() => {
    if (!tool) return;
    document.body.classList.add('is-placing');
    let start: { el: HTMLElement; pageNo: number; x: number; y: number } | null = null;

    const pageAt = (target: EventTarget | null) => {
      const el = target instanceof Element ? target.closest<HTMLElement>('.abs-view.is-source .abs-page[data-page-no]') : null;
      return el ? { el, pageNo: Number(el.dataset.pageNo) } : null;
    };
    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const hit = pageAt(e.target);
      if (!hit) return; // the toolbar and the rest keep working
      e.preventDefault();
      e.stopPropagation();
      start = { ...hit, x: e.clientX, y: e.clientY };
      setBand({ x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY });
    };
    const move = (e: PointerEvent) => {
      if (start) setBand({ x0: start.x, y0: start.y, x1: e.clientX, y1: e.clientY });
    };
    const up = async (e: PointerEvent) => {
      const s = start;
      start = null;
      setBand(null);
      if (!s) return;
      e.preventDefault();
      e.stopPropagation();
      const docId = useDocStore.getState().activeId;
      const tr = useTranslationStore.getState();
      const pg = tr.pages[s.pageNo];
      if (!docId || !pg) return;
      const rect = s.el.getBoundingClientRect();
      const zoom = rect.width / pg.width;
      const pt = (cx: number, cy: number) => [
        Math.min(Math.max(0, (cx - rect.left) / zoom), pg.width),
        Math.min(Math.max(0, (cy - rect.top) / zoom), pg.height),
      ];
      const [ax, ay] = pt(s.x, s.y);
      const [bx, by] = pt(e.clientX, e.clientY);
      const dragged = Math.hypot(e.clientX - s.x, e.clientY - s.y) > 6;
      const fit = (x: number, y: number, w: number, h: number) => {
        const left = Math.min(Math.max(0, x), Math.max(0, pg.width - w));
        const top = Math.min(Math.max(0, y), Math.max(0, pg.height - h));
        return [left, top, left + w, top + h];
      };
      useEditStore.getState().setTool(null);
      try {
        let id: string;
        if (tool.kind === 'text') {
          const box = dragged ? [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by, Math.min(ay, by) + 20)] : fit(ax, ay - 12, Math.min(280, pg.width - 40), 30);
          if (box[2] - box[0] < 40) box[2] = box[0] + 40;
          id = (await api.addTextBlock(docId, s.pageNo, box, '在这里输入文字')).block_id;
        } else if (tool.kind === 'line') {
          const dx = bx - ax;
          const dy = by - ay;
          let box: number[];
          let dir: string;
          if (!dragged) {
            box = fit(ax, ay - 3, 160, 6);
            dir = 'h';
          } else if (Math.abs(dy) * zoom < 8) {
            box = [Math.min(ax, bx), (ay + by) / 2 - 3, Math.max(ax, bx), (ay + by) / 2 + 3];
            dir = 'h';
          } else if (Math.abs(dx) * zoom < 8) {
            box = [(ax + bx) / 2 - 3, Math.min(ay, by), (ax + bx) / 2 + 3, Math.max(ay, by)];
            dir = 'v';
          } else {
            box = [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
            dir = dx * dy > 0 ? 'd1' : 'd2';
          }
          id = (await api.addLine(docId, s.pageNo, box, dir)).block_id;
        } else {
          let w = 240;
          let h = 180;
          try {
            const bmp = await createImageBitmap(tool.file);
            const k = Math.min(1, 260 / bmp.width, 340 / bmp.height);
            w = Math.max(24, bmp.width * k);
            h = Math.max(24, bmp.height * k);
            if (dragged) {
              // the dragged box, kept to the picture's own proportions
              const bw = Math.max(24, Math.abs(bx - ax));
              w = bw;
              h = (bw * bmp.height) / bmp.width;
            }
            bmp.close();
          } catch {
            /* not decodable here: the server decides */
          }
          const box = dragged ? fit(Math.min(ax, bx), Math.min(ay, by), w, h) : fit(ax - w / 2, ay - h / 2, w, h);
          id = (await api.addPicture(docId, s.pageNo, box, tool.file)).block_id;
        }
        await tr.refreshPage(docId, s.pageNo);
        useEditStore.getState().select(String(id), 'src');
        window.dispatchEvent(new Event('pdftr:translations-changed'));
      } catch (err) {
        useViewStore.getState().toast(err instanceof Error ? err.message : String(err), 'error');
      }
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        useEditStore.getState().setTool(null);
      }
    };
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('pointermove', move, true);
    document.addEventListener('pointerup', up, true);
    window.addEventListener('keydown', key, true);
    return () => {
      document.body.classList.remove('is-placing');
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('pointermove', move, true);
      document.removeEventListener('pointerup', up, true);
      window.removeEventListener('keydown', key, true);
      setBand(null);
    };
  }, [tool]);

  if (!tool || !band) return null;
  if (tool.kind === 'line') {
    return (
      <svg className="place-band is-line" aria-hidden="true">
        <line x1={band.x0} y1={band.y0} x2={band.x1} y2={band.y1} />
      </svg>
    );
  }
  return (
    <div
      className="place-band"
      aria-hidden="true"
      style={{ left: Math.min(band.x0, band.x1), top: Math.min(band.y0, band.y1), width: Math.abs(band.x1 - band.x0), height: Math.abs(band.y1 - band.y0) }}
    />
  );
}
