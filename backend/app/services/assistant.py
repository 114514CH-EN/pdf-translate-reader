"""Reading assistant: document summary, suggested questions, grounded Q&A."""
from __future__ import annotations

import json
import math
import re
from collections import Counter
from typing import AsyncIterator

from ..db import get_db
from .llm_client import chat_completion, chat_completion_stream, has_credentials
from .settings_store import load_settings

STOP = {
    "the", "a", "an", "and", "or", "of", "to", "in", "is", "are", "for", "on", "with",
    "this", "that", "these", "those", "be", "by", "as", "at", "from", "it", "its",
}


_CJK_RUN = re.compile(r"[\u4e00-\u9fff]+")


def _tokens(text: str) -> list[str]:
    """English words + CJK character bigrams (so Chinese questions match translations)."""
    low = (text or "").lower()
    toks = [t for t in re.findall(r"[a-z0-9]{2,}", low) if t not in STOP]
    for run in _CJK_RUN.findall(low):
        if len(run) == 1:
            toks.append(run)
        toks.extend(run[i:i + 2] for i in range(len(run) - 1))
    return toks


def retrieve_blocks(doc_id: int, query: str, k: int = 8, lang: str = "zh") -> list[dict]:
    """BM25-ish retrieval over source text AND translation of every block."""
    with get_db() as db:
        rows = db.execute(
            "SELECT b.id, b.page_no, b.order_idx, b.type, b.text, t.text AS translation FROM blocks b"
            " LEFT JOIN translations t ON t.block_id=b.id AND t.lang=?"
            " WHERE b.doc_id=? AND b.text != '' AND b.type NOT IN ('image')",
            (lang, doc_id),
        ).fetchall()
    q_terms = _tokens(query)
    if not q_terms:
        return []
    df: Counter = Counter()
    docs = []
    for r in rows:
        toks = _tokens(r["text"]) + _tokens(r["translation"] or "")
        docs.append((dict(r), toks))
        df.update(set(toks))
    n = max(len(docs), 1)
    scored = []
    for d, toks in docs:
        tf = Counter(toks)
        score = 0.0
        for t in set(q_terms):
            if t in tf:
                idf = math.log(1 + (n - df[t] + 0.5) / (df[t] + 0.5))
                score += idf * (tf[t] * 2.2) / (tf[t] + 1.2 * (0.25 + 0.75 * len(toks) / 60))
        if d["type"] == "heading":
            score *= 1.2
        if score > 0:
            scored.append((score, d))
    scored.sort(key=lambda x: -x[0])
    return [d for _, d in scored[:k]]


class AssistantNotConfigured(Exception):
    """The reading assistant has no API configured (it never borrows the translation API)."""


ASSISTANT_DEFAULTS = {
    "provider": "deepseek",
    "base_url": "",
    "model": "",
    "api_key": None,
    "temperature": 0.3,
    "max_tokens": 2048,
    "context_chars": 12000,
    "reply_lang": "",  # "" → the document's translation target language
}


def assistant_config() -> dict:
    """The assistant's own settings (defaults filled in, key decrypted)."""
    stored = (load_settings().get("assistant")) or {}
    a = {**ASSISTANT_DEFAULTS, **{k: v for k, v in stored.items() if v is not None or k == "api_key"}}
    a.pop("same_as_translation", None)  # legacy option: the assistant is always configured separately
    return a


def assistant_settings(doc_id: int | None = None, purpose: str = "assistant") -> dict:
    """LLM cfg for the assistant — its own provider/key/model only."""
    base = load_settings()
    a = assistant_config()
    if a.get("provider") in ("custom", "ollama", "lmstudio") and not (a.get("base_url") or "").strip():
        raise AssistantNotConfigured("阅读助手尚未配置：请在 设置 → 阅读助手 里填写 Base URL 和模型（本地 AI 可以不填 Key）")
    if not has_credentials(a):
        raise AssistantNotConfigured("阅读助手尚未配置：请在 设置 → 阅读助手 API 里单独填写服务商、API Key 和模型")
    from .llm_client import PRESETS

    preset = PRESETS.get(a.get("provider") or "", {})
    if not (a.get("model") or preset.get("default_model")):
        raise AssistantNotConfigured("阅读助手还没有填写模型名：请在 设置 → 阅读助手 → 模型 里填写（可先点「保存并测试」拉取可用模型列表）")
    return {
        "provider": a.get("provider"),
        "base_url": a.get("base_url") or preset.get("base_url") or "",
        "model": a.get("model") or preset.get("default_model") or "",
        "api_key": a.get("api_key"),
        "target_lang": a.get("reply_lang") or base.get("target_lang") or "zh",
        "temperature": float(a.get("temperature") or 0.3),
        "max_tokens": int(a.get("max_tokens") or 2048),
        "context_chars": int(a.get("context_chars") or 12000),
        "pricing": base.get("pricing"),
        "_thinking": a.get("thinking") or "off",
        "_purpose": purpose,
        "_doc_id": doc_id,
    }


