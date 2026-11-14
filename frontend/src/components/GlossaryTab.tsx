import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api/client';
import { useTranslationStore } from '../stores/translation';
import { useViewStore } from '../stores/view';
import type { GlossaryTerm } from '../types';
import { Icon } from './Icon';

function errMsg(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

const STATUS_OPTIONS = [
  { value: 'proposed', label: '待定' },
  { value: 'approved', label: '已采用' },
  { value: 'rejected', label: '已拒绝' },
];

export function GlossaryTab({ docId }: { docId: string }) {
  const toast = useViewStore((s) => s.toast);
  const job = useTranslationStore((s) => s.job);
  const [terms, setTerms] = useState<GlossaryTerm[]>([]);
  const [loading, setLoading] = useState(false);
  const [newSrc, setNewSrc] = useState('');
  const [newTgt, setNewTgt] = useState('');
  const [newNote, setNewNote] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const [importGlobal, setImportGlobal] = useState(false);
  const [filter, setFilter] = useState('');
  // 全选: ticked terms, changed or deleted together
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [confirmDel, setConfirmDel] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await api.listGlossary(docId);
      setTerms(rows);
    } catch (e) {
      toast(`加载术语库失败：${errMsg(e)}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [docId, toast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // a different document: start with nothing ticked
  useEffect(() => {
    setPicked(new Set());
    setConfirmDel(false);
  }, [docId]);

  // terms added from the selection toolbar
  useEffect(() => {
    const on = () => void refresh();
    window.addEventListener('pdftr:glossary-changed', on);
    return () => window.removeEventListener('pdftr:glossary-changed', on);
  }, [refresh]);

  // after an extract job completes, refresh the table
  useEffect(() => {
    if (job && job.status === 'done' && (job.kind === 'extract' || job.kind === 'extract_terms')) {
      void refresh();
    }
  }, [job, refresh]);

  const addRow = async () => {
    const src = newSrc.trim();
    const tgt = newTgt.trim();
    if (!src || !tgt) {
      toast('请填写源术语和目标译法', 'error');
      return;
    }
    try {
      await api.createGlossary({
        doc_id: docId,
        src_term: src,
        tgt_term: tgt,
        note: newNote.trim() || undefined,
        status: 'proposed',
      });
      setNewSrc('');
      setNewTgt('');
      setNewNote('');
      await refresh();
    } catch (e) {
      toast(`添加术语失败：${errMsg(e)}`, 'error');
    }
  };

  const patch = async (
    id: string,
    body: Partial<Pick<GlossaryTerm, 'src_term' | 'tgt_term' | 'note' | 'status'>> & { scope?: 'global' | 'doc'; doc_id?: string },
  ) => {
    // the row changes at once; the server catches up, and a refusal puts the old row back
    const before = terms;
    setTerms((rows) => rows.map((t) => (t.id === id ? ({ ...t, ...body } as GlossaryTerm) : t)));
    try {
      await api.updateGlossary(id, body);
      await refresh();
    } catch (e) {
      setTerms(before);
      toast(`更新术语失败：${errMsg(e)}`, 'error');
    }
  };

  const remove = async (id: string) => {
    const before = terms;
    setTerms((rows) => rows.filter((t) => t.id !== id));
    try {
      await api.deleteGlossary(id);
    } catch (e) {
      setTerms(before);
      toast(`删除术语失败：${errMsg(e)}`, 'error');
    }
  };

  const batch = async (
    change: { status: string } | { scope: 'global' } | { scope: 'doc'; doc_id: string } | { delete: true },
    done: string,
  ) => {
    const ids = [...picked];
    if (!ids.length || busy) return;
    setBusy(true);
    try {
      const { changed } = await api.batchGlossary(ids, change);
      if ('delete' in change) setPicked(new Set());
      setConfirmDel(false);
      await refresh();
      toast(`${done} ${changed} 个术语`, 'success');
    } catch (e) {
      toast(`批量操作失败：${errMsg(e)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const importCsv = async (file: File) => {
    try {
      await api.importGlossary(file, docId, importGlobal ? 'global' : 'doc');
      await refresh();
      toast('导入成功', 'success');
    } catch (e) {
      toast(`导入失败：${errMsg(e)}`, 'error');
    }
  };

  const exportCsv = async () => {
    try {
      await api.exportGlossary(docId, 'glossary.csv');
    } catch (e) {
      toast(`导出失败：${errMsg(e)}`, 'error');
    }
  };

  const extract = async () => {
    try {
      const { job_id } = await api.extractTerms(docId);
      useTranslationStore.getState().setJob({
        id: job_id,
        kind: 'extract',
        status: 'running',
        total: 0,
        done: 0,
        failed: 0,
        params: { doc_id: docId },
      });
      toast('术语提取已开始');
    } catch (e) {
      toast(`提取术语失败：${errMsg(e)}`, 'error');
    }
  };

  const ORIGIN: Record<string, string> = { manual: '手动', extract: '提取', extracted: '提取', import: '导入', csv: '导入', selection: '划词' };
  const f = filter.trim().toLowerCase();
  // in the order they were added: a card stays where it is when it is made global or its status changes
  const shown = terms
    .filter((t) => !f || t.src_term.toLowerCase().includes(f) || t.tgt_term.toLowerCase().includes(f))
    .sort((a, b) => Number(a.id) - Number(b.id));
  const approved = terms.filter((t) => t.status === 'approved').length;
  // a ticked term that has since gone (deleted, or another document's list) no longer counts
  const live = new Set(terms.map((t) => t.id));
  const pickedIds = [...picked].filter((id) => live.has(id));
  const shownPicked = shown.filter((t) => picked.has(t.id)).length;
  const allShown = shown.length > 0 && shownPicked === shown.length;
  const toggleAll = () =>
    setPicked((cur) => {
      const next = new Set(cur);
      // 全选 works on what the filter shows; a second press clears those again
      for (const t of shown) {
        if (allShown) next.delete(t.id);
        else next.add(t.id);
      }
      return next;
    });
  const togglePick = (id: string) =>
    setPicked((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="glossary-tab">
      <div className="glossary-head">
        <label className="glossary-search">
          <Icon name="search" size={13} />
          <input placeholder="筛选术语…" spellCheck={false} autoComplete="off" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="筛选术语" />
        </label>
        <button type="button" className="btn btn-sm" title="让模型从这份文档里找出专业术语" onClick={() => void extract()}>
          提取术语
        </button>
      </div>
      <div className="glossary-io">
        <button type="button" className="link-btn" onClick={() => fileRef.current?.click()}>
          导入 CSV
        </button>
        <button type="button" className="link-btn" onClick={() => void exportCsv()}>
          导出 CSV
        </button>
        <label className="glossary-check" title="导入的术语对所有文档生效">
          <input type="checkbox" checked={importGlobal} onChange={(e) => setImportGlobal(e.target.checked)} />
          导入为全局
        </label>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void importCsv(file);
            e.target.value = '';
          }}
        />
      </div>

      <form
        className="glossary-new"
        onSubmit={(e) => {
          e.preventDefault();
          void addRow();
        }}
      >
        <div className="term-pair">
          <input className="cell-input" placeholder="源术语" spellCheck={false} autoComplete="off" value={newSrc} onChange={(e) => setNewSrc(e.target.value)} />
          <Icon name="next" size={12} className="term-arrow" />
          <input className="cell-input" placeholder="目标译法" spellCheck={false} autoComplete="off" value={newTgt} onChange={(e) => setNewTgt(e.target.value)} />
        </div>
        <div className="glossary-new-foot">
          <input className="cell-input" placeholder="备注（可选）" value={newNote} onChange={(e) => setNewNote(e.target.value)} />
          <button type="submit" className="btn btn-sm btn-primary">
            添加
          </button>
        </div>
      </form>

      <div className="glossary-list">
        {terms.length > 0 && (
          <div className="glossary-count-row">
            <span className="glossary-count">
              {f ? `${shown.length} / ${terms.length} 个术语` : `${terms.length} 个术语`}，已采用 {approved}
            </span>
            {shown.length > 0 && (
              <label className="glossary-check glossary-all" title={allShown ? '取消选中列表里的全部术语' : f ? '选中筛选出来的全部术语' : '选中全部术语'}>
                <input
                  type="checkbox"
                  checked={allShown}
                  ref={(el) => {
                    if (el) el.indeterminate = shownPicked > 0 && !allShown;
                  }}
                  onChange={toggleAll}
                />
                全选
              </label>
            )}
          </div>
        )}
        {pickedIds.length > 0 && (
          <div className="glossary-bulk" role="toolbar" aria-label="批量操作选中的术语">
            <div className="glossary-bulk-head">
              <span>已选 {pickedIds.length} 个</span>
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  setPicked(new Set());
                  setConfirmDel(false);
                }}
              >
                取消选择
              </button>
            </div>
            <div className="glossary-bulk-actions">
              <button type="button" className="term-chip" disabled={busy} onClick={() => void batch({ status: 'approved' }, '已采用')}>
                采用
              </button>
              <button type="button" className="term-chip" disabled={busy} onClick={() => void batch({ status: 'proposed' }, '已改为待定')}>
                待定
              </button>
              <button type="button" className="term-chip" disabled={busy} onClick={() => void batch({ status: 'rejected' }, '已拒绝')}>
                拒绝
              </button>
              <button type="button" className="term-chip" disabled={busy} title="所有文档都会使用" onClick={() => void batch({ scope: 'global' }, '已设为全局')}>
                设为全局
              </button>
              <button type="button" className="term-chip" disabled={busy} title="只在这份文档里使用" onClick={() => void batch({ scope: 'doc', doc_id: docId }, '已改为仅本文档')}>
                仅本文档
              </button>
              <button
                type="button"
                className={`term-chip danger${confirmDel ? ' is-armed' : ''}`}
                disabled={busy}
                onClick={() => (confirmDel ? void batch({ delete: true }, '已删除') : setConfirmDel(true))}
                onBlur={() => setConfirmDel(false)}
              >
                {confirmDel ? `确认删除 ${pickedIds.length} 个` : '删除'}
              </button>
            </div>
          </div>
        )}
        {loading && terms.length === 0 && <div className="empty-hint">加载中…</div>}
        {!loading && terms.length === 0 && (
          <div className="empty-hint">
            还没有术语
            <div className="empty-sub">在上面手动添加，或点「提取术语」让模型从文档里找。已采用的术语会在翻译时保持一致。</div>
          </div>
        )}
        {terms.length > 0 && shown.length === 0 && <div className="empty-hint">没有匹配「{filter.trim()}」的术语</div>}
        {shown.map((t) => {
          const global = t.scope === 'global' || t.doc_id === null;
          return (
            <div key={t.id} className={`term-card is-${t.status}${picked.has(t.id) ? ' is-picked' : ''}`}>
              <input type="checkbox" className="term-pick" checked={picked.has(t.id)} onChange={() => togglePick(t.id)} aria-label={`选中 ${t.src_term}`} />
              <div className="term-pair">
                <input
                  className="term-input term-src"
                  spellCheck={false}
                  defaultValue={t.src_term}
                  aria-label="源术语"
                  title={t.src_term}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v && v !== t.src_term) void patch(t.id, { src_term: v });
                  }}
                />
                <Icon name="next" size={12} className="term-arrow" />
                <input
                  className="term-input term-tgt"
                  spellCheck={false}
                  defaultValue={t.tgt_term}
                  aria-label="目标译法"
                  title={t.tgt_term}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v && v !== t.tgt_term) void patch(t.id, { tgt_term: v });
                  }}
                />
              </div>
              <div className="term-foot">
                <input
                  className="term-input term-note"
                  defaultValue={t.note ?? ''}
                  placeholder="备注"
                  aria-label="备注"
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v !== (t.note ?? '')) void patch(t.id, { note: v });
                  }}
                />
                <span className="term-origin">{ORIGIN[t.origin ?? 'manual'] ?? t.origin}</span>
                <button
                  type="button"
                  className={`term-chip ${global ? 'on' : ''}`}
                  aria-pressed={global}
                  title={global ? '全局术语：所有文档都会使用（点击改为仅本文档）' : '仅本文档使用（点击设为全局术语）'}
                  onClick={() => void patch(t.id, global ? { scope: 'doc', doc_id: docId } : { scope: 'global' })}
                >
                  全局
                </button>
                <select
                  className={`term-status is-${t.status}`}
                  value={t.status}
                  aria-label="状态"
                  onChange={(e) => void patch(t.id, { status: e.target.value })}
                >
                  {STATUS_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                  {!STATUS_OPTIONS.some((o) => o.value === t.status) && <option value={t.status}>{t.status}</option>}
                </select>
                <button type="button" className="term-del" title="删除这个术语" aria-label="删除" onClick={() => void remove(t.id)}>
                  <Icon name="trash" size={13} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
