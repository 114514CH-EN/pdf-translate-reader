import { useEffect, useRef, useState } from 'react';
import { useViewStore } from '../stores/view';
import type { SidebarTab } from '../types';
import { AssistantTab } from './AssistantTab';
import { NotesTab } from './NotesTab';
import { GlossaryTab } from './GlossaryTab';
import { Icon } from './Icon';

const TABS: { key: SidebarTab; label: string; icon: string }[] = [
  { key: 'assistant', label: '阅读助手', icon: 'chat' },
  { key: 'notes', label: '笔记', icon: 'note' },
  { key: 'glossary', label: '术语库', icon: 'book' },
];

const W_KEY = 'pdftr.sidebarWidth';
const MIN_W = 260;
const MAX_W = 640;

function readWidth(): number {
  try {
    const v = Number(localStorage.getItem(W_KEY));
    return v >= MIN_W && v <= MAX_W ? v : 340;
  } catch {
    return 340;
  }
}

export function Sidebar({ docId }: { docId: string | null }) {
  const open = useViewStore((s) => s.sidebarOpen);
  const tab = useViewStore((s) => s.sidebarTab);
  const setOpen = useViewStore((s) => s.setSidebarOpen);
  const setTab = useViewStore((s) => s.setSidebarTab);
  const [width, setWidth] = useState(readWidth);
  const [resizing, setResizing] = useState(false);
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    try {
      localStorage.setItem(W_KEY, String(width));
    } catch {
      /* not remembered */
    }
  }, [width]);

  // drag the left edge to resize the panel
  const onResizeStart = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    setResizing(true);
    document.body.classList.add('resizing');
    const move = (ev: PointerEvent) => {
      setWidth(Math.min(MAX_W, Math.max(MIN_W, startW + (startX - ev.clientX))));
    };
    const up = () => {
      setResizing(false);
      document.body.classList.remove('resizing');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  if (!open) {
    return (
      <aside className="sidebar collapsed" aria-label="侧边面板（已收起）">
        <button
          type="button"
          className="sidebar-rail-btn"
          title="展开侧边面板"
          aria-label="展开侧边面板"
          onClick={() => setOpen(true)}
        >
          <Icon name="panelOpen" size={16} />
        </button>
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className="sidebar-rail-btn"
            title={`打开${t.label}`}
            onClick={() => setTab(t.key)}
          >
            <Icon name={t.icon} size={16} />
            <span>{t.label}</span>
          </button>
        ))}
      </aside>
    );
  }

  return (
    <aside
      ref={ref}
      className={`sidebar open ${resizing ? 'resizing' : ''}`}
      style={{ ['--sidebar-w' as string]: `${width}px` }}
    >
      <div
        className="sidebar-resizer"
        role="separator"
        aria-orientation="vertical"
        title="拖动调整面板宽度（双击恢复默认）"
        onPointerDown={onResizeStart}
        onDoubleClick={() => setWidth(340)}
      />
      <div className="sidebar-head">
        <div className="sidebar-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              className={`sidebar-tab ${tab === t.key ? 'active' : ''}`}
              onClick={() => setTab(t.key)}
            >
              <Icon name={t.icon} size={14} />
              {t.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="icon-btn"
          title="收起侧边面板"
          aria-label="收起侧边面板"
          onClick={() => setOpen(false)}
        >
          <Icon name="panelClose" size={16} />
        </button>
      </div>
      <div className="sidebar-body">
        {!docId ? (
          <div className="empty-hint">请先上传 PDF</div>
        ) : tab === 'assistant' ? (
          <AssistantTab docId={docId} />
        ) : tab === 'notes' ? (
          <NotesTab docId={docId} />
        ) : (
          <GlossaryTab docId={docId} />
        )}
      </div>
    </aside>
  );
}
