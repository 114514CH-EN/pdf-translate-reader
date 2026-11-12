PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    file_path TEXT NOT NULL,
    page_count INTEGER NOT NULL DEFAULT 0,
    source_lang TEXT NOT NULL DEFAULT 'en',
    target_lang TEXT NOT NULL DEFAULT 'zh',
    domain_guess TEXT,
    summary_md TEXT,
    questions_json TEXT,
    status TEXT NOT NULL DEFAULT 'new',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_opened_at TEXT
);

CREATE TABLE IF NOT EXISTS pages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    page_no INTEGER NOT NULL,
    width REAL NOT NULL,
    height REAL NOT NULL,
    extract_json TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    UNIQUE(doc_id, page_no)
);

CREATE TABLE IF NOT EXISTS blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    page_no INTEGER NOT NULL,
    order_idx INTEGER NOT NULL,
    type TEXT NOT NULL DEFAULT 'paragraph',
    level INTEGER NOT NULL DEFAULT 0,
    bbox_json TEXT NOT NULL,
    style_json TEXT,
    meta_json TEXT,
    text TEXT NOT NULL DEFAULT '',
    font_size REAL,
    bold INTEGER NOT NULL DEFAULT 0,
    list_marker TEXT,
    stable_key TEXT NOT NULL,
    UNIQUE(page_id, order_idx)
);

CREATE TABLE IF NOT EXISTS translations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    block_id INTEGER NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
    lang TEXT NOT NULL,
    model TEXT,
    prompt_ver TEXT,
    text TEXT NOT NULL DEFAULT '',
    edited INTEGER NOT NULL DEFAULT 0,
    cache_key TEXT,
    layout_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(block_id, lang)
);

CREATE TABLE IF NOT EXISTS sentences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    block_id INTEGER NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    src_text TEXT NOT NULL,
    tgt_text TEXT NOT NULL DEFAULT '',
    edited INTEGER NOT NULL DEFAULT 0,
    UNIQUE(block_id, idx)
);

CREATE TABLE IF NOT EXISTS glossary (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
    src_term TEXT NOT NULL,
    tgt_term TEXT NOT NULL DEFAULT '',
    note TEXT,
    origin TEXT NOT NULL DEFAULT 'manual',
    status TEXT NOT NULL DEFAULT 'approved',
    frequency INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    page_no INTEGER,
    block_id INTEGER REFERENCES blocks(id) ON DELETE SET NULL,
    content TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    meta_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    total INTEGER NOT NULL DEFAULT 0,
    done INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    params_json TEXT,
    result_json TEXT,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id INTEGER,
    purpose TEXT NOT NULL,              -- translate / assistant / lookup / glossary / polish / summary
    provider TEXT,
    model TEXT,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    cache_hit_tokens INTEGER NOT NULL DEFAULT 0,  -- part of prompt_tokens served from the provider's cache
    peak INTEGER NOT NULL DEFAULT 0,              -- 1: billed at peak-hour prices
    estimated INTEGER NOT NULL DEFAULT 0,  -- 1: provider returned no usage, counted from text
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS highlights (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    page_no INTEGER NOT NULL,
    pane TEXT NOT NULL DEFAULT 'src',   -- src: original pane, tgt: translation pane
    rects_json TEXT NOT NULL,           -- [[x0,y0,x1,y1], ...] in page pt
    text TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT 'yellow',
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_log(created_at);
CREATE INDEX IF NOT EXISTS idx_highlights_doc ON highlights(doc_id, page_no);
CREATE INDEX IF NOT EXISTS idx_blocks_doc_page ON blocks(doc_id, page_no);
CREATE INDEX IF NOT EXISTS idx_translations_block ON translations(block_id);
CREATE INDEX IF NOT EXISTS idx_glossary_doc ON glossary(doc_id);
CREATE INDEX IF NOT EXISTS idx_jobs_doc ON jobs(doc_id);
