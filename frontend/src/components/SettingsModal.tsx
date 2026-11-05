import { useEffect, useState } from 'react';
import { api as apiClient } from '../api/client';
import { KEYLESS_PROVIDERS, MODEL_SUGGESTIONS, PROVIDER_PRESETS, useSettingsStore } from '../stores/settings';
import { useViewStore, type SettingsTab } from '../stores/view';
import type { ApiProvider, AssistantApiSettings, BackupInfo, PricingSettings, ThinkingLevel, UsageSummary } from '../types';
import { THEMES } from '../lib/theme';
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_LABELS,
  comboFromEvent,
  resolveShortcuts,
  type ShortcutAction,
} from '../lib/shortcuts';

function ShortcutEditor({
  value,
  onChange,
}: {
  value: Record<ShortcutAction, string>;
  onChange: (next: Record<ShortcutAction, string>) => void;
}) {
  const [capturing, setCapturing] = useState<ShortcutAction | null>(null);
  const dupes = new Set(
    Object.values(value).filter((v, i, arr) => arr.findIndex((x) => x.toLowerCase() === v.toLowerCase()) !== i),
  );
  return (
    <div className="shortcut-list">
      {(Object.keys(SHORTCUT_LABELS) as ShortcutAction[]).map((a) => (
        <div key={a} className="shortcut-row">
          <span>{SHORTCUT_LABELS[a]}</span>
          <button
            type="button"
            className={`btn btn-sm kbd ${capturing === a ? 'shortcut-capture' : ''} ${dupes.has(value[a]) ? 'dupe' : ''}`}
            title={capturing === a ? '按下新的组合键（Esc 取消）' : '点击后按下新的组合键'}
            onClick={() => setCapturing(a)}
            onBlur={() => setCapturing((c) => (c === a ? null : c))}
            onKeyDown={(e) => {
              if (capturing !== a) return;
              e.preventDefault();
              e.stopPropagation();
              if (e.key === 'Escape') {
                setCapturing(null);
                return;
              }
              const combo = comboFromEvent(e);
              if (!combo) return;
              onChange({ ...value, [a]: combo });
              setCapturing(null);
            }}
          >
            {capturing === a ? '请按键…' : value[a]}
          </button>
          {value[a] !== DEFAULT_SHORTCUTS[a] && (
            <button type="button" className="btn btn-xs" onClick={() => onChange({ ...value, [a]: DEFAULT_SHORTCUTS[a] })}>
              恢复
            </button>
          )}
        </div>
      ))}
      {dupes.size > 0 && <div className="shortcut-warn">有重复的快捷键（标红），只会触发其中一个</div>}
    </div>
  );
}

const LANG_OPTIONS = [
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
];

const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'translate', label: '翻译' },
  { id: 'assistant', label: '阅读助手' },
  { id: 'usage', label: '用量与费用' },
  { id: 'ui', label: '界面' },
  { id: 'data', label: '数据与安全' },
];

