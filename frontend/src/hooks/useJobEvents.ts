import { useEffect, useRef } from 'react';
import { api, streamSSEJson, ApiError } from '../api/client';
import type { JobInfo } from '../types';
import { useTranslationStore } from '../stores/translation';
import { useViewStore } from '../stores/view';

interface JobEventsOptions {
  /** called when the job completes successfully */
  onDone?: (job: JobInfo) => void;
  /** called when the job fails */
  onError?: (error: string) => void;
  /** called on every progress event (throttle on the caller side) */
  onProgress?: (job: Partial<JobInfo>) => void;
}

function errMsg(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * Subscribe to a job's SSE event stream and mirror progress into the
 * translation store. Falls back to polling GET /jobs/{id} once at start
 * so the banner has data even before the first event.
 */
export function useJobEvents(jobId: string | null, opts: JobEventsOptions = {}): void {
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    const ac = new AbortController();
    const tStore = useTranslationStore.getState();

    // seed current status
    void api
      .getJob(jobId)
      .then((job) => {
        if (!cancelled) {
          tStore.setJob(job);
          if (job.status === 'done' || job.status === 'done_with_errors') optsRef.current.onDone?.(job);
          if (job.status === 'failed') optsRef.current.onError?.(job.error ?? '任务失败');
        }
      })
      .catch(() => {
        /* job may not exist yet; SSE will tell us */
      });

    void (async () => {
      try {
        await streamSSEJson<Record<string, unknown>>(
          `/jobs/${encodeURIComponent(jobId)}/events`,
          { signal: ac.signal },
          (event, data) => {
            if (cancelled) return;
            if (event === 'progress') {
              const patch = {
                done: Number(data.done ?? 0),
                total: Number(data.total ?? 0),
                failed: Number(data.failed ?? 0),
                status: 'running',
                result: (data.result as JobInfo['result']) ?? null,
              };
              useTranslationStore.getState().patchJob(patch);
              optsRef.current.onProgress?.(patch);
            } else if (event === 'done') {
              const job = data as unknown as JobInfo;
              useTranslationStore.getState().setJob({
                ...job,
                status: job.status ?? 'done',
              });
              optsRef.current.onDone?.(job);
            } else if (event === 'error') {
              const error =
                typeof data === 'object' && data !== null && 'error' in data
                  ? String((data as { error: unknown }).error)
                  : String(data);
              useTranslationStore.getState().patchJob({ status: 'failed', error });
              useViewStore.getState().toast(`任务出错：${error}`, 'error');
              optsRef.current.onError?.(error);
            }
          },
        );
      } catch (e) {
        if (!cancelled && !ac.signal.aborted) {
          useViewStore.getState().toast(`任务事件流中断：${errMsg(e)}`, 'error');
        }
      }
    })();

    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [jobId]);
}
