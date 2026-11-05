"""Upfront domain term extraction feeding the glossary."""
from __future__ import annotations

import asyncio
import re
from collections import Counter

from ..db import get_db
from . import prompts
from .llm_client import chat_completion
from .settings_store import bump_glossary_rev, load_settings
from .translate_worker import _job_update, create_job

STOPWORDS = {
    "the", "and", "for", "with", "that", "this", "from", "are", "was", "were", "have", "has",
    "not", "you", "your", "can", "will", "each", "which", "when", "using", "used", "use",
    "into", "than", "then", "them", "they", "their", "our", "all", "any", "may", "must",
    "also", "been", "between", "both", "before", "after", "above", "below", "over", "under",
}


def _sample_document(doc_id: int) -> tuple[str, list[str], str | None]:
    with get_db() as db:
        doc = db.execute("SELECT title, domain_guess FROM documents WHERE id=?", (doc_id,)).fetchone()
        heads = [
            r["text"].split("\n")[0]
            for r in db.execute(
                "SELECT text FROM blocks WHERE doc_id=? AND type='heading' ORDER BY page_no, order_idx LIMIT 40",
                (doc_id,),
            ).fetchall()
        ]
        texts = [
            r["text"]
            for r in db.execute(
                "SELECT text FROM blocks WHERE doc_id=? AND type IN ('paragraph','list') ORDER BY page_no, order_idx LIMIT 60",
                (doc_id,),
            ).fetchall()
        ]
        all_text = " ".join(r["text"] for r in db.execute("SELECT text FROM blocks WHERE doc_id=?", (doc_id,)).fetchall())
    words = re.findall(r"[A-Za-z][A-Za-z\-]{2,}", all_text)
    freq = Counter(w for w in words if w.lower() not in STOPWORDS)
    top = [w for w, _ in freq.most_common(40)]
    sample_parts = [f"TITLE: {doc['title']}"] + [f"HEADING: {h}" for h in heads] + texts[:25]
    sample = "\n".join(sample_parts + ["\nFREQUENT TERMS: " + ", ".join(top)])
    return sample, top, doc["domain_guess"] if doc else None


async def run_extract_terms(job_id: int, doc_id: int) -> None:
    cfg = {**load_settings(), "_purpose": "glossary", "_doc_id": doc_id}
    target_lang = cfg.get("target_lang") or "zh"
    sample, _top, domain = _sample_document(doc_id)
    try:
        messages = prompts.build_term_messages(sample, target_lang, domain)
        content = await chat_completion(cfg, messages, temperature=0.1)
        terms = prompts.parse_terms_response(content)
    except Exception as e:
        _job_update(job_id, status="error", error=str(e)[:500])
        return

    with get_db() as db:
        existing = {
            r["src_term"].lower()
            for r in db.execute("SELECT src_term FROM glossary WHERE doc_id=? OR doc_id IS NULL", (doc_id,)).fetchall()
        }
        added = 0
        for t in terms:
            if t["src_term"].lower() in existing:
                continue
            db.execute(
                "INSERT INTO glossary (doc_id, src_term, tgt_term, note, origin, status) VALUES (?, ?, ?, ?, 'auto', 'proposed')",
                (doc_id, t["src_term"], t["tgt_term"], t["note"]),
            )
            added += 1
        if added:
            domain_guess = domain
            if not domain_guess:
                # derive a crude domain guess from first heading
                h = db.execute("SELECT text FROM blocks WHERE doc_id=? AND type='heading' LIMIT 1", (doc_id,)).fetchone()
                domain_guess = h["text"].split("\n")[0][:60] if h else None
            db.execute("UPDATE documents SET domain_guess=?, updated_at=datetime('now') WHERE id=?", (domain_guess, doc_id))
        db.execute("UPDATE jobs SET total=?, done=?, status='done', updated_at=datetime('now') WHERE id=?", (len(terms), added, job_id))
    bump_glossary_rev()


def start_extract_terms(doc_id: int) -> int:
    job_id = create_job(doc_id, "extract_terms", 0, {})

    def _runner():
        asyncio.run(run_extract_terms(job_id, doc_id))

    import threading

    threading.Thread(target=_runner, daemon=True).start()
    return job_id