const PURPOSE_LABELS: Record<string, string> = {
  translate: '翻译',
  assistant: '阅读助手问答',
  summary: '文档总结',
  lookup: '划词查询',
  glossary: '术语抽取',
  polish: '一致性润色',
  test: '连接测试',
  other: '其他',
};

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`;
  return n.toLocaleString();
}

function fmtCost(v: number | null | undefined, cur: string): string {
  if (v == null) return '—';
  return `${cur}${v < 0.01 && v > 0 ? v.toFixed(4) : v.toFixed(2)}`;
}

/** Peak ranges (given in the provider's UTC offset) as local clock times, e.g. "1:00–4:00、6:00–10:00". */
function localPeak(peak: PricingSettings['peak']): string {
  const off = peak?.utc_offset ?? 8;
  const ranges = peak?.ranges ?? [];
  const fmt = (h: number) => {
    const d = new Date();
    d.setUTCHours(Math.floor(h - off), Math.round((h % 1) * 60), 0, 0);
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  };
  return ranges.map(([a, b]) => `${fmt(a)}–${fmt(b)}`).join('、');
}

/**
 * Model field with 「拉取模型列表」: asks the endpoint for its models (with the values the
 * form shows right now — no need to save first) and lets the reader pick one.
 */
function ModelPicker({
  id,
  value,
  onChange,
  target,
  provider,
  baseUrl,
  keyInput,
  placeholder,
  children,
}: {
  id: string;
  value: string;
  onChange: (m: string) => void;
  target: 'translation' | 'assistant';
  provider: string;
  baseUrl: string;
  keyInput: string;
  placeholder?: string;
  children?: React.ReactNode;
}) {
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState(false);

  // a different endpoint has different models
  useEffect(() => {
    setModels([]);
    setOpen(false);
    setError('');
  }, [provider, baseUrl]);

  const fetchModels = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await apiClient.fetchModels({
        target,
        provider,
        base_url: baseUrl,
        api_key: keyInput.trim() || undefined,
      });
      setModels(r.models);
      setOpen(r.models.length > 0);
      setFilter('');
      if (!r.ok || r.models.length === 0) setError(r.error || '没有拉取到模型');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const q = filter.trim().toLowerCase();
  const shown = q ? models.filter((m) => m.toLowerCase().includes(q)) : models;
  return (
    <>
      <div className="form-row">
        <label htmlFor={id}>模型</label>
        <div className="model-row">
          <input
            id={id}
            type="text"
            list={`${id}-list`}
            value={value}
            placeholder={placeholder}
            onChange={(e) => onChange(e.target.value)}
          />
          <ModelList id={`${id}-list`} provider={provider} fetched={models} />
          <button type="button" className="btn" disabled={busy} onClick={() => void fetchModels()}>
            {busy ? '拉取中…' : '拉取模型列表'}
          </button>
          {children}
        </div>
      </div>
      {error && <div className="test-result bad">拉取模型失败：{error}</div>}
      {open && models.length > 0 && (
        <div className="model-picker">
          <div className="model-picker-head">
            <input
              type="search"
              className="model-picker-filter"
              placeholder={`筛选 ${models.length} 个模型…`}
              aria-label="筛选模型"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <button type="button" className="icon-btn" aria-label="收起模型列表" title="收起" onClick={() => setOpen(false)}>
              ×
            </button>
          </div>
          <div className="model-picker-list" role="listbox" aria-label="可用模型">
            {shown.map((m) => (
              <button
                key={m}
                type="button"
                role="option"
                aria-selected={m === value}
                className={`model-option ${m === value ? 'selected' : ''}`}
                onClick={() => {
                  onChange(m);
                  setOpen(false);
                }}
              >
                {m}
                {MODEL_SUGGESTIONS[provider]?.find((x) => x.id === m) && (
                  <span className="model-option-note">{MODEL_SUGGESTIONS[provider]!.find((x) => x.id === m)!.note}</span>
                )}
              </button>
            ))}
            {shown.length === 0 && <div className="fieldset-hint">没有匹配「{filter}」的模型</div>}
          </div>
        </div>
      )}
    </>
  );
}

function ResultLine({ ok, okText, badText }: { ok: boolean; okText: string; badText: string }) {
  return <div className={`test-result ${ok ? 'ok' : 'bad'}`}>{ok ? okText : badText}</div>;
}

const THINKING_OPTIONS: { value: ThinkingLevel; label: string }[] = [
  { value: 'off', label: '关闭' },
  { value: 'low', label: '开启 · 低强度' },
  { value: 'high', label: '开启 · 高强度' },
  { value: 'max', label: '开启 · 最大强度' },
];

/** <datalist> with the provider's current models plus whatever the API listed. */
function ModelList({ id, provider, fetched = [] }: { id: string; provider: string; fetched?: string[] }) {
  const sugg = MODEL_SUGGESTIONS[provider] ?? [];
  const extra = fetched.filter((m) => !sugg.some((x) => x.id === m));
  return (
    <datalist id={id}>
      {sugg.map((m) => (
        <option key={m.id} value={m.id}>
          {m.note}
        </option>
      ))}
      {extra.map((m) => (
        <option key={m} value={m} />
      ))}
    </datalist>
  );
}

export function SettingsModal() {
  const open = useViewStore((s) => s.settingsOpen);
  const setOpen = useViewStore((s) => s.setSettingsOpen);
  const tab = useViewStore((s) => s.settingsTab);
  const openSettings = useViewStore((s) => s.openSettings);
  const settings = useSettingsStore((s) => s.settings);
  const load = useSettingsStore((s) => s.load);
  const save = useSettingsStore((s) => s.save);
  const saving = useSettingsStore((s) => s.saving);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  if (!open) return null;
  const needsSave = tab !== 'usage' && tab !== 'data';

  return (
    <div className="modal-backdrop" onClick={() => setOpen(false)}>
      <div className="modal modal-wide" role="dialog" aria-label="设置" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>设置</h2>
          <button type="button" className="btn btn-icon" aria-label="关闭" onClick={() => setOpen(false)}>
            ×
          </button>
        </div>
        <div className="settings-layout">
          <nav className="settings-nav" aria-label="设置分类">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`settings-nav-btn ${tab === t.id ? 'active' : ''}`}
                aria-current={tab === t.id ? 'page' : undefined}
                onClick={() => openSettings(t.id)}
              >
                {t.label}
                {t.id === 'assistant' && !settings.assistant?.configured && <span className="nav-dot" title="尚未配置" />}
              </button>
            ))}
          </nav>
          <div className="modal-body settings-body">
            {tab === 'translate' && <TranslateSettings />}
            {tab === 'assistant' && <AssistantSettings />}
            {tab === 'usage' && <UsageSettings />}
            {tab === 'ui' && <UiSettingsPane />}
            {tab === 'data' && <DataSettings />}
          </div>
        </div>
        {needsSave && (
          <div className="modal-foot">
            <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void save({})}>
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function TranslateSettings() {
  const settings = useSettingsStore((s) => s.settings);
  const testing = useSettingsStore((s) => s.testing);
  const testResult = useSettingsStore((s) => s.testResult);
  const testConnection = useSettingsStore((s) => s.testConnection);
  const patchLocal = useSettingsStore((s) => s.patchLocal);
  const apiKeyInput = useSettingsStore((s) => s.apiKeyInput);
  const setApiKeyInput = useSettingsStore((s) => s.setApiKeyInput);
  const api = settings.api;

  const onProviderChange = (value: string) => {
    const preset = PROVIDER_PRESETS.find((p) => p.value === value);
    patchLocal({
      api: { ...api, provider: value as ApiProvider, base_url: preset && preset.value !== 'custom' ? preset.base : api.base_url },
    });
  };
  return (
    <>
      <fieldset className="fieldset">
        <legend>翻译 API</legend>
        <p className="fieldset-hint">用于全文翻译、术语抽取、润色和划词查询。</p>
        <div className="form-row">
          <label htmlFor="set-provider">服务商</label>
          <select id="set-provider" value={api.provider} onChange={(e) => onProviderChange(e.target.value)}>
            {PROVIDER_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        <div className="form-row">
          <label htmlFor="set-baseurl">Base URL</label>
          <input id="set-baseurl" type="text" value={api.base_url} onChange={(e) => patchLocal({ api: { ...api, base_url: e.target.value } })} />
        </div>
        <div className="form-row">
          <label htmlFor="set-apikey">API Key</label>
          <input
            id="set-apikey"
            type="password"
            autoComplete="off"
            placeholder={
              api.api_key_masked
                ? `已加密保存（${api.api_key_masked}）`
                : KEYLESS_PROVIDERS.has(api.provider)
                  ? '本地 AI 一般不需要，可留空'
                  : '输入 API Key'
            }
            value={apiKeyInput}
            onChange={(e) => setApiKeyInput(e.target.value)}
          />
        </div>
        <ModelPicker
          id="set-model"
          target="translation"
          value={api.model}
          onChange={(m) => patchLocal({ api: { ...api, model: m } })}
          provider={api.provider}
          baseUrl={api.base_url}
          keyInput={apiKeyInput}
        >
          <button type="button" className="btn" disabled={testing} onClick={() => void testConnection()}>
            {testing ? '测试中…' : '保存并测试'}
          </button>
        </ModelPicker>
        {testResult && (
          <ResultLine
            ok={testResult.ok}
            okText={`翻译 API 连接成功${testResult.latency_ms != null ? `，延迟 ${testResult.latency_ms}ms` : ''}`}
            badText={`翻译 API 连接失败${testResult.error ? `：${testResult.error}` : ''}`}
          />
        )}

      </fieldset>

      <fieldset className="fieldset">
        <legend>翻译偏好</legend>
        <div className="form-row">
          <label htmlFor="set-lang">目标语言</label>
          <select
            id="set-lang"
            value={settings.translation.target_lang}
            onChange={(e) => patchLocal({ translation: { ...settings.translation, target_lang: e.target.value } })}
          >
            {LANG_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="form-row">
          <label htmlFor="set-style">翻译风格</label>
          <select
            id="set-style"
            value={settings.translation.style}
            onChange={(e) =>
              patchLocal({ translation: { ...settings.translation, style: e.target.value as 'academic' | 'general' } })
            }
          >
            <option value="academic">学术</option>
            <option value="general">通用</option>
          </select>
        </div>
        <div className="form-row">
          <label htmlFor="set-thinking">思考模式</label>
          <select
            id="set-thinking"
            value={settings.translation.thinking ?? 'off'}
            onChange={(e) =>
              patchLocal({ translation: { ...settings.translation, thinking: e.target.value as ThinkingLevel } })
            }
          >
            {THINKING_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.value === 'off' ? '关闭（推荐：翻译更快、更省）' : o.label}
              </option>
            ))}
          </select>
        </div>
        <p className="fieldset-hint">
          DeepSeek V4 默认开启思考模式，会多花不少时间和输出 token；翻译、术语抽取、润色和划词查询默认把它关掉。其他服务商忽略此项。
        </p>
      </fieldset>
    </>
  );
}

function AssistantSettings() {
  const settings = useSettingsStore((s) => s.settings);
  const patchLocal = useSettingsStore((s) => s.patchLocal);
  const keyInput = useSettingsStore((s) => s.assistantKeyInput);
  const setKeyInput = useSettingsStore((s) => s.setAssistantKeyInput);
  const testAssistant = useSettingsStore((s) => s.testAssistant);
  const test = useSettingsStore((s) => s.assistantTest);
  const testing = useSettingsStore((s) => s.assistantTesting);
  const copyFromTranslation = useSettingsStore((s) => s.copyAssistantFromTranslation);
  const asst = settings.assistant as AssistantApiSettings;
  const patch = (p: Partial<AssistantApiSettings>) => patchLocal({ assistant: { ...asst, ...p } });

  return (
    <>
      <fieldset className="fieldset">
        <legend>阅读助手 API（独立配置）</legend>
        <p className="fieldset-hint">
          阅读助手（问答、总结、解释选中内容）只用这里的配置，不会使用翻译 API。适合给它配一个更擅长推理讲解的模型。
        </p>
        {!asst.configured && (
          <div className="setup-hint">
            还没有配置。可以直接填写下面的信息，或
            <button type="button" className="btn btn-xs" onClick={() => void copyFromTranslation()}>
              先复制翻译 API 的配置
            </button>
            再修改。
          </div>
        )}
        <div className="form-row">
          <label htmlFor="set-asst-provider">服务商</label>
          <select
            id="set-asst-provider"
            value={asst.provider}
            onChange={(e) => {
              const preset = PROVIDER_PRESETS.find((p) => p.value === e.target.value);
              patch({ provider: e.target.value, base_url: preset && preset.value !== 'custom' ? preset.base : asst.base_url });
            }}
          >
            {PROVIDER_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        <div className="form-row">
          <label htmlFor="set-asst-url">Base URL</label>
          <input id="set-asst-url" type="text" value={asst.base_url ?? ''} onChange={(e) => patch({ base_url: e.target.value })} />
        </div>
        <div className="form-row">
          <label htmlFor="set-asst-key">API Key</label>
          <input
            id="set-asst-key"
            type="password"
            autoComplete="off"
            placeholder={
              asst.api_key_masked
                ? `已加密保存（${asst.api_key_masked}）`
                : KEYLESS_PROVIDERS.has(asst.provider)
                  ? '本地 AI 一般不需要，可留空'
                  : '阅读助手自己的 API Key'
            }
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
          />
        </div>
        <ModelPicker
          id="set-asst-model"
          target="assistant"
          value={asst.model ?? ''}
          onChange={(m) => patch({ model: m })}
          provider={asst.provider}
          baseUrl={asst.base_url ?? ''}
          keyInput={keyInput}
          placeholder="例如 deepseek-v4-pro / deepseek-flash"
        >
          <button type="button" className="btn" disabled={testing} onClick={() => void testAssistant()}>
            {testing ? '测试中…' : '保存并测试'}
          </button>
        </ModelPicker>
        {!asst.model && !(MODEL_SUGGESTIONS[asst.provider]?.length) && (
          <p className="fieldset-hint warn">还没有填写模型名：点「拉取模型列表」，从这个服务提供的模型里选一个。</p>
        )}
        {test && (
          <ResultLine
            ok={test.ok}
            okText={`阅读助手连接成功${test.latency_ms != null ? `，延迟 ${test.latency_ms}ms` : ''}`}
            badText={`阅读助手连接失败${test.error ? `：${test.error}` : ''}`}
          />
        )}

      </fieldset>

      <fieldset className="fieldset">
        <legend>回答方式</legend>
        <div className="form-row">
          <label htmlFor="set-asst-lang">回答语言</label>
          <select id="set-asst-lang" value={asst.reply_lang ?? ''} onChange={(e) => patch({ reply_lang: e.target.value })}>
            <option value="">跟随翻译目标语言</option>
            {LANG_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="form-row">
          <label htmlFor="set-asst-think">思考模式</label>
          <select
            id="set-asst-think"
            value={asst.thinking ?? 'off'}
            onChange={(e) => patch({ thinking: e.target.value as ThinkingLevel })}
          >
            {THINKING_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        {(asst.thinking ?? 'off') !== 'off' && (
          <p className="fieldset-hint">
            开启后先思考再回答（侧栏可展开看思考过程），讲解推导更可靠，但更慢、输出 token 更多；思考时「创造性」不生效。仅 DeepSeek 支持。
          </p>
        )}
        <div className="form-row">
          <label htmlFor="set-asst-temp">创造性</label>
          <div className="range-row">
            <input
              id="set-asst-temp"
              type="range"
              min={0}
              max={1}
              step={0.1}
              value={asst.temperature ?? 0.3}
              onChange={(e) => patch({ temperature: Number(e.target.value) })}
            />
            <span className="range-value">{(asst.temperature ?? 0.3).toFixed(1)}（低 = 严谨，高 = 发散）</span>
          </div>
        </div>
        <div className="form-row">
          <label htmlFor="set-asst-len">回答长度</label>
          <select id="set-asst-len" value={asst.max_tokens ?? 2048} onChange={(e) => patch({ max_tokens: Number(e.target.value) })}>
            <option value={1024}>简短（约 1k token）</option>
            <option value={2048}>适中（约 2k token）</option>
            <option value={4096}>详细（约 4k token）</option>
            <option value={8192}>很长（约 8k token）</option>
          </select>
        </div>
        <div className="form-row">
          <label htmlFor="set-asst-ctx">参考原文</label>
          <select
            id="set-asst-ctx"
            value={asst.context_chars ?? 12000}
            onChange={(e) => patch({ context_chars: Number(e.target.value) })}
          >
            <option value={6000}>少（约 6 千字，省 token）</option>
            <option value={12000}>适中（约 1.2 万字）</option>
            <option value={24000}>多（约 2.4 万字，回答更全面）</option>
          </select>
        </div>
      </fieldset>
    </>
  );
}

function UsageSettings() {
  const settings = useSettingsStore((s) => s.settings);
  const save = useSettingsStore((s) => s.save);
  const [days, setDays] = useState(30);
  const [data, setData] = useState<UsageSummary | null>(null);
  const [err, setErr] = useState('');
  const [pricing, setPricing] = useState<PricingSettings>(settings.pricing ?? { currency: '¥', models: {} });

  useEffect(() => {
    let live = true;
    apiClient
      .getUsage(days)
      .then((d) => live && setData(d))
      .catch((e) => live && setErr(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [days]);

  const models = Array.from(
    new Set(
      [settings.api.model, settings.assistant?.model, ...Object.keys(pricing.models), ...(data?.groups.map((g) => g.model) ?? [])].filter(
        (m): m is string => !!m,
      ),
    ),
  );
  const setPrice = (model: string, key: 'in' | 'in_hit' | 'out' | 'peak_mult', v: string) => {
    const cur = { ...{ in: 0, out: 0 }, ...pricing.models[model] };
    const next = { ...cur, [key]: v === '' ? undefined : Number(v) || 0 };
    setPricing({ ...pricing, models: { ...pricing.models, [model]: next } });
  };
  const preset = settings.pricing_presets?.deepseek;
  /** DeepSeek official prices — also mapped onto look-alike names used by relay services */
  const fillDeepseek = () => {
    if (!preset) return;
    const next = { ...pricing.models, ...preset.models };
    for (const m of models) {
      const low = m.toLowerCase();
      if (!low.includes('deepseek') || next[m]) continue;
      if (low.includes('flash')) next[m] = { ...preset.models['deepseek-flash'] };
      else if (low.includes('pro')) next[m] = { ...preset.models['deepseek-v4-pro'] };
    }
    setPricing({ ...pricing, currency: '¥', models: next, peak: { ...preset.peak, enabled: true } });
  };
  const priceInput = (m: string, key: 'in' | 'in_hit' | 'out' | 'peak_mult', label: string, step = '0.01') => (
    <input
      type="number"
      min={key === 'peak_mult' ? 1 : 0}
      step={step}
      aria-label={`${m} ${label}`}
      placeholder={key === 'in_hit' ? '同未命中' : key === 'peak_mult' ? '1' : ''}
      value={pricing.models[m]?.[key] ?? ''}
      onChange={(e) => setPrice(m, key, e.target.value)}
    />
  );
  const cur = data?.currency ?? pricing.currency;
  const maxDay = Math.max(1, ...(data?.by_day.map((d) => d.tokens) ?? [1]));

  return (
    <>
      <fieldset className="fieldset">
        <legend>用量</legend>
        <div className="usage-head">
          <div className="usage-total">
            <div className="usage-big">{data ? fmtTokens(data.total_tokens) : '…'}</div>
            <div className="usage-sub">token（最近 {days} 天）</div>
          </div>
          <div className="usage-total">
            <div className="usage-big">{data ? fmtCost(data.total_cost, cur) : '…'}</div>
            <div className="usage-sub">{data?.total_cost == null ? '填写单价后显示费用' : '估算费用'}</div>
          </div>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="统计范围">
            <option value={1}>今天</option>
            <option value={7}>最近 7 天</option>
            <option value={30}>最近 30 天</option>
            <option value={365}>最近一年</option>
          </select>
        </div>
        {err && <div className="test-result bad">{err}</div>}
        {data && data.by_day.length > 1 && (
          <div className="usage-bars" aria-label="每日用量">
            {data.by_day.map((d) => (
              <div key={d.date} className="usage-bar" title={`${d.date}：${fmtTokens(d.tokens)} token`}>
                <span style={{ height: `${Math.max(4, (d.tokens / maxDay) * 100)}%` }} />
              </div>
            ))}
          </div>
        )}
        {data && data.groups.length > 0 ? (
          <table className="usage-table">
            <thead>
              <tr>
                <th>用途</th>
                <th>模型</th>
                <th>调用</th>
                <th>输入</th>
                <th>其中缓存命中</th>
                <th>输出</th>
                <th>费用</th>
              </tr>
            </thead>
            <tbody>
              {data.groups.map((g) => (
                <tr key={`${g.purpose}-${g.model}`}>
                  <td>{PURPOSE_LABELS[g.purpose] ?? g.purpose}</td>
                  <td>{g.model ?? '—'}</td>
                  <td>{g.calls}</td>
                  <td title={g.estimated ? '服务商未返回用量，按字数估算' : undefined}>
                    {fmtTokens(g.prompt_tokens)}
                    {g.estimated ? '*' : ''}
                  </td>
                  <td>{g.cache_hit_tokens ? fmtTokens(g.cache_hit_tokens) : '—'}</td>
                  <td>{fmtTokens(g.completion_tokens)}</td>
                  <td title={g.peak_calls ? `${g.peak_calls} 次在高峰时段` : undefined}>{fmtCost(g.cost, cur)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          data && <p className="fieldset-hint">这段时间还没有调用记录。</p>
        )}
        {data && data.by_doc.length > 0 && (
          <div className="usage-docs">
            <div className="usage-docs-title">按文档</div>
            {data.by_doc.slice(0, 6).map((d) => (
              <div key={d.doc_id} className="usage-doc-row">
                <span className="usage-doc-name">{d.title}</span>
                <span>{fmtTokens(d.tokens)}</span>
                <span>{fmtCost(d.cost, cur)}</span>
              </div>
            ))}
          </div>
        )}
        {data?.groups.some((g) => g.estimated) && <p className="fieldset-hint">* 服务商没有返回用量，按字数估算。</p>}
      </fieldset>

      <fieldset className="fieldset">
        <legend>单价（每 100 万 token，空闲时段）</legend>
        <p className="fieldset-hint">
          价格经常调整，请按服务商官网填写；用中转服务（第三方 API）时按中转商的价格填。填好后用量和「翻译全文」前的估算都会显示费用。
        </p>
        <div className="form-row">
          <label htmlFor="set-currency">货币</label>
          <select id="set-currency" value={pricing.currency} onChange={(e) => setPricing({ ...pricing, currency: e.target.value })}>
            <option value="¥">人民币 ¥</option>
            <option value="$">美元 $</option>
            <option value="£">英镑 £</option>
          </select>
          {preset && (
            <button type="button" className="btn btn-sm" title="deepseek-flash / deepseek-v4-pro 的官方价格，含缓存命中价和高峰翻倍" onClick={fillDeepseek}>
              填入 DeepSeek 官方价格（{preset.as_of}）
            </button>
          )}
        </div>
        <table className="usage-table price-table">
          <thead>
            <tr>
              <th>模型</th>
              <th>输入（未命中）</th>
              <th>输入（缓存命中）</th>
              <th>输出</th>
              <th>高峰倍率</th>
            </tr>
          </thead>
          <tbody>
            {models.map((m) => (
              <tr key={m}>
                <td>{m}</td>
                <td>{priceInput(m, 'in', '输入单价（缓存未命中）')}</td>
                <td>{priceInput(m, 'in_hit', '输入单价（缓存命中）', '0.001')}</td>
                <td>{priceInput(m, 'out', '输出单价')}</td>
                <td>{priceInput(m, 'peak_mult', '高峰倍率', '0.1')}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <label className="inline-check">
          <input
            type="checkbox"
            checked={!!pricing.peak?.enabled}
            onChange={(e) =>
              setPricing({ ...pricing, peak: { ...(preset?.peak ?? {}), ...pricing.peak, enabled: e.target.checked } })
            }
          />
          按 DeepSeek 峰谷时段计价：北京时间周一至周五 9:00–12:00、14:00–18:00 为高峰（价格 × 高峰倍率），其余为空闲
        </label>
        {pricing.peak?.enabled && (
          <p className="fieldset-hint">
            现在是{data?.peak_now ? '高峰' : '空闲'}时段；换算成你电脑的时间，高峰是 {localPeak(pricing.peak)}。法定节假日无法自动识别，按工作日计。
          </p>
        )}
        <div className="card-actions">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => void save({ pricing }).then(() => apiClient.getUsage(days).then(setData))}
          >
            保存单价
          </button>
        </div>
      </fieldset>
    </>
  );
}

function UiSettingsPane() {
  const settings = useSettingsStore((s) => s.settings);
  const patchLocal = useSettingsStore((s) => s.patchLocal);
  return (
    <fieldset className="fieldset">
      <legend>界面</legend>
      <div className="form-row">
        <label htmlFor="set-theme">主题</label>
        <select
          id="set-theme"
          value={(settings.ui?.theme as string) ?? 'system'}
          onChange={(e) => patchLocal({ ui: { ...settings.ui, theme: e.target.value } })}
        >
          {THEMES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}（{t.note}）
            </option>
          ))}
        </select>
      </div>
      <div className="form-row form-row-top">
        <label>快捷键</label>
        <ShortcutEditor
          value={resolveShortcuts(settings.ui?.shortcuts)}
          onChange={(next) => patchLocal({ ui: { ...settings.ui, shortcuts: next } })}
        />
      </div>
    </fieldset>
  );
}

function DataSettings() {
  const [info, setInfo] = useState<{ dir: string; keep: number; items: BackupInfo[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useViewStore((s) => s.toast);
  useEffect(() => {
    void apiClient.listBackups().then(setInfo).catch(() => setInfo(null));
  }, []);
  const backupNow = async () => {
    setBusy(true);
    try {
      const r = await apiClient.createBackup();
      setInfo((i) => (i ? { ...i, items: r.items } : i));
      toast(`已备份：${r.name}`, 'success');
    } catch (e) {
      toast(`备份失败：${e instanceof Error ? e.message : String(e)}`, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <fieldset className="fieldset">
        <legend>自动备份</legend>
        <p className="fieldset-hint">
          每次启动时自动备份文档库（译文、笔记、高亮、术语、设置；最多一小时一次），保留最近 {info?.keep ?? 10} 份。
          恢复方法：关闭程序，用备份文件替换 data\pdf_translate.db 后重新运行 run.bat。
        </p>
        {info && <div className="backup-dir" title="备份文件夹">{info.dir}</div>}
        <div className="backup-list">
          {info?.items.length ? (
            info.items.map((b) => (
              <div key={b.name} className="backup-row">
                <span>{b.created_at.replace('T', ' ')}</span>
                <span className="backup-size">{(b.size / 1024 / 1024).toFixed(1)} MB</span>
              </div>
            ))
          ) : (
            <div className="fieldset-hint">还没有备份。</div>
          )}
        </div>
        <div className="card-actions">
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void backupNow()}>
            {busy ? '备份中…' : '立即备份'}
          </button>
        </div>
      </fieldset>
      <fieldset className="fieldset">
        <legend>API Key 安全</legend>
        <p className="fieldset-hint">
          翻译和阅读助手的 API Key 都加密保存：在 Windows 上使用系统的 DPAPI（与当前 Windows 账户绑定，复制到别的电脑或账户无法解密，需要重新填写）。
          data\config.json 和数据库里都不再有明文 Key。
        </p>
      </fieldset>
    </>
  );
}
