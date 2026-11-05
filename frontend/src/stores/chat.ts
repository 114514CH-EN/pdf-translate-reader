import { create } from 'zustand';
import { api, streamSSEJson, ApiError } from '../api/client';
import type { AssistantMode, ChatMessage } from '../types';
import { useViewStore } from './view';

export interface SendOptions {
  mode?: AssistantMode;
  /** text the reader selected in the document */
  quote?: string;
}

interface ChatState {
  messages: ChatMessage[];
  summaryMd: string;
  questions: string[];
  summaryError: string;
  /** the assistant has no API of its own yet */
  notConfigured: boolean;
  loading: boolean;
  streaming: boolean;
  streamingText: string;
  streamingSources: number[];
  streamingReasoning: string;
  docId: string | null;

  loadFor: (docId: string) => Promise<void>;
  send: (message: string, pageNo?: number, opts?: SendOptions) => Promise<void>;
  regenerate: (pageNo?: number) => Promise<void>;
  clearHistory: () => Promise<void>;
  refreshSummary: () => Promise<void>;
  stopStreaming: () => void;
  reset: () => void;
}

function errMsg(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

const isNotConfigured = (msg: string) => msg.includes('尚未配置');

let abort: AbortController | null = null;

const EMPTY = {
  messages: [] as ChatMessage[],
  summaryMd: '',
  questions: [] as string[],
  summaryError: '',
  notConfigured: false,
  loading: false,
  streaming: false,
  streamingText: '',
  streamingSources: [] as number[],
  streamingReasoning: '',
};

export const useChatStore = create<ChatState>((set, get) => ({
  ...EMPTY,
  docId: null,

  async loadFor(docId) {
    if (get().docId === docId && (get().loading || get().summaryMd || get().messages.length > 0)) return;
    if (get().docId !== docId && abort) {
      abort.abort();
      abort = null;
    }
    set({ ...EMPTY, docId, loading: true });
    try {
      let summaryError = '';
      const [summary, messages] = await Promise.all([
        api.getSummary(docId).catch((e) => {
          summaryError = errMsg(e);
          return null;
        }),
        api.getChat(docId).catch(() => [] as ChatMessage[]),
      ]);
      if (get().docId !== docId) return; // switched documents meanwhile
      set({
        summaryMd: summary?.summary_md ?? '',
        questions: summary?.questions ?? [],
        summaryError: summaryError && !isNotConfigured(summaryError) ? `无法生成文档总结：${summaryError}` : '',
        notConfigured: isNotConfigured(summaryError),
        messages: Array.isArray(messages) ? messages : [],
        loading: false,
      });
    } catch (e) {
      set({ loading: false });
      useViewStore.getState().toast(`加载阅读助手失败：${errMsg(e)}`, 'error');
    }
  },

  async refreshSummary() {
    const { docId } = get();
    if (!docId) return;
    set({ loading: true, summaryError: '' });
    try {
      const summary = await api.getSummary(docId, true);
      set({ summaryMd: summary.summary_md ?? '', questions: summary.questions ?? [], loading: false, notConfigured: false });
    } catch (e) {
      const m = errMsg(e);
      set({
        loading: false,
        summaryMd: '',
        questions: [],
        notConfigured: isNotConfigured(m),
        summaryError: isNotConfigured(m) ? '' : `无法生成文档总结：${m}`,
      });
    }
  },

  async clearHistory() {
    const { docId } = get();
    if (!docId) return;
    try {
      await api.clearChat(docId);
      set({ messages: [] });
    } catch (e) {
      useViewStore.getState().toast(`清空失败：${errMsg(e)}`, 'error');
    }
  },

  async regenerate(pageNo) {
    const { docId, streaming, messages } = get();
    if (!docId || streaming) return;
    const last = messages[messages.length - 1];
    if (last?.error) {
      // a failed reply was never stored: just ask the last question again
      const q = [...messages].reverse().find((m) => m.role === 'user');
      set({ messages: messages.slice(0, messages.length - 2) });
      if (q) await get().send(q.content, pageNo);
      return;
    }
    try {
      const { question } = await api.dropLastExchange(docId);
      set({ messages: get().messages.slice(0, Math.max(0, get().messages.length - 2)) });
      // stored questions with a quote look like "> quote\n\nquestion"
      const m = /^> ([\s\S]*?)\n\n([\s\S]*)$/.exec(question);
      if (m) await get().send(m[2], pageNo, { quote: m[1] });
      else await get().send(question, pageNo);
    } catch (e) {
      useViewStore.getState().toast(`重新生成失败：${errMsg(e)}`, 'error');
    }
  },

  async send(message, pageNo, opts = {}) {
    const { docId, messages } = get();
    if (!docId || get().streaming) return;
    const shown = opts.quote ? `> ${opts.quote.slice(0, 600)}\n\n${message}` : message;
    set({
      messages: [...messages, { role: 'user', content: shown }],
      streaming: true,
      streamingText: '',
      streamingSources: [],
      streamingReasoning: '',
    });
    abort = new AbortController();
    const finish = (content: string) => {
      set({
        messages: [
          ...get().messages,
          { role: 'assistant', content, sources: get().streamingSources, reasoning: get().streamingReasoning || undefined },
        ],
        streaming: false,
        streamingText: '',
        streamingReasoning: '',
      });
    };
    try {
      await streamSSEJson<{ text?: string; content?: string; sources?: number[]; error?: string }>(
        `/documents/${encodeURIComponent(docId)}/chat`,
        {
          method: 'POST',
          body: { message, page_no: pageNo, mode: opts.mode ?? 'ask', quote: opts.quote },
          signal: abort.signal,
        },
        (event, data) => {
          if (event === 'sources' && Array.isArray(data.sources)) {
            set({ streamingSources: data.sources });
          } else if (event === 'reasoning' && typeof data.text === 'string') {
            set({ streamingReasoning: get().streamingReasoning + data.text });
          } else if (event === 'token' && typeof data.text === 'string') {
            set({ streamingText: get().streamingText + data.text });
          } else if (event === 'done') {
            finish(typeof data.content === 'string' ? data.content : get().streamingText);
          } else if (event === 'error') {
            const errText = typeof data?.error === 'string' ? data.error : '流式响应出错';
            set({
              messages: [...get().messages, { role: 'assistant', content: errText, error: true }],
              streaming: false,
              streamingText: '',
            });
          }
        },
      );
      if (get().streaming) {
        const tail = get().streamingText;
        if (tail) finish(tail);
        else set({ streaming: false, streamingText: '' });
      }
    } catch (e) {
      if (!abort?.signal.aborted) {
        const m = errMsg(e);
        set({
          messages: [...get().messages, { role: 'assistant', content: `没有得到回复：${m}`, error: true }],
          notConfigured: get().notConfigured || isNotConfigured(m),
        });
      }
      set({ streaming: false, streamingText: '' });
    } finally {
      abort = null;
    }
  },

  stopStreaming() {
    if (abort) {
      abort.abort();
      abort = null;
    }
    const tail = get().streamingText;
    if (tail) {
      set({
        messages: [...get().messages, { role: 'assistant', content: tail, sources: get().streamingSources }],
        streaming: false,
        streamingText: '',
      });
    } else {
      set({ streaming: false, streamingText: '' });
    }
  },

  reset() {
    if (abort) {
      abort.abort();
      abort = null;
    }
    set({ ...EMPTY, docId: null });
  },
}));
