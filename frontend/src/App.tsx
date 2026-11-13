import { useCallback, useEffect, useRef, useState, lazy, Suspense } from 'react';

/** must equal backend/app/config.py APP_VERSION */
const EXPECTED_BACKEND = '2026.11.13-3';
import HomeView from './components/HomeView';
import { api } from './api/client';
import { DocumentTabs } from './components/DocumentTabs';
import { Toolbar } from './components/Toolbar';
import { PageAbsoluteView } from './components/PageAbsoluteView';
import { FlowTranslationPane } from './components/FlowTranslationPane';
import { Sidebar } from './components/Sidebar';
import { ProgressStrip } from './components/ProgressStrip';
import { SearchBar } from './components/SearchBar';
import { SelectionToolbar } from './components/SelectionToolbar';
import { useReadingPosition } from './hooks/useReadingPosition';
import { JobsProgressBanner } from './components/JobsProgressBanner';
import { UploadDropZone } from './components/UploadDropZone';
import { pageAtTop, scrollPageIntoView, useSyncScroll } from './hooks/useSyncScroll';
import { useJobEvents } from './hooks/useJobEvents';
import { useDocStore } from './stores/doc';
import { useViewStore } from './stores/view';
import { useTranslationStore } from './stores/translation';
import { useSettingsStore } from './stores/settings';
import { TOOLBAR_EVENT, actionFor, comboFromEvent, resolveShortcuts } from './lib/shortcuts';
import { applyPageTone, applyTheme, nextTheme, type PageTone, type ThemeMode } from './lib/theme';
import { isPetMode } from './pet/mode';

/** Only the pet build downloads this — the classic reader never fetches it. */
// loaded when first needed: the PDF engine (pdf.js, ≈400 KB) and the settings window
const PdfPane = lazy(() => import('./components/PdfPane').then((m) => ({ default: m.PdfPane })));
const SettingsModal = lazy(() => import('./components/SettingsModal').then((m) => ({ default: m.SettingsModal })));
const PetAssistant = lazy(() =>
  import('./pet/PetAssistant').then((m) => ({ default: m.PetAssistant })),
);

function Toasts() {
  const toasts = useViewStore((s) => s.toasts);
  const dismiss = useViewStore((s) => s.dismissToast);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => dismiss(t.id)}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    el.isContentEditable
  );
}