async def ensure_summary(doc_id: int) -> dict:
    with get_db() as db:
        doc = db.execute(
            "SELECT title, summary_md, questions_json, domain_guess FROM documents WHERE id=?", (doc_id,)
        ).fetchone()
        if doc is None:
            return {"summary_md": "", "questions": []}
        if doc["summary_md"] and doc["questions_json"]:
            return {"summary_md": doc["summary_md"], "questions": json.loads(doc["questions_json"] or "[]")}
        heads = [
            r["text"].split("\n")[0]
            for r in db.execute(
                "SELECT text FROM blocks WHERE doc_id=? AND type='heading' ORDER BY page_no, order_idx LIMIT 60",
                (doc_id,),
            ).fetchall()
        ]
        body = [
            r["text"]
            for r in db.execute(
                "SELECT text FROM blocks WHERE doc_id=? AND type IN ('paragraph','list') ORDER BY page_no, order_idx LIMIT 60",
                (doc_id,),
            ).fetchall()
        ]

    sample = "\n".join([f"TITLE: {doc['title']}"] + [f"# {h}" for h in heads] + body)
    cfg = {**assistant_settings(doc_id, "summary"), "_thinking": "off"}
    from .prompts import TARGET_NAMES

    reader_lang = TARGET_NAMES.get(cfg.get("target_lang") or "zh", "Simplified Chinese")
    messages = [
        {
            "role": "system",
            "content": (
                "You are a reading assistant helping a university engineering student study a document. "
                "From the document sample produce STRICT JSON: "
                f'{{"summary_md": "<Markdown in {reader_lang}: one sentence on what the document is, then 3-6 '
                'bullet points with the key content / tasks / requirements; keep it under 160 words>", '
                f'"questions": ["<4 short, specific questions in {reader_lang} a student would ask about THIS '
                'document (concepts, how to do a task, what is required)>"]}. '
                "Use $...$ for any math. No commentary outside JSON."
            ),
        },
        {"role": "user", "content": sample[:9000]},
    ]
    content = await chat_completion(cfg, messages, temperature=0.3)
    txt = content.strip()
    if txt.startswith("```"):
        txt = re.sub(r"^```(?:json)?\s*", "", txt)
        txt = re.sub(r"\s*```$", "", txt)
    m = re.search(r"\{[\s\S]*\}", txt)
    data = json.loads(m.group(0) if m else txt)
    summary = str(data.get("summary_md") or "").strip()
    questions = [str(q).strip() for q in data.get("questions") or [] if str(q).strip()][:5]
    with get_db() as db:
        db.execute(
            "UPDATE documents SET summary_md=?, questions_json=?, updated_at=datetime('now') WHERE id=?",
            (summary, json.dumps(questions, ensure_ascii=False), doc_id),
        )
    return {"summary_md": summary, "questions": questions}


MODES = {
    "ask": "",
    "explain": (
        "The reader selected the quoted passage and wants it explained: say what it means in plain words, "
        "define the technical terms, and say why it matters in this document."
    ),
    "formula": (
        "The reader selected a formula / derivation step. Explain every symbol, what the formula expresses, "
        "and how it is derived or used here, step by step with LaTeX math."
    ),
    "translate": "Translate the quoted passage faithfully, then add short notes on any tricky terms.",
    "page": "Summarise the current page: its purpose, the key points / tasks, and anything easy to miss.",
    "quiz": "Write 3 short self-test questions (with answers hidden under a 'Answers' heading) about the current page.",
}


