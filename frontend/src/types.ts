/// <reference types="vite/client" />

// ---- API contract types (FastAPI backend) ----

export type LangCode = string; // 'zh' | 'en' | 'ja' | 'ko' | ...

export interface DocumentRow {
  id: string;
  title: string;
  page_count: number;
  source_lang: string;
  target_lang: string;
  domain_guess: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  last_opened_at: string | null;
}

export interface DocDetail extends DocumentRow {
  summary_md?: string | null;
  domain_guess: string | null;
  /** remembered reading position */
  last_page?: number | null;
  last_frac?: number | null;
}

export type BlockType = 'heading' | 'paragraph' | 'list' | 'table' | 'image' | 'formula' | 'code';

export interface BlockStyle {
  size: number;
  font?: string | null;
  bold?: boolean;
  italic?: boolean;
  /** PDF color int 0xRRGGBB (or hex string). */
  color?: number | string | null;
  align?: string | null;
}

export interface TableCell {
  row: number;
  col: number;
  bbox: [number, number, number, number];
  text: string;
  /** dominant source text color (0xRRGGBB) — e.g. white header text on a dark fill */
  color?: number;
  bold?: boolean;
  colspan?: number;
  /** cell is (mostly) a formula → shown as a crop of the original rendering */
  math?: boolean;
  /** dominant source font size (pt) */
  size?: number;
  /** where the source text sits inside the cell: [left, top, right] gaps in pt */
  inset?: [number, number, number?];
  align?: 'center' | 'right';
}

/** A formula run on the original page; {{id}} placeholders in text refer to it. */
export interface MathRun {
  id: string;
  bbox: [number, number, number, number];
  baseline: number;
  size: number;
}

/** One aligned sentence pair of a block. */
export interface SentencePair {
  idx: number;
  src: string;
  tgt: string;
  edited: boolean;
  /** heuristic alignment (not produced by the model) */
  auto: boolean;
}

/** Figure region detected on the original page (vector drawing / raster image). */
export interface PageFigure {
  bbox: [number, number, number, number];
  url: string;
}

export interface BlockMeta {
  /** source text with formula placeholders {{mN}} */
  ph?: string;
  /** formula blocks: the crop of the original page (padding included), short of the text lines around it */
  crop?: [number, number, number, number];
  math?: MathRun[];
  cells?: TableCell[];
  n_rows?: number;
  n_cols?: number;
  file?: string;
  width?: number;
  height?: number;
  /** numbered / bulleted paragraph: pt from the block's left edge to the text after the marker */
  hang?: number;
  /** extra space (pt) above each numbered item of the block (paragraph spacing) */
  item_gaps?: number[];
  /** code listing: per line box, and where its comment starts (page x `cx`, char index `ci`, colour `cc`) */
  code?: { lines: CodeLine[]; cw?: number };
}

export interface CodeLine {
  y0: number;
  y1: number;
  x0: number;
  x1: number;
  cx?: number;
  ci?: number;
  cc?: number;
}

export interface Block {
  id: string;
  page_no?: number;
  type: BlockType;
  level: number;
  text: string;
  /** PDF pt, y axis pointing down: [x0, y0, x1, y1]. */
  bbox: [number, number, number, number];
  style: BlockStyle;
  meta?: BlockMeta | null;
  font_size?: number | null;
  bold?: boolean | number | null;
  list_marker?: string | null;
  translation: string | null;
  translation_edited: 0 | 1 | boolean;
  translated: boolean;
  sentences?: SentencePair[] | null;
}

export interface PageBlocks {
  page_no: number;
  width: number;
  height: number;
  target_lang: string;
  blocks: Block[];
  /** text-free render of the original page (figures, images, rules, fills); null when the page has no graphics */
  background?: string | null;
  /** full original render of the page (with text) — crops keep formulas pixel-identical */
  original?: string | null;
  figures?: PageFigure[];
}

export interface JobInfo {
  id: string;
  kind: string;
  status: string; // pending | running | done | failed | cancelled
  total: number;
  done: number;
  failed: number;
  error?: string | null;
  params?: Record<string, unknown> | null;
  result?: { failed_ids?: Array<string | number>; changed_ids?: Array<string | number> } | null;
}

export type TranslateScope = 'doc' | 'page' | 'blocks';

export interface TranslateRequest {
  doc_id: string;
  scope: TranslateScope;
  page_no?: number;
  block_ids?: string[];
  force?: boolean;
  target_lang?: string;
}

export type ApiProvider = 'deepseek' | 'openai' | 'qwen' | 'kimi' | 'ollama' | 'lmstudio' | 'custom';

export interface ApiSettings {
  provider: ApiProvider;
  base_url: string;
  api_key_masked: string | null;
  model: string;
  /** Write-only. Send full key to set; omit / null to keep existing. */
  api_key?: string | null;
}

