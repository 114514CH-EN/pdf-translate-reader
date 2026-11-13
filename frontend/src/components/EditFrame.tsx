import { useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { useEditStore } from '../stores/edit';
import type { Block, BlockLayout, EditSide } from '../types';

/**
 * The frame around the selected block in edit mode: a format bar and drag handles.
 *
 *   bar      A− / A+ (font size), B (bold), colours, left / centre / right,
 *            隐藏 (hide the block), 还原 (drop all formatting)
 *   ⠿        drag to move the block
 *   corners  drag to resize it (the text re-fits)
 *
 * Every action is one undo step (stores/edit.ts). Geometry is in page points, so it
 * is the same at every zoom level and in the exported PDF.
 */

type Box = [number, number, number, number];
type Grip = 'move' | 'nw' | 'ne' | 'sw' | 'se';

const COLOURS: { name: string; value: number }[] = [
  { name: '黑', value: 0x1a1a1a },
  { name: '红', value: 0xc0392b },
  { name: '蓝', value: 0x1f5fbf },
  { name: '绿', value: 0x1e8449 },
  { name: '橙', value: 0xc56a00 },
];
const MIN = 6; // pt

const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;

export default function EditFrame({
  block,
  layout,
  box,
  zoom,
  page,
  onDrag,
  side = 'tgt',
  kind = 'text',
}: {
  /** a picture or a line of the reader's own has no text to format */
  kind?: 'text' | 'image' | 'line';
  /** the translation or the original text of the block */
  side?: EditSide;
  block: Block;
  layout: BlockLayout | null;
  box: Box;
  zoom: number;
  page: { width: number; height: number };
  /** live box while dragging (null when done) */
  onDrag: (box: Box | null) => void;
}) {
  const setLayoutOf = useEditStore((s) => s.setLayout);
  const setLayout = (blockId: string, patch: Partial<BlockLayout> | null) => setLayoutOf(blockId, patch, side);
  const drag = useRef<{ grip: Grip; px: number; py: number; start: Box; last: Box } | null>(null);
  const [x0, y0, x1, y1] = box;
  const id = String(block.id);
  const scale = layout?.scale ?? 1;
  const hidden = !!layout?.hidden;
  const bold = layout?.bold ?? !!(block.style?.bold || block.bold);
  const align = layout?.align ?? block.style?.align ?? 'left';

  const begin = (grip: Grip) => (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { grip, px: e.clientX, py: e.clientY, start: box, last: box };
  };
  const move = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.px) / zoom;
    const dy = (e.clientY - d.py) / zoom;
    let [a, b, c, f] = d.start;
    if (d.grip === 'move') {
      const w = c - a;
      const h = f - b;
      a = Math.min(Math.max(0, a + dx), Math.max(0, page.width - w));
      b = Math.min(Math.max(0, b + dy), Math.max(0, page.height - h));
      c = a + w;
      f = b + h;
    } else {
      if (d.grip.includes('w')) a = Math.min(Math.max(0, a + dx), c - MIN);
      if (d.grip.includes('e')) c = Math.max(Math.min(page.width, c + dx), a + MIN);
      if (d.grip.includes('n')) b = Math.min(Math.max(0, b + dy), f - MIN);
      if (d.grip.includes('s')) f = Math.max(Math.min(page.height, f + dy), b + MIN);
    }
    d.last = [a, b, c, f];
    onDrag(d.last);
  };
  const end = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    const moved = d.last.some((v, i) => Math.abs(v - d.start[i]) > 0.3);
    if (moved) void setLayout(id, { bbox: d.last.map((v) => Math.round(v * 100) / 100) as Box });
    onDrag(null);
  };
  const gripProps = (grip: Grip) => ({ onPointerDown: begin(grip), onPointerMove: move, onPointerUp: end, onPointerCancel: end });

  const BAR_W = 400; // about as wide as the bar gets
  const top = y0 * zoom;
  const barAbove = top > 46;
  const barLeft = Math.max(0, Math.min(x0 * zoom, page.width * zoom - BAR_W));
  // keep typing focus where it is: the bar never takes it
  const keep = (e: React.MouseEvent) => e.preventDefault();

  return (
    <>
      <div
        className="edit-bar"
        role="toolbar"
        aria-label="格式"
        style={{ left: barLeft, top: barAbove ? top - 40 : y1 * zoom + 8 }}
        onMouseDown={keep}
      >
        <button type="button" className="edit-grip" title="拖动来移动这个段落。键盘：先按 Esc 退出打字，再用方向键微调（Shift 移得更远），Delete 隐藏" aria-label="移动" {...gripProps('move')}>
          ⠿
        </button>
        {!hidden && kind === 'line' && (
          <>
            <button type="button" className="edit-btn is-text" title="线条变细" aria-label="线条变细" disabled={scale <= 0.45} onClick={() => void setLayout(id, { scale: Math.round((scale / 1.35) * 1000) / 1000 })}>
              细
            </button>
            <button type="button" className="edit-btn is-text" title="线条变粗" aria-label="线条变粗" disabled={scale >= 2.9} onClick={() => void setLayout(id, { scale: Math.round(Math.min(3, scale * 1.35) * 1000) / 1000 })}>
              粗
            </button>
            <span className="edit-sep" />
            {COLOURS.map((c) => (
              <button
                key={c.value}
                type="button"
                className={`edit-swatch ${(layout?.color ?? 0x1a1a1a) === c.value ? 'active' : ''}`}
                style={{ background: hex(c.value) }}
                title={`线条颜色：${c.name}`}
                aria-label={`线条颜色：${c.name}`}
                onClick={() => void setLayout(id, { color: c.value })}
              />
            ))}
            <span className="edit-sep" />
          </>
        )}
        {!hidden && kind === 'text' && (
          <>
            <button type="button" className="edit-btn" title="字号减小" aria-label="字号减小" disabled={scale <= 0.45} onClick={() => void setLayout(id, { scale: Math.round((scale / 1.1) * 1000) / 1000 })}>
              A−
            </button>
            <span className="edit-scale" title="相对原字号">{Math.round(scale * 100)}%</span>
            <button type="button" className="edit-btn" title="字号增大" aria-label="字号增大" disabled={scale >= 2.9} onClick={() => void setLayout(id, { scale: Math.round(scale * 1.1 * 1000) / 1000 })}>
              A+
            </button>
            <button type="button" className={`edit-btn is-bold ${bold ? 'active' : ''}`} title="加粗" aria-label="加粗" aria-pressed={bold} onClick={() => void setLayout(id, { bold: !bold })}>
              B
            </button>
            <span className="edit-sep" />
            {COLOURS.map((c) => (
              <button
                key={c.value}
                type="button"
                className={`edit-swatch ${layout?.color === c.value ? 'active' : ''}`}
                style={{ background: hex(c.value) }}
                title={`文字颜色：${c.name}`}
                aria-label={`文字颜色：${c.name}`}
                onClick={() => void setLayout(id, { color: c.value })}
              />
            ))}
            <label className="edit-swatch is-custom" title="其他颜色">
              <input
                type="color"
                aria-label="其他颜色"
                value={hex(layout?.color ?? 0x1a1a1a)}
                onChange={(e) => void setLayout(id, { color: parseInt(e.target.value.slice(1), 16) })}
              />
            </label>
            <span className="edit-sep" />
            {(
              [
                ['left', '左对齐', 'M2 3h12M2 7h8M2 11h12M2 15h8'],
                ['center', '居中', 'M2 3h12M4 7h8M2 11h12M4 15h8'],
                ['right', '右对齐', 'M2 3h12M6 7h8M2 11h12M6 15h8'],
              ] as const
            ).map(([value, label, d]) => (
              <button key={value} type="button" className={`edit-btn ${align === value ? 'active' : ''}`} title={label} aria-label={label} aria-pressed={align === value} onClick={() => void setLayout(id, { align: value })}>
                <svg viewBox="0 0 16 18" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
                  <path d={d} />
                </svg>
              </button>
            ))}
            <span className="edit-sep" />
          </>
        )}
        {block.meta?.user ? (
          <button type="button" className="edit-btn is-text" title={hidden ? '放回页面上' : '从页面上拿掉（可以撤销；导出时也不出现）'} onClick={() => void setLayout(id, { hidden: !hidden })}>
            {hidden ? '放回' : '删除'}
          </button>
        ) : (
          <button type="button" className="edit-btn is-text" title={hidden ? '重新显示这个段落' : '隐藏这个段落（导出时也不出现）'} onClick={() => void setLayout(id, { hidden: !hidden })}>
            {hidden ? '显示' : '隐藏'}
          </button>
        )}
        {kind === 'text' && (
          <button type="button" className="edit-btn is-text" title="去掉这个段落的所有格式修改（字号、颜色、位置…）" disabled={!layout} onClick={() => void setLayout(id, null)}>
            还原
          </button>
        )}
      </div>
      {(['nw', 'ne', 'sw', 'se'] as const).map((g) => (
        <span
          key={g}
          className={`edit-handle is-${g}`}
          style={{ left: (g.includes('w') ? x0 : x1) * zoom, top: (g.includes('n') ? y0 : y1) * zoom }}
          title="拖动来调整大小"
          {...gripProps(g)}
        />
      ))}
    </>
  );
}
