import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api/client';
import { useTranslationStore } from '../stores/translation';
import { useViewStore } from '../stores/view';
import type { GlossaryTerm } from '../types';

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

  return (
    <div className="glossary-tab">
      <div className="glossary-actions">
        <button type="button" className="btn btn-sm" onClick={() => fileRef.current?.click()}>
          导入CSV
        </button>
        <button type="button" className="btn btn-sm" onClick={() => void exportCsv()}>
          导出CSV
        </button>
        <button type="button" className="btn btn-sm" onClick={() => void extract()}>
          提取术语
        </button>
        <label className="glossary-check" title="导入的术语对所有文档生效">
          <input type="checkbox" checked={importGlobal} onChange={(e) => setImportGlobal(e.target.checked)} />
          导入为全局
        </label>
        <input
          className="cell-input glossary-filter"
          placeholder="筛选…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void importCsv(f);
            e.target.value = '';
          }}
        />
      </div>

      <div className="glossary-new-row">
        <input
          className="cell-input"
          placeholder="源术语"
          value={newSrc}
          onChange={(e) => setNewSrc(e.target.value)}
        />
        <input
          className="cell-input"
          placeholder="目标译法"
          value={newTgt}
          onChange={(e) => setNewTgt(e.target.value)}
        />
        <input
          className="cell-input"
          placeholder="备注（可选）"
          value={newNote}
          onChange={(e) => setNewNote(e.target.value)}
        />
        <button type="button" className="btn btn-sm btn-primary" onClick={() => void addRow()}>
          添加
        </button>
      </div>

      <div className="glossary-table-wrap">
        {loading && <div className="empty-hint">加载中…</div>}
        {!loading && terms.length === 0 && <div className="empty-hint">暂无术语</div>}
        {terms.length > 0 && (
          <table className="glossary-table">
            <thead>
              <tr>
                <th>源术语</th>
                <th>目标译法</th>
                <th>备注</th>
                <th>状态</th>
                <th title="全局术语对所有文档生效；本文档术语优先">全局</th>
                <th>来源</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {terms
                .filter((t) => {
                  const f = filter.trim().toLowerCase();
                  return !f || t.src_term.toLowerCase().includes(f) || t.tgt_term.toLowerCase().includes(f);
                })
                .map((t) => (
                <tr key={t.id}>
                  <td>
                    <input
                      className="cell-input"
                      defaultValue={t.src_term}
                      onBlur={(e) => {
                        const v = e.target.value.trim();
                        if (v && v !== t.src_term) void patch(t.id, { src_term: v });
                      }}
                    />
                  </td>
                  <td>
                    <input
                      className="cell-input"
                      defaultValue={t.tgt_term}
                      onBlur={(e) => {
                        const v = e.target.value.trim();
                        if (v && v !== t.tgt_term) void patch(t.id, { tgt_term: v });
                      }}
                    />
                  </td>
                  <td>
                    <input
                      className="cell-input"
                      defaultValue={t.note ?? ''}
                      onBlur={(e) => {
                        const v = e.target.value.trim();
                        if (v !== (t.note ?? '')) void patch(t.id, { note: v });
                      }}
                    />
                  </td>
                  <td>
                    <select
                      className="cell-select"
                      value={t.status}
                      onChange={(e) => void patch(t.id, { status: e.target.value })}
                    >
                      {STATUS_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                      {!STATUS_OPTIONS.some((o) => o.value === t.status) && (
                        <option value={t.status}>{t.status}</option>
                      )}
                    </select>
                  </td>
                  <td className="scope-cell">
                    <input
                      type="checkbox"
                      checked={t.scope === 'global' || t.doc_id === null}
                      title={t.scope === 'global' ? '全局术语（点击改为仅本文档）' : '设为全局术语，其他文档也会使用'}
                      onChange={(e) =>
                        void patch(t.id, e.target.checked ? { scope: 'global' } : { scope: 'doc', doc_id: docId })
                      }
                    />
                  </td>
                  <td className="origin-cell">{t.origin ?? '手动'}</td>
                  <td>
                    <button type="button" className="btn btn-sm" onClick={() => void remove(t.id)}>
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