def _with_neighbours(doc_id: int, hits: list[dict], lang: str) -> list[dict]:
    """Add the block right before each hit (headings / lead-in sentences give context)."""
    if not hits:
        return hits
    with get_db() as db:
        out: list[dict] = []
        for h in hits:
            prev = db.execute(
                "SELECT b.id, b.page_no, b.type, b.text, t.text AS translation FROM blocks b"
                " LEFT JOIN translations t ON t.block_id=b.id AND t.lang=?"
                " WHERE b.doc_id=? AND (b.page_no < ? OR (b.page_no = ? AND b.order_idx < ?))"
                " AND b.type NOT IN ('image') ORDER BY b.page_no DESC, b.order_idx DESC LIMIT 1",
                (lang, doc_id, h["page_no"], h["page_no"], h.get("order_idx", 0)),
            ).fetchone()
            if prev:
                out.append(dict(prev))
            out.append(h)
    return out


async def stream_chat(
    doc_id: int,
    message: str,
    page_no: int | None = None,
    *,
    mode: str = "ask",
    quote: str | None = None,
) -> AsyncIterator[str | dict]:
    """Grounded answer stream. Yields {"sources": [...]} first, then text chunks; persists the exchange."""
    from .prompts import TARGET_NAMES

    cfg = assistant_settings(doc_id)
    lang = load_settings().get("target_lang") or "zh"
    reader_lang = TARGET_NAMES.get(cfg["target_lang"], "Simplified Chinese")
    query = " ".join(x for x in (message, quote or "") if x)
    hits = retrieve_blocks(doc_id, query, k=8, lang=lang)
    with get_db() as db:
        doc = db.execute(
            "SELECT title, domain_guess, summary_md FROM documents WHERE id=?", (doc_id,)
        ).fetchone()
        history = db.execute(
            "SELECT role, content FROM chat_messages WHERE doc_id=? ORDER BY id DESC LIMIT 10", (doc_id,)
        ).fetchall()
        heads = [
            f"p{r['page_no']} {r['text'].splitlines()[0][:80]}"
            for r in db.execute(
                "SELECT page_no, text FROM blocks WHERE doc_id=? AND type='heading' ORDER BY page_no, order_idx LIMIT 80",
                (doc_id,),
            )
        ]
        page_rows = []
        if page_no:
            page_rows = [
                dict(r)
                for r in db.execute(
                    "SELECT b.id, b.page_no, b.order_idx, b.type, b.text, t.text AS translation FROM blocks b"
                    " LEFT JOIN translations t ON t.block_id=b.id AND t.lang=?"
                    " WHERE b.doc_id=? AND b.page_no=? AND b.type NOT IN ('image') ORDER BY b.order_idx",
                    (lang, doc_id, page_no),
                )
            ]
    if doc is None:
        raise ValueError("文档不存在")

    def fmt(d: dict) -> str:
        src = re.sub(r"\s+", " ", d["text"])[:700]
        tr = re.sub(r"\s+", " ", d.get("translation") or "")[:400]
        return f"[p{d['page_no']}] {src}" + (f"\n   (译: {tr})" if tr else "")

    # the current page first for page-level modes, retrieval first otherwise
    ordered = (page_rows + _with_neighbours(doc_id, hits, lang)) if mode in ("page", "quiz") \
        else (_with_neighbours(doc_id, hits, lang) + page_rows)
    seen: set = set()
    parts, pages_used = [], []
    budget = cfg["context_chars"]
    for d in ordered:
        if d["id"] in seen:
            continue
        seen.add(d["id"])
        line = fmt(d)
        if budget - len(line) < 0:
            break
        budget -= len(line)
        parts.append(line)
        if d["page_no"] not in pages_used:
            pages_used.append(d["page_no"])
    context = "\n".join(parts)
    yield {"sources": sorted(p for p in pages_used if p)[:12]}

    sys_prompt = (
        f"You are a patient study assistant for the document {doc['title']!r} "
        f"(domain: {doc['domain_guess'] or 'general'}); the reader is a university engineering student. "
        f"Always reply in {reader_lang} unless the user clearly writes in another language. "
        "Ground the answer in the excerpts and cite pages like [p3]. If the excerpts do not cover the question, "
        "say so in one short line and still help from general subject knowledge, clearly marked "
        "(e.g. “（以下为一般知识，文档未直接说明）”). "
        "Format: concise Markdown — short paragraphs, lists, **bold** key terms. Write math in LaTeX: "
        "$...$ inline and $$...$$ for display equations (e.g. $T_{samp}$, $$G(f)e^{-j2\\pi f t_0}$$). "
        "Do not invent page numbers."
    )
    messages = [{"role": "system", "content": sys_prompt}]
    for h in reversed(history):
        messages.append({"role": h["role"], "content": h["content"][:2500]})
    ctx_head = []
    if doc["summary_md"]:
        ctx_head.append(f"Document summary: {doc['summary_md']}")
    if heads:
        ctx_head.append("Outline: " + " | ".join(heads[:50]))
    if page_no:
        ctx_head.append(f"The reader is currently on page {page_no}.")
    task = MODES.get(mode, "")
    q_parts = []
    if quote:
        q_parts.append(f"Selected passage (page {page_no or '?'}):\n\"\"\"\n{quote[:3000]}\n\"\"\"")
    if task:
        q_parts.append(f"Task: {task}")
    q_parts.append(f"Question: {message}")
    messages.append(
        {
            "role": "user",
            "content": "\n".join(ctx_head) + f"\n\nDocument excerpts:\n{context or '(none matched)'}\n\n"
            + "\n\n".join(q_parts),
        }
    )
    chunks: list[str] = []
    try:
        async for chunk in chat_completion_stream(
            cfg, messages, temperature=cfg["temperature"],
            # thinking tokens count against max_tokens on DeepSeek — leave room for the answer
            max_tokens=cfg["max_tokens"] * (4 if cfg["_thinking"] != "off" else 1),
        ):
            if isinstance(chunk, dict):
                yield chunk  # {"reasoning": …}
                continue
            chunks.append(chunk)
            yield chunk
    finally:
        answer = "".join(chunks)
        if answer.strip():  # keep what was generated, also when the reader pressed stop
            user_text = message if not quote else f"> {quote[:600]}\n\n{message}"
            meta = json.dumps({"sources": sorted(p for p in pages_used if p)[:12], "mode": mode})
            with get_db() as db:
                db.execute("INSERT INTO chat_messages (doc_id, role, content) VALUES (?, 'user', ?)",
                           (doc_id, user_text))
                db.execute(
                    "INSERT INTO chat_messages (doc_id, role, content, meta_json) VALUES (?, 'assistant', ?, ?)",
                    (doc_id, answer, meta),
                )


