import { create } from 'zustand';
import { api, streamSSEJson, ApiError } from '../api/client';
import type { AssistantMode, ChatMessage } from '../types';
import { useViewStore } from './view';

export interface SendOptions {
  mode?: AssistantMode;
  /** text the reader selected in the document */
  quote?: string;
  /** 讲解这一节: the section's heading block */
  sectionId?: number;
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
// The document summary is written by a model and can take minutes when the model is slow
// or down. Browsers keep at most six connections to one address: a summary request left
// open for every document switched through used them all up, and then even the PDF
// itself waited forever ("正在加载 PDF…"). One at a time, and cancelled on a switch.
let summaryAbort: AbortController | null = null;
const SUMMARY_DELAY = 1200; // flicking through tabs asks for nothing

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
    // already loaded — or the summary already failed for this document: not again on its
    // own every time the panel is opened (that kept calling a model that was down); the
    // panel's 重试 button asks again
    const cur = get();
    if (cur.docId === docId && (cur.loading || cur.summaryMd || cur.messages.length > 0 || cur.summaryError || cur.notConfigured)) return;
    if (get().docId !== docId && abort) {
      abort.abort();
      abort = null;
    }
    summaryAbort?.abort();
    const ctl = new AbortController();
    summaryAbort = ctl;
    set({ ...EMPTY, docId, loading: true });
    try {
      let summaryError = '';
      const summaryLater = async () => {
        await new Promise((r) => window.setTimeout(r, SUMMARY_DELAY));
        if (ctl.signal.aborted || get().docId !== docId) return null;
        return api.getSummary(docId, false, ctl.signal).catch((e) => {
          if (!ctl.signal.aborted) summaryError = errMsg(e);
          return null;
        });
      };
      const [summary, messages] = await Promise.all([summaryLater(), api.getChat(docId).catch(() => [] as ChatMessage[])]);
      if (summaryAbort === ctl) summaryAbort = null;
      if (get().docId !== docId || ctl.signal.aborted) return; // switched documents meanwhile
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
    summaryAbort?.abort();
    const ctl = new AbortController();
    summaryAbort = ctl;
    try {
      const summary = await api.getSummary(docId, true, ctl.signal);
      if (get().docId !== docId) return;
      set({ summaryMd: summary.summary_md ?? '', questions: summary.questions ?? [], loading: false, notConfigured: false });
    } catch (e) {
      if (ctl.signal.aborted || get().docId !== docId) return;
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
          body: { message, page_no: pageNo, mode: opts.mode ?? 'ask', quote: opts.quote, section_id: opts.sectionId },
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
