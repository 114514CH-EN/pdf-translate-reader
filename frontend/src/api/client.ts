import type {
  AppSettings,
  BackupInfo,
  Highlight,
  HighlightColor,
  BlockLayout,
  ImageTranslation,
  ReplaceResult,
  PageProgress,
  SearchHit,
  TranslateEstimate,
  UsageSummary,
  ChatMessage,
  DocDetail,
  DocumentRow,
  ExportFormat,
  GlossaryTerm,
  JobInfo,
  Note,
  PageBlocks,
  SummaryResult,
  TestConnectionResult,
  TranslateRequest,
} from '../types';

const BASE = '/api';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function parseError(res: Response): Promise<ApiError> {
  let msg = `请求失败 (${res.status})`;
  try {
    const data: unknown = await res.json();
    if (data && typeof data === 'object') {
      const obj = data as Record<string, unknown>;
      if (typeof obj.detail === 'string') msg = obj.detail;
      else if (typeof obj.error === 'string') msg = obj.error;
    }
  } catch {
    /* non-JSON error body */
  }
  return new ApiError(msg, res.status);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BASE + path, init);
  } catch (e) {
    throw new ApiError(e instanceof Error ? e.message : '网络错误', 0);
  }
  if (!res.ok) throw await parseError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

// ---------- endpoints ----------