async def lookup(doc_id: int, text: str, page_no: int | None, mode: str = "auto") -> str:
    """Selection lookup with the *translation* API: a word → dictionary entry in context,
    a phrase/sentence → translation. Short, non-streaming."""
    from .prompts import TARGET_NAMES

    base = load_settings()
    if not has_credentials(base):
        raise ValueError("翻译 API 尚未配置（设置 → 翻译 API）")
    cfg = {**base, "_purpose": "lookup", "_doc_id": doc_id}
    lang = base.get("target_lang") or "zh"
    tgt = TARGET_NAMES.get(lang, "Simplified Chinese")
    text = re.sub(r"\s+", " ", text).strip()[:1500]
    context = ""
    with get_db() as db:
        row = None
        if page_no:
            probe = text[:40]
            row = db.execute(
                "SELECT text FROM blocks WHERE doc_id=? AND page_no=? AND instr(replace(text, char(10), ' '), ?) > 0 LIMIT 1",
                (doc_id, page_no, probe),
            ).fetchone()
        if row:
            context = re.sub(r"\s+", " ", row["text"])[:900]
        glossary = db.execute(
            "SELECT src_term, tgt_term FROM glossary WHERE (doc_id=? OR doc_id IS NULL) AND status='approved'"
            " AND instr(lower(?), lower(src_term)) > 0 LIMIT 10",
            (doc_id, text),
        ).fetchall()
    is_word = mode == "define" or (mode == "auto" and len(text.split()) <= 3 and len(text) <= 40)
    gl = "; ".join(f"{g['src_term']} → {g['tgt_term']}" for g in glossary)
    if is_word:
        task = (
            f"Give a compact dictionary entry in {tgt} for the term below: pronunciation (IPA) if it is an English "
            "word, part of speech, the meaning IN THIS CONTEXT first (bold), 1-2 other common meanings, and "
            "one short example. Use Markdown, max 90 words."
        )
    else:
        task = (
            f"Translate the passage below into {tgt} accurately (technical register). Output the translation, "
            "then — only if useful — one line '术语：' listing up to 3 key terms with their translations."
        )
    messages = [
        {"role": "system", "content": "You are a precise bilingual technical dictionary and translator. "
                                      "Write math as LaTeX in $...$."},
        {"role": "user", "content": task + (f"\nGlossary to follow: {gl}" if gl else "")
         + (f"\n\nContext sentence: {context}" if context else "") + f"\n\nText: {text}"},
    ]
    return (await chat_completion(cfg, messages, temperature=0.1, max_tokens=600)).strip()
