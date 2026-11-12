import { createContext, useContext, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import ImageBlock from './ImageBlock';
import EditFrame from './EditFrame';
import { selKey, useEditStore } from '../stores/edit';
import { useFitBox } from '../hooks/useFitBox';
import { scrollPageIntoView } from '../hooks/useSyncScroll';
import { useTranslationStore, type PageData } from '../stores/translation';
import { useViewStore } from '../stores/view';
import type { Block, EditSide, MathRun, TableCell } from '../types';
import { HighlightLayer } from './HighlightLayer';
import { MathText, OrigCrop, hasMath, type PageImage } from './MathText';
import { codeTranslationFits, emWidth, splitCodeLine } from '../lib/codeBlock';

/** PDF font name → CSS stack with a CJK-capable fallback (no serif surprise). */
function fontStack(font: string | null | undefined): string {
  const name = (font ?? '').replace(/^[A-Z]{6}\+/, '').replace(/[-,](Bold|Italic|Regular|Light|Medium|Semibold|BoldItalic).*$/i, '');
  const serif = /times|serif|roman|cambria|georgia|garamond|minion|palatino|mincho|song|simsun|batang|ming/i.test(name);
  const generic = serif
    ? '"Times New Roman", "Songti SC", SimSun, serif'
    : '"Segoe UI", Calibri, Arial, "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif';
  return name ? `"${name}", ${generic}` : generic;
}

/** Weight implied by the PDF font name ("Calibri-Light" → 300, "…-Bold" → 700). */
function fontWeightOf(font: string | null | undefined, bold: boolean): number {
  const f = font ?? '';
  if (bold || /bold|black|heavy|semibold|demi/i.test(f)) return /semibold|demi/i.test(f) ? 600 : 700;
  if (/light|thin|extralight|hairline/i.test(f)) return 300;
  return 400;
}

function colorToCss(color: number | string | null | undefined): string | undefined {
  if (color === null || color === undefined) return undefined;
  if (typeof color === 'string') return color;
  const n = color >>> 0;
  return `#${n.toString(16).padStart(6, '0')}`;
}

/** Split a markdown-ish table translation into rows of cells (separator rows skipped). */
function parseMarkdownRows(text: string): string[][] | null {
  if (!text.includes('|')) return null;
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && l.includes('|'))
    .filter((l) => !/^\|?[\s:|-]+\|?$/.test(l)); // drop GFM separator rows like |---|---|
  if (lines.length === 0) return null;
  return lines.map((line) =>
    line
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((c) => c.trim()),
  );
}

/** Rows of cells back into the markdown the translation is stored as. */
function tableMarkdown(rows: string[][]): string {
  const line = (r: string[]) => `| ${r.map((c) => c.replace(/\|/g, '｜').replace(/\s*\n\s*/g, ' ').trim()).join(' | ')} |`;
  const out = rows.map(line);
  if (rows.length) out.splice(1, 0, `| ${rows[0].map(() => '---').join(' | ')} |`);
  return out.join('\n');
}

/** Light text (e.g. white header text) is only readable on the page background's dark fill. */
function isLight(color: number | undefined): boolean {
  if (color === undefined || color === null) return false;
  const r = (color >> 16) & 255;
  const g = (color >> 8) & 255;
  const b = color & 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 180;
}

