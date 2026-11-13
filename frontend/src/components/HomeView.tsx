import { useRef, useState } from 'react';
import { useViewStore } from '../stores/view';
import type { DocumentRow } from '../types';
import { useDocStore } from '../stores/doc';
import { Icon } from './Icon';

/**
 * What the window shows when no document is open: the library as cards to pick up
 * where you left off, or — the very first time — how to start.
 *
 * (It used to be two grey panes saying 「请先上传 PDF」 three times.)
 */
type Sort = 'recent' | 'name' | 'progress' | 'pages';

export default function HomeView() {
  const documents = useDocStore((s) => s.documents);
  const openDocument = useDocStore((s) => s.openDocument);
  const uploadFile = useDocStore((s) => s.uploadFile);
  const uploading = useDocStore((s) => s.uploading);
  const fileRef = useRef<HTMLInputElement>(null);
  const setHomeOpen = useViewStore((s) => s.setHomeOpen);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('recent');

  const pick = () => fileRef.current?.click();
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
    setHomeOpen(false);
    void openDocument(String(d.id));
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
                <button key={d.id} type="button" className="home-card" onClick={() => go(d)} title={d.title}>
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
    </div>
  );
}
