import { useEffect, useRef, useState } from 'react';
import { useDocStore } from '../stores/doc';
import { useViewStore } from '../stores/view';
import { Icon } from './Icon';

/**
 * Tab strip of open documents. × closes the tab (the document stays in the
 * library); the library menu reopens documents or deletes them for good.
 */
export function DocumentTabs() {
  const documents = useDocStore((s) => s.documents);
  const openIds = useDocStore((s) => s.openIds);
  const activeId = useDocStore((s) => s.activeId);
  const setActive = useDocStore((s) => s.setActive);
  const closeDocument = useDocStore((s) => s.closeDocument);
  const deleteDocument = useDocStore((s) => s.deleteDocument);
  const uploadFile = useDocStore((s) => s.uploadFile);
  const uploading = useDocStore((s) => s.uploading);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [libOpen, setLibOpen] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const libRef = useRef<HTMLDivElement>(null);
  const homeOpen = useViewStore((s) => s.homeOpen);
  const setHomeOpen = useViewStore((s) => s.setHomeOpen);
  const atHome = homeOpen || !activeId;

  const byId = new Map(documents.map((d) => [String(d.id), d]));
  const tabs = openIds.map((id) => byId.get(id)).filter((d): d is NonNullable<typeof d> => !!d);

  useEffect(() => {
    if (!libOpen) return;
    const onDown = (e: MouseEvent) => {
      if (libRef.current && !libRef.current.contains(e.target as Node)) {
        setLibOpen(false);
        setConfirmId(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setLibOpen(false);
        setConfirmId(null);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [libOpen]);

  const onPick = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const file = files[0];
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      useDocStore.setState({ error: '仅支持 PDF 文件' });
      return;
    }
    void uploadFile(file);
  };

  return (
    <div className="doc-tabs">
      <button
        type="button"
        className={`btn btn-ghost btn-sm home-tab ${atHome ? 'active' : ''}`}
        aria-pressed={atHome}
        title="首页：所有文档和上次读到的地方"
        onClick={() => {
          setHomeOpen(true);
          void useDocStore.getState().loadDocuments();
        }}
      >
        <Icon name="home" size={15} />
        首页
      </button>
      <div className="lib-menu" ref={libRef}>
        <button
          type="button"
          className={`btn btn-ghost btn-sm ${libOpen ? 'active' : ''}`}
          title="文档库：打开或删除已上传的文档"
          aria-expanded={libOpen}
          onClick={() => {
            setLibOpen(!libOpen);
            setConfirmId(null);
          }}
        >
          <Icon name="library" size={15} />
          文档库
          <span className="lib-count">{documents.length}</span>
        </button>
        {libOpen && (
          <div className="menu lib-dropdown" role="menu">
            {documents.length === 0 && <div className="menu-empty">还没有文档，拖拽 PDF 到窗口即可上传</div>}
            {documents.map((d) => {
              const id = String(d.id);
              const isOpen = openIds.includes(id);
              const confirming = confirmId === id;
              return (
                <div key={id} className={`lib-row ${String(activeId) === id ? 'current' : ''}`}>
                  <button
                    type="button"
                    className="lib-open"
                    title={isOpen ? '切换到此文档' : '打开此文档'}
                    onClick={() => {
                      setActive(id);
                      setLibOpen(false);
                    }}
                  >
                    <Icon name="page" size={14} />
                    <span className="lib-title">{d.title}</span>
                    <span className="lib-meta">
                      {d.page_count} 页{isOpen ? '，已打开' : ''}
                    </span>
                  </button>
                  {confirming ? (
                    <span className="lib-confirm">
                      <button type="button" className="btn btn-xs btn-danger" onClick={() => void deleteDocument(id)}>
                        确认删除
                      </button>
                      <button type="button" className="btn btn-xs" onClick={() => setConfirmId(null)}>
                        取消
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="icon-btn danger-hover"
                      title="永久删除（含译文、笔记、术语）"
                      aria-label={`删除 ${d.title}`}
                      onClick={() => setConfirmId(id)}
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="doc-tabs-scroll" role="tablist">
        {tabs.map((doc) => {
          const id = String(doc.id);
          return (
            <div
              key={id}
              role="tab"
              aria-selected={!homeOpen && id === String(activeId)}
              className={`doc-tab ${!homeOpen && id === String(activeId) ? 'active' : ''}`}
              onClick={() => setActive(id)}
              onAuxClick={(e) => {
                if (e.button === 1) closeDocument(id); // middle-click closes, like a browser
              }}
              title={doc.title}
            >
              <span className="doc-tab-title">{doc.title}</span>
              <button
                type="button"
                className="doc-tab-close"
                aria-label={`关闭 ${doc.title}`}
                title="关闭标签（文档仍保留在文档库）"
                onClick={(e) => {
                  e.stopPropagation();
                  closeDocument(id);
                }}
              >
                <Icon name="close" size={12} />
              </button>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        className="btn btn-ghost btn-sm doc-tab-add"
        title="上传 PDF"
        disabled={uploading}
        onClick={() => fileInputRef.current?.click()}
      >
        <Icon name="upload" size={15} />
        {uploading ? '上传中…' : '上传'}
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf,.pdf"
        style={{ display: 'none' }}
        onChange={(e) => {
          onPick(e.target.files);
          e.target.value = '';
        }}
      />
    </div>
  );
}
