/**
 * 桌宠版阅读助手：小页。它趴在窗口下沿，会走动、被拖着甩、被划词叫醒，
 * 用它头顶的对话气泡回答问题。对话能力全部来自 useChatStore —— 和后端
 * /api/documents/{id}/chat 的 SSE 流式没有一行区别，这里只是换了个身体。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { Markdown } from '../components/Markdown';
import { useChatStore } from '../stores/chat';
import { useDocStore } from '../stores/doc';
import { useSettingsStore } from '../stores/settings';
import { useViewStore } from '../stores/view';
import { PetBody, type PetMood } from './PetBody';
import {
  DEFAULT_APPEARANCE,
  PET_SIZE_MAX,
  PET_SIZE_MIN,
  loadAppearance,
  looksLikeImageUrl,
  saveAppearance,
  uploadedUrl,
  type Appearance,
} from './appearance';
import { PET_SUMMON_EVENT } from './mode';
import './pet.css';

/** distance of the pet's feet from the bottom of the window — above the status bar */
const GROUND = 32;
const BUBBLE_MAX_W = 416;
const POS_KEY = 'pdftr.pet.pos';

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

function readRatio(): number {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (raw) {
      const v = JSON.parse(raw) as { ratio?: unknown };
      if (typeof v.ratio === 'number' && Number.isFinite(v.ratio)) return clamp(v.ratio, 0, 1);
    }
  } catch {
    /* first run, or storage blocked */
  }
  return 0.66;
}

/** A stored question looks like "> quote\n\nquestion". */
function splitQuote(content: string): { quote: string; text: string } {
  const m = /^> ([\s\S]*?)\n\n([\s\S]*)$/.exec(content);
  return m ? { quote: m[1], text: m[2] } : { quote: '', text: content };
}

const short = (t: string, n = 18) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

