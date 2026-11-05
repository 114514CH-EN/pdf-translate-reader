import { create } from 'zustand';
import { api, ApiError } from '../api/client';
import type { AppSettings, AssistantApiSettings, TestConnectionResult } from '../types';
import { useViewStore } from './view';

export const PROVIDER_PRESETS: { value: string; label: string; base: string }[] = [
  { value: 'deepseek', label: 'DeepSeek', base: 'https://api.deepseek.com' },
  { value: 'openai', label: 'OpenAI', base: 'https://api.openai.com/v1' },
  { value: 'qwen', label: '通义千问', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { value: 'kimi', label: 'Kimi', base: 'https://api.moonshot.cn/v1' },
  { value: 'ollama', label: 'Ollama（本地）', base: 'http://127.0.0.1:11434/v1' },
  { value: 'lmstudio', label: 'LM Studio（本地）', base: 'http://127.0.0.1:1234/v1' },
  { value: 'custom', label: '自定义', base: '' },
];

/** model names offered in the model fields (free text is still allowed) */
/** providers that usually run without an API key */
export const KEYLESS_PROVIDERS = new Set(['ollama', 'lmstudio', 'custom']);

export const MODEL_SUGGESTIONS: Record<string, { id: string; note: string }[]> = {
  deepseek: [
    { id: 'deepseek-flash', note: '快、便宜，适合翻译' },
    { id: 'deepseek-v4-pro', note: '更强的推理，适合阅读助手' },
  ],
};

const DEFAULT_SETTINGS: AppSettings = {
  api: {
    provider: 'deepseek',
    base_url: 'https://api.deepseek.com',
    api_key_masked: null,
    model: 'deepseek-flash',
    api_key: null,
  },
  translation: { target_lang: 'zh', style: 'academic', thinking: 'off' },
  ui: {},
  assistant: {
    provider: 'deepseek',
    base_url: 'https://api.deepseek.com',
    model: '',
    api_key_masked: null,
    thinking: 'off',
    temperature: 0.3,
    max_tokens: 2048,
    context_chars: 12000,
    reply_lang: '',
  },
  pricing: { currency: '¥', models: {}, peak: { enabled: false } },
};

interface SettingsState {
  settings: AppSettings;
  loading: boolean;
  saving: boolean;
  testing: boolean;
  testResult: TestConnectionResult | null;
  /** transient api key typed by the user (never persisted in the store from server) */
  apiKeyInput: string;
  assistantKeyInput: string;
  assistantTest: TestConnectionResult | null;
  assistantTesting: boolean;
  loaded: boolean;

  load: () => Promise<void>;
  save: (patch: Partial<AppSettings>) => Promise<boolean>;
  setApiKeyInput: (v: string) => void;
  setAssistantKeyInput: (v: string) => void;
  testAssistant: () => Promise<void>;
  /** one-off: copy the translation API (incl. key) into the assistant's own settings */
  copyAssistantFromTranslation: () => Promise<void>;
  patchLocal: (patch: Partial<AppSettings>) => void;
  testConnection: () => Promise<TestConnectionResult | null>;
}

function errMsg(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loading: false,
  saving: false,
  testing: false,
  testResult: null,
  apiKeyInput: '',
  assistantKeyInput: '',
  assistantTest: null,
  assistantTesting: false,
  loaded: false,

  async load() {
    if (get().loaded || get().loading) return;
    set({ loading: true });
    try {
      const settings = await api.getSettings();
      set({
        settings: {
          ...settings,
          api: { ...settings.api, api_key: null },
        },
        loading: false,
        loaded: true,
      });
    } catch (e) {
      set({ loading: false });
      useViewStore.getState().toast(`读取设置失败：${errMsg(e)}`, 'error');
    }
  },

  async save(patch) {
    const merged: AppSettings = {
      ...get().settings,
      ...patch,
      api: { ...get().settings.api, ...(patch.api ?? {}) },
      translation: { ...get().settings.translation, ...(patch.translation ?? {}) },
      ui: { ...get().settings.ui, ...(patch.ui ?? {}) },
      assistant: { ...(DEFAULT_SETTINGS.assistant as AssistantApiSettings), ...get().settings.assistant, ...(patch.assistant ?? {}) },
    };
    // api_key is write-only: send full key only if user typed one
    const apiKey = get().apiKeyInput.trim();
    const assistantKey = get().assistantKeyInput.trim();
    const body: AppSettings = {
      ...merged,
      api: {
        provider: merged.api.provider,
        base_url: merged.api.base_url,
        api_key_masked: merged.api.api_key_masked,
        model: merged.api.model,
        api_key: apiKey.length > 0 ? apiKey : null,
      },
      assistant: { ...merged.assistant!, api_key: assistantKey.length > 0 ? assistantKey : null },
      pricing: merged.pricing,
    };
    set({ saving: true });
    try {
      const saved = await api.putSettings(body);
      set({
        settings: { ...saved, api: { ...saved.api, api_key: null } },
        apiKeyInput: '',
        assistantKeyInput: '',
        saving: false,
      });
      useViewStore.getState().toast('设置已保存', 'success');
      return true;
    } catch (e) {
      set({ saving: false });
      useViewStore.getState().toast(`保存设置失败：${errMsg(e)}`, 'error');
      return false;
    }
  },

  setApiKeyInput: (v) => set({ apiKeyInput: v }),
  setAssistantKeyInput: (v) => set({ assistantKeyInput: v }),

  async copyAssistantFromTranslation() {
    try {
      const saved = await api.putSettings({ assistant: { copy_from_translation: true } } as unknown as AppSettings);
      set({ settings: { ...get().settings, assistant: saved.assistant }, assistantTest: null });
      useViewStore.getState().toast('已把翻译 API 复制为阅读助手的独立配置，可以再单独修改', 'success');
    } catch (e) {
      useViewStore.getState().toast(`复制失败：${errMsg(e)}`, 'error');
    }
  },

  async testAssistant() {
    const okSave = await get().save({});
    if (!okSave) return;
    set({ assistantTesting: true, assistantTest: null });
    try {
      set({ assistantTest: await api.testAssistantConnection(), assistantTesting: false });
    } catch (e) {
      set({ assistantTest: { ok: false, error: errMsg(e) }, assistantTesting: false });
    }
  },

  patchLocal(patch) {
    const cur = get().settings;
    set({
      settings: {
        ...cur,
        ...patch,
        api: { ...cur.api, ...(patch.api ?? {}) },
        translation: { ...cur.translation, ...(patch.translation ?? {}) },
        ui: { ...cur.ui, ...(patch.ui ?? {}) },
        assistant: { ...(cur.assistant as AssistantApiSettings), ...(patch.assistant ?? {}) },
        pricing: { ...(cur.pricing ?? { currency: '¥', models: {} }), ...(patch.pricing ?? {}) },
      },
    });
  },

  async testConnection() {
    // persist current form first so backend tests what the user sees
    const okSave = await get().save({});
    if (!okSave) return null;
    set({ testing: true, testResult: null });
    try {
      const result = await api.testConnection();
      set({ testing: false, testResult: result });
      return result;
    } catch (e) {
      const result: TestConnectionResult = { ok: false, error: errMsg(e) };
      set({ testing: false, testResult: result });
      return result;
    }
  },
}));
