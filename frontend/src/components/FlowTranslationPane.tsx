import { useEffect, useState, type RefObject } from 'react';
import { api } from '../api/client';
import { MathText, OrigFigure, type PageImage } from './MathText';
import { scrollPageIntoView } from '../hooks/useSyncScroll';
import { useTranslationStore } from '../stores/translation';
import { useViewStore } from '../stores/view';
import type { Block, PageFigure, SentencePair } from '../types';

/** Parse a GFM table (separator rows dropped). null when the text is not a table. */
function mdRows(text: string | null | undefined): string[][] | null {
  if (!text || !text.includes('|')) return null;
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('|'))
    .filter((l) => !/^\|?[\s:|-]+\|?$/.test(l));
  if (lines.length === 0) return null;
  return lines.map((l) => l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
}

/**
 * Table in 逐句对照. Formula cells are crops of the original page (their extracted
 * text is often garbled), other cells render {{mN}} placeholders as formulas.
 */
function MdTable({
  rows,
  block,
  page,
  className,
}: {
  rows: string[][];
  block: Block;
  page: PageImage;
  className?: string;
}) {
  const cellAt = new Map((block.meta?.cells ?? []).map((c) => [`${c.row}:${c.col}`, c]));
  const runs = block.meta?.math;
  const basePt = block.style?.size || 11;
  const content = (i: number, j: number, text: string) => {
    const cell = cellAt.get(`${i}:${j}`);
    if (cell?.math && page.url) {
      const [x0, y0, x1, y1] = cell.bbox;
      const [il, it, ir] = cell.inset ?? [2, 2, 2];
      const size = cell.size || basePt;
      const box: [number, number, number, number] = [
        x0 + Math.max(il - 1.5, 0.8),
        y0 + Math.max(it - 2, 0.8),
        x1 - Math.max((ir ?? 2) - 1.5, 0.8),
        Math.min(y1 - 0.8, y0 + it + size * 1.8),
      ];
      return <CellCrop page={page} bbox={box} basePt={size} />;
    }
    return <MathText text={text} runs={runs} page={page} basePt={basePt} />;
  };
  return (
    <table className={`flow-table ${className ?? ''}`}>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            {r.map((c, j) => (i === 0 ? <th key={j}>{content(i, j, c)}</th> : <td key={j}>{content(i, j, c)}</td>))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Inline crop of the original page, sized in em so it follows the table's font size. */
function CellCrop({ page, bbox, basePt }: { page: PageImage; bbox: [number, number, number, number]; basePt: number }) {
  const e = 1 / Math.max(basePt, 1);
  const [x0, y0, x1, y1] = bbox;
  return (
    <span
      className="inline-formula"
      aria-label="公式"
      style={{
        display: 'inline-block',
        verticalAlign: 'middle',
        width: `${(x1 - x0) * e}em`,
        height: `${(y1 - y0) * e}em`,
        backgroundImage: `url("${page.url}")`,
        backgroundRepeat: 'no-repeat',
        backgroundSize: `${page.width * e}em ${page.height * e}em`,
        backgroundPosition: `${-x0 * e}em ${-y0 * e}em`,
      }}
    />
  );
}

function withMarker(text: string, marker: string | null | undefined): string {
  if (!marker) return text;
  const t = text.trimStart();
  if (t.startsWith(marker) || /^([•·▪●○■◦\-–*]|\(?\d{1,3}[.)、])\s*/.test(t)) return text;
  return marker + ' ' + text;
}

interface RowProps {
  block: Block;
  page: PageImage;
  hovered: boolean;
  failed: boolean;
  onHover: (id: string | null) => void;
  editMode: boolean;
  onSave: (id: string, text: string) => void;
  onSaveSentence: (block: Block, idx: number, text: string) => void;
}

function kindLabel(block: Block): string {
  switch (block.type) {
    case 'heading':
      return `标题${block.level ? ' H' + block.level : ''}`;
    case 'table':
      return '表格';
    case 'image':
      return '图片';
    case 'formula':
      return '公式';
    case 'code':
      return '代码';
    case 'list':
      return '列表';
    default:
      return '段落';
  }
}

function PairRow({ block, page, hovered, failed, onHover, editMode, onSave, onSaveSentence }: RowProps) {
  const runs = block.meta?.math;
  const basePt = block.style?.size || 11;
  const srcText = block.meta?.ph ?? block.text;
  const tgt = block.translation;
  const show = (t: string) => <MathText text={t} runs={runs} page={page} basePt={basePt} />;
  const sentences = block.sentences && block.sentences.length > 1 ? block.sentences : null;

  return (
    <div
      className={`flow-pair ${hovered ? 'hovered' : ''} ${failed ? 'failed' : ''}`}
      data-block-id={block.id}
      onMouseEnter={() => onHover(block.id)}
      onMouseLeave={() => onHover(null)}
    >
      <div className="flow-pair-meta">
        <span className="flow-kind">{kindLabel(block)}</span>
        {block.translation_edited ? <span className="flow-edited">已编辑</span> : null}
        {sentences && <span className="flow-kind subtle">逐句 {sentences.length}</span>}
        {failed && <span className="flow-failed">翻译失败</span>}
      </div>

      {block.type === 'formula' ? (
        <OrigFigure page={page} bbox={block.bbox} />
      ) : block.type === 'code' ? (
        <>
          <div className="flow-src" title="原文">
            <pre className="flow-code">{block.text}</pre>
          </div>
          <EditableTgt block={block} editMode={editMode} onSave={onSave} render={(t) => <pre className="flow-code">{t}</pre>} />
        </>
      ) : block.type === 'table' && mdRows(srcText) ? (
        <>
          <div className="flow-src">
            <MdTable rows={mdRows(srcText)!} block={block} page={page} className="src" />
          </div>
          {tgt && mdRows(tgt) && !editMode ? (
            <div className="flow-tgt">
              <MdTable rows={mdRows(tgt)!} block={block} page={page} />
            </div>
          ) : (
            <EditableTgt block={block} editMode={editMode} onSave={onSave} render={(t) => t} />
          )}
        </>
      ) : sentences && !editMode ? (
        <div className="flow-sentences">
          {sentences.map((s) => (
            <SentenceRow key={s.idx} block={block} s={s} show={show} onSave={onSaveSentence} />
          ))}
        </div>
      ) : (
        <>
          <div className="flow-src" title="原文">
            {show(block.type === 'list' ? withMarker(srcText, block.list_marker) : srcText)}
          </div>
          <EditableTgt block={block} editMode={editMode} onSave={onSave} render={show} />
        </>
      )}
    </div>
  );
}

/** One aligned sentence: source above, translation below; double-click to edit just this sentence. */
function SentenceRow({
  block,
  s,
  show,
  onSave,
}: {
  block: Block;
  s: SentencePair;
  show: (t: string) => JSX.Element;
  onSave: (block: Block, idx: number, text: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <div className={`flow-sent ${s.edited ? 'edited' : ''}`}>
      <div className="flow-sent-src">{show(s.src)}</div>
      <div
        className={`flow-sent-tgt ${editing ? 'editing' : ''}`}
        title={editing ? 'Enter 保存 / Esc 取消' : '双击编辑这一句'}
        contentEditable={editing}
        suppressContentEditableWarning
        onDoubleClick={() => setEditing(true)}
        onBlur={(e) => {
          if (!editing) return;
          setEditing(false);
          const next = (e.currentTarget.textContent ?? '').trim();
          if (next && next !== s.tgt) onSave(block, s.idx, next);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.currentTarget.blur();
          } else if (e.key === 'Escape') {
            e.currentTarget.textContent = s.tgt;
            setEditing(false);
          }
        }}
      >
        {editing ? s.tgt : show(s.tgt)}
      </div>
    </div>
  );
}

function EditableTgt({
  block,
  editMode,
  onSave,
  render,
}: {
  block: Block;
  editMode: boolean;
  onSave: (id: string, text: string) => void;
  render: (t: string) => JSX.Element | string;
}) {
  const tgt = block.translation;
  return (
    <div
      className={`flow-tgt ${tgt ? '' : 'untranslated'}`}
      contentEditable={editMode && !!tgt}
      suppressContentEditableWarning
      title={tgt ? (editMode ? '编辑整块译文（{{mN}} 为公式占位符）' : '译文') : '尚未翻译'}
      onBlur={(e) => {
        if (!(editMode && tgt)) return;
        const next = e.currentTarget.textContent ?? '';
        if (next !== tgt) onSave(block.id, next);
      }}
    >
      {tgt ? (editMode ? tgt : render(tgt)) : '（未翻译）'}
    </div>
  );
}

/** Place each figure right before the first block that starts below its top edge. */
/**
 * Figures go before the first block (in reading order) that is below them in their own
 * column — by height alone, a figure in the right column of a two-column page would land
 * in the middle of the left one.
 */
function interleave(blocks: Block[], figures: PageFigure[]): Array<Block | PageFigure> {
  const at = new Map<number, PageFigure[]>();
  const tail: PageFigure[] = [];
  for (const f of [...figures].sort((a, b) => a.bbox[1] - b.bbox[1])) {
    const same = (b: Block) => Math.min(b.bbox[2], f.bbox[2]) - Math.max(b.bbox[0], f.bbox[0]) > 0;
    let i = blocks.findIndex((b) => same(b) && b.bbox[1] >= f.bbox[1] - 1);
    if (i < 0) {
      // nothing below it in its column: after the last block above it there
      let last = -1;
      blocks.forEach((b, k) => {
        if (same(b) && b.bbox[1] < f.bbox[1]) last = k;
      });
      i = last >= 0 ? last + 1 : -1;
    }
    if (i < 0 || i >= blocks.length) tail.push(f);
    else at.set(i, [...(at.get(i) ?? []), f]);
  }
  const out: Array<Block | PageFigure> = [];
  blocks.forEach((b, k) => {
    out.push(...(at.get(k) ?? []), b);
  });
  return out.concat(tail);
}

/* ---- 连续阅读: the translation alone, read as one article (逐句对照 + 只看译文) ---- */

const ENDS_SENTENCE = /[.!?:;。！？：；)\]"”’]\s*$/;

/** Running heads, page numbers, footers: short lines in the top or bottom margin. */
function inMargin(b: Block, pageHeight: number): boolean {
  const t = (b.text || '').trim();
  if (b.type === 'heading' || t.length > 60) return false;
  return b.bbox[3] < pageHeight * 0.07 || b.bbox[1] > pageHeight * 0.93;
}

/** A paragraph cut by a column or a page: the next piece carries on without a new paragraph. */
function carriesOn(prev: Block | undefined, b: Block): boolean {
  if (!prev || prev.type !== 'paragraph' || b.type !== 'paragraph') return false;
  return !ENDS_SENTENCE.test((prev.text || '').trim()) && /^[a-z(\d]/.test((b.text || '').trim());
}

function ArticleBlock({
  block,
  page,
  cont,
  onHover,
}: {
  block: Block;
  page: PageImage;
  cont: boolean;
  onHover: (id: string | null) => void;
}) {
  const runs = block.meta?.math;
  const basePt = block.style?.size || 11;
  const src = block.meta?.ph ?? block.text;
  const tgt = block.translation;
  const text = tgt || src;
  const show = (t: string) => <MathText text={t} runs={runs} page={page} basePt={basePt} />;
  const hover = { onMouseEnter: () => onHover(block.id), onMouseLeave: () => onHover(null) };
  const cls = tgt ? '' : ' art-untranslated';
  if (block.type === 'heading') {
    const Tag = block.level <= 1 ? 'h2' : block.level === 2 ? 'h3' : 'h4';
    return (
      <Tag className={`art-h${cls}`} data-block-id={block.id} {...hover}>
        {show(text)}
      </Tag>
    );
  }
  if (block.type === 'formula') {
    return (
      <div className="art-formula" data-block-id={block.id} {...hover}>
        <OrigFigure page={page} bbox={block.bbox} />
      </div>
    );
  }
  if (block.type === 'table') {
    const rows = mdRows(tgt) || mdRows(src);
    return (
      <div className="art-table" data-block-id={block.id} {...hover}>
        {rows ? <MdTable rows={rows} block={block} page={page} /> : <OrigFigure page={page} bbox={block.bbox} />}
      </div>
    );
  }
  if (block.type === 'code') {
    return (
      <pre className="flow-code art-code" data-block-id={block.id} {...hover}>
        {text}
      </pre>
    );
  }
  // a reference list entry, a figure / table caption: each set as what it is
  const kind = /^\s*(\[\d{1,3}\]|\d{1,3}\.\s)/.test(block.text || '') && /\b(19|20)\d{2}\b/.test(block.text || '')
    ? ' art-ref'
    : /^\s*(fig(ure)?\.?|table|tab\.|图|表)\s*\d+/i.test(src || '')
      ? ' art-caption'
      : '';
  if (kind === ' art-ref') {
    // the PDF often keeps a whole reference list in one block: one entry per line
    const entries = text.replace(/\s*\n\s*/g, ' ').split(/\s+(?=\[\d{1,3}\]\s)/);
    return (
      <div className="art-refs" data-block-id={block.id} {...hover}>
        {entries.map((e, i) => (
          <p key={i} className={`art-p art-ref${cls}`}>
            {show(e)}
          </p>
        ))}
      </div>
    );
  }
  return (
    <p
      className={`art-p${block.type === 'list' ? ' art-list' : ''}${cont ? ' art-cont' : ''}${kind}${cls}`}
      data-block-id={block.id}
      title={tgt ? undefined : '这一段还没有翻译'}
      {...hover}
    >
      {show(block.type === 'list' ? withMarker(text, block.list_marker) : text)}
    </p>
  );
}

/** Short labels drawn inside a figure (axis titles, ticks) — the figure image shows them. */
function insideFigure(b: Block, figures: PageFigure[]): boolean {
  if (b.type === 'table' || b.type === 'heading') return false;
  const [x0, y0, x1, y1] = b.bbox;
  const area = Math.max((x1 - x0) * (y1 - y0), 1e-6);
  return figures.some((f) => {
    const w = Math.min(x1, f.bbox[2]) - Math.max(x0, f.bbox[0]);
    const h = Math.min(y1, f.bbox[3]) - Math.max(y0, f.bbox[1]);
    return w > 0 && h > 0 && (w * h) / area > 0.6;
  });
}

function isFigure(x: Block | PageFigure): x is PageFigure {
  return (x as PageFigure).url !== undefined && (x as Block).id === undefined;
}

/**
 * 逐句对照: true sentence pairs when the block has an alignment (model-aligned
 * or heuristic), else block pairs. Formulas are crops of the original page.
 */
export function FlowTranslationPane({
  scrollRef,
  docId,
}: {
  scrollRef: RefObject<HTMLDivElement>;
  docId: string;
}) {
  const editMode = useViewStore((s) => s.editMode);
  const hoverId = useViewStore((s) => s.hoverBlockId);
  const setHover = useViewStore((s) => s.setHoverBlock);
  const pageCount = useViewStore((s) => s.pageCount);
  const currentPage = useViewStore((s) => s.currentPage);
  const pageNavSeq = useViewStore((s) => s.pageNavSeq);
  const pages = useTranslationStore((s) => s.pages);
  const loadPage = useTranslationStore((s) => s.loadPage);
  const saveBlock = useTranslationStore((s) => s.saveBlockTranslation);
  const refreshPage = useTranslationStore((s) => s.refreshPage);
  const failedBlockIds = useTranslationStore((s) => s.failedBlockIds);
  const failed = new Set(failedBlockIds.map(String));
  const toast = useViewStore((s) => s.toast);

  const saveSentence = async (block: Block, idx: number, text: string) => {
    try {
      await api.putSentence(block.id, idx, text);
      await refreshPage(docId, block.page_no ?? useViewStore.getState().currentPage);
    } catch (e) {
      toast(`保存句子失败：${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  };

  useEffect(() => {
    const first = Math.max(1, currentPage - 2);
    const last = Math.min(pageCount || currentPage, currentPage + 2); // page count unknown → current only
    for (let n = first; n <= last; n++) {
      void loadPage(docId, n);
    }
  }, [docId, currentPage, pageCount, loadPage]);

  useEffect(() => {
    if (pageNavSeq === 0) return;
    const el = scrollRef.current;
    if (!el) return;
    // react to explicit nav requests only — not to scroll-driven page changes
    scrollPageIntoView(el, useViewStore.getState().currentPage, 'auto');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageNavSeq, scrollRef]);

  // 逐句对照 with only the translation shown: one continuous article
  const article = useViewStore((s) => s.panes === 'tgt') && !editMode;
  const total = pageCount || Math.max(currentPage, 1);
  const range: number[] = [];
  for (let n = 1; n <= total; n++) range.push(n);

  return (
    <div className={`translation-pane flow-view${article ? ' article-view' : ''}`} ref={scrollRef}>
      <div className="flow-column">
        {range.map((n) => {
          const page = pages[n];
          const blocks = page?.blocks ?? [];
          if (article) {
            const img = { url: page?.original, width: page?.width ?? 595, height: page?.height ?? 842 };
            const shown = blocks.filter(
              (b) =>
                b.type !== 'image' &&
                !inMargin(b, img.height) &&
                !(page?.figures?.length && insideFigure(b, page.figures)),
            );
            // the last paragraph of the previous page, for a paragraph carried over the page break
            const prevBlocks = pages[n - 1]?.blocks?.filter((b) => b.type !== 'image' && !inMargin(b, pages[n - 1]!.height)) ?? [];
            let prev: Block | undefined = prevBlocks[prevBlocks.length - 1];
            return (
              <section key={n} className="flow-page art-page" data-page-no={n}>
                <div className="art-page-mark" data-block-id={`__page_${n}`}>
                  {n}
                </div>
                {!page?.loaded && <div className="flow-empty">加载中…</div>}
                {interleave(shown, page?.figures ?? []).map((item, i) => {
                  if (isFigure(item)) {
                    prev = undefined;
                    return (
                      <figure key={`fig-${i}`} className="art-figure">
                        <img src={item.url} alt={`第 ${n} 页插图`} loading="lazy" draggable={false}
                          style={{ width: Math.min((item.bbox[2] - item.bbox[0]) * 1.3, 640) }} />
                      </figure>
                    );
                  }
                  const cont = carriesOn(prev, item);
                  prev = item;
                  return <ArticleBlock key={item.id} block={item} page={img} cont={cont} onHover={setHover} />;
                })}
              </section>
            );
          }
          return (
            <section key={n} className="flow-page" data-page-no={n}>
              <div className="flow-page-header" data-block-id={`__page_${n}`}>
                第 {n} 页
              </div>
              {!page?.loaded && <div className="flow-empty">加载中…</div>}
              {page?.loaded && blocks.length === 0 && (
                <div className="flow-empty">本页无文本块</div>
              )}
              {interleave(
                blocks.filter(
                  (b) =>
                    !(page?.figures?.length) ||
                    (b.type !== 'image' && !insideFigure(b, page.figures)),
                ),
                page?.figures ?? [],
              ).map((item, i) =>
                isFigure(item) ? (
                  <figure key={`fig-${i}`} className="flow-figure">
                    <img
                      src={item.url}
                      alt={`第 ${n} 页插图`}
                      loading="lazy"
                      draggable={false}
                      style={{ width: (item.bbox[2] - item.bbox[0]) * 1.25 }}
                    />
                  </figure>
                ) : (
                  <PairRow
                    key={item.id}
                    block={item}
                    page={{ url: page?.original, width: page?.width ?? 595, height: page?.height ?? 842 }}
                    hovered={hoverId === item.id}
                    failed={failed.has(String(item.id))}
                    onHover={setHover}
                    editMode={editMode}
                    onSave={(id, text) => void saveBlock(id, text)}
                    onSaveSentence={(b, idx, text) => void saveSentence(b, idx, text)}
                  />
                ),
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
