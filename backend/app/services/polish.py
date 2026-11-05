"""Consistency polish pass over an already translated document.

1. Term consistency — every non-edited translation whose source contains an
   approved glossary term but whose translation lacks the required rendering is
   revised minimally by the model.
2. Heading consistency — all translated headings are reviewed together so that
   recurring patterns ("Task 1 – …", "[15 marks]") and terms read the same.

Edited translations (edited=1) are never touched. Revised blocks lose their
stored sentence alignment (the heuristic alignment takes over).
"""
from __future__ import annotations

import asyncio
import json
import re

from ..db import get_db
from . import prompts
from .llm_client import chat_completion
from .settings_store import load_settings
from .translate_worker import (
    PH_RE,
    _job_status,
    _job_update,
    create_job,
    repair_placeholders,
    set_job_result,
)

BATCH = 10


def _term_hits(src: str, tgt: str, terms: list[dict]) -> list[dict]:
    missing = []
    low = src.lower()
    for t in terms:
        s, g = t["src_term"].strip(), (t["tgt_term"] or "").strip()
        if not s or not g:
            continue
        pat = r"(?<![A-Za-z])" + re.escape(s.lower()) + r"(?![A-Za-z])"
        if re.search(pat, low) and g not in tgt:
            missing.append({"src": s, "tgt": g})
    return missing


def find_candidates(doc_id: int, lang: str) -> tuple[list[dict], list[dict]]:
    with get_db() as db:
        terms = [
            dict(r)
            for r in db.execute(
                "SELECT src_term, tgt_term FROM glossary WHERE (doc_id=? OR doc_id IS NULL) AND status='approved'"
                " ORDER BY (doc_id IS NULL) ASC",
                (doc_id,),
            )
        ]
        rows = db.execute(
            "SELECT b.id, b.type, b.level, b.text, b.meta_json, t.text AS translation FROM blocks b"
            " JOIN translations t ON t.block_id=b.id AND t.lang=?"
            " WHERE b.doc_id=? AND t.edited=0 AND b.type NOT IN ('image','formula') ORDER BY b.page_no, b.order_idx",
            (lang, doc_id),
        ).fetchall()
    # doc-specific terms shadow global ones with the same source
    seen, uniq = set(), []
    for t in terms:
        k = t["src_term"].lower()
        if k not in seen:
            seen.add(k)
            uniq.append(t)
    term_items, headings = [], []
    for r in rows:
        src = json.loads(r["meta_json"] or "{}").get("ph") or r["text"]
        if r["type"] == "heading":
            headings.append({"id": r["id"], "level": r["level"], "source": src.replace("\n", " "),
                             "translation": r["translation"].replace("\n", " ")})
        if r["type"] == "table":
            continue  # cell grids are fragile; tables keep their translation
        miss = _term_hits(src, r["translation"], uniq)
        if miss:
            term_items.append({"id": r["id"], "source": src, "translation": r["translation"], "missing": miss})
    return term_items, headings


def _apply(lang: str, revisions: dict[int, str], originals: dict[int, str]) -> list[int]:
    changed = []
    with get_db() as db:
        for bid, text in revisions.items():
            old = originals.get(bid)
            if old is None or not text.strip() or text == old:
                continue
            text = repair_placeholders(text, PH_RE.findall(old))
            db.execute(
                "UPDATE translations SET text=?, updated_at=datetime('now') WHERE block_id=? AND lang=? AND edited=0",
                (text, bid, lang),
            )
            db.execute("DELETE FROM sentences WHERE block_id=?", (bid,))
            changed.append(bid)
    return changed


async def run_polish_job(job_id: int, doc_id: int) -> None:
    cfg = {**load_settings(), "_purpose": "polish", "_doc_id": doc_id}
    with get_db() as db:
        doc = db.execute("SELECT target_lang FROM documents WHERE id=?", (doc_id,)).fetchone()
    lang = (doc["target_lang"] if doc else None) or cfg.get("target_lang") or "zh"
    term_items, headings = find_candidates(doc_id, lang)
    batches = [term_items[i:i + BATCH] for i in range(0, len(term_items), BATCH)]
    total = len(batches) + (1 if len(headings) >= 2 else 0)
    _job_update(job_id, total=total, done=0)
    changed: list[int] = []
    done = failed = 0
    last_err = None
    for batch in batches:
        if _job_status(job_id) == "cancelled":
            return
        try:
            content = await chat_completion(cfg, prompts.build_polish_messages(batch, [], lang), temperature=0.0)
            revs = prompts.parse_revisions(content)
            changed += _apply(lang, revs, {it["id"]: it["translation"] for it in batch})
        except Exception as e:  # keep going; report at the end
            failed += 1
            last_err = f"{type(e).__name__}: {e}"[:300]
        done += 1
        _job_update(job_id, done=done, failed=failed)
        set_job_result(job_id, changed_ids=changed)
    if len(headings) >= 2 and _job_status(job_id) != "cancelled":
        try:
            content = await chat_completion(cfg, prompts.build_heading_polish_messages(headings[:200], lang), temperature=0.0)
            revs = prompts.parse_revisions(content)
            changed += _apply(lang, revs, {h["id"]: h["translation"] for h in headings})
        except Exception as e:
            failed += 1
            last_err = f"{type(e).__name__}: {e}"[:300]
        done += 1
    set_job_result(job_id, changed_ids=changed, term_candidates=len(term_items), headings=len(headings))
    status = "done" if not failed else ("error" if failed == total else "done_with_errors")
    _job_update(job_id, done=done, failed=failed, status=status, error=last_err)


def start_polish_job(doc_id: int) -> int:
    job_id = create_job(doc_id, "polish", 0, {"doc_id": doc_id})
    try:
        asyncio.get_running_loop().create_task(run_polish_job(job_id, doc_id))
    except RuntimeError:
        import threading

        threading.Thread(target=lambda: asyncio.run(run_polish_job(job_id, doc_id)), daemon=True).start()
    return job_id
