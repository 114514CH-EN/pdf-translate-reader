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
    try {
      await api.updateGlossary(id, body);
      await refresh();
    } catch (e) {
      toast(`更新术语失败：${errMsg(e)}`, 'error');
    }
  };

  const remove = async (id: string) => {
    try {
      await api.deleteGlossary(id);
      await refresh();
    } catch (e) {
      toast(`删除术语失败：${errMsg(e)}`, 'error');
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
  const shown = terms.filter((t) => !f || t.src_term.toLowerCase().includes(f) || t.tgt_term.toLowerCase().includes(f));
  const approved = terms.filter((t) => t.status === 'approved').length;

  return (
    <div className="glossary-tab">
      <div className="glossary-head">
        <label className="glossary-search">
          <Icon name="search" size={13} />
          <input placeholder="筛选术语" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="筛选术语" />
        </label>
        <button type="button" className="btn btn-sm" title="让模型从这份文档里找出专业术语" onClick={() => void extract()}>
          <Icon name="sparkle" size={13} />
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
          <input className="cell-input" placeholder="源术语" value={newSrc} onChange={(e) => setNewSrc(e.target.value)} />
          <Icon name="next" size={12} className="term-arrow" />
          <input className="cell-input" placeholder="目标译法" value={newTgt} onChange={(e) => setNewTgt(e.target.value)} />
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
          <div className="glossary-count">
            {f ? `${shown.length} / ${terms.length} 个术语` : `${terms.length} 个术语`} · 已采用 {approved}
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
            <div key={t.id} className={`term-card is-${t.status}`}>
              <div className="term-pair">
                <input
                  className="term-input term-src"
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
