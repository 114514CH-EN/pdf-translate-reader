import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api/client';
import { useDocStore } from '../stores/doc';
import { useViewStore } from '../stores/view';
import type { PaperInfo } from '../types';
import { Icon } from './Icon';

function authorsLine(a: string[]): string {
  if (a.length <= 3) return a.join(', ');
  return `${a.slice(0, 3).join(', ')} 等 ${a.length} 人`;
}

function paperKey(p: PaperInfo, i: number): string {
  return p.doi || p.arxiv || p.pdf_url || `${p.title}-${i}`;
}

/** 找论文: an arXiv id, a DOI, a link or a title → papers with a free PDF can be imported in one click. */
export function PaperSearch() {
  const { open, query, seq } = useViewStore((s) => s.paperSearch);
  const close = useViewStore((s) => s.closePaperSearch);
  const importPaper = useDocStore((s) => s.importPaper);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<PaperInfo[] | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const run = async (text: string) => {
    const t = text.trim();
    if (!t) return;
    abortRef.current?.abort();
    const ctl = new AbortController();
    abortRef.current = ctl;
    setBusy(true);
    setError(null);
    try {
      const r = await api.searchPapers(t, ctl.signal);
      if (ctl.signal.aborted) return;
      setResults(r.results);
    } catch (e) {
      if (ctl.signal.aborted) return;
      setResults(null);
      setError(e instanceof ApiError || e instanceof Error ? e.message : String(e));
    } finally {
      if (!ctl.signal.aborted) setBusy(false);
    }
  };

  // opened (again): start from what was asked for, e.g. a reference clicked in the text
  useEffect(() => {
    if (!open) return;
    setQ(query);
    setResults(null);
    setError(null);
    setExpanded(null);
    window.setTimeout(() => inputRef.current?.focus(), 30);
    if (query) void run(query);
    return () => abortRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, seq]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !importing) close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, importing, close]);

  if (!open) return null;

  const doImport = async (p: PaperInfo, key: string) => {
    setImporting(key);
    setError(null);
    try {
      await importPaper(p);
      close();
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(null);
    }
  };

  return (
    <div className="modal-backdrop" onClick={() => !importing && close()}>
      <div className="modal paper-modal" role="dialog" aria-label="找论文" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>找论文</h2>
          <button type="button" className="btn btn-icon" aria-label="关闭" disabled={!!importing} onClick={close}>
            ×
          </button>
        </div>
        <div className="modal-body paper-body">
          <form
            className="paper-form"
            onSubmit={(e) => {
              e.preventDefault();
              void run(q);
            }}
          >
            <input
              ref={inputRef}
              type="text"
              value={q}
              placeholder="arXiv 编号、DOI、论文链接，或标题关键词"
              aria-label="要找的论文"
              onChange={(e) => setQ(e.target.value)}
            />
            <button type="submit" className="btn btn-primary" disabled={busy || !q.trim()}>
              <Icon name="search" size={15} />
              {busy ? '查找中…' : '查找'}
            </button>
          </form>
          {!results && !error && !busy && (
            <p className="fieldset-hint">
              例如 <code>1706.03762</code>、<code>10.1145/3065386</code>、一个 PDF 链接，或论文标题。
              有免费全文（arXiv、开放获取期刊）的论文可以一键导入；需要订阅的论文，请在出版社网站下载 PDF 后拖进来。
            </p>
          )}
          {error && (
            <div className="paper-error" role="alert">
              {error}
            </div>
          )}
          {results && results.length === 0 && <p className="fieldset-hint">没有找到。换个关键词，或直接粘贴 DOI / arXiv 编号试试。</p>}
          {results && results.length > 0 && (
            <ul className="paper-list">
              {results.map((p, i) => {
                const key = paperKey(p, i);
                const meta = [p.year, p.venue].filter(Boolean).join(' · ');
                return (
                  <li key={key} className="paper-item">
                    <div className="paper-main">
                      <div className="paper-title">{p.title || '（无标题）'}</div>
                      {p.authors.length > 0 && <div className="paper-authors">{authorsLine(p.authors)}</div>}
                      {(meta || p.doi || p.arxiv) && (
                        <div className="paper-meta">
                          {meta}
                          {p.arxiv && <span className="paper-id">arXiv {p.arxiv}</span>}
                          {p.doi && !p.doi.toLowerCase().startsWith('10.48550/') && (
                            <span className="paper-id">DOI {p.doi}</span>
                          )}
                        </div>
                      )}
                      {p.abstract && (
                        <button
                          type="button"
                          className={`paper-abstract ${expanded === key ? 'open' : ''}`}
                          aria-expanded={expanded === key}
                          onClick={() => setExpanded(expanded === key ? null : key)}
                        >
                          {p.abstract}
                        </button>
                      )}
                    </div>
                    <div className="paper-act">
                      {p.pdf_url || p.arxiv ? (
                        <button
                          type="button"
                          className="btn btn-sm btn-primary"
                          disabled={!!importing}
                          onClick={() => void doImport(p, key)}
                        >
                          {importing === key ? '下载中…' : '下载并导入'}
                        </button>
                      ) : (
                        <span className="paper-closed" title="没有找到可以免费下载的 PDF">
                          无免费全文
                        </span>
                      )}
                      {p.landing_url && (
                        <a className="link-btn paper-link" href={p.landing_url} target="_blank" rel="noreferrer">
                          打开网页
                        </a>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className="modal-foot paper-foot">
          <span className="fieldset-hint">论文信息来自 OpenAlex 和 arXiv</span>
        </div>
      </div>
    </div>
  );
}