export function PetAssistant() {
  const docId = useDocStore((s) => s.activeId);
  const docTitle = useDocStore((s) => s.documents.find((d) => String(d.id) === String(s.activeId))?.title);

  const summaryMd = useChatStore((s) => s.summaryMd);
  const questions = useChatStore((s) => s.questions);
  const notConfigured = useChatStore((s) => s.notConfigured);
  const messages = useChatStore((s) => s.messages);
  const loading = useChatStore((s) => s.loading);
  const streaming = useChatStore((s) => s.streaming);
  const streamingText = useChatStore((s) => s.streamingText);
  const streamingSources = useChatStore((s) => s.streamingSources);
  const streamingReasoning = useChatStore((s) => s.streamingReasoning);
  const loadFor = useChatStore((s) => s.loadFor);
  const send = useChatStore((s) => s.send);
  const regenerate = useChatStore((s) => s.regenerate);
  const stop = useChatStore((s) => s.stopStreaming);
  const clear = useChatStore((s) => s.clearHistory);
  const refreshSummary = useChatStore((s) => s.refreshSummary);

  const currentPage = useViewStore((s) => s.currentPage);
  const requestPageNav = useViewStore((s) => s.requestPageNav);
  const openSettings = useViewStore((s) => s.openSettings);
  const toast = useViewStore((s) => s.toast);
  const copyFromTranslation = useSettingsStore((s) => s.copyAssistantFromTranslation);

  const [pos, setPos] = useState({ x: 0, y: GROUND });
  const posRef = useRef(pos);
  const [placed, setPlaced] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [walking, setWalking] = useState(false);

  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState(false);
  const [picking, setPicking] = useState(false);
  const [appearance, setAppearance] = useState<Appearance>(() => loadAppearance());
  const [urlDraft, setUrlDraft] = useState(() => {
    const a = loadAppearance();
    return a.kind === 'url' ? a.url : '';
  });
  const [uploading, setUploading] = useState(false);
  const [stripping, setStripping] = useState(false);
  const [input, setInput] = useState('');
  const [composing, setComposing] = useState(false);

  const size = appearance.size;
  // handlers and effects read the current edge length through a ref
  const sizeRef = useRef(size);
  useEffect(() => {
    sizeRef.current = size;
  }, [size]);
  const maxX = useCallback(() => Math.max(0, window.innerWidth - sizeRef.current - 14), []);
  const fileRef = useRef<HTMLInputElement>(null);

  // growing the pet near the right edge would push it off screen
  const lastSize = useRef(size);
  useEffect(() => {
    if (lastSize.current === size) return;
    lastSize.current = size;
    posRef.current = { x: Math.min(posRef.current.x, maxX()), y: GROUND };
    setPos(posRef.current);
  }, [size, maxX]);

  const applyAppearance = (next: Appearance) => {
    setAppearance(next);
    saveAppearance(next);
  };

  const petSrc = appearance.url;

  const applyUrl = () => {
    const url = urlDraft.trim();
    if (!url) return;
    if (!looksLikeImageUrl(url)) {
      toast('这看起来不像图片地址，请填以 .png / .jpg / .gif / .webp / .svg 结尾的直链', 'error');
      return;
    }
    applyAppearance({ ...appearance, kind: 'url', url });
    toast('形象已换成这个网址的图片', 'success');
  };

  const errorDetail = async (res: Response): Promise<string> => {
    const detail = (await res.json().catch(() => null)) as { detail?: string } | null;
    return detail?.detail ?? `HTTP ${res.status}`;
  };

  /** 让服务端把已导入形象的背景去掉（动图逐帧处理，动画保留） */
  const stripStored = async (): Promise<{ animated: boolean }> => {
    const res = await fetch('/api/pet/avatar/strip', { method: 'POST' });
    if (!res.ok) throw new Error(await errorDetail(res));
    return (await res.json()) as { animated: boolean };
  };

  const uploadFile = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const up = await fetch('/api/pet/avatar', { method: 'POST', body: form });
      if (!up.ok) throw new Error(await errorDetail(up));
      const info = await stripStored();
      applyAppearance({
        ...appearance,
        kind: 'upload',
        url: uploadedUrl(Date.now()),
        name: file.name || 'avatar.png',
      });
      toast(info.animated ? '形象已更新，背景已去掉（动画保留）' : '形象已更新，背景已去掉', 'success');
    } catch (e) {
      toast(`导入失败：${e instanceof Error ? e.message : String(e)}`, 'error');
    } finally {
      setUploading(false);
    }
  };

  /** 对已经导入的形象再跑一次去背景（阈值不变，方便重试） */
  const stripCurrent = async () => {
    if (appearance.kind !== 'upload') return;
    setStripping(true);
    try {
      const info = await stripStored();
      applyAppearance({ ...appearance, url: uploadedUrl(Date.now()) });
      toast(info.animated ? '背景已去掉，动画保留' : '背景已去掉', 'success');
    } catch (e) {
      toast(`去背景失败：${e instanceof Error ? e.message : String(e)}`, 'error');
    } finally {
      setStripping(false);
    }
  };

  const resetAppearance = async () => {
    applyAppearance({ ...DEFAULT_APPEARANCE, size: appearance.size });
    setUrlDraft('');
    try {
      await fetch('/api/pet/avatar', { method: 'DELETE' });
    } catch {
      /* the server copy is gone with the next upload anyway */
    }
  };

  const [vw, setVw] = useState(() => window.innerWidth);
  const [vh, setVh] = useState(() => window.innerHeight);
  const bodyRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ offX: number; offY: number; startX: number; startY: number; moved: boolean } | null>(null);

  /** Keep the ref in step with the state synchronously — pointerup needs the final x. */
  const place = useCallback((next: { x: number; y: number }) => {
    posRef.current = next;
    setPos(next);
  }, []);

  // ---- where the pet stands ----
  useEffect(() => {
    place({ x: Math.round(readRatio() * maxX()), y: GROUND });
    setPlaced(true);
  }, [place]);

  useEffect(() => {
    const onResize = () => {
      setVw(window.innerWidth);
      setVh(window.innerHeight);
      place({ x: Math.min(posRef.current.x, maxX()), y: Math.min(posRef.current.y, window.innerHeight - sizeRef.current - GROUND) });
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [place]);

  // ---- drag it around, let go and it falls back to the bottom edge ----
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = e.currentTarget.getBoundingClientRect();
    dragRef.current = {
      offX: e.clientX - rect.left,
      offY: e.clientY - rect.top,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
    };
    setDragging(true);
    setWalking(false);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    if (!d.moved && Math.abs(e.clientX - d.startX) + Math.abs(e.clientY - d.startY) > 3) d.moved = true;
    if (!d.moved) return;
    const x = clamp(e.clientX - d.offX, 8, maxX());
    const top = clamp(e.clientY - d.offY, 8, window.innerHeight - sizeRef.current - GROUND);
    place({ x, y: window.innerHeight - sizeRef.current - top });
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (!d) return;
    setDragging(false);
    if (!d.moved) {
      setOpen((o) => !o);
      return;
    }
    const limit = maxX();
    try {
      localStorage.setItem(POS_KEY, JSON.stringify({ ratio: limit > 0 ? posRef.current.x / limit : 0 }));
    } catch {
      /* not remembered */
    }
    if (posRef.current.y > GROUND + 2) {
      setDropping(true);
      place({ x: posRef.current.x, y: GROUND });
      window.setTimeout(() => setDropping(false), 520);
    }
  };

  // ---- wandering along the bottom edge ----
  const wander = useCallback(() => {
    const limit = maxX();
    const from = posRef.current.x;
    let to = 14 + Math.random() * Math.max(0, limit - 14);
    if (Math.abs(to - from) < 70) {
      to = from < limit / 2 ? Math.min(limit, from + 130 + Math.random() * 170) : Math.max(14, from - 130 - Math.random() * 170);
    }
    setWalking(true);
    place({ x: to, y: GROUND });
    window.setTimeout(() => setWalking(false), 2450);
  }, [place]);

  useEffect(() => {
    if (!placed || open || dragging || dropping) return;
    let timer = 0;
    const tick = () => {
      if (!document.hidden) wander();
      timer = window.setTimeout(tick, 12000 + Math.random() * 16000);
    };
    timer = window.setTimeout(tick, 7000 + Math.random() * 9000);
    return () => window.clearTimeout(timer);
  }, [placed, open, dragging, dropping, wander]);

  // ---- summoning: the sidebar button, 划词, a new question ----
  useEffect(() => {
    const onSummon = () => {
      setOpen(true);
      setWalking(false);
    };
    window.addEventListener(PET_SUMMON_EVENT, onSummon);
    return () => window.removeEventListener(PET_SUMMON_EVENT, onSummon);
  }, []);

  useEffect(() => {
    if (docId) void loadFor(docId);
    else useChatStore.getState().reset();
  }, [docId, loadFor]);

  useEffect(() => {
    if (streaming) setOpen(true);
  }, [streaming]);

  useEffect(() => {
    if (notConfigured) setOpen(true);
  }, [notConfigured]);

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, streamingText, streaming]);

  const mood: PetMood = dragging || dropping
    ? 'idle'
    : streaming
      ? streamingText
        ? 'talk'
        : 'think'
      : walking
        ? 'walk'
        : 'idle';

  // ---- bubble geometry: above the pet, nudged back inside the window ----
  const bubbleW = Math.min(BUBBLE_MAX_W, Math.max(260, vw - 24));
  const bubbleLeft = clamp(pos.x + size / 2 - bubbleW / 2, 10, Math.max(10, vw - bubbleW - 10));
  const bubbleBottom = clamp(pos.y + size + 12, 14, Math.max(14, vh - 200));
  const bubbleMaxH = Math.max(150, Math.min(460, vh - bubbleBottom - 20));
  const tailX = clamp(pos.x + size / 2 - bubbleLeft, 18, bubbleW - 18);

  const doSend = async (text: string) => {
    const msg = text.trim();
    if (!msg || streaming || !docId) return;
    setInput('');
    setHistory(false);
    await send(msg, useViewStore.getState().currentPage);
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制', 'success');
    } catch {
      toast('复制失败：浏览器不允许访问剪贴板', 'error');
    }
  };

  const shown = history ? messages : messages.slice(-2);
  const lastAssistant = messages.map((m) => m.role).lastIndexOf('assistant');

  const setupCard = (
    <div className="pet-setup">
      <p>小页还没接上 AI。阅读助手和翻译分开配置：可以给它单独用一个更擅长讲解的模型，用量也分开统计。</p>
      <div className="pet-setup-actions">
        <button type="button" className="btn btn-primary btn-xs" onClick={() => openSettings('assistant')}>
          去配置
        </button>
        <button
          type="button"
          className="btn btn-xs"
          title="把翻译 API 的服务商、Key、模型复制一份作为阅读助手的独立配置"
          onClick={() => void copyFromTranslation().then(() => refreshSummary())}
        >
          复制翻译 API 的配置
        </button>
      </div>
    </div>
  );

  return (
    <>
      <div
        className={`pet ${walking ? 'is-walking' : ''} ${dragging ? 'is-dragging' : ''} ${dropping ? 'is-dropping' : ''}`}
        style={{ left: pos.x, bottom: pos.y, width: size, height: size, visibility: placed ? 'visible' : 'hidden' }}
      >
        <div
          className="pet-hit"
          role="button"
          tabIndex={0}
          aria-label="小页 · 阅读助手，点击展开对话"
          aria-expanded={open}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setOpen((o) => !o);
            }
          }}
        >
          <PetBody
            src={petSrc}
            mood={mood}
            dragging={dragging}
            dropping={dropping}
            alert={notConfigured && !open}
          />
        </div>
      </div>

      {open && (
        <>
          <div
            className="pet-tail"
            style={{ left: bubbleLeft + tailX - 6, bottom: bubbleBottom - 6 }}
            aria-hidden="true"
          />
          <div
            className="pet-bubble"
            role="dialog"
            aria-label="小页 · 阅读助手"
            style={{
              left: bubbleLeft,
              bottom: bubbleBottom,
              width: bubbleW,
              maxHeight: bubbleMaxH,
            }}
          >
          <div className="pet-bubble-head">
            <span className="pet-name">小页</span>
            {docTitle && (
              <span className="pet-chip" title={docTitle}>
                {short(docTitle)}
              </span>
            )}
            <span className="pet-chip">第 {currentPage} 页</span>
            <span className="pet-head-spacer" />
            <button
              type="button"
              className={`icon-btn ${picking ? 'active' : ''}`}
              title="换装"
              aria-label="换装"
              aria-pressed={picking}
              onClick={() => setPicking((p) => !p)}
            >
              <Icon name="palette" size={14} />
            </button>
            <button
              type="button"
              className={`icon-btn ${history ? 'active' : ''}`}
              title={history ? '只看最近一问一答' : '看完整对话记录'}
              aria-pressed={history}
              onClick={() => setHistory((h) => !h)}
            >
              <Icon name="rows" size={14} />
            </button>
            <button type="button" className="icon-btn" title="收起来" aria-label="收起对话" onClick={() => setOpen(false)}>
              <Icon name="close" size={14} />
            </button>
          </div>

          <div className="pet-bubble-body" ref={bodyRef}>
            {picking ? (
              <>
                <div className="pet-appearance">
                  <div className="pet-field">
                    <span className="pet-field-label">图片网址</span>
                    <div className="pet-field-row">
                      <input
                        className="pet-text"
                        placeholder="https://…/cat.gif"
                        value={urlDraft}
                        spellCheck={false}
                        onChange={(e) => setUrlDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') applyUrl();
                        }}
                      />
                      <button type="button" className="pet-chip-btn" disabled={!urlDraft.trim()} onClick={applyUrl}>
                        应用
                      </button>
                    </div>
                  </div>

                  <div className="pet-field">
                    <span className="pet-field-label">大小 · {size}px</span>
                    <input
                      className="pet-range"
                      type="range"
                      min={PET_SIZE_MIN}
                      max={PET_SIZE_MAX}
                      step={4}
                      value={size}
                      onChange={(e) => applyAppearance({ ...appearance, size: Number(e.target.value) })}
                    />
                  </div>

                  <div className="pet-field-row">
                    <button
                      type="button"
                      className="pet-chip-btn"
                      disabled={uploading}
                      onClick={() => fileRef.current?.click()}
                    >
                      {uploading ? '导入中…' : '选择本地图片 / GIF'}
                    </button>
                    <button
                      type="button"
                      className="pet-chip-btn"
                      disabled={appearance.kind !== 'upload' || stripping}
                      title={
                        appearance.kind === 'upload'
                          ? '把和边框连通的那片背景挖掉，做成透明底'
                          : '只对「选择本地图片」导入的图可用'
                      }
                      onClick={() => void stripCurrent()}
                    >
                      {stripping ? '处理中…' : '去掉背景'}
                    </button>
                    <button
                      type="button"
                      className="pet-chip-btn"
                      disabled={appearance.kind === 'builtin'}
                      onClick={() => void resetAppearance()}
                    >
                      换回大肥鱼
                    </button>
                    <input
                      ref={fileRef}
                      className="pet-import"
                      type="file"
                      accept="image/*"
                      onChange={(e) => {
                        void uploadFile(e.target.files?.[0]);
                        e.target.value = '';
                      }}
                    />
                  </div>

                  {appearance.kind === 'builtin' && (
                    <div className="pet-picker-hint">现在用的是附带的大肥鱼（Twemoji 🐳，CC-BY 4.0）。</div>
                  )}
                  {appearance.kind === 'upload' && (
                    <div className="pet-picker-hint">
                      已保存到本机 data\pet\。导入时已经自动去过一次背景，边上有残留就再点一次「去掉背景」。
                    </div>
                  )}
                  {appearance.kind === 'url' && (
                    <div className="pet-picker-hint">
                      直接引用外部地址，图片换了这边跟着变；外部图片没法在这里去背景，需要透明底请下载后导入。
                    </div>
                  )}
                </div>

                <div className="pet-picker-bar">
                  <span className="pet-picker-hint">
                    程序不内置任何角色。透明底的 PNG / 动态 GIF 效果最好。免费素材可以看
                    <a href="https://www.dicebear.com/styles/" target="_blank" rel="noreferrer">
                      DiceBear
                    </a>
                    、
                    <a href="https://opengameart.org/" target="_blank" rel="noreferrer">
                      OpenGameArt
                    </a>
                    、
                    <a href="https://kenney.nl/assets" target="_blank" rel="noreferrer">
                      Kenney
                    </a>
                    。
                  </span>
                </div>
              </>
            ) : notConfigured ? (
              setupCard
            ) : (
              <>
                {messages.length === 0 &&
                  (loading ? (
                    <div className="pet-empty">正在读这份文档…</div>
                  ) : summaryMd ? (
                    <div className="pet-msg-a">
                      <Markdown text={summaryMd} onPage={requestPageNav} />
                    </div>
                  ) : (
                    <div className="pet-empty">
                      在原文或译文里<strong>选中一段文字</strong>，小页会解释、讲公式或翻译；也可以直接问我。
                    </div>
                  ))}

                {messages.length === 0 && questions.length > 0 && (
                  <div className="pet-chips" style={{ padding: 0 }}>
                    {questions.slice(0, 4).map((q) => (
                      <button key={q} type="button" className="pet-chip-btn" disabled={streaming} onClick={() => void doSend(q)}>
                        {q}
                      </button>
                    ))}
                  </div>
                )}

                {shown.map((m, i) => {
                  const index = messages.length - shown.length + i;
                  if (m.role === 'user') {
                    const { quote, text } = splitQuote(m.content);
                    return (
                      <div key={index} className="pet-msg">
                        <div className="pet-msg-q">
                          {quote && <span className="pet-quote">{quote.length > 220 ? `${quote.slice(0, 220)}…` : quote}</span>}
                          {text}
                        </div>
                      </div>
                    );
                  }
                  return (
                    <div key={index} className="pet-msg">
                      <div className={`pet-msg-a ${m.error ? 'error' : ''}`}>
                        <Markdown text={m.content} onPage={requestPageNav} />
                      </div>
                      {!m.error && (
                        <div className="pet-foot-row">
                          {m.sources && m.sources.length > 0 && (
                            <span className="pet-sources">
                              参考
                              {m.sources.map((p) => (
                                <button key={p} type="button" className="page-ref" onClick={() => requestPageNav(p)}>
                                  p{p}
                                </button>
                              ))}
                            </span>
                          )}
                          <span className="pet-foot-actions">
                            <button
                              type="button"
                              className="icon-btn"
                              title="复制回答"
                              aria-label="复制回答"
                              onClick={() => void copy(m.content)}
                            >
                              <Icon name="copy" size={12} />
                            </button>
                            {index === lastAssistant && (
                              <button
                                type="button"
                                className="icon-btn"
                                title="重新生成"
                                aria-label="重新生成"
                                disabled={streaming}
                                onClick={() => void regenerate(useViewStore.getState().currentPage)}
                              >
                                <Icon name="refresh" size={12} />
                              </button>
                            )}
                          </span>
                        </div>
                      )}
                      {m.error && (
                        <div className="pet-foot-row">
                          <span className="pet-foot-actions">
                            <button type="button" className="btn btn-xs" onClick={() => void regenerate(useViewStore.getState().currentPage)}>
                              重试
                            </button>
                            <button type="button" className="btn btn-xs" onClick={() => openSettings('assistant')}>
                              检查设置
                            </button>
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })}

                {streaming && (
                  <div className="pet-msg">
                    {streamingReasoning && (
                      <details className="pet-thinking" open={!streamingText}>
                        <summary>{streamingText ? `思考过程（${streamingReasoning.length} 字）` : '正在想…'}</summary>
                        <div className="pet-thinking-text">{streamingReasoning}</div>
                      </details>
                    )}
                    <div className="pet-msg-a">
                      {streamingText ? (
                        <>
                          <Markdown text={streamingText} onPage={requestPageNav} />
                          <span className="pet-caret" />
                        </>
                      ) : (
                        <span className="pet-empty">正在想…</span>
                      )}
                    </div>
                    {streamingSources.length > 0 && (
                      <div className="pet-foot-row">参考 {streamingSources.map((p) => `p${p}`).join(' ')}</div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          {!notConfigured && !picking && (
            <div className="pet-chips">
              <button
                type="button"
                className="pet-chip-btn"
                disabled={streaming || !docId}
                onClick={() => void send('总结本页', currentPage, { mode: 'page' })}
              >
                总结本页
              </button>
              <button
                type="button"
                className="pet-chip-btn"
                disabled={streaming || !docId}
                onClick={() => void send('本页自测', currentPage, { mode: 'quiz' })}
              >
                本页自测
              </button>
              <button type="button" className="pet-chip-btn" disabled={loading || !docId} onClick={() => void refreshSummary()}>
                重读总结
              </button>
              <span style={{ flex: 1 }} />
              <button
                type="button"
                className="pet-chip-btn"
                disabled={streaming || messages.length === 0}
                onClick={() => void clear()}
              >
                清空
              </button>
            </div>
          )}

          {!notConfigured && !picking && (
            <div className="pet-input-row">
              <textarea
                className="pet-input"
                rows={1}
                placeholder="问我这份文档…（Enter 发送，Shift+Enter 换行）"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onCompositionStart={() => setComposing(true)}
                onCompositionEnd={() => setComposing(false)}
                onKeyDown={(e) => {
                  // Enter while an IME (拼音) is composing only confirms the candidate
                  if (e.key === 'Enter' && !e.shiftKey && !composing && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                    e.preventDefault();
                    void doSend(input);
                  }
                }}
              />
              <div className="pet-send">
                {streaming ? (
                  <button type="button" className="btn btn-sm" onClick={stop} title="停止生成">
                    <Icon name="stop" size={12} />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={!input.trim() || !docId}
                    title="发送"
                    aria-label="发送"
                    onClick={() => void doSend(input)}
                  >
                    <Icon name="send" size={12} />
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
        </>
      )}
    </>
  );
}
