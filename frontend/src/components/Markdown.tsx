import { useEffect, useState, type ReactNode } from 'react';

/**
 * Small, safe Markdown renderer for assistant replies (no raw HTML from the
 * model): paragraphs, #-headings, lists, > quotes, ``` code blocks, | tables |,
 * **bold**, *italic*, `code`, LaTeX math ($…$, $$…$$, \(…\), \[…\]) rendered by
 * KaTeX, and page references like [p3] which become buttons that jump there.
 */

// KaTeX (≈270 KB + fonts) is only fetched when an answer actually contains a formula
type Katex = typeof import('katex').default;
let katexLib: Katex | null = null;
let katexLoading: Promise<void> | null = null;
function loadKatex(): Promise<void> {
  katexLoading ??= Promise.all([import('katex'), import('katex/dist/katex.min.css')]).then(([m]) => {
    katexLib = m.default;
  });
  return katexLoading;
}

function TeX({ src, display }: { src: string; display: boolean }) {
  const [, setReady] = useState(katexLib !== null);
  useEffect(() => {
    let alive = true;
    if (!katexLib) void loadKatex().then(() => alive && setReady(true));
    return () => {
      alive = false;
    };
  }, []);
  if (!katexLib) return <code>{src}</code>; // for a moment, until the library arrives
  let html: string;
  try {
    html = katexLib.renderToString(src, { displayMode: display, throwOnError: false, strict: 'ignore', trust: false });
  } catch {
    return <code>{src}</code>;
  }
  return display ? (
    <div className="md-math" dangerouslySetInnerHTML={{ __html: html }} />
  ) : (
    <span className="md-math-inline" dangerouslySetInnerHTML={{ __html: html }} />
  );
}

function inline(text: string, onPage?: (n: number) => void, keyBase = ''): ReactNode[] {
  const out: ReactNode[] = [];
  const re =
    /(\$\$[^$]+\$\$|\\\((?:[^\\]|\\(?!\)))+\\\)|\$(?!\s)(?:[^$\\\n]|\\.)+?(?<!\s)\$(?!\d)|\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|\[p(\d+)(?:[-–]\d+)?\])/g;
  let last = 0;
  let k = 0;
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > last) out.push(text.slice(last, i));
    const tok = m[0];
    const key = `${keyBase}-${k++}`;
    if (tok.startsWith('$$')) out.push(<TeX key={key} src={tok.slice(2, -2)} display={false} />);
    else if (tok.startsWith('\\(')) out.push(<TeX key={key} src={tok.slice(2, -2)} display={false} />);
    else if (tok.startsWith('$')) out.push(<TeX key={key} src={tok.slice(1, -1)} display={false} />);
    else if (tok.startsWith('**')) out.push(<strong key={key}>{inline(tok.slice(2, -2), onPage, key)}</strong>);
    else if (tok.startsWith('`')) out.push(<code key={key}>{tok.slice(1, -1)}</code>);
    else if (tok.startsWith('[p') && m[2]) {
      const n = Number(m[2]);
      out.push(
        <button key={key} type="button" className="page-ref" title={`跳到第 ${n} 页`} onClick={() => onPage?.(n)}>
          {tok.slice(1, -1)}
        </button>,
      );
    } else out.push(<em key={key}>{tok.slice(1, -1)}</em>);
    last = i + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const isTableSep = (l: string) => /^\s*\|?[\s:|-]+\|?\s*$/.test(l) && l.includes('-');
const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

export function Markdown({ text, onPage }: { text: string; onPage?: (n: number) => void }) {
  const lines = text.replace(/\r/g, '').split('\n');
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let para: string[] = [];
  let quote: string[] = [];
  const key = () => `b${blocks.length}`;
  const flushPara = () => {
    if (para.length) {
      blocks.push(<p key={key()}>{inline(para.join('\n'), onPage, key())}</p>);
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      const k = key();
      const items = list.items.map((it, i) => <li key={i}>{inline(it, onPage, `${k}-${i}`)}</li>);
      blocks.push(list.ordered ? <ol key={k}>{items}</ol> : <ul key={k}>{items}</ul>);
      list = null;
    }
  };
  const flushQuote = () => {
    if (quote.length) {
      blocks.push(<blockquote key={key()}>{inline(quote.join('\n'), onPage, key())}</blockquote>);
      quote = [];
    }
  };
  const flushAll = () => {
    flushPara();
    flushList();
    flushQuote();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    // display math: $$ … $$ / \[ … \] (possibly over several lines)
    const dm = /^\s*(\$\$|\\\[)(.*)$/.exec(line);
    if (dm) {
      const close = dm[1] === '$$' ? '$$' : '\\]';
      let body = dm[2];
      let j = i;
      while (!body.includes(close) && j + 1 < lines.length) body += '\n' + lines[++j];
      const end = body.indexOf(close);
      if (end >= 0) {
        flushAll();
        blocks.push(<TeX key={key()} src={body.slice(0, end)} display />);
        const rest = body.slice(end + close.length).trim();
        if (rest) para.push(rest);
        i = j;
        continue;
      }
    }
    // fenced code
    if (/^\s*```/.test(line)) {
      flushAll();
      const code: string[] = [];
      while (i + 1 < lines.length && !/^\s*```/.test(lines[i + 1])) code.push(lines[++i]);
      i++;
      blocks.push(
        <pre key={key()} className="md-code">
          <code>{code.join('\n')}</code>
        </pre>,
      );
      continue;
    }
    // table
    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flushAll();
      const head = cells(line);
      const rows: string[][] = [];
      i++;
      while (i + 1 < lines.length && isTableRow(lines[i + 1])) rows.push(cells(lines[++i]));
      const k = key();
      blocks.push(
        <table key={k} className="md-table">
          <thead>
            <tr>{head.map((c, j) => <th key={j}>{inline(c, onPage, `${k}h${j}`)}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri}>{r.map((c, j) => <td key={j}>{inline(c, onPage, `${k}-${ri}-${j}`)}</td>)}</tr>
            ))}
          </tbody>
        </table>,
      );
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    const ul = /^\s*[-*•]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const q = /^\s*>\s?(.*)$/.exec(line);
    if (!line.trim()) {
      flushAll();
    } else if (q) {
      flushPara();
      flushList();
      quote.push(q[1]);
    } else if (h) {
      flushAll();
      blocks.push(<h4 key={key()}>{inline(h[2], onPage, key())}</h4>);
    } else if (ul || ol) {
      flushPara();
      flushQuote();
      const ordered = !!ol;
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push((ul ?? ol)![1]);
    } else {
      flushList();
      flushQuote();
      para.push(line);
    }
  }
  flushAll();
  return <div className="md">{blocks}</div>;
}
