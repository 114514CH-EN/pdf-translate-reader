import { useRef } from 'react';
import { useDocStore } from '../stores/doc';
import { Icon } from './Icon';

/**
 * What the window shows when no document is open: the library as cards to pick up
 * where you left off, or — the very first time — how to start.
 *
 * (It used to be two grey panes saying 「请先上传 PDF」 three times.)
 */
export default function HomeView() {
  const documents = useDocStore((s) => s.documents);
  const openDocument = useDocStore((s) => s.openDocument);
  const uploadFile = useDocStore((s) => s.uploadFile);
  const uploading = useDocStore((s) => s.uploading);
  const fileRef = useRef<HTMLInputElement>(null);

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

  return (
    <div className="home">
      {input}
      <div className="home-inner">
        <div className="home-head">
          <h1 className="home-title">继续阅读</h1>
          <span className="home-count">{documents.length} 份文档</span>
        </div>
        <div className="home-grid">
          {documents.map((d) => {
            const total = d.blocks_total ?? 0;
            const pct = total > 0 ? Math.round(((d.blocks_done ?? 0) / total) * 100) : 0;
            return (
              <button key={d.id} type="button" className="home-card" onClick={() => void openDocument(d.id)} title={d.title}>
                <span className="home-thumb">
                  <img src={`/api/documents/${encodeURIComponent(d.id)}/pages/1/original.png`} alt="" loading="lazy" draggable={false} />
                </span>
                <span className="home-card-title">{d.title}</span>
                <span className="home-card-meta">
                  {d.page_count} 页 · {total === 0 ? '无文字' : pct >= 100 ? '已译完' : pct > 0 ? `已译 ${pct}%` : '未翻译'}
                </span>
                <span className="home-card-bar" aria-hidden="true">
                  <span style={{ width: `${pct}%` }} />
                </span>
              </button>
            );
          })}
          <button type="button" className="home-card home-add" onClick={pick} disabled={uploading}>
            <span className="home-thumb">
              <Icon name="plus" size={26} />
            </span>
            <span className="home-card-title">{uploading ? '正在上传…' : '添加 PDF'}</span>
            <span className="home-card-meta">点击选择，或拖到窗口里</span>
          </button>
        </div>
      </div>
    </div>
  );
}