export default function App() {
  const documents = useDocStore((s) => s.documents);
  const activeId = useDocStore((s) => s.activeId);
  const loadDocuments = useDocStore((s) => s.loadDocuments);
  const openDocument = useDocStore((s) => s.openDocument);

  const mode = useViewStore((s) => s.mode);
  const leftPanePct = useViewStore((s) => s.leftPanePct);
  const setLeftPanePct = useViewStore((s) => s.setLeftPanePct);
  const requestPageNav = useViewStore((s) => s.requestPageNav);
  const currentPage = useViewStore((s) => s.currentPage);
  const editMode = useViewStore((s) => s.editMode);
  // 原文也能编辑: in edit mode the left pane turns into editable blocks of the original
  const srcEdits = useDocStore((s) => s.detail?.src_edits ?? 0);
  const [srcOriginal, setSrcOriginal] = useState(false);
  useEffect(() => {
    // leaving edit mode: find out whether the original now carries edits
    const id = useDocStore.getState().activeId;
    if (editMode || !id) return;
    void api.getDocument(id).then((d) => useDocStore.getState().patchDetail({ src_edits: d.src_edits ?? 0 })).catch(() => undefined);
  }, [editMode]);
  useEffect(() => setSrcOriginal(false), [activeId]);
  // the window / tab is named after what is being read
  useEffect(() => {
    const base = isPetMode() ? 'PDF 双语翻译阅读器（桌宠版）' : 'PDF 双语翻译阅读器';
    const doc = documents.find((d) => String(d.id) === String(activeId));
    document.title = doc ? `${doc.title} - ${base}` : base;
  }, [activeId, documents]);
  const showSrcEdited = mode === 'page' && (editMode || (srcEdits > 0 && !srcOriginal));

  const job = useTranslationStore((s) => s.job);
  const refreshPage = useTranslationStore((s) => s.refreshPage);
  const resetTranslations = useTranslationStore((s) => s.reset);

  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const dividerRef = useRef<HTMLDivElement>(null);

  // initial load
  useEffect(() => {
    void loadDocuments();
  }, [loadDocuments]);

  // when a doc becomes active, refresh detail + reset per-doc state
  useEffect(() => {
    if (activeId) {
      useViewStore.setState({ currentPage: 1, pageCount: 0 }); // each doc starts at its first page
      resetTranslations();
      // the assistant panel resets itself in loadFor(docId) — resetting here would race it
      void openDocument(activeId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // on startup, activate the first open tab (closing the last tab leaves the empty state)
  const bootRef = useRef(false);
  const openIds = useDocStore((s) => s.openIds);
  useEffect(() => {
    if (bootRef.current || documents.length === 0) return;
    bootRef.current = true;
    if (!activeId && openIds.length > 0) useDocStore.getState().setActive(openIds[0]);
  }, [activeId, documents, openIds]);

  // detect an old backend process still serving this (new) page
  const [backendStale, setBackendStale] = useState<string | null>(null);
  // after an update the backend re-parses old documents in the background
  const [upgrading, setUpgrading] = useState(0);
  useEffect(() => {
    let timer = 0;
    let seen = false;
    const check = () => {
      fetch('/api/health')
        .then((r) => r.json())
        .then((h: { version?: string; upgrading?: number }) => {
          if (h.version !== EXPECTED_BACKEND) setBackendStale(h.version ?? '旧版本');
          const left = h.upgrading ?? 0;
          setUpgrading(left);
          if (left > 0) {
            seen = true;
            timer = window.setTimeout(check, 1500);
          } else if (seen) {
            window.location.reload(); // show the documents with their new layout
          }
        })
        .catch(() => undefined);
    };
    check();
    return () => window.clearTimeout(timer);
  }, []);

  // a quiet look for a new release, at most once a day (local app only)
  useEffect(() => {
    const KEY = 'pdftr.update.checked';
    const timer = window.setTimeout(() => {
      try {
        if (Date.now() - Number(localStorage.getItem(KEY) || 0) < 20 * 3600 * 1000) return;
      } catch {
        return;
      }
      fetch('/api/health')
        .then((r) => r.json())
        .then((h: { cloud?: boolean }) => (h.cloud ? null : fetch('/api/update/check').then((r) => (r.ok ? r.json() : null))))
        .then((u: { newer?: boolean; latest?: string } | null) => {
          if (!u) return;
          try {
            localStorage.setItem(KEY, String(Date.now()));
          } catch {
            /* private mode */
          }
          if (u.newer) {
            useViewStore.getState().toast(`有新版本 v${u.latest}：在 ⚙ 设置 → 数据与安全 里可以一键更新`, 'success');
          }
        })
        .catch(() => undefined);
    }, 8000);
    return () => window.clearTimeout(timer);
  }, []);

  // settings (theme + shortcuts) are needed app-wide, not only in the modal
  const ui = useSettingsStore((s) => s.settings.ui);
  useEffect(() => {
    void useSettingsStore.getState().load();
  }, []);
  const theme = (ui?.theme as ThemeMode | undefined) ?? 'system';
  useEffect(() => applyTheme(theme), [theme]);
  const pageTone = ui?.pageTone as PageTone | undefined;
  useEffect(() => applyPageTone(pageTone), [pageTone]);

  // keyboard shortcuts (configurable in 设置 → 快捷键; ignored while typing)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('.shortcut-capture')) return; // the settings dialog is recording a key
      const combo = comboFromEvent(e);
      if (!combo) return;
      const map = resolveShortcuts(useSettingsStore.getState().settings.ui?.shortcuts);
      // search replaces the browser's find, also while typing in a field
      if (actionFor(combo, map) === 'search' && useDocStore.getState().activeId) {
        e.preventDefault();
        useViewStore.getState().setSearchOpen(true);
        window.dispatchEvent(new Event('pdftr:focus-search'));
        return;
      }
      if (isTypingTarget(e.target)) return;
      const action = actionFor(combo, map);
      if (!action) return;
      e.preventDefault();
      const view = useViewStore.getState();
      switch (action) {
        case 'prevPage':
          requestPageNav(view.currentPage - 1);
          break;
        case 'nextPage':
          requestPageNav(view.currentPage + 1);
          break;
        case 'toggleMode':
          view.setMode(view.mode === 'page' ? 'flow' : 'page');
          break;
        case 'toggleEdit':
          view.setEditMode(!view.editMode);
          break;
        case 'zoomIn':
          view.zoomIn();
          break;
        case 'zoomOut':
          view.zoomOut();
          break;
        case 'openSettings':
          view.setSettingsOpen(true);
          break;
        case 'toggleTheme': {
          const st = useSettingsStore.getState();
          void st.save({ ui: { ...st.settings.ui, theme: nextTheme((st.settings.ui?.theme as ThemeMode) ?? 'system') } });
          break;
        }
        default:
          window.dispatchEvent(new CustomEvent(TOOLBAR_EVENT, { detail: action }));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [requestPageNav]);

  // sync scroll between panes in both modes
  useSyncScroll(leftRef, rightRef, !!activeId, showSrcEdited);
  // The left pane is swapped (original PDF ⇄ editable original) when edit mode starts or
  // ends: the new one starts at its top, so bring it to where the right pane is.
  const firstSwap = useRef(true);
  useEffect(() => {
    if (firstSwap.current) {
      firstSwap.current = false;
      return;
    }
    let tries = 0;
    let timer = 0;
    const align = () => {
      const left = leftRef.current;
      const right = rightRef.current;
      const pos = right ? pageAtTop(right) : null;
      const page = pos ? Number(pos.page) : useViewStore.getState().currentPage;
      const target = left?.querySelector<HTMLElement>(`[data-page-no="${page}"]`);
      if (left && target && target.getBoundingClientRect().height > 50) {
        scrollPageIntoView(left, page, 'auto', pos?.frac ?? 0);
        return;
      }
      if (++tries < 40) timer = window.setTimeout(align, 100); // the PDF is still being laid out
    };
    timer = window.setTimeout(align, 60);
    return () => window.clearTimeout(timer);
  }, [showSrcEdited]);
  // 最近阅读位置
  useReadingPosition(leftRef);

  // job SSE: on done, refresh current page blocks
  const lastProgressRefresh = useRef(0);
  const refreshLoaded = () => {
    const id = useDocStore.getState().activeId;
    if (!id) return;
    const loaded = Object.values(useTranslationStore.getState().pages)
      .filter((pg) => pg.loaded)
      .map((pg) => pg.pageNo);
    for (const n of loaded) void refreshPage(id, n);
  };
  useJobEvents(job?.id ?? null, {
    onProgress: () => {
      // show translations as they arrive (throttled)
      const now = Date.now();
      if (now - lastProgressRefresh.current > 2500) {
        lastProgressRefresh.current = now;
        refreshLoaded();
      }
    },
    onDone: (done) => {
      useTranslationStore.getState().setFailedBlockIds((done.result?.failed_ids ?? []).map(String));
      const id = useDocStore.getState().activeId;
      if (id) {
        // a job can touch every page: refresh all pages already loaded
        const loaded = Object.values(useTranslationStore.getState().pages)
          .filter((pg) => pg.loaded)
          .map((pg) => pg.pageNo);
        const { currentPage: p } = useViewStore.getState();
        for (const n of loaded.length ? loaded : [p]) void refreshPage(id, n);
      }
    },
    onError: (err) => {
      useViewStore.getState().toast(`翻译任务失败：${err}`, 'error');
    },
  });

  // resizable divider
  const onDividerPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startPct = useViewStore.getState().leftPanePct;
    const main = dividerRef.current?.parentElement;
    const mainW = main?.clientWidth ?? window.innerWidth;
    const onMove = (ev: PointerEvent) => {
      const delta = ((ev.clientX - startX) / mainW) * 100;
      setLeftPanePct(startPct + delta);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.classList.remove('resizing');
    };
    document.body.classList.add('resizing');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [setLeftPanePct]);

  return (
    <UploadDropZone>
      <div className="app">
        <header className="topbar">
          <DocumentTabs />
        </header>

        {backendStale && (
          <div className="stale-banner" role="alert">
            后台服务还是旧版本（{backendStale}），和这个页面不配套。如果刚更新过，先按 F5 刷新；还在的话，关闭旧的服务窗口（黑色命令行窗口）后
            重新打开程序（PDFTranslate.exe，或源码版的 run.bat）。
          </div>
        )}
        {upgrading > 0 && !backendStale && (
          <div className="stale-banner is-info" role="status">
            刚更新过：正在按新版本重新整理 {upgrading} 份文档的版面，已有译文会保留。完成后页面会自动刷新。
          </div>
        )}
        {job && activeId && <JobsProgressBanner docId={activeId} />}

        <Toolbar />
        <ProgressStrip />

        <main className="main" aria-label="阅读区">
          <SearchBar />
          {!activeId ? (
            <HomeView />
          ) : (
          <>
          <div className="split">
          <section className="pane pane-left" style={{ width: `${leftPanePct}%` }}>
            {activeId && showSrcEdited ? (
              // the original as editable blocks: in edit mode, and afterwards while it carries edits
              <PageAbsoluteView scrollRef={leftRef} docId={activeId} side="src" />
            ) : (
              <Suspense fallback={null}>
                <PdfPane scrollRef={leftRef} docId={activeId} />
              </Suspense>
            )}
            {activeId && mode === 'page' && !editMode && srcEdits > 0 && (
              <button
                type="button"
                className="src-view-switch"
                title="这份文档的原文被你修改过。可以在「修改后的原文」和「原始 PDF」之间切换"
                onClick={() => setSrcOriginal((v) => !v)}
              >
                {srcOriginal ? '正在看原始 PDF，点击看修改后的原文' : '正在看修改后的原文，点击看原始 PDF'}
              </button>
            )}
          </section>
          <div
            ref={dividerRef}
            className="split-divider"
            role="separator"
            aria-orientation="vertical"
            onPointerDown={onDividerPointerDown}
          />
          <section className="pane pane-right">
            {activeId ? (
              mode === 'page' ? (
                <PageAbsoluteView scrollRef={rightRef} docId={activeId} />
              ) : (
                <FlowTranslationPane scrollRef={rightRef} docId={activeId} />
              )
            ) : (
              <div className="translation-pane pane-empty">
                <div className="empty-hint">
                  {documents.length > 0 ? '没有打开的文档' : '请先上传 PDF'}
                  <div className="empty-sub">
                    {documents.length > 0
                      ? '从标签栏的「文档库」打开一个文档，或拖拽新的 PDF 到窗口'
                      : '拖拽 PDF 到窗口，或点击标签栏 + 号选择文件'}
                  </div>
                </div>
              </div>
            )}
          </section>
          </div>

          <Sidebar docId={activeId} />
          </>
          )}
        </main>

        {/* hint bar */}
        <footer className="statusbar">
          <span>
            {!activeId
              ? '把 PDF 拖进窗口就能添加'
              : editMode
                ? '编辑模式：点击原文或译文即可修改，Ctrl+Z 撤销'
                : '←/→ 翻页，拖拽分隔线调整布局'}
          </span>
          {activeId && (
            <span>
              {mode === 'page' ? '整页预览' : '逐句对照'}，第 {currentPage} 页
            </span>
          )}
        </footer>

        <Suspense fallback={null}>
          <SettingsModal />
        </Suspense>
        <SelectionToolbar />
        {isPetMode() && (
          <Suspense fallback={null}>
            <PetAssistant />
          </Suspense>
        )}
        <Toasts />
      </div>
    </UploadDropZone>
  );
}
