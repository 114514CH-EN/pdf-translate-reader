import { useTranslationStore } from '../stores/translation';
import { useViewStore } from '../stores/view';
import { api } from '../api/client';
import type { TranslateRequest } from '../types';

/**
 * Slim top progress bar shown while a translation/extraction job runs.
 * Click the failed counter to retry failed blocks (or the page) with force.
 */
export function JobsProgressBanner({ docId }: { docId: string }) {
  const job = useTranslationStore((s) => s.job);
  const startTranslate = useTranslationStore((s) => s.startTranslate);
  const refreshPage = useTranslationStore((s) => s.refreshPage);
  const toast = useViewStore((s) => s.toast);
  const currentPage = useViewStore((s) => s.currentPage);

  if (!job) return null;
  const active = job.status === 'running' || job.status === 'pending';
  const pct = job.total > 0 ? Math.round((job.done / job.total) * 100) : 0;

  const cancel = async () => {
    try {
      await api.cancelJob(job.id);
      useTranslationStore.getState().patchJob({ status: 'cancelled' });
      toast('任务已取消');
    } catch {
      toast('取消失败', 'error');
    }
  };

  const retryFailed = async () => {
    const params = (job.params ?? {}) as Record<string, unknown>;
    // precise retry: exactly the blocks that failed (ids reported by the backend)
    const failedIds = (job.result?.failed_ids ?? []).map(String);
    const blockIds = failedIds.length
      ? failedIds
      : Array.isArray(params.block_ids)
        ? (params.block_ids as string[])
        : null;
    const pageFromParams = typeof params.page_no === 'number' ? params.page_no : null;
    const body: TranslateRequest = blockIds
      ? { doc_id: docId, scope: 'blocks', block_ids: blockIds, force: true }
      : { doc_id: docId, scope: 'page', page_no: pageFromParams ?? currentPage, force: true };
    const jobId = await startTranslate(body);
    if (jobId) {
      useTranslationStore.getState().setJob({
        id: jobId,
        kind: 'translate',
        status: 'running',
        total: blockIds ? blockIds.length : 0,
        done: 0,
        failed: 0,
        params: body as unknown as Record<string, unknown>,
      });
    }
  };

  return (
    <div className={`jobs-banner ${job.status}`} role="status">
      <div className="jobs-banner-inner">
        <span className="jobs-kind">
          {job.kind === 'extract' || job.kind === 'extract_terms'
            ? '术语提取'
            : job.kind === 'polish'
              ? '一致性润色'
              : '翻译任务'}
        </span>
        {active ? (
          <>
            <div className="jobs-progress" aria-label="进度">
              <div className="jobs-progress-fill" style={{ width: `${pct}%` }} />
            </div>
            <span className="jobs-counts">
              {job.done}/{job.total}
              {job.failed > 0 ? ` · 失败 ${job.failed}` : ''}
            </span>
            <button type="button" className="btn btn-sm" onClick={cancel}>
              取消
            </button>
          </>
        ) : (
          <>
            <span className="jobs-counts">
              {job.status === 'done' || job.status === 'done_with_errors'
                ? job.kind === 'polish'
                  ? `已完成 · 修改 ${job.result?.changed_ids?.length ?? 0} 处`
                  : '已完成'
                : job.status === 'failed' || job.status === 'error'
                  ? `失败：${job.error ?? '未知错误'}`
                  : '已停止'}
              {job.failed > 0 ? ` · 失败 ${job.failed}（已标红）` : ''}
              {job.failed > 0 && job.error && job.status !== 'error' ? ` · ${job.error.slice(0, 80)}` : ''}
            </span>
            {job.failed > 0 && (
              <button type="button" className="btn btn-sm" onClick={retryFailed}>
                重试失败项
              </button>
            )}
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                useTranslationStore.getState().setJob(null);
                void refreshPage(docId, currentPage);
              }}
            >
              关闭
            </button>
          </>
        )}
      </div>
    </div>
  );
}