function TableCells({
  block,
  zoom,
  page,
  hasBackground,
  editMode = false,
  onSave,
}: {
  block: Block;
  zoom: number;
  page: PageImage;
  hasBackground: boolean;
  editMode?: boolean;
  onSave?: (id: string, text: string) => void;
}) {
  const cells: TableCell[] = block.meta?.cells ?? [];
  const translation = block.translation;
  const mdRows = translation ? parseMarkdownRows(translation) : null;
  // cells are positioned relative to the table block box
  const [bx0, by0] = block.bbox;
  if (cells.length === 0 || (translation && !mdRows)) return null;
  return (
    <>
      {cells.map((cell) => {
        if (page.url && (cell.math || mdRows?.[cell.row]?.[cell.col] === undefined)) {
          // formula cells (and cells the model dropped) keep the original rendering
          return (
            <OrigCrop key={`${cell.row}-${cell.col}`} page={page} bbox={cell.bbox} zoom={zoom} offset={[bx0, by0]} pad={0} />
          );
        }
        return (
          <TableCellView
            key={`${cell.row}-${cell.col}`}
            cell={cell}
            text={mdRows?.[cell.row]?.[cell.col] ?? cell.text}
            editable={editMode && !!mdRows && !!onSave}
            onCommit={(next) => {
              if (!mdRows || !onSave) return;
              const rows = mdRows.map((r) => r.slice());
              if (!rows[cell.row] || rows[cell.row][cell.col] === next) return;
              rows[cell.row][cell.col] = next;
              onSave(block.id, tableMarkdown(rows));
            }}
            offset={[bx0, by0]}
            zoom={zoom}
            fallbackPt={block.style?.size ?? 10}
            light={!hasBackground && isLight(cell.color)}
            runs={block.meta?.math}
            page={page}
          />
        );
      })}
    </>
  );
}

