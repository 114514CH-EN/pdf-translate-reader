import { useEffect, useRef, useState } from 'react';
import { useViewStore } from '../stores/view';
import type { DocumentRow } from '../types';
import { useDocStore } from '../stores/doc';
import { Icon } from './Icon';
import { withTransition } from '../lib/transition';

/**
 * What the window shows when no document is open: the library as cards to pick up
 * where you left off, or — the very first time — how to start.
 *
 * (It used to be two grey panes saying 「请先上传 PDF」 three times.)
 */
type Sort = 'recent' | 'name' | 'progress' | 'pages';

/** "今天" / "昨天" / "3 天前" / "2026-10-02" — when a document was last opened (the server keeps UTC) */
function ago(v: string | null): string {
  if (!v) return '还没打开过';
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(v) || !v.includes(' ') ? v : v.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return '';
  const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86_400_000);
  if (days <= 0) return '今天打开过';
  if (days === 1) return '昨天打开过';
  if (days < 30) return `${days} 天前打开过`;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} 打开过`;
}

export default function HomeView() {
  const documents = useDocStore((s) => s.documents);
  const openDocument = useDocStore((s) => s.openDocument);
  const uploadFile = useDocStore((s) => s.uploadFile);
  const uploading = useDocStore((s) => s.uploading);
  const fileRef = useRef<HTMLInputElement>(null);
  const setHomeOpen = useViewStore((s) => s.setHomeOpen);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('recent');
  // 悬停预览: rest the pointer on a card for a moment and it comes forward with more to see
  const [peek, setPeek] = useState<{ id: string; x: number; y: number; w: number } | null>(null);
  const peekTimer = useRef(0);
  const armPeek = (id: string, el: HTMLElement) => {
    window.clearTimeout(peekTimer.current);
    peekTimer.current = window.setTimeout(() => {
      const r = el.getBoundingClientRect();
      setPeek({ id, x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width });
    }, 480);
  };
  const dropPeek = (soon = true) => {
    window.clearTimeout(peekTimer.current);
    if (soon) peekTimer.current = window.setTimeout(() => setPeek(null), 120);
    else setPeek(null);
  };
  useEffect(() => () => window.clearTimeout(peekTimer.current), []);

  const pick = () => fileRef.current?.click();
  const newBlank = () => {
    const d = new Date();
    const title = `新文档 ${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    useViewStore.getState().setHomeOpen(false);
    void useDocStore.getState().createBlank(title);
  };
  const input = (
    <input
      ref={fileRef}
      type="file"
      accept=".pdf,application/pdf"
      multiple
      hidden
      onChange={(e) => {
        for (const f of Array.from(e.target.files ?? [])) void uploadFile(f);
        e.target.value = '';
      }}
    />
  );

  if (documents.length === 0) {
    return (
      <div className="home">
        {input}
        <div className="home-start">
          <button type="button" className="home-drop" onClick={pick} disabled={uploading}>
            <span className="home-drop-icon">
              <Icon name="upload" size={26} />
            </span>
            <span className="home-drop-title">{uploading ? '正在上传…' : '把 PDF 拖到这里'}</span>
            <span className="home-drop-sub">或者点击选择文件</span>
          </button>
          <button type="button" className="btn home-blank" onClick={newBlank} disabled={uploading}>
            <Icon name="docPlus" size={15} />
            或者从一张空白页开始，自己写一份
          </button>
          <ol className="home-steps">
            <li>上传一份 PDF（论文、课件、手册都可以）</li>
            <li>在 ⚙ 设置里填好翻译 API，点「翻译全文」</li>
            <li>左边原文、右边译文，版式一致，对照着读</li>
          </ol>
        </div>
      </div>
    );
  }

  const state = (d: DocumentRow) => {
    const total = d.blocks_total ?? 0;
    const pct = total > 0 ? Math.round(((d.blocks_done ?? 0) / total) * 100) : 0;
    const label = total === 0 ? '无文字' : pct >= 100 ? '已译完' : pct > 0 ? `已译 ${pct}%` : '未翻译';
    return { pct, label };
  };
  const thumb = (d: DocumentRow, page = 1) => `/api/documents/${encodeURIComponent(d.id)}/pages/${page}/original.png`;
  const go = (d: DocumentRow) => {
    dropPeek(false);
    withTransition(() => {
      setHomeOpen(false);
      void openDocument(String(d.id));
    });
  };

  // the list arrives most-recently-opened first: the first one is where the reader left off
  const current = documents[0];
  const at = Math.min(Math.max(current.last_page ?? 1, 1), current.page_count || 1);
  const started = !!current.last_opened_at;
  const cur = state(current);

  const q = query.trim().toLowerCase();
  const rest = documents
    .filter((d) => !q || d.title.toLowerCase().includes(q))
    .sort((a, b) => {
      if (sort === 'name') return a.title.localeCompare(b.title, 'zh');
      if (sort === 'progress') return state(b).pct - state(a).pct;
      if (sort === 'pages') return b.page_count - a.page_count;
      return 0; // recent: the order the server gave
    });

  return (
    <div className="home">
      {input}
      <div className="home-inner">
        {/* one thing in front: the document being read, shown at the page it was left on */}
        <section className="home-now" aria-label="继续阅读">
          <button type="button" className="home-now-sheet" onClick={() => go(current)} title={`打开 ${current.title}`}>
            <img src={thumb(current, at)} alt="" draggable={false} />
          </button>
          <div className="home-now-body">
            <div className="home-now-kicker">{!started ? '刚添加' : at > 1 ? '上次读到' : '最近打开'}</div>
            <h1 className="home-now-title">{current.title}</h1>
            <div className="home-now-meta">
              <span>
                第 {at} 页，共 {current.page_count} 页
              </span>
              <span>{cur.label}</span>
            </div>
            <div className="home-now-bar" aria-hidden="true">
              <span style={{ width: `${(at / Math.max(current.page_count, 1)) * 100}%` }} />
            </div>
            <div className="home-now-actions">
              <button type="button" className="btn btn-primary home-now-go" onClick={() => go(current)}>
                {at > 1 ? '继续阅读' : '开始阅读'}
              </button>
              <button type="button" className="btn" onClick={pick} disabled={uploading}>
                <Icon name="upload" size={15} />
                {uploading ? '正在上传…' : '添加 PDF'}
              </button>
              <button type="button" className="btn" onClick={newBlank} disabled={uploading} title="从一张空白页开始，自己写一份 PDF">
                <Icon name="docPlus" size={15} />
                新建空白文档
              </button>
            </div>
          </div>
        </section>

        <section className="home-lib" aria-label="全部文档">
          <div className="home-head">
            <h2 className="home-title">全部文档</h2>
            <span className="home-count">{q ? `${rest.length} / ${documents.length}` : documents.length} 份</span>
            <span className="home-head-gap" />
            <label className="home-search">
              <Icon name="search" size={13} />
              <input
                placeholder="按名称找…"
                aria-label="按名称找文档"
                spellCheck={false}
                autoComplete="off"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <select className="home-sort" aria-label="排序" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
              <option value="recent">最近打开</option>
              <option value="name">名称</option>
              <option value="progress">翻译进度</option>
              <option value="pages">页数</option>
            </select>
          </div>
          <div className="home-grid">
            {rest.map((d) => {
              const st = state(d);
              const page = Math.min(Math.max(d.last_page ?? 1, 1), d.page_count || 1);
              return (
                <button
                  key={d.id}
                  type="button"
                  className="home-card"
                  onClick={() => go(d)}
                  onMouseEnter={(e) => armPeek(String(d.id), e.currentTarget)}
                  onMouseLeave={() => dropPeek()}
                >
                  <span className="home-thumb">
                    <img src={thumb(d)} alt="" loading="lazy" draggable={false} />
                    {/* what you get by opening it, shown when the card is pointed at */}
                    <span className="home-thumb-note">{page > 1 ? `读到第 ${page} 页` : '从头开始读'}</span>
                  </span>
                  <span className="home-card-title">{d.title}</span>
                  <span className="home-card-meta">
                    <span>{d.page_count} 页</span>
                    <span>{st.label}</span>
                  </span>
                  <span className="home-card-bar" aria-hidden="true">
                    <span style={{ width: `${st.pct}%` }} />
                  </span>
                </button>
              );
            })}
            {!q && (
              <button type="button" className="home-card home-add" onClick={pick} disabled={uploading}>
                <span className="home-thumb">
                  <Icon name="plus" size={26} />
                </span>
                <span className="home-card-title">{uploading ? '正在上传…' : '添加 PDF'}</span>
                <span className="home-card-meta">点击选择，或拖到窗口里</span>
              </button>
            )}
          </div>
          {q && rest.length === 0 && <div className="empty-hint">没有名称里带「{query.trim()}」的文档</div>}
        </section>
      </div>
      {(() => {
        const d = peek && documents.find((x) => String(x.id) === peek.id);
        if (!peek || !d) return null;
        const st = state(d);
        const page = Math.min(Math.max(d.last_page ?? 1, 1), d.page_count || 1);
        const w = Math.max(300, Math.round(peek.w * 1.55));
        const left = Math.min(Math.max(12, peek.x - w / 2), window.innerWidth - w - 12);
        const h = w * 0.78 + 150;
        const top = Math.min(Math.max(12, peek.y - h / 2), window.innerHeight - h - 12);
        return (
          <div
            className="home-peek"
            style={{ left, top, width: w }}
            onMouseEnter={() => window.clearTimeout(peekTimer.current)}
            onMouseLeave={() => dropPeek()}
          >
            <button type="button" className="home-peek-sheet" onClick={() => go(d)} aria-label={`打开 ${d.title}`}>
              <img src={thumb(d, page)} alt="" draggable={false} />
            </button>
            <div className="home-peek-body">
              <div className="home-peek-title">{d.title}</div>
              <div className="home-peek-meta">
                <span>{page > 1 ? `读到第 ${page} 页，共 ${d.page_count} 页` : `共 ${d.page_count} 页`}</span>
                <span>{st.label}</span>
                <span>{ago(d.last_opened_at)}</span>
              </div>
              <div className="home-peek-actions">
                <button type="button" className="btn btn-primary btn-sm" onClick={() => go(d)}>
                  {page > 1 ? '继续阅读' : '开始阅读'}
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
