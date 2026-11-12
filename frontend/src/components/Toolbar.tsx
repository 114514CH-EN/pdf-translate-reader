import { useEffect, useRef, useState } from 'react';
import EditTools from './EditTools';
import { EstimateDialog, skipEstimate } from './EstimateDialog';
import type { TranslateEstimate } from '../types';
import { useViewStore } from '../stores/view';
import { useDocStore } from '../stores/doc';
import { useTranslationStore } from '../stores/translation';
import { api } from '../api/client';
import type { ExportFormat } from '../types';
import { useSettingsStore } from '../stores/settings';
import { TOOLBAR_EVENT, resolveShortcuts, type ShortcutAction } from '../lib/shortcuts';
import { THEMES, type ThemeMode } from '../lib/theme';
import { Icon } from './Icon';

const EXPORT_ITEMS: { format: ExportFormat; label: string; suffix: string }[] = [
  { format: 'pdf_translated', label: '纯译文 PDF（原版式）', suffix: '_译文.pdf' },
  { format: 'pdf_side_by_side', label: '左右对照 PDF（原文 | 译文）', suffix: '_对照.pdf' },
  { format: 'pdf_alternate', label: '交替页 PDF（原页 + 译页）', suffix: '_交替.pdf' },
  { format: 'pdf_bilingual', label: '双语流式 PDF', suffix: '_双语.pdf' },
  { format: 'md', label: 'Markdown', suffix: '.md' },
  { format: 'pdf_source_edited', label: '原文修改版 PDF（编辑过的原文）', suffix: '_原文修改版.pdf' },
];

type TranslateAction = 'doc' | 'page' | 'page_force' | 'doc_force' | 'polish';

