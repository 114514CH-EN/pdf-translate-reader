import { useEffect, useState, type FormEvent, type ReactNode } from 'react';

/**
 * Login for the server version (backend cloud mode, see deploy/README.md).
 *
 * The desktop app answers /api/session with {cloud: false} and this renders the
 * app straight away. On the server the page first shows a login card; the
 * backend checks the workspace account and sets an HttpOnly session cookie, so
 * every later request (fetch, <img>, the PDF itself) carries it.
 *
 * A session that runs out while reading (any API call answered 401 "请先登录")
 * brings the card back over the app, which then reloads after logging in.
 */

export const AUTH_EVENT = 'pdftr:auth-required';
const LOGIN_DETAIL = '请先登录';

let hooked = false;
/** One place for every request, including the few raw fetch() calls in the app. */
function hookFetch(): void {
  if (hooked || typeof window === 'undefined') return;
  hooked = true;
  const orig = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await orig(input, init);
    if (res.status === 401) {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/api/') && !url.includes('/api/login')) {
        try {
          const body = (await res.clone().json()) as { detail?: unknown };
          if (body.detail === LOGIN_DETAIL) window.dispatchEvent(new Event(AUTH_EVENT));
        } catch {
          /* not ours */
        }
      }
    }
    return res;
  };
}

export interface SessionInfo {
  cloud: boolean;
  user: string | null;
}

export async function fetchSession(): Promise<SessionInfo> {
  try {
    const res = await fetch('/api/session');
    if (!res.ok) return { cloud: false, user: null };
    return (await res.json()) as SessionInfo;
  } catch {
    return { cloud: false, user: null };
  }
}

export async function logout(): Promise<void> {
  try {
    await fetch('/api/logout', { method: 'POST' });
  } finally {
    window.location.reload();
  }
}

type GateState = 'checking' | 'open' | 'login';

export default function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GateState>('checking');
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    hookFetch();
    let alive = true;
    void fetchSession().then((s) => {
      if (alive) setState(!s.cloud || s.user ? 'open' : 'login');
    });
    const onExpired = () => setExpired(true);
    window.addEventListener(AUTH_EVENT, onExpired);
    return () => {
      alive = false;
      window.removeEventListener(AUTH_EVENT, onExpired);
    };
  }, []);

  if (state === 'checking') return null;
  if (state === 'login') return <LoginCard onDone={() => setState('open')} />;
  return (
    <>
      {children}
      {expired && (
        <div className="auth-overlay" role="dialog" aria-modal="true" aria-label="重新登录">
          <LoginCard expired onDone={() => window.location.reload()} />
        </div>
      )}
    </>
  );
}

function LoginCard({ onDone, expired = false }: { onDone: () => void; expired?: boolean }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      if (res.ok) {
        onDone();
        return;
      }
      let msg = `登录失败（${res.status}）`;
      try {
        const body = (await res.json()) as { detail?: unknown };
        if (typeof body.detail === 'string') msg = body.detail;
      } catch {
        /* keep the status message */
      }
      setError(msg);
    } catch {
      setError('连不上服务器，请检查网络后再试');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={expired ? 'auth-card-wrap is-overlay' : 'auth-card-wrap'}>
      <form className="auth-card" onSubmit={(e) => void submit(e)}>
        <img className="auth-logo" src="/favicon.svg" alt="" width={56} height={56} />
        <h1 className="auth-title">PDF 双语翻译阅读器</h1>
        <p className="auth-sub">{expired ? '登录已过期，请重新登录。' : '用 workspace 的账号登录。'}</p>
        <label className="auth-field">
          <span>用户名</span>
          <input
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
            required
          />
        </label>
        <label className="auth-field">
          <span>密码</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {error && (
          <p className="auth-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn btn-primary auth-submit" disabled={busy}>
          {busy ? '登录中…' : '登录'}
        </button>
      </form>
    </div>
  );
}