/** One translated cell, laid out like the source text: same inset, alignment and size. */
function TableCellView({
  cell,
  text,
  offset,
  zoom,
  fallbackPt,
  light,
  runs,
  page,
  editable = false,
  onCommit,
}: {
  cell: TableCell;
  text: string;
  editable?: boolean;
  onCommit?: (text: string) => void;
  offset: [number, number];
  zoom: number;
  fallbackPt: number;
  light: boolean;
  runs: MathRun[] | undefined;
  page: PageImage;
}) {
  const [x0, y0, x1, y1] = cell.bbox;
  const pt = cell.size || fallbackPt;
  const size = pt * zoom;
  const ref = useRef<HTMLDivElement>(null);
  const w = Math.max(1, (x1 - x0) * zoom);
  const h = Math.max(1, (y1 - y0) * zoom);
  useFitBox(ref, size, [text, size, w, h, editable]);
  const [il, it, ir] = cell.inset ?? [3, 2, 3];
  // the CSS line box sits ~0.2em above the glyph tops
  const padTop = Math.max(0, (it - 0.22 * pt) * zoom);
  const padSide = Math.min(Math.max(il, 1.5), 0.6 * (x1 - x0)) * zoom;
  return (
    <div
      ref={ref}
      className={editable ? 'abs-cell editable' : 'abs-cell'}
      contentEditable={editable}
      suppressContentEditableWarning
      onBlur={(e) => editable && onCommit?.((e.currentTarget.textContent ?? '').trim())}
      onKeyDown={(e) => {
        if (!editable) return;
        if (e.key === 'Escape' || (e.key === 'Enter' && !e.shiftKey)) {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
      style={{
        left: (x0 - offset[0]) * zoom,
        top: (y0 - offset[1]) * zoom,
        width: w,
        height: h,
        fontSize: size,
        paddingTop: padTop,
        paddingLeft: cell.align ? 2 * zoom : padSide,
        paddingRight:
          cell.align === 'right'
            ? Math.min(Math.max(ir ?? 3, 1.5), 0.4 * (x1 - x0)) * zoom
            : cell.align === 'center'
              ? 2 * zoom
              : Math.min(padSide, 4 * zoom),
        textAlign: cell.align ?? 'left',
        color: light ? undefined : colorToCss(cell.color),
        fontWeight: cell.bold ? 700 : undefined,
      }}
    >
      {editable ? text : <MathText text={text} runs={runs} page={page} basePt={pt} />}
    </div>
  );
}

/** which text the pane shows and edits: the translation (right) or the original (left, edit mode) */
const SideContext = createContext<EditSide>('tgt');

interface BlockViewProps {
  block: Block;
  zoom: number;
  docId: string;
  pageNo: number;
  editMode: boolean;
  hovered: boolean;
  failed: boolean;
  hasBackground: boolean;
  page: PageImage;
  /** formula blocks: the crop (padding included), short of the text lines around it (meta.crop) */
  cropBox?: [number, number, number, number];
  onHover: (id: string | null) => void;
  onSave: (id: string, text: string) => void;
}

/** Translation already carries a bullet / number → don't prepend the source marker again. */
function startsWithMarker(text: string, marker: string): boolean {
  const t = text.trimStart();
  if (marker && t.startsWith(marker)) return true;
  return /^([•·▪●○■□◦➢➤✓✔❖\-–*]|o(?=\s)|\(?\d{1,3}[.)、]|\(?[a-zA-Z][.)]|[ivxIVX]{1,4}[.)])\s*/.test(t);
}

// a bullet glyph may be glued to the text ("•若…": Chinese translations often drop the space);
// numbers and letters need the space ("1.5 V" is not an item)
const HANG_MARKER =
  /^\s*(?:([•·▪‣●○◆◇■□◦➢➤✓✔❖])\s*|((?:[–—*-])|o(?=\s)|\(?\d{1,3}(?:\.\d{1,3})*[.)、]|\(\d{1,3}\)|\(?[a-zA-Z][.)]|[ivxIVX]{1,5}[.)])(?:\s+|$))(.*)$/;

/**
 * Numbered / bulleted text → [{marker, body}] items, so the marker can sit in a
 * hanging gutter like the source ("1.1.⇥Plot …"). Models often answer "1.1.\n译文";
 * a marker alone on its line takes the next line as its body. null when the text
 * does not start with a marker.
 */
function hangItems(text: string, fallbackMarker: string | null | undefined): { marker: string; body: string }[] | null {
  const items: { marker: string; body: string }[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = HANG_MARKER.exec(line);
    if (m) {
      items.push({ marker: m[1] ?? m[2], body: m[3] });
    } else if (items.length === 0) {
      if (!fallbackMarker) return null;
      items.push({ marker: fallbackMarker, body: line });
    } else {
      const last = items[items.length - 1];
      last.body = last.body ? last.body + '\n' + line : line;
    }
  }
  return items.length ? items : null;
}

/** Text blocks reach as far up/down as their inline formulas (tall fractions, braces). */
function blockBox(block: Block): [number, number, number, number] {
  let [x0, y0, x1, y1] = block.bbox;
  if (block.type === 'paragraph' || block.type === 'list' || block.type === 'heading') {
    for (const m of block.meta?.math ?? []) {
      y0 = Math.min(y0, m.bbox[1]);
      y1 = Math.max(y1, m.bbox[3]);
    }
  }
  return [x0, y0, x1, y1];
}

function BlockView({ block, zoom, docId, pageNo, editMode, hovered, failed, hasBackground, page, cropBox, onHover, onSave }: BlockViewProps) {
  // the reader's own formatting from edit mode (text blocks only): size, weight, colour,
  // alignment, a new place or size on the page, or hidden altogether
  const textual = block.type !== 'image' && block.type !== 'table' && block.type !== 'code' && block.type !== 'formula';
  const layout = textual ? (block.layout ?? null) : null;
  const side = useContext(SideContext);
  const selected = useEditStore((s) => editMode && s.selectedId === selKey(block.id, side));
  const [dragBox, setDragBox] = useState<[number, number, number, number] | null>(null);
  const [x0, y0, x1, y1] = dragBox ?? layout?.bbox ?? blockBox(block);
  const boxW = (x1 - x0) * zoom;
  const boxH = (y1 - y0) * zoom;
  const style = block.style ?? { size: 12 };
  const basePt = (style.size || block.font_size || 12) * (layout?.scale ?? 1);
  const baseSize = basePt * zoom;
  const contentRef = useRef<HTMLDivElement>(null);
  const hasTranslation = !!block.translation;
  const select = () => {
    if (editMode) useEditStore.getState().select(block.id, side);
  };

  useFitBox(contentRef, baseSize, [block.translation, block.text, baseSize, boxW, boxH, editMode, selected, layout?.bold]);

  const isList = block.type === 'list';
  const flash = useViewStore((s) => s.flashBlockId !== null && s.flashBlockId === String(block.id));
  const cls = (extra: string[]) =>
    ['abs-block', `abs-${block.type}`, hovered ? 'hovered' : '', failed ? 'failed' : '', flash ? 'flash' : '', ...extra]
      .filter(Boolean)
      .join(' ');
  const box = { left: x0 * zoom, top: y0 * zoom, width: boxW, height: boxH };
  const hover = {
    onMouseEnter: () => onHover(block.id),
    onMouseLeave: () => onHover(null),
  };

  // Image block — the page background already contains the image; ImageBlock adds
  // the optional copy with its text translated (设置 → 翻译 → 翻译图片文字).
  if (block.type === 'image' && side === 'src') return null; // the page background shows it
  if (block.type === 'image') {
    return (
      <ImageBlock
        block={block}
        docId={docId}
        pageNo={pageNo}
        className={cls([])}
        style={box}
        hasBackground={hasBackground}
        {...hover}
      />
    );
  }

  // Code listing: the code stays the original rendering (syntax colours, alignment);
  // the translated comments are laid out from the column where each comment starts.
  if (block.type === 'code') {
    const lines = block.meta?.code?.lines ?? [];
    const fits = codeTranslationFits(block.text, block.translation, block.meta);
    if (page.url && fits) {
      const tl = block.translation!.split('\n');
      const sizePt = basePt * 0.95;
      const right = Math.max(x1, page.width - 30);
      return (
        <>
          {lines.map((ln, i) => {
            const cut = ln.cx != null && splitCodeLine(tl[i], ln.ci).comment ? Math.min(ln.cx - 0.6, ln.x1) : ln.x1;
            return cut > ln.x0 ? (
              <OrigCrop key={`c${i}`} page={page} bbox={[ln.x0, ln.y0, cut, ln.y1]} zoom={zoom} pad={0.6} />
            ) : null;
          })}
          {lines.map((ln, i) => {
            if (ln.cx == null) return null;
            const { head, comment } = splitCodeLine(tl[i], ln.ci);
            if (!comment) return null;
            const text = head + comment;
            const avail = (right - ln.cx) / (emWidth(text) * sizePt);
            const pt = sizePt * Math.max(0.6, Math.min(1, avail));
            const h = (ln.y1 - ln.y0) * zoom;
            return (
              <div
                key={`t${i}`}
                className="abs-code-comment"
                style={{
                  left: ln.cx * zoom,
                  top: ln.y0 * zoom,
                  height: h,
                  lineHeight: `${h}px`,
                  fontSize: pt * zoom,
                  color: colorToCss(ln.cc ?? style.color) ?? '#2e7d32',
                  fontFamily: fontStack(style.font),
                }}
              >
                {text}
              </div>
            );
          })}
          <div className={cls(['orig'])} data-block-id={block.id} style={box} title="代码：只翻译注释" {...hover} />
        </>
      );
    }
    if (page.url) {
      return (
        <>
          <OrigCrop page={page} bbox={block.bbox} zoom={zoom} pad={1.5} />
          <div className={cls(['orig'])} data-block-id={block.id} style={box} title="代码（保持原样）" {...hover} />
        </>
      );
    }
    return (
      <div className={cls([])} data-block-id={block.id} style={box} {...hover}>
        <pre className="abs-code-text" style={{ fontSize: baseSize }}>
          {fits ? block.translation : block.text}
        </pre>
      </div>
    );
  }

  // Formula blocks and untranslated content: show the original rendering, pixel-identical.
  // (Fallback to text when the original render is unavailable.)
  // (In edit mode, clicking an untranslated text block turns it into a box to type a translation in.)
  if (page.url && (block.type === 'formula' || !hasTranslation) && !(editMode && selected && textual)) {
    return (
      <>
        <OrigCrop
          page={page}
          bbox={block.type === 'formula' && cropBox ? cropBox : block.bbox}
          zoom={zoom}
          pad={block.type === 'table' ? 1 : block.type === 'formula' && cropBox ? 0 : 1.5}
        />
        <div
          className={cls(['orig', block.type === 'formula' ? '' : 'untranslated'])}
          data-block-id={block.id}
          style={box}
          title={side === 'src' ? (editMode && textual ? '点一下可以修改原文' : undefined) : block.type === 'formula' ? '公式（保持原样）' : editMode && textual ? '尚未翻译：点一下可以自己写译文' : '尚未翻译（显示原文）'}
          onClick={textual ? select : undefined}
          {...hover}
        />
      </>
    );
  }

  // Table block
  if (block.type === 'table') {
    const mdRows = block.translation ? parseMarkdownRows(block.translation) : null;
    const flowFallback = (!!block.translation && !mdRows) || !(block.meta?.cells?.length ?? 0);
    return (
      <div className={cls([])} data-block-id={block.id} style={box} {...hover}>
        <TableCells block={block} zoom={zoom} page={page} hasBackground={hasBackground} editMode={editMode} onSave={onSave} />
        {flowFallback && (
          <div
            className="abs-table-fallback"
            ref={contentRef}
            style={{
              fontSize: baseSize,
              position: 'absolute',
              inset: 0,
              overflow: 'hidden',
              padding: 2 * zoom,
              background: 'rgba(255,255,255,0.92)',
            }}
          >
            {block.translation ?? block.text}
          </div>
        )}
      </div>
    );
  }

  if (layout?.hidden) {
    // hidden by the reader: nothing in read mode, a ghost to bring it back in edit mode
    if (!editMode) return null;
    return (
      <>
        <div className={cls(['is-hidden', selected ? 'selected' : ''])} data-block-id={block.id} style={box} onClick={select} {...hover}>
          <span className="abs-hidden-note">已隐藏</span>
        </div>
        {selected && <EditFrame side={side} block={block} layout={layout} box={[x0, y0, x1, y1]} zoom={zoom} page={page} onDrag={setDragBox} />}
      </>
    );
  }

  const textStyle: React.CSSProperties = {
    color: colorToCss(layout?.color ?? style.color) ?? '#1a1a1a',
    // follow the source: Word headings are often *light* (Calibri Light), not bold
    fontWeight: layout?.bold !== undefined ? (layout.bold ? 700 : 400) : fontWeightOf(style.font, !!(style.bold || block.bold)),
    fontStyle: style.italic ? 'italic' : undefined,
    textAlign: (layout?.align ?? (style.align as React.CSSProperties['textAlign'])) ?? 'left',
    fontFamily: fontStack(style.font),
    lineHeight: 1.25,
    fontSize: baseSize,
  };

  // Heading / paragraph / list — list_marker prefix shown for list blocks
  const marker = isList && block.list_marker ? block.list_marker + ' ' : '';
  const shown = block.translation ?? block.meta?.ph ?? block.text; // text fallback when no original render
  const displayText = (marker && startsWithMarker(shown, block.list_marker ?? '') ? '' : marker) + shown;
  // hanging indent (marker in a gutter, wrapped lines aligned with the text) like the source
  const hangPt = block.meta?.hang;
  const useGutter = !!hangPt && hangPt > 0 && hangPt < (x1 - x0) * 0.4;
  const gaps = block.meta?.item_gaps;
  const hang = useGutter || gaps?.length ? hangItems(shown, isList ? block.list_marker : null) : null;
  const hangW = useGutter ? (hangPt ?? 0) * zoom : 0;
  // paragraph spacing between items, as in the source (falls back to the typical gap)
  const typicalGap = gaps?.length ? Math.max(...gaps.slice(1), 0) : 0;
  // in em, so the spacing shrinks together with the text when a long translation is fitted
  const gapAbove = (i: number) =>
    i === 0 ? 0 : `${(gaps && hang && gaps.length === hang.length ? gaps[i] : typicalGap) / basePt}em`;

  const canType = editMode && (hasTranslation || selected);
  return (
    <>
    <div
      className={cls([canType ? 'editable' : '', hasTranslation ? '' : 'untranslated', selected ? 'selected' : '', dragBox ? 'is-dragging' : ''])}
      data-block-id={block.id}
      style={box}
      onMouseDown={select}
      {...hover}
    >
      <div
        ref={contentRef}
        className="abs-block-content"
        style={textStyle}
        contentEditable={canType}
        suppressContentEditableWarning
        title={editMode && hasMath(block.translation) ? '{{mN}} 是公式占位符，请保留' : undefined}
        onBlur={(e) => {
          if (!canType) return;
          const next = e.currentTarget.textContent ?? ''; // edit mode shows the bare translation
          // an untranslated block starts from the source text: saved once it has been rewritten
          if (next !== (block.translation ?? block.meta?.ph ?? block.text) && (hasTranslation || next.trim())) onSave(block.id, next);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') e.currentTarget.blur();
        }}
      >
        {canType ? (
          (block.translation ?? block.meta?.ph ?? block.text)
        ) : hang ? (
          hang.map((it, i) => (
            <div key={i} className="abs-hang-item" style={{ marginTop: gapAbove(i) }}>
              <span
                className={`abs-hang-marker ${it.marker === 'o' ? 'is-o' : ''}`}
                style={useGutter ? { width: hangW } : { marginRight: '0.4em' }}
              >
                {it.marker}
              </span>
              <span className="abs-hang-body">
                <MathText text={it.body} runs={block.meta?.math} page={page} basePt={basePt} />
              </span>
            </div>
          ))
        ) : (
          <MathText text={displayText} runs={block.meta?.math} page={page} basePt={basePt} />
        )}
      </div>
    </div>
    {selected && <EditFrame side={side} block={block} layout={layout} box={[x0, y0, x1, y1]} zoom={zoom} page={page} onDrag={setDragBox} />}
    </>
  );
}

/** Small action bar over the hovered block: try-translate / retranslate. */
function BlockActions({ block, zoom, onHover }: { block: Block; zoom: number; onHover: (id: string | null) => void }) {
  const startRetranslateBlock = useTranslationStore((s) => s.startRetranslateBlock);
  const busy = useTranslationStore((s) => s.busy);
  if (block.type === 'image' || block.type === 'formula') return null;
  const [, y0, x1] = block.bbox;
  const run = async () => {
    const jobId = await startRetranslateBlock(block.id);
    if (jobId) {
      useTranslationStore.getState().setJob({
        id: jobId,
        kind: 'translate',
        status: 'running',
        total: 1,
        done: 0,
        failed: 0,
        params: { scope: 'blocks', block_ids: [block.id] },
      });
    }
  };
  return (
    <div
      className="block-actions"
      style={{ left: x1 * zoom, top: y0 * zoom }}
      onMouseEnter={() => onHover(block.id)}
      onMouseLeave={() => onHover(null)}
    >
      <button type="button" className="btn btn-xs" disabled={busy} onClick={() => void run()}>
        {block.translation ? '↻ 重译' : '试翻此段'}
      </button>
    </div>
  );
}

function AbsolutePage({
  page,
  zoom,
  docId,
  editMode,
  hoverId,
  failedIds,
  onHover,
  onSave,
  active,
}: {
  active: boolean;
  page: PageData;
  zoom: number;
  docId: string;
  editMode: boolean;
  hoverId: string | null;
  failedIds: Set<string>;
  onHover: (id: string | null) => void;
  onSave: (id: string, text: string) => void;
}) {
  const [bgFailed, setBgFailed] = useState(false);
  const bg = page.background && !bgFailed ? page.background : null;
  useEffect(() => setBgFailed(false), [page.background]);
  // probe the original render once; an old backend (or a failed render) has none
  const [origOk, setOrigOk] = useState<boolean | null>(null);
  useEffect(() => {
    if (!active) return; // far-away pages fetch nothing
    if (!page.original) {
      // not loaded yet (placeholder) → undecided; loaded without a render → failed
      setOrigOk(page.loaded ? false : null);
      return;
    }
    setOrigOk(null); // loading — never flash the text fallback meanwhile
    let live = true;
    const probe = new Image();
    probe.onload = () => live && setOrigOk(true);
    probe.onerror = () => live && setOrigOk(false);
    probe.src = page.original;
    return () => {
      live = false;
      probe.src = ''; // drop the download when the page scrolls out of range
    };
  }, [page.original, page.loaded, active]);
  // (hooks stay above the early return below: a page that scrolls out of range must run the same hooks)
  const side = useContext(SideContext);
  // the left pane in edit mode: the same page, but each block shows the ORIGINAL — untouched
  // (a crop of the page) until the reader edits it, then their text and formatting
  const blocks = useMemo(
    () =>
      side === 'src'
        ? page.blocks.map((b) => ({ ...b, translation: b.src_edit?.text ?? null, layout: b.src_edit?.layout ?? null, translated: !!b.src_edit?.text, image_tr: null }))
        : page.blocks,
    [side, page.blocks],
  );
  const img: PageImage = { url: origOk === false ? null : page.original, width: page.width, height: page.height };
  if (!active) {
    // virtualised: an empty sheet keeps the scroll geometry, no images / blocks
    return (
      <div className="abs-page" data-page-no={page.pageNo} style={{ width: page.width * zoom, height: page.height * zoom }}>
        <div className="abs-page-anchor" data-block-id={`__page_${page.pageNo}`} />
      </div>
    );
  }
  const hovered = hoverId ? page.blocks.find((b) => b.id === hoverId) : undefined;
  const translatable = page.blocks.filter((b) => b.type !== 'image' && b.type !== 'formula' && b.text.trim());
  const nDone = translatable.filter((b) => b.translation).length;
  return (
    <div
      className={`abs-page ${bg ? 'has-bg' : ''} ${editMode ? 'is-editing' : ''}`}
      data-page-no={page.pageNo}
      style={{ width: page.width * zoom, height: page.height * zoom }}
      onMouseDown={(e) => {
        // a click on the empty page lets go of the selected block
        const t = e.target as HTMLElement;
        if (editMode && (t === e.currentTarget || t.classList.contains('abs-page-bg'))) {
          useEditStore.getState().select(null);
          (document.activeElement as HTMLElement | null)?.blur?.();
        }
      }}
    >
      {bg && (
        <img
          className="abs-page-bg"
          src={bg}
          alt=""
          draggable={false}
          decoding="async"
          onError={() => setBgFailed(true)}
        />
      )}
      <div className="abs-page-anchor" data-block-id={`__page_${page.pageNo}`} />
      {blocks.map((b) => (
        <BlockView
          key={b.id}
          block={b}
          zoom={zoom}
          docId={docId}
          pageNo={page.pageNo}
          editMode={editMode}
          hasBackground={!!bg}
          page={img}
          cropBox={b.type === 'formula' ? b.meta?.crop : undefined}
          hovered={hoverId === b.id}
          failed={failedIds.has(String(b.id))}
          onHover={onHover}
          onSave={onSave}
        />
      ))}
      <HighlightLayer pageNo={page.pageNo} pane={side} zoom={zoom} />
      {hovered && !editMode && side === 'tgt' && <BlockActions block={hovered} zoom={zoom} onHover={onHover} />}
      {side === 'tgt' && page.loaded && translatable.length > 0 && nDone < translatable.length && (
        <div className={`abs-page-badge ${nDone === 0 ? 'none' : 'partial'}`}>
          {nDone === 0 ? '未翻译' : `已翻译 ${nDone}/${translatable.length}`}
        </div>
      )}
      {page.loading && !page.loaded && <div className="abs-page-loading">加载中…</div>}
    </div>
  );
}

/**
 * 整页预览: each page is a pt-sized box with absolutely positioned translated
 * blocks preserving the original PDF geometry (PDFMathTranslate style).
 */
export function PageAbsoluteView({
  scrollRef,
  docId,
  side = 'tgt',
}: {
  scrollRef: RefObject<HTMLDivElement>;
  docId: string;
  /** 'src': the original with the reader's edits (left pane) */
  side?: EditSide;
}) {
  const zoom = useViewStore((s) => s.zoom);
  const editMode = useViewStore((s) => s.editMode);
  const hoverId = useViewStore((s) => s.hoverBlockId);
  const setHover = useViewStore((s) => s.setHoverBlock);
  const pageCount = useViewStore((s) => s.pageCount);
  const currentPage = useViewStore((s) => s.currentPage);
  const pageNavSeq = useViewStore((s) => s.pageNavSeq);
  const pages = useTranslationStore((s) => s.pages);
  const loadPage = useTranslationStore((s) => s.loadPage);
  const failedBlockIds = useTranslationStore((s) => s.failedBlockIds);
  const failedIds = new Set(failedBlockIds.map(String));
  // unloaded pages take the size of a loaded one so both panes stay aligned
  const sample = Object.values(pages).find((p) => p.loaded);

  // the left pane swaps in when edit mode starts: begin at the page being read, not at page 1
  useEffect(() => {
    if (side !== 'src') return;
    const page = useViewStore.getState().currentPage;
    const id = requestAnimationFrame(() => {
      if (scrollRef.current) scrollPageIntoView(scrollRef.current, page, 'auto', 0);
    });
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [side]);

  // load pages lazily: current ± 2, clamped to the real page count
  useEffect(() => {
    const total = pageCount || 0;
    const first = Math.max(1, currentPage - 2);
    const last = Math.min(total > 0 ? total : currentPage, currentPage + 2);
    for (let n = first; n <= last; n++) {
      void loadPage(docId, n);
    }
  }, [docId, currentPage, pageCount, loadPage]);

  // nav: scroll target pane to page
  useEffect(() => {
    if (pageNavSeq === 0) return;
    const el = scrollRef.current;
    if (!el) return;
    // react to explicit nav requests only — not to scroll-driven page changes
    scrollPageIntoView(el, useViewStore.getState().currentPage, 'auto');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageNavSeq, scrollRef]);

  const range: number[] = [];
  const total = pageCount || currentPage || 1;
  for (let n = 1; n <= total; n++) range.push(n);

  return (
    <SideContext.Provider value={side}>
    <div className={`translation-pane abs-view ${side === 'src' ? 'is-source' : ''}`} ref={scrollRef}>
      {range.map((n) => {
        const page = pages[n] ?? {
          pageNo: n,
          width: sample?.width ?? 595,
          height: sample?.height ?? 842,
          blocks: [],
          loading: false,
          loaded: false,
        };
        return (
          <AbsolutePage
            key={n}
            page={page}
            zoom={zoom}
            docId={docId}
            editMode={editMode}
            hoverId={hoverId}
            failedIds={failedIds}
            onHover={setHover}
            onSave={(id, text) => void useEditStore.getState().setText(id, text, side)}
            active={Math.abs(n - currentPage) <= 3}
          />
        );
      })}
    </div>
    </SideContext.Provider>
  );
}
