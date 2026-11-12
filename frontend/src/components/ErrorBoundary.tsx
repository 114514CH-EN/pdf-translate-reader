import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * The last line of defence: if rendering the app throws, show what happened and
 * ways out — instead of an empty page that looks like the program is broken for good.
 *
 * Ways out: reload; close the open documents first (a problem tied to one document
 * would otherwise come straight back); install a newer version (the settings
 * dialog cannot be reached from here).
 */

interface State {
  error: Error | null;
  note: string;
  busy: boolean;
}

export default class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, note: '', busy: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[pdftr] render failed', error, info.componentStack);
  }

  private closeDocs = () => {
    try {
      for (const key of Object.keys(window.localStorage)) {
        // which documents were open and which one was showing — not settings, not notes
        if (/^pdftr[.:_-]?(open|active|tabs|last)/i.test(key)) window.localStorage.removeItem(key);
      }
    } catch {
      /* storage unavailable: a plain reload is all that is left */
    }
    window.location.reload();
  };

  private update = async () => {
    this.setState({ busy: true, note: '正在检查更新…' });
    try {
      const check = (await (await fetch('/api/update/check?force=true')).json()) as {
        newer?: boolean;
        latest?: string;
        can_install?: boolean;
        page?: string;
        detail?: string;
      };
      if (!check.newer) {
        this.setState({ busy: false, note: check.detail ?? '已经是最新版本。请把下面的错误信息发给开发者。' });
        return;
      }
      if (!check.can_install) {
        this.setState({ busy: false, note: `有新版本 v${check.latest}，请到 ${check.page ?? 'GitHub 发布页'} 下载。` });
        return;
      }
      const res = await fetch('/api/update/install', { method: 'POST', headers: { 'X-PDFTR-Update': '1' } });
      if (!res.ok) throw new Error(`更新没有启动（${res.status}）`);
      this.setState({ note: `正在下载并安装 v${check.latest}，完成后页面会自动刷新…` });
      const target = check.latest;
      const started = Date.now();
      const wait = () => {
        window.setTimeout(() => {
          fetch('/api/health')
            .then((r) => r.json())
            .then((h: { release?: string }) => (h.release === target ? window.location.reload() : wait()))
            .catch(() => (Date.now() - started > 300_000 ? this.setState({ busy: false, note: '程序没有自己重新启动，请手动打开 PDFTranslate.exe。' }) : wait()));
        }, 2000);
      };
      wait();
    } catch (e) {
      this.setState({ busy: false, note: e instanceof Error ? e.message : String(e) });
    }
  };

  render(): ReactNode {
    const { error, note, busy } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="crash-screen" role="alert">
        <div className="crash-card">
          <h1>页面出错了</h1>
          <p>文档、译文和笔记都还在，没有丢。可以先试试下面的办法：</p>
          <div className="crash-actions">
            <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
              重新加载
            </button>
            <button type="button" className="btn" onClick={this.closeDocs}>
              关闭打开的文档后重新加载
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => void this.update()}>
              检查并安装更新
            </button>
          </div>
          {note && <p className="crash-note">{note}</p>}
          <details>
            <summary>错误信息（反馈问题时请附上）</summary>
            <pre>{String(error.stack || error.message || error)}</pre>
          </details>
        </div>
      </div>
    );
  }
}
