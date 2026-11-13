import { useEffect, useRef, useState } from 'react';
import { useChatStore } from '../stores/chat';
import { useSettingsStore } from '../stores/settings';
import { useViewStore } from '../stores/view';
import type { AssistantMode } from '../types';
import { Icon } from './Icon';
import { Markdown } from './Markdown';

const QUICK: { mode: AssistantMode; label: string; title: string }[] = [
  { mode: 'page', label: '总结本页', title: '总结当前页的要点和容易忽略的地方' },
  { mode: 'quiz', label: '本页自测', title: '根据当前页出 3 道自测题（附答案）' },
];

export function AssistantTab({ docId }: { docId: string }) {
  const summaryMd = useChatStore((s) => s.summaryMd);
  const summaryError = useChatStore((s) => s.summaryError);
  const notConfigured = useChatStore((s) => s.notConfigured);
  const questions = useChatStore((s) => s.questions);
  const messages = useChatStore((s) => s.messages);
  const streaming = useChatStore((s) => s.streaming);
  const streamingText = useChatStore((s) => s.streamingText);
  const streamingSources = useChatStore((s) => s.streamingSources);
  const streamingReasoning = useChatStore((s) => s.streamingReasoning);
  const loading = useChatStore((s) => s.loading);
  const loadFor = useChatStore((s) => s.loadFor);
  const send = useChatStore((s) => s.send);
  const regenerate = useChatStore((s) => s.regenerate);
  const stop = useChatStore((s) => s.stopStreaming);
  const clear = useChatStore((s) => s.clearHistory);
  const refreshSummary = useChatStore((s) => s.refreshSummary);
  const requestPageNav = useViewStore((s) => s.requestPageNav);
  const currentPage = useViewStore((s) => s.currentPage);
  const openSettings = useViewStore((s) => s.openSettings);
  const toast = useViewStore((s) => s.toast);
  const settingsOpen = useViewStore((s) => s.settingsOpen);
  const asst = useSettingsStore((s) => s.settings.assistant);
  const loadSettings = useSettingsStore((s) => s.load);
  const copyFromTranslation = useSettingsStore((s) => s.copyAssistantFromTranslation);

  const [input, setInput] = useState('');
  const [composing, setComposing] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void loadFor(docId);
    void loadSettings();
  }, [docId, loadFor, loadSettings]);

  // the reader may have just configured the assistant in 设置 → retry once it closes
  const wasOpen = useRef(settingsOpen);
  useEffect(() => {
    if (wasOpen.current && !settingsOpen && notConfigured) void refreshSummary();
    wasOpen.current = settingsOpen;
  }, [settingsOpen, notConfigured, refreshSummary]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, streamingText]);

  const page = () => useViewStore.getState().currentPage;
  const doSend = async (text: string) => {
    const msg = text.trim();
    if (!msg || streaming) return;
    setInput('');
    await send(msg, page());
  };
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制', 'success');
    } catch {
      toast('复制失败：浏览器不允许访问剪贴板', 'error');
    }
  };

  if (notConfigured) {
    return (
      <div className="assistant-tab">
        <div className="assistant-scroll">
          <div className="card setup-card">
            <div className="card-title">
              阅读助手还没有配置模型
            </div>
            <p>
              阅读助手和翻译分开配置：可以给它用一个更擅长讲解、推理的模型，用量也分开统计。需要填写服务商、API Key 和模型。
            </p>
            <div className="card-actions">
              <button type="button" className="btn btn-primary btn-sm" onClick={() => openSettings('assistant')}>
                去配置
              </button>
              <button
                type="button"
                className="btn btn-sm"
                title="把翻译 API 的服务商、Key、模型复制一份作为阅读助手的独立配置"
                onClick={() => void copyFromTranslation().then(() => refreshSummary())}
              >
                复制翻译 API 的配置
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const lastAssistant = messages.map((m) => m.role).lastIndexOf('assistant');

  return (
    <div className="assistant-tab">
      <div className="assistant-scroll" ref={listRef}>
        {loading && <div className="empty-hint">正在生成文档总结…</div>}
        {!loading && summaryMd && (
          <div className={`card summary-card ${summaryOpen ? '' : 'collapsed'}`}>
            <div className="card-title">
              <button
                type="button"
                className="card-toggle"
                aria-expanded={summaryOpen}
                onClick={() => setSummaryOpen((o) => !o)}
              >
                文档总结
              </button>
              {asst?.model && <span className="model-chip" title="阅读助手使用的模型">{asst.model}</span>}
              <button
                type="button"
                className="icon-btn"
                title="重新生成总结和推荐问题"
                aria-label="重新生成总结"
                onClick={() => void refreshSummary()}
              >
                <Icon name="refresh" size={14} />
              </button>
            </div>
            {summaryOpen && (
              <div className="summary-body">
                <Markdown text={summaryMd} onPage={requestPageNav} />
              </div>
            )}
          </div>
        )}
        {!loading && !summaryMd && summaryError && (
          <div className="card summary-card error">
            <div className="summary-body">{summaryError}</div>
            <div className="card-actions">
              <button type="button" className="btn btn-sm" onClick={() => openSettings('assistant')}>
                打开设置
              </button>
              <button type="button" className="btn btn-sm" onClick={() => void refreshSummary()}>
                重试
              </button>
            </div>
          </div>
        )}
        {messages.length === 0 && questions.length > 0 && (
          <div className="question-chips">
            {questions.map((q, i) => (
              <button key={i} type="button" className="chip" disabled={streaming} onClick={() => void doSend(q)}>
                {q}
              </button>
            ))}
          </div>
        )}
        {messages.length === 0 && !loading && (
          <div className="assistant-tip">
            提示：在原文或译文里<strong>选中一段文字</strong>，可以直接让助手解释、讲公式或翻译。
          </div>
        )}
        <div className="chat-list">
          {messages.map((m, i) => (
            <div key={i} className={`chat-msg ${m.role} ${m.error ? 'error' : ''}`}>
              <div className="chat-role">{m.role === 'user' ? '我' : m.error ? '出错了' : '助手'}</div>
              {m.reasoning && (
                <details className="thinking-box">
                  <summary>思考过程（{m.reasoning.length} 字）</summary>
                  <div className="thinking-text">{m.reasoning}</div>
                </details>
              )}
              <div className="chat-content">
                <Markdown text={m.content} onPage={requestPageNav} />
              </div>
              {m.role === 'assistant' && !m.error && (
                <div className="chat-foot">
                  {m.sources && m.sources.length > 0 && (
                    <span className="chat-sources">
                      参考
                      {m.sources.map((p) => (
                        <button key={p} type="button" className="page-ref" onClick={() => requestPageNav(p)}>
                          p{p}
                        </button>
                      ))}
                    </span>
                  )}
                  <span className="chat-foot-actions">
                    <button type="button" className="icon-btn" title="复制回答" aria-label="复制回答" onClick={() => void copy(m.content)}>
                      <Icon name="copy" size={13} />
                    </button>
                    {i === lastAssistant && (
                      <button
                        type="button"
                        className="icon-btn"
                        title="重新生成这个回答"
                        aria-label="重新生成"
                        disabled={streaming}
                        onClick={() => void regenerate(page())}
                      >
                        <Icon name="refresh" size={13} />
                      </button>
                    )}
                  </span>
                </div>
              )}
              {m.role === 'assistant' && m.error && i === messages.length - 1 && (
                <div className="chat-foot">
                  <span className="chat-foot-actions">
                    <button type="button" className="btn btn-xs" onClick={() => void regenerate(page())}>
                      重试
                    </button>
                    <button type="button" className="btn btn-xs" onClick={() => openSettings('assistant')}>
                      检查设置
                    </button>
                  </span>
                </div>
              )}
            </div>
          ))}
          {streaming && (
            <div className="chat-msg assistant">
              <div className="chat-role">助手</div>
              {streamingReasoning && (
                <details className="thinking-box" open={!streamingText}>
                  <summary>{streamingText ? `思考过程（${streamingReasoning.length} 字）` : '正在思考…'}</summary>
                  <div className="thinking-text">{streamingReasoning}</div>
                </details>
              )}
              <div className="chat-content streaming">
                {streamingText ? <Markdown text={streamingText} onPage={requestPageNav} /> : streamingReasoning ? '' : '正在思考…'}
                <span className="caret" />
              </div>
              {streamingSources.length > 0 && (
                <div className="chat-foot">
                  <span className="chat-sources">参考 {streamingSources.map((p) => `p${p}`).join(' ')}</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="quick-row">
        {QUICK.map((q) => (
          <button
            key={q.mode}
            type="button"
            className="chip chip-sm"
            title={q.title}
            disabled={streaming}
            onClick={() => void send(q.label, page(), { mode: q.mode })}
          >
            {q.label}
          </button>
        ))}
        <span className="quick-page">第 {currentPage} 页</span>
      </div>
      <div className="chat-input-row">
        <textarea
          className="chat-input"
          rows={2}
          placeholder="向阅读助手提问（Enter 发送，Shift+Enter 换行；会参考当前页）"
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
        <div className="chat-actions">
          {streaming ? (
            <button type="button" className="btn btn-sm" onClick={stop}>
              <Icon name="stop" size={13} />
              停止
            </button>
          ) : (
            <button type="button" className="btn btn-primary btn-sm" disabled={!input.trim()} onClick={() => void doSend(input)}>
              <Icon name="send" size={13} />
              发送
            </button>
          )}
          <button
            type="button"
            className="icon-btn"
            title="清空对话记录"
            aria-label="清空对话记录"
            disabled={streaming || messages.length === 0}
            onClick={() => void clear()}
          >
            <Icon name="trash" size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
