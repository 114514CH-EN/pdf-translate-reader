import { useEffect, useRef, useState } from 'react';

/**
 * 设置 → 数据与安全 → 软件更新.
 *
 * The backend asks GitHub for the latest release. The packaged Windows app can
 * download it and restart into it by itself; a source checkout gets a link to
 * the download page instead.
 */

interface CheckResult {
  current: string;
  latest: string;
  newer: boolean;
  notes: string;
  page: string;
  size: number;
  can_install: boolean;
  packaged: boolean;
  failed?: boolean;
}

interface InstallState {
  state: 'idle' | 'downloading' | 'unpacking' | 'restarting' | 'error';
  done: number;
  total: number;
  error: string;
  version: string;
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let msg = `请求失败（${res.status}）`;
    try {
      const body = (await res.json()) as { detail?: unknown };
      if (typeof body.detail === 'string') msg = body.detail;
    } catch {
      /* keep the status message */
    }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

export function checkForUpdate(force = false): Promise<CheckResult> {
  return getJson<CheckResult>(`/api/update/check${force ? '?force=true' : ''}`);
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(0)} MB`;

export default function UpdateCard() {
  const [info, setInfo] = useState<CheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [job, setJob] = useState<InstallState | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const check = async (force: boolean) => {
    setChecking(true);
    setError('');
    try {
      setInfo(await checkForUpdate(force));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    void check(false);
    return () => window.clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** After the app has stopped: wait for the new one, then load its page. */
  const waitForRestart = (target: string, started = Date.now()) => {
    timer.current = window.setTimeout(() => {
      fetch('/api/health')
        .then((r) => r.json())
        .then((h: { release?: string }) => {
          if (h.release === target) window.location.reload();
          else waitForRestart(target, started);
        })
        .catch(() => {
          if (Date.now() - started > 180_000) {
            setJob((j) => (j ? { ...j, state: 'error', error: '程序没有自己重新启动，请手动双击 PDFTranslate.exe。' } : j));
          } else {
            waitForRestart(target, started);
          }
        });
    }, 1500);
  };

  const poll = (target: string) => {
    timer.current = window.setTimeout(() => {
      getJson<InstallState>('/api/update/status')
        .then((s) => {
          setJob(s);
          if (s.state === 'restarting') waitForRestart(target);
          else if (s.state === 'downloading' || s.state === 'unpacking') poll(target);
        })
        .catch(() => waitForRestart(target)); // the server went away: it is restarting
    }, 700);
  };

  const install = async () => {
    if (!info) return;
    if (!window.confirm(`下载并更新到 v${info.latest}？程序会自动重启，正在进行的翻译会中断（已翻好的都保存了）。`)) return;
    setError('');
    try {
      const s = await getJson<InstallState>('/api/update/install', {
        method: 'POST',
        headers: { 'X-PDFTR-Update': '1' },
      });
      setJob(s);
      poll(info.latest);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const working = job && job.state !== 'idle' && job.state !== 'error';
  const pct = job && job.total > 0 ? Math.min(100, Math.round((job.done / job.total) * 100)) : 0;

  return (
    <fieldset className="fieldset">
      <legend>软件更新</legend>
      <p className="fieldset-hint">
        当前版本 {info?.current ? `v${info.current}` : '…'}
        {info && !info.newer && info.latest && '，已经是最新版本。'}
        {info?.newer && (
          <>
            ，有新版本 <b>v{info.latest}</b>
            {info.size > 0 && `（${mb(info.size)}）`}。
            {info.can_install
              ? '更新时自动下载、替换程序文件并重启；文档、译文、笔记和设置都在 data 文件夹里，不会动。'
              : info.packaged
                ? '新版本的安装包还在生成，过几分钟再检查一次。'
                : '源码版请下载新版本，或在程序文件夹里 git pull 后重新运行 run.bat。'}
          </>
        )}
      </p>
      {info?.failed && <p className="fieldset-hint warn">上一次更新没有完成，程序文件已恢复原样，可以再试一次。</p>}
      {info?.newer && info.notes && (
        <details className="update-notes">
          <summary>v{info.latest} 更新了什么</summary>
          <pre>{info.notes}</pre>
        </details>
      )}
      {working && job && (
        <div className="update-progress" role="status">
          <div className="update-bar">
            <span style={{ width: `${job.state === 'downloading' ? pct : 100}%` }} />
          </div>
          <span>
            {job.state === 'downloading' && `正在下载 ${pct}%（${mb(job.done)} / ${mb(job.total)}）`}
            {job.state === 'unpacking' && '正在解压…'}
            {job.state === 'restarting' && '正在替换文件并重启，页面会自动刷新…'}
          </span>
        </div>
      )}
      {(error || job?.state === 'error') && (
        <p className="fieldset-hint warn" role="alert">
          {error || job?.error}
        </p>
      )}
      <div className="card-actions">
        {info?.newer && info.can_install && (
          <button type="button" className="btn btn-sm btn-primary" disabled={!!working} onClick={() => void install()}>
            {working ? '更新中…' : `下载并更新到 v${info.latest}`}
          </button>
        )}
        {info?.newer && !info.can_install && (
          <a className="btn btn-sm btn-primary" href={info.page} target="_blank" rel="noreferrer">
            打开下载页面
          </a>
        )}
        <button type="button" className="btn btn-sm" disabled={checking || !!working} onClick={() => void check(true)}>
          {checking ? '检查中…' : '检查更新'}
        </button>
      </div>
    </fieldset>
  );
}