export interface TranslationSettings {
  target_lang: string;
  style: 'academic' | 'general';
  /** thinking mode for translation calls (DeepSeek V4 thinks by default — off is faster and cheaper) */
  thinking?: ThinkingLevel;
}

export interface UiSettings {
  [key: string]: unknown;
}

/** Reading assistant may use its own provider/model/key (e.g. a stronger chat model). */
/** The reading assistant's own API — never shared with translation. */
export interface AssistantApiSettings {
  provider: ApiProvider | string;
  base_url: string;
  model: string;
  api_key_masked: string | null;
  api_key?: string | null;
  configured?: boolean;
  temperature?: number;
  max_tokens?: number;
  context_chars?: number;
  /** '' → the document's target language */
  reply_lang?: string;
  /** DeepSeek V4 thinking mode */
  thinking?: ThinkingLevel;
  copy_from_translation?: boolean;
}

export type ThinkingLevel = 'off' | 'low' | 'high' | 'max';

export interface ModelPrice {
  /** input, cache miss */
  in: number;
  /** input, cache hit (defaults to `in`) */
  in_hit?: number;
  out: number;
  /** peak-hour price = off-peak × peak_mult */
  peak_mult?: number;
}

export interface PeakSchedule {
  enabled: boolean;
  utc_offset?: number;
  weekdays_only?: boolean;
  ranges?: [number, number][];
}

export interface PricingSettings {
  currency: string;
  /** per 1M tokens, keyed by model name ("*" = any model) */
  models: Record<string, ModelPrice>;
  peak?: PeakSchedule;
}

export interface AppSettings {
  api: ApiSettings;
  translation: TranslationSettings;
  ui: UiSettings;
  assistant?: AssistantApiSettings;
  pricing?: PricingSettings;
  pricing_presets?: Record<string, PricingSettings & { as_of?: string }>;
  peak_now?: boolean;
}

export interface UsageGroup {
  purpose: string;
  model: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  cache_hit_tokens: number;
  calls: number;
  peak_calls: number;
  estimated: boolean;
  cost: number | null;
}

export interface UsageSummary {
  days: number;
  currency: string;
  groups: UsageGroup[];
  total_tokens: number;
  total_cost: number | null;
  peak_now: boolean;
  by_day: { date: string; tokens: number }[];
  by_doc: { doc_id: number; title: string; tokens: number; cost: number | null }[];
}

export interface TranslateEstimate {
  blocks: number;
  already_done: number;
  /** already translated, but redone because the glossary / model changed */
  stale: number;
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost: number | null;
  cost_offpeak: number | null;
  /** null when there is no peak pricing */
  cost_peak: number | null;
  peak_now: boolean;
  currency: string;
  model: string | null;
  seconds: number;
}

export interface BackupInfo {
  name: string;
  size: number;
  created_at: string;
}

export interface SearchHit {
  block_id: number;
  page_no: number;
  field: 'src' | 'tgt';
  type: string;
  /** top of the block as a fraction of the page height */
  y: number;
  pre: string;
  match: string;
  post: string;
}

export interface PageProgress {
  page_no: number;
  total: number;
  done: number;
  failed: number;
}

export type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink' | 'orange';

export interface Highlight {
  id: number;
  doc_id: number;
  page_no: number;
  pane: 'src' | 'tgt';
  rects: [number, number, number, number][];
  text: string;
  color: HighlightColor;
  note: string;
  created_at: string;
}

export interface TestConnectionResult {
  ok: boolean;
  latency_ms?: number;
  models?: string[];
  error?: string;
}

export interface SummaryResult {
  summary_md: string;
  questions: string[];
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  /** a failed reply shown inline (not persisted) */
  error?: boolean;
  /** pages the answer was grounded on */
  sources?: number[];
  /** thinking-mode reasoning (only kept for this session) */
  reasoning?: string;
}

export type AssistantMode = 'ask' | 'explain' | 'formula' | 'translate' | 'page' | 'quiz';

export interface Note {
  id: string;
  doc_id: string;
  page_no: number | null;
  block_id: string | null;
  content: string;
  created_at: string;
  updated_at: string;
}

export interface GlossaryTerm {
  id: string;
  doc_id: string;
  src_term: string;
  tgt_term: string;
  note: string | null;
  origin: string | null;
  status: string; // proposed | approved | rejected
  frequency: number | null;
  /** global terms apply to every document; doc terms win on conflicts */
  scope?: 'global' | 'doc';
}

export type ExportFormat = 'md' | 'pdf_translated' | 'pdf_bilingual' | 'pdf_side_by_side' | 'pdf_alternate';
export type ViewMode = 'page' | 'flow';
export type SidebarTab = 'assistant' | 'notes' | 'glossary';

export interface ToastItem {
  id: number;
  kind: 'info' | 'error' | 'success';
  text: string;
}