export function Toolbar() {
  const mode = useViewStore((s) => s.mode);
  const setMode = useViewStore((s) => s.setMode);
  const currentPage = useViewStore((s) => s.currentPage);
  const pageCount = useViewStore((s) => s.pageCount);
  const requestPageNav = useViewStore((s) => s.requestPageNav);
  const zoom = useViewStore((s) => s.zoom);
  const setZoom = useViewStore((s) => s.setZoom);
  const zoomIn = useViewStore((s) => s.zoomIn);
  const zoomOut = useViewStore((s) => s.zoomOut);
  const editMode = useViewStore((s) => s.editMode);
  const setEditMode = useViewStore((s) => s.setEditMode);
  const setSettingsOpen = useViewStore((s) => s.setSettingsOpen);
  const toast = useViewStore((s) => s.toast);

  const activeId = useDocStore((s) => s.activeId);
  const detail = useDocStore((s) => s.detail);
  const startTranslate = useTranslationStore((s) => s.startTranslate);
  const busy = useTranslationStore((s) => s.busy);

  const [exportOpen, setExportOpen] = useState(false);
  const exportRef = useRef<HTMLDivElement>(null);
  const [trOpen, setTrOpen] = useState(false);
  const [pendingEstimate, setPendingEstimate] = useState<{
    est: TranslateEstimate;
    body: { doc_id: string; scope: 'page' | 'doc'; page_no?: number; force: boolean };
  } | null>(null);
  const trRef = useRef<HTMLDivElement>(null);
  const job = useTranslationStore((s) => s.job);
  const jobActive = !!job && (job.status === 'running' || job.status === 'pending');
  const [pageInput, setPageInput] = useState(String(currentPage));

  useEffect(() => {
    setPageInput(String(currentPage));
  }, [currentPage]);

  useEffect(() => {
    if (!exportOpen && !trOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (exportRef.current && !exportRef.current.contains(e.target as Node)) setExportOpen(false);
      if (trRef.current && !trRef.current.contains(e.target as Node)) setTrOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [exportOpen, trOpen]);

  const translate = async (action: TranslateAction) => {
    if (!activeId) return;
    setTrOpen(false);
    if (action === 'polish') {
      try {
        const { job_id } = await api.polish(activeId);
        useTranslationStore.getState().setJob({
          id: job_id, kind: 'polish', status: 'running', total: 0, done: 0, failed: 0, params: { doc_id: activeId },
        });
        toast('一致性润色已开始：统一术语译法与标题格式');
      } catch (e) {
        toast(`润色失败：${e instanceof Error ? e.message : String(e)}`, 'error');
      }
      return;
    }
    const page = action === 'page' || action === 'page_force';
    const force = action === 'page_force' || action === 'doc_force';
    const body = {
      doc_id: activeId,
      scope: page ? ('page' as const) : ('doc' as const),
      page_no: page ? currentPage : undefined,
      force,
    };
    if (!page && !skipEstimate()) {
      // whole document: show tokens / cost / time first
      try {
        const est = await api.translateEstimate(activeId, 'doc', undefined, force);
        if (est.blocks === 0) {
          toast('全文都已翻译（已翻译且未改动的块会跳过）。需要重新翻译请用「重新翻译全文」', 'info');
          return;
        }
        setPendingEstimate({ est, body });
        return;
      } catch {
        /* estimate unavailable → just start */
      }
    }
    await startJob(body);
  };

  const startJob = async (body: { doc_id: string; scope: 'page' | 'doc'; page_no?: number; force: boolean }) => {
    const page = body.scope === 'page';
    const force = body.force;
    const jobId = await startTranslate(body);
    if (jobId) {
      useTranslationStore.getState().setFailedBlockIds([]);
      useTranslationStore.getState().setJob({
        id: jobId, kind: 'translate', status: 'running', total: 0, done: 0, failed: 0,
        params: body as unknown as Record<string, unknown>,
      });
      toast(
        page
          ? `已开始${force ? '重新' : ''}翻译第 ${currentPage} 页`
          : `已开始${force ? '重新' : ''}翻译全文（已翻译且未改动的块会跳过）`,
      );
    }
  };

  const doExport = async (item: (typeof EXPORT_ITEMS)[number]) => {
    if (!activeId) return;
    setExportOpen(false);
    const base = detail?.title?.replace(/\.pdf$/i, '') ?? 'document';
    try {
      await api.exportDocument(activeId, item.format, base + item.suffix);
      toast('导出已开始下载', 'success');
    } catch (e) {
      toast(`导出失败：${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  };

  const clampPage = (v: number) => (pageCount > 0 ? Math.min(Math.max(1, v), pageCount) : 1);

  const fitWidth = () => {
    // fit the page width into the narrower of the two panes (minus scrollbar + margin)
    const panes = Array.from(
      document.querySelectorAll<HTMLElement>('.pane-left .pdf-pane, .pane-right .translation-pane'),
    ).filter((el) => el.clientWidth > 0);
    const cur = useViewStore.getState().currentPage;
    const pages = useTranslationStore.getState().pages;
    const pageW = pages[cur]?.width ?? pages[1]?.width ?? 595;
    const avail = panes.length ? Math.min(...panes.map((el) => el.clientWidth)) - 32 : 0;
    if (avail > 0) setZoom(Math.round((avail / pageW) * 100) / 100, true);
  };

  // 适合宽度 mode: refit whenever the reading area changes size (window, sidebar, divider)
  const zoomFit = useViewStore((s) => s.zoomFit);
  const firstPage = useTranslationStore((s) => s.pages[1]);
  const pageReady = !!firstPage?.loaded;
  useEffect(() => {
    if (!zoomFit || !activeId || !pageReady) return;
    const split = document.querySelector<HTMLElement>('.split');
    let t = 0;
    const refit = () => {
      window.clearTimeout(t);
      t = window.setTimeout(() => fitRef.current(), 120);
    };
    refit();
    const ro = split ? new ResizeObserver(refit) : null;
    if (split) ro!.observe(split);
    return () => {
      window.clearTimeout(t);
      ro?.disconnect();
    };
  }, [zoomFit, activeId, pageReady]);

  // shortcuts routed from App (see lib/shortcuts.ts)
  const translateRef = useRef(translate);
  translateRef.current = translate;
  const fitRef = useRef(fitWidth);
  fitRef.current = fitWidth;
  useEffect(() => {
    const on = (e: Event) => {
      const action = (e as CustomEvent<ShortcutAction>).detail;
      if (action === 'translateDoc') void translateRef.current('doc');
      else if (action === 'translatePage') void translateRef.current('page');
      else if (action === 'fitWidth') fitRef.current();
    };
    window.addEventListener(TOOLBAR_EVENT, on);
    return () => window.removeEventListener(TOOLBAR_EVENT, on);
  }, []);

  const theme = (useSettingsStore((s) => s.settings.ui?.theme) as ThemeMode | undefined) ?? 'system';


  const kb = (a: ShortcutAction) => {
    const c = resolveShortcuts(useSettingsStore.getState().settings.ui?.shortcuts)[a];
    return c ? `（${c}）` : '';
  };
  const [themeOpen, setThemeOpen] = useState(false);
  const themeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!themeOpen) return;
    const onDown = (e: MouseEvent) => {
      if (themeRef.current && !themeRef.current.contains(e.target as Node)) setThemeOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [themeOpen]);
  const pickTheme = (t: ThemeMode) => {
    const st = useSettingsStore.getState();
    void st.save({ ui: { ...st.settings.ui, theme: t } });
    setThemeOpen(false);
  };

  return (
    <>
    {pendingEstimate && (
      <EstimateDialog
        est={pendingEstimate.est}
        force={pendingEstimate.body.force}
        onCancel={() => setPendingEstimate(null)}
        onConfirm={() => {
          const b = pendingEstimate.body;
          setPendingEstimate(null);
          void startJob(b);
        }}
      />
    )}
    <div className={`toolbar ${activeId ? '' : 'is-home'}`}>
      <div className="segmented" role="group" aria-label="视图模式">
        <button
          type="button"
          className={`seg-btn ${mode === 'page' ? 'active' : ''}`}
          aria-pressed={mode === 'page'}
          title={`整页预览：保持原版式${kb('toggleMode')}`}
          onClick={() => setMode('page')}
        >
          <Icon name="page" size={15} />
          <span className="btn-label">整页预览</span>
        </button>
        <button
          type="button"
          className={`seg-btn ${mode === 'flow' ? 'active' : ''}`}
          aria-pressed={mode === 'flow'}
          title={`逐句对照：原文与译文按句排列${kb('toggleMode')}`}
          onClick={() => setMode('flow')}
        >
          <Icon name="rows" size={15} />
          <span className="btn-label">逐句对照</span>
        </button>
      </div>

      <div className="cluster" role="group" aria-label="翻页">
        <button
          type="button"
          className="icon-btn"
          title="第一页"
          aria-label="第一页"
          disabled={currentPage <= 1}
          onClick={() => requestPageNav(1)}
        >
          <Icon name="first" />
        </button>
        <button
          type="button"
          className="icon-btn"
          title={`上一页${kb('prevPage')}`}
          aria-label="上一页"
          disabled={currentPage <= 1}
          onClick={() => requestPageNav(currentPage - 1)}
        >
          <Icon name="prev" />
        </button>
        <span className="page-field">
          <input
            className="page-input"
            type="text"
            inputMode="numeric"
            value={pageInput}
            aria-label="页码"
            onChange={(e) => setPageInput(e.target.value)}
            onBlur={() => {
              const v = parseInt(pageInput, 10);
              if (!Number.isNaN(v)) requestPageNav(clampPage(v));
              else setPageInput(String(currentPage));
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const v = parseInt(pageInput, 10);
                if (!Number.isNaN(v)) requestPageNav(clampPage(v));
                else setPageInput(String(currentPage));
                (e.target as HTMLInputElement).blur();
              }
            }}
          />
          <span className="page-total">/ {pageCount || '–'}</span>
        </span>
        <button
          type="button"
          className="icon-btn"
          title={`下一页${kb('nextPage')}`}
          aria-label="下一页"
          disabled={pageCount > 0 && currentPage >= pageCount}
          onClick={() => requestPageNav(currentPage + 1)}
        >
          <Icon name="next" />
        </button>
        <button
          type="button"
          className="icon-btn"
          title="最后一页"
          aria-label="最后一页"
          disabled={pageCount > 0 && currentPage >= pageCount}
          onClick={() => requestPageNav(pageCount)}
        >
          <Icon name="last" />
        </button>
      </div>

      <div className="cluster" role="group" aria-label="缩放">
        <button type="button" className="icon-btn" title={`缩小${kb('zoomOut')}`} aria-label="缩小" onClick={zoomOut}>
          <Icon name="minus" />
        </button>
        <button
          type="button"
          className="zoom-label"
          title="恢复 100%"
          onClick={() => setZoom(1)}
        >
          {Math.round(zoom * 100)}%
        </button>
        <button type="button" className="icon-btn" title={`放大${kb('zoomIn')}`} aria-label="放大" onClick={zoomIn}>
          <Icon name="plus" />
        </button>
        <span className="cluster-sep" />
        <button
          type="button"
          className={`icon-btn with-label ${zoomFit ? 'active' : ''}`}
          aria-pressed={zoomFit}
          title={`适合宽度${kb('fitWidth')}（开启后随窗口和面板宽度自动调整）`}
          onClick={fitWidth}
        >
          <Icon name="fit" />
          <span>适合宽度</span>
        </button>
      </div>

      <div className="toolbar-spacer" />

      <div className="toolbar-group">
        <div className="export-menu split-btn" ref={trRef}>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!activeId || busy || jobActive}
            title={`翻译整个文档（已翻译且未改动的块自动跳过）${kb('translateDoc')}`}
            onClick={() => void translate('doc')}
          >
            <Icon name="translate" />
            {jobActive && job?.kind === 'translate' ? '翻译中…' : '翻译全文'}
          </button>
          <button
            type="button"
            className="btn btn-primary split-caret"
            disabled={!activeId || busy || jobActive}
            aria-label="更多翻译选项"
            aria-expanded={trOpen}
            onClick={() => setTrOpen(!trOpen)}
          >
            <Icon name="chevronDown" size={14} />
          </button>
          {trOpen && (
            <div className="menu" role="menu">
              <button type="button" className="menu-item" onClick={() => void translate('page')}>
                只翻译本页<span className="menu-kbd">{kb('translatePage').slice(1, -1)}</span>
              </button>
              <button type="button" className="menu-item" onClick={() => void translate('page_force')}>
                强制重新翻译本页
              </button>
              <button type="button" className="menu-item" onClick={() => void translate('doc_force')}>
                强制重新翻译全文
              </button>
              <div className="menu-sep" />
              <button type="button" className="menu-item" onClick={() => void translate('polish')}>
                一致性润色（统一术语和标题）
              </button>
            </div>
          )}
        </div>
        {editMode && <EditTools />}
        <button
          type="button"
          className={`btn ${editMode ? 'active' : ''}`}
          aria-pressed={editMode}
          disabled={!activeId}
          title={`编辑译文${kb('toggleEdit')}`}
          onClick={() => setEditMode(!editMode)}
        >
          <Icon name="edit" />
          <span className={editMode ? undefined : 'btn-label'}>{editMode ? '完成编辑' : '编辑译文'}</span>
        </button>
        <div className="export-menu" ref={exportRef}>
          <button
            type="button"
            className="btn"
            disabled={!activeId}
            aria-expanded={exportOpen}
            onClick={() => setExportOpen(!exportOpen)}
          >
            <Icon name="download" />
            <span className="btn-label">导出</span>
            <Icon name="chevronDown" size={13} className="caret" />
          </button>
          {exportOpen && (
            <div className="menu" role="menu">
              {EXPORT_ITEMS.map((item) => (
                <button
                  key={item.format}
                  type="button"
                  className="menu-item"
                  onClick={() => void doExport(item)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="export-menu" ref={themeRef}>
          <button
            type="button"
            className="icon-btn bordered"
            title="界面风格"
            aria-label="界面风格"
            aria-expanded={themeOpen}
            onClick={() => setThemeOpen(!themeOpen)}
          >
            <Icon name="palette" />
          </button>
          {themeOpen && (
            <div className="menu theme-menu" role="menu">
              {THEMES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={`theme-item ${theme === t.id ? 'current' : ''}`}
                  onClick={() => pickTheme(t.id)}
                >
                  <span className="theme-swatch" aria-hidden="true">
                    {t.swatch.map((c, i) => (
                      <i key={i} style={{ background: c }} />
                    ))}
                  </span>
                  <span className="theme-name">
                    {t.name}
                    <small>{t.note}</small>
                  </span>
                  {theme === t.id && <Icon name="check" size={14} />}
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          type="button"
          className="icon-btn bordered"
          title={`设置${kb('openSettings')}`}
          aria-label="设置"
          onClick={() => setSettingsOpen(true)}
        >
          <Icon name="settings" />
        </button>
      </div>
    </div>
    </>
  );
}
