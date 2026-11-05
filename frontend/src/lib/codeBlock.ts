import type { BlockMeta } from '../types';

/**
 * Code listings (block.type === 'code'): only the comments are translated.
 * Mirrors backend/app/services/code_blocks.py — the translation keeps every
 * line with its code part unchanged, so line i's comment starts at the same
 * character index `ci` as in the source.
 */

const HEAD = /^(%+|\/\/+|#+)\s?/;

export function splitCodeLine(line: string, ci: number | null | undefined): { code: string; head: string; comment: string } {
  if (ci == null || ci >= line.length) return { code: line, head: '', comment: '' };
  const code = line.slice(0, ci);
  const rest = line.slice(ci);
  const m = HEAD.exec(rest);
  const head = m ? m[0] : '';
  return { code, head, comment: rest.slice(head.length).trim() };
}

/** The translation still lines up with the listing (same lines, same code parts). */
export function codeTranslationFits(text: string, translation: string | null | undefined, meta: BlockMeta | null | undefined): boolean {
  const lines = meta?.code?.lines;
  if (!translation || !lines) return false;
  const src = text.split('\n');
  const tgt = translation.split('\n');
  if (src.length !== tgt.length || lines.length !== src.length) return false;
  return src.every((s, i) => {
    const ci = lines[i].ci;
    if (ci == null) return s.trimEnd() === tgt[i].trimEnd();
    return tgt[i].slice(0, ci).trimEnd() === s.slice(0, ci).trimEnd();
  });
}

/** Rough rendered width in em: CJK / full-width characters are 1em, the rest ~0.55em. */
export function emWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += /[⺀-鿿가-힯豈-﫿＀-￯　-〿]/.test(ch) ? 1 : 0.55;
  return w;
}