export const api = {
  listDocuments(): Promise<DocumentRow[]> {
    return request<DocumentRow[]>('/documents');
  },

  async uploadDocument(file: File): Promise<{ doc_id: string; warning?: string | null }> {
    const form = new FormData();
    form.append('file', file);
    let res: Response;
    try {
      res = await fetch(BASE + '/documents', { method: 'POST', body: form });
    } catch (e) {
      throw new ApiError(e instanceof Error ? e.message : '网络错误', 0);
    }
    if (!res.ok) throw await parseError(res);
    return (await res.json()) as { doc_id: string; warning?: string | null };
  },

  getDocument(id: string): Promise<DocDetail> {
    return request<DocDetail>(`/documents/${encodeURIComponent(id)}`);
  },

  deleteDocument(id: string): Promise<void> {
    return request<void>(`/documents/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  /** 从零开始: a document of empty pages */
  createBlank(title: string): Promise<{ doc_id: string }> {
    return request<{ doc_id: string }>('/documents/blank', jsonInit('POST', { title }));
  },
  addPage(docId: string): Promise<{ page_no: number; page_count: number }> {
    return request(`/documents/${encodeURIComponent(docId)}/pages`, jsonInit('POST', {}));
  },
  /** a text box of the reader's own on a page (kept like an edit of the original) */
  addTextBlock(docId: string, pageNo: number, bbox: number[], text: string, size = 12): Promise<{ block_id: string }> {
    return request(`/documents/${encodeURIComponent(docId)}/pages/${pageNo}/blocks`, jsonInit('POST', { bbox, text, size }));
  },

  documentFileUrl(id: string): string {
    return `${BASE}/documents/${encodeURIComponent(id)}/file`;
  },

  imageUrl(docId: string, fname: string): string {
    return `${BASE}/documents/${encodeURIComponent(docId)}/images/${encodeURIComponent(fname)}`;
  },

  /** 「翻译图片文字」 for one picture of a page */
  translateImage(docId: string, pageNo: number, blockId: string): Promise<ImageTranslation | null> {
    return request<ImageTranslation | null>(
      `/documents/${encodeURIComponent(docId)}/pages/${pageNo}/images/${encodeURIComponent(blockId)}/translate`,
      { method: 'POST' },
    );
  },
  deleteImageTranslation(docId: string, pageNo: number, blockId: string): Promise<{ ok: boolean }> {
    return request(`/documents/${encodeURIComponent(docId)}/pages/${pageNo}/images/${encodeURIComponent(blockId)}/translation`, {
      method: 'DELETE',
    });
  },

  getPageBlocks(id: string, pageNo: number, lang?: string): Promise<PageBlocks> {
    const q = lang ? `?lang=${encodeURIComponent(lang)}` : '';
    return request<PageBlocks>(`/documents/${encodeURIComponent(id)}/pages/${pageNo}/blocks${q}`);
  },

  translate(body: TranslateRequest): Promise<{ job_id: string }> {
    return request<{ job_id: string }>('/translate', jsonInit('POST', body));
  },

  getJob(jobId: string): Promise<JobInfo> {
    return request<JobInfo>(`/jobs/${encodeURIComponent(jobId)}`);
  },

  cancelJob(jobId: string): Promise<void> {
    return request<void>(`/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' });
  },

  /** lang "__src__" stores an edit of the original text instead of a translation */
  putTranslation(blockId: string, text: string, lang?: string): Promise<void> {
    return request<void>(
      `/blocks/${encodeURIComponent(blockId)}/translation`,
      jsonInit('PUT', lang ? { text, lang } : { text }),
    );
  },

  /** 公式编辑: the picture of a rewritten formula (for PDF export) */
  async putFormulaImage(blockId: string, tex: string, png: Blob): Promise<void> {
    const bytes = new Uint8Array(await png.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return request<void>(`/blocks/${encodeURIComponent(blockId)}/formula-image`, jsonInit('PUT', { tex, png: btoa(bin) }));
  },

  /** edit mode: formatting of a translated block; null clears it */
  putLayout(blockId: string, layout: BlockLayout | null, lang?: string): Promise<void> {
    return request<void>(`/blocks/${encodeURIComponent(blockId)}/layout`, jsonInit('PUT', lang ? { layout, lang } : { layout }));
  },
  /** find (and replace) in every translation of a document */
  replaceInTranslations(
    docId: string,
    body: { find: string; replace: string; dry_run?: boolean; case_sensitive?: boolean },
  ): Promise<ReplaceResult> {
    return request<ReplaceResult>(`/documents/${encodeURIComponent(docId)}/replace`, jsonInit('POST', body));
  },

  retranslateBlock(blockId: string): Promise<{ job_id: string }> {
    return request<{ job_id: string }>(
      `/blocks/${encodeURIComponent(blockId)}/retranslate`,
      { method: 'POST' },
    );
  },

  getSettings(): Promise<AppSettings> {
    return request<AppSettings>('/settings');
  },

  putSettings(body: AppSettings): Promise<AppSettings> {
    return request<AppSettings>('/settings', jsonInit('PUT', body));
  },

  testConnection(): Promise<TestConnectionResult> {
    return request<TestConnectionResult>('/settings/test-connection', { method: 'POST' });
  },

  getSummary(id: string, refresh = false): Promise<SummaryResult> {
    return request<SummaryResult>(`/documents/${encodeURIComponent(id)}/summary${refresh ? '?refresh=true' : ''}`);
  },

  clearChat(id: string): Promise<void> {
    return request<void>(`/documents/${encodeURIComponent(id)}/chat`, { method: 'DELETE' });
  },

  testAssistantConnection(): Promise<TestConnectionResult> {
    return request<TestConnectionResult>('/settings/test-connection', jsonInit('POST', { target: 'assistant' }));
  },

  dropLastExchange(id: string): Promise<{ question: string }> {
    return request(`/documents/${encodeURIComponent(id)}/chat/last`, { method: 'DELETE' });
  },

  lookup(id: string, text: string, pageNo?: number, mode: 'auto' | 'define' | 'translate' = 'auto'): Promise<{ result_md: string }> {
    return request(`/documents/${encodeURIComponent(id)}/lookup`, jsonInit('POST', { text, page_no: pageNo, mode }));
  },

  search(id: string, q: string): Promise<{ q: string; total: number; results: SearchHit[] }> {
    return request(`/documents/${encodeURIComponent(id)}/search?q=${encodeURIComponent(q)}`);
  },

  progress(id: string): Promise<{ pages: PageProgress[]; job_status: string | null }> {
    return request(`/documents/${encodeURIComponent(id)}/progress`);
  },

  translateEstimate(id: string, scope: 'doc' | 'page', pageNo?: number, force = false): Promise<TranslateEstimate> {
    const q = new URLSearchParams({ scope, force: String(force) });
    if (pageNo) q.set('page_no', String(pageNo));
    return request(`/documents/${encodeURIComponent(id)}/translate-estimate?${q}`);
  },

  savePosition(id: string, page: number, frac: number): Promise<void> {
    return request(`/documents/${encodeURIComponent(id)}/position`, jsonInit('PUT', { page, frac }));
  },

  listHighlights(docId: string): Promise<Highlight[]> {
    return request(`/highlights?doc_id=${encodeURIComponent(docId)}`);
  },

  createHighlight(body: {
    doc_id: string;
    page_no: number;
    pane: 'src' | 'tgt';
    rects: number[][];
    text: string;
    color: HighlightColor;
    note?: string;
  }): Promise<Highlight> {
    return request('/highlights', jsonInit('POST', body));
  },

  updateHighlight(id: number, body: { note?: string; color?: HighlightColor }): Promise<Highlight> {
    return request(`/highlights/${id}`, jsonInit('PUT', body));
  },

  deleteHighlight(id: number): Promise<void> {
    return request(`/highlights/${id}`, { method: 'DELETE' });
  },

  /** 拉取模型列表 — uses the unsaved form values when given */
  fetchModels(body: {
    target: 'translation' | 'assistant';
    provider?: string;
    base_url?: string;
    api_key?: string;
  }): Promise<{ ok: boolean; models: string[]; error?: string }> {
    return request('/settings/models', jsonInit('POST', body));
  },

  getUsage(days = 30): Promise<UsageSummary> {
    return request(`/settings/usage?days=${days}`);
  },

  listBackups(): Promise<{ dir: string; keep: number; items: BackupInfo[] }> {
    return request('/settings/backups');
  },

  /** stop the local server (the 「退出程序」 button) */
  shutdown(): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/shutdown', { method: 'POST', headers: { 'X-PDFTR-Shutdown': '1' } });
  },
  createBackup(): Promise<{ name: string; items: BackupInfo[] }> {
    return request('/settings/backups', { method: 'POST' });
  },

  getChat(id: string): Promise<ChatMessage[]> {
    return request<ChatMessage[]>(`/documents/${encodeURIComponent(id)}/chat`);
  },

  listNotes(docId: string): Promise<Note[]> {
    return request<Note[]>(`/notes?doc_id=${encodeURIComponent(docId)}`);
  },

  createNote(body: {
    doc_id: string;
    page_no?: number | null;
    block_id?: string | null;
    content: string;
  }): Promise<Note> {
    return request<Note>('/notes', jsonInit('POST', body));
  },

  updateNote(id: string, body: Partial<Pick<Note, 'content' | 'page_no' | 'block_id'>>): Promise<Note> {
    return request<Note>(`/notes/${encodeURIComponent(id)}`, jsonInit('PUT', body));
  },

  deleteNote(id: string): Promise<void> {
    return request<void>(`/notes/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  listGlossary(docId: string): Promise<GlossaryTerm[]> {
    return request<GlossaryTerm[]>(`/glossary?doc_id=${encodeURIComponent(docId)}`);
  },

  createGlossary(body: {
    doc_id: string;
    src_term: string;
    tgt_term: string;
    note?: string;
    status?: string;
  }): Promise<GlossaryTerm> {
    return request<GlossaryTerm>('/glossary', jsonInit('POST', body));
  },

  updateGlossary(
    id: string,
    body: Partial<Pick<GlossaryTerm, 'src_term' | 'tgt_term' | 'note' | 'status'>> & {
      scope?: 'global' | 'doc';
      doc_id?: string;
    },
  ): Promise<GlossaryTerm> {
    return request<GlossaryTerm>(`/glossary/${encodeURIComponent(id)}`, jsonInit('PUT', body));
  },

  deleteGlossary(id: string): Promise<void> {
    return request<void>(`/glossary/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  async importGlossary(file: File, docId?: string, scope: 'global' | 'doc' = 'doc'): Promise<unknown> {
    const form = new FormData();
    form.append('file', file);
    const q = new URLSearchParams({ scope });
    if (docId) q.set('doc_id', docId);
    let res: Response;
    try {
      res = await fetch(BASE + '/glossary/import?' + q.toString(), { method: 'POST', body: form });
    } catch (e) {
      throw new ApiError(e instanceof Error ? e.message : '网络错误', 0);
    }
    if (!res.ok) throw await parseError(res);
    try {
      return (await res.json()) as unknown;
    } catch {
      return undefined;
    }
  },

  exportDocument(id: string, format: ExportFormat, fallbackName: string): Promise<void> {
    return downloadBlob(
      `/documents/${encodeURIComponent(id)}/export`,
      jsonInit('POST', { format }),
      fallbackName,
    );
  },

  exportGlossary(docId: string, fallbackName: string): Promise<void> {
    return downloadBlob(
      `/glossary/export?doc_id=${encodeURIComponent(docId)}`,
      { method: 'GET' },
      fallbackName,
    );
  },

  polish(id: string): Promise<{ job_id: string }> {
    return request<{ job_id: string }>(`/documents/${encodeURIComponent(id)}/polish`, { method: 'POST' });
  },

  putSentence(blockId: string, idx: number, text: string): Promise<{ ok: boolean; translation: string }> {
    return request<{ ok: boolean; translation: string }>(
      `/blocks/${encodeURIComponent(blockId)}/sentences/${idx}`,
      jsonInit('PUT', { text }),
    );
  },

  extractTerms(id: string): Promise<{ job_id: string }> {
    return request<{ job_id: string }>(
      `/documents/${encodeURIComponent(id)}/extract-terms`,
      { method: 'POST' },
    );
  },
};

// ---------- blob download ----------

function filenameFromDisposition(cd: string | null, fallback: string): string {
  if (!cd) return fallback;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      /* keep fallback below */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(cd);
  return plain ? plain[1] : fallback;
}

export async function downloadBlob(
  path: string,
  init: RequestInit,
  fallbackName: string,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(BASE + path, init);
  } catch (e) {
    throw new ApiError(e instanceof Error ? e.message : '网络错误', 0);
  }
  if (!res.ok) throw await parseError(res);
  const blob = await res.blob();
  const name = filenameFromDisposition(res.headers.get('Content-Disposition'), fallbackName);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---------- SSE helper (fetch-based; works for GET and POST streams) ----------

export interface SSEHandlers {
  onEvent: (event: string, data: string) => void;
}

export async function streamSSE(
  path: string,
  opts: { method?: string; body?: unknown; signal?: AbortSignal },
  handlers: SSEHandlers,
): Promise<void> {
  const hasBody = opts.body !== undefined;
  const init: RequestInit = {
    method: opts.method ?? 'GET',
    signal: opts.signal,
  };
  if (hasBody) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(BASE + path, init);
  } catch (e) {
    if (opts.signal?.aborted) return;
    throw new ApiError(e instanceof Error ? e.message : '网络错误', 0);
  }
  if (!res.ok) throw await parseError(res);
  if (!res.body) throw new ApiError('响应无数据流', 0);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let ev = 'message';
  let dataLines: string[] = [];

  const dispatch = (): void => {
    if (dataLines.length === 0) return;
    const data = dataLines.join('\n');
    dataLines = [];
    handlers.onEvent(ev, data);
    ev = 'message';
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line === '') {
        dispatch();
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      let val = colon < 0 ? '' : line.slice(colon + 1);
      if (val.startsWith(' ')) val = val.slice(1);
      if (field === 'event') ev = val;
      else if (field === 'data') dataLines.push(val);
    }
  }
  dispatch();
}

/** Convenience: SSE stream where every event data payload is JSON. */
export async function streamSSEJson<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown; signal?: AbortSignal },
  onEvent: (event: string, data: T) => void,
): Promise<void> {
  await streamSSE(path, opts, {
    onEvent: (event, data) => {
      let parsed: T;
      try {
        parsed = JSON.parse(data) as T;
      } catch {
        parsed = data as unknown as T;
      }
      onEvent(event, parsed);
    },
  });
}
