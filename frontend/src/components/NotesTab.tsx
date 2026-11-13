import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import { useHighlightStore } from '../stores/highlights';
import { useViewStore } from '../stores/view';
import type { Highlight, Note } from '../types';

function errMsg(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

/** "今天 14:05" / "11-03 09:20" / "2025-12-01" — short enough for the narrow panel */
function shortTime(v: string): string {
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(v) || !v.includes(' ') ? v : v.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return v;
  const p2 = (n: number) => String(n).padStart(2, '0');
  const now = new Date();
  const hm = `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return `今天 ${hm}`;
  if (d.getFullYear() === now.getFullYear()) return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${hm}`;
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

export function NotesTab({ docId }: { docId: string }) {
  const toast = useViewStore((s) => s.toast);
  const currentPage = useViewStore((s) => s.currentPage);
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState('');
  const [anchorPage, setAnchorPage] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');
  const [filter, setFilter] = useState<'all' | 'hl' | 'note'>('all');
  const highlights = useHighlightStore((s) => s.items);
  const updateHighlight = useHighlightStore((s) => s.update);
  const removeHighlight = useHighlightStore((s) => s.remove);
  const setActiveHl = useHighlightStore((s) => s.setActive);
  const requestPageNav = useViewStore((s) => s.requestPageNav);
  const [hlEditing, setHlEditing] = useState<number | null>(null);
  const [hlText, setHlText] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await api.listNotes(docId);
      setNotes(rows);
    } catch (e) {
      toast(`加载笔记失败：${errMsg(e)}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [docId, toast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const addNote = async () => {
    const content = draft.trim();
    if (!content) return;
    try {
      await api.createNote({
        doc_id: docId,
        page_no: anchorPage ? currentPage : null,
        content,
      });
      setDraft('');
      await refresh();
      toast('笔记已添加', 'success');
    } catch (e) {
      toast(`添加笔记失败：${errMsg(e)}`, 'error');
    }
  };

  const saveEdit = async (id: string) => {
    try {
      await api.updateNote(id, { content: editingText });
      setEditingId(null);
      await refresh();
    } catch (e) {
      toast(`保存笔记失败：${errMsg(e)}`, 'error');
    }
  };

  const remove = async (id: string) => {
    try {
      await api.deleteNote(id);
      await refresh();
    } catch (e) {
      toast(`删除笔记失败：${errMsg(e)}`, 'error');
    }
  };

  return (
    <div className="notes-tab">
      <div className="notes-compose">
        <textarea
          className="notes-input"
          rows={3}
          placeholder="记点什么…（Ctrl+Enter 添加）"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && draft.trim()) {
              e.preventDefault();
              void addNote();
            }
          }}
        />
        <div className="notes-compose-row">
          <label className="check-label">
            <input
              type="checkbox"
              checked={anchorPage}
              onChange={(e) => setAnchorPage(e.target.checked)}
            />
            关联第 {currentPage} 页
          </label>
          <button type="button" className="btn btn-primary" disabled={!draft.trim()} onClick={() => void addNote()}>
            添加
          </button>
        </div>
      </div>
      <div className="notes-filter" role="tablist">
        {(
          [
            ['all', `全部 ${notes.length + highlights.length}`],
            ['hl', `高亮 ${highlights.length}`],
            ['note', `笔记 ${notes.length}`],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={filter === id}
            className={`chip chip-sm ${filter === id ? 'active' : ''}`}
            onClick={() => setFilter(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="notes-list">
        {loading && <div className="empty-hint">加载中…</div>}
        {!loading && notes.length === 0 && highlights.length === 0 && (
          <div className="empty-hint">
            暂无笔记
            <div className="empty-sub">在原文或译文里选中文字，可以用彩色高亮标记并写笔记</div>
          </div>
        )}
        {filter !== 'note' &&
          [...highlights]
            .sort((a, b) => a.page_no - b.page_no || (a.rects[0]?.[1] ?? 0) - (b.rects[0]?.[1] ?? 0))
            .map((h: Highlight) => (
              <div key={`h${h.id}`} className={`note-item hl-item hl-border-${h.color}`}>
                <div className="note-meta">
                  <button
                    type="button"
                    className="badge badge-btn"
                    title="跳到这里"
                    onClick={() => {
                      requestPageNav(h.page_no, Math.max(0, (h.rects[0]?.[1] ?? 0) - 60) / 842);
                      setActiveHl(h.id);
                    }}
                  >
                    {h.pane === 'src' ? '原文' : '译文'}第 {h.page_no} 页
                  </button>
                </div>
                <div className="hl-quote">“{h.text.length > 220 ? h.text.slice(0, 220) + '…' : h.text}”</div>
                {hlEditing === h.id ? (
                  <>
                    <textarea className="notes-input" rows={3} autoFocus value={hlText} onChange={(e) => setHlText(e.target.value)} />
                    <div className="note-actions">
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => {
                          void updateHighlight(h.id, { note: hlText });
                          setHlEditing(null);
                        }}
                      >
                        保存
                      </button>
                      <button type="button" className="btn btn-sm" onClick={() => setHlEditing(null)}>
                        取消
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    {h.note && <div className="note-content">{h.note}</div>}
                    <div className="note-actions">
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => {
                          setHlEditing(h.id);
                          setHlText(h.note);
                        }}
                      >
                        {h.note ? '编辑笔记' : '写笔记'}
                      </button>
                      <button type="button" className="btn btn-sm" onClick={() => void removeHighlight(h.id)}>
                        删除
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))}
        {filter !== 'hl' && notes.map((n) => (
          <div key={n.id} className="note-item">
            <div className="note-meta">
              {n.page_no != null ? <span className="badge">第 {n.page_no} 页</span> : <span className="badge">全局</span>}
              <span className="note-time">{shortTime(n.updated_at || n.created_at)}</span>
            </div>
            {editingId === n.id ? (
              <>
                <textarea
                  className="notes-input"
                  rows={3}
                  value={editingText}
                  onChange={(e) => setEditingText(e.target.value)}
                />
                <div className="note-actions">
                  <button type="button" className="btn btn-sm" onClick={() => void saveEdit(n.id)}>
                    保存
                  </button>
                  <button type="button" className="btn btn-sm" onClick={() => setEditingId(null)}>
                    取消
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="note-content">{n.content}</div>
                <div className="note-actions">
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                      setEditingId(n.id);
                      setEditingText(n.content);
                    }}
                  >
                    编辑
                  </button>
                  <button type="button" className="btn btn-sm" onClick={() => void remove(n.id)}>
                    删除
                  </button>
                </div>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
