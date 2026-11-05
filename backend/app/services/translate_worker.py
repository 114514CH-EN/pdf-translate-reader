"""Background translation jobs: batching, cache, retry, progress, cancel."""
from __future__ import annotations

import asyncio
import hashlib
import json
import re
from typing import Any

from ..db import get_db
from . import code_blocks, prompts
from .llm_client import chat_completion
from .sentence_split import join_units, sentence_units
from .settings_store import load_settings

MAX_SENT_UNITS = 25  # blocks with more sentences are translated as a whole

MAX_BATCH_CHARS = 4000
MAX_BATCH_ITEMS = 12
SEM = asyncio.Semaphore(3)
WAVE = 3


def _norm_src(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().lower()


def cache_key(src: str, target_lang: str, model: str, glossary_rev: int) -> str:
    raw = "|".join([_norm_src(src), target_lang, model or "", prompts.PROMPT_VER, str(glossary_rev)])
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _job_update(job_id: int, **fields: Any) -> None:
    if not fields:
        return
    cols = ", ".join(f"{k}=?" for k in fields)
    with get_db() as db:
        db.execute(f"UPDATE jobs SET {cols}, updated_at=datetime('now') WHERE id=?", (*fields.values(), job_id))


def set_job_result(job_id: int, **result: Any) -> None:
    """Merge keys into jobs.result_json (failed_ids, changed_ids, …)."""
    with get_db() as db:
        row = db.execute("SELECT result_json FROM jobs WHERE id=?", (job_id,)).fetchone()
        cur = {}
        if row and row["result_json"]:
            try:
                cur = json.loads(row["result_json"])
            except Exception:
                cur = {}
        cur.update(result)
        db.execute("UPDATE jobs SET result_json=? WHERE id=?", (json.dumps(cur, ensure_ascii=False), job_id))


def _job_status(job_id: int) -> str:
    with get_db() as db:
        row = db.execute("SELECT status FROM jobs WHERE id=?", (job_id,)).fetchone()
    return row["status"] if row else "cancelled"


def create_job(doc_id: int, kind: str, total: int, params: dict) -> int:
    with get_db() as db:
        cur = db.execute(
            "INSERT INTO jobs (doc_id, kind, status, total, params_json) VALUES (?, ?, 'running', ?, ?)",
            (doc_id, kind, total, json.dumps(params, ensure_ascii=False)),
        )
        return cur.lastrowid


def cancel_job(job_id: int) -> bool:
    with get_db() as db:
        row = db.execute("SELECT status FROM jobs WHERE id=?", (job_id,)).fetchone()
        if row and row["status"] in ("pending", "running"):
            db.execute("UPDATE jobs SET status='cancelled', updated_at=datetime('now') WHERE id=?", (job_id,))
            return True
    return False


def select_blocks(doc_id: int, scope: str, page_no: int | None, block_ids: list[int] | None) -> list[dict]:
    q = (
        "SELECT b.id, b.text, b.type, b.order_idx, b.page_no, b.meta_json, t.text AS translation, t.edited AS edited,"
        " t.cache_key AS cache_key FROM blocks b"
        " LEFT JOIN translations t ON t.block_id=b.id AND t.lang=(SELECT target_lang FROM documents WHERE id=b.doc_id)"
        " WHERE b.doc_id=? AND b.type NOT IN ('image', 'formula')"
    )
    args: list[Any] = [doc_id]
    if scope == "page" and page_no is not None:
        q += " AND b.page_no=?"
        args.append(page_no)
    elif scope == "blocks" and block_ids:
        q += " AND b.id IN (%s)" % ",".join("?" * len(block_ids))
        args.extend(block_ids)
    q += " ORDER BY b.page_no, b.order_idx"
    with get_db() as db:
        rows = db.execute(q, args).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        try:
            meta = json.loads(d.pop("meta_json") or "{}")
        except Exception:
            meta = {}
        d["meta"] = meta
        # translate the placeholder text: formulas stay as {{mN}} and are re-inserted verbatim
        d["src"] = meta.get("ph") or d["text"]
        d["placeholders"] = PH_RE.findall(d["src"])
        out.append(d)
    return out


PH_RE = re.compile(r"\{\{m\d+\}\}")


def repair_placeholders(text: str, expected: list[str]) -> str:
    """Drop invented formula placeholders and re-append any the model dropped."""
    if not expected and "{{m" not in text:
        return text
    exp = set(expected)
    text = PH_RE.sub(lambda m: m.group(0) if m.group(0) in exp else "", text)
    missing = [p for p in expected if p not in text]
    if missing:
        text = text.rstrip() + " " + " ".join(missing)
    return text


def _glossary_for_batch(doc_id: int, batch_texts: str) -> list[dict]:
    with get_db() as db:
        rows = db.execute(
            "SELECT src_term, tgt_term, note, status FROM glossary WHERE (doc_id=? OR doc_id IS NULL)"
            " AND status!='rejected' ORDER BY (status='approved') DESC, (doc_id IS NULL) ASC, frequency DESC, id"
            " LIMIT 120",
            (doc_id,),
        ).fetchall()
    terms = [dict(r) for r in rows]
    approved = [t for t in terms if t["status"] == "approved"]
    proposed = [t for t in terms if t["status"] == "proposed"]
    low = batch_texts.lower()
    hit = [t for t in proposed if t["src_term"].lower() in low]
    merged = approved + hit
    seen, out = set(), []
    for t in merged:
        k = t["src_term"].lower()
        if k not in seen:
            seen.add(k)
            out.append(t)
    return out[:40]


def _heading_trail(doc_id: int, page_no: int, order_idx: int) -> list[str]:
    with get_db() as db:
        rows = db.execute(
            "SELECT text, page_no, order_idx FROM blocks WHERE doc_id=? AND type='heading'"
            " AND (page_no < ? OR (page_no = ? AND order_idx <= ?)) ORDER BY page_no DESC, order_idx DESC LIMIT 5",
            (doc_id, page_no, page_no, order_idx),
        ).fetchall()
    return list(reversed([r["text"].split("\n")[0][:80] for r in rows]))


def _prev_digests(doc_id: int, lang: str, before_block_id: int, n: int = 3) -> list[str]:
    with get_db() as db:
        rows = db.execute(
            "SELECT t.text FROM translations t JOIN blocks b ON b.id=t.block_id"
            " WHERE b.doc_id=? AND t.lang=? AND t.block_id < ? ORDER BY t.block_id DESC LIMIT ?",
            (doc_id, lang, before_block_id, n),
        ).fetchall()
    return [re.sub(r"\s+", " ", r["text"])[:80] for r in reversed(rows)]


def plan_blocks(doc_id: int, scope: str, params: dict, target_lang: str, model: str,
                glossary_rev: int) -> tuple[list[dict], list[dict], int]:
    """(all blocks in scope, blocks that need a model call, blocks already done)."""
    force = bool(params.get("force"))
    overwrite_edits = bool(params.get("overwrite_edits"))
    blocks = select_blocks(doc_id, scope, params.get("page_no"), params.get("block_ids"))
    todo: list[dict] = []
    done_count = 0
    for b in blocks:
        if b["text"].strip() == "":
            done_count += 1
        elif b["edited"] and not overwrite_edits:
            done_count += 1
        elif b["type"] == "code" and not force and code_blocks.translation_fits(b["text"], b["translation"], b["meta"]):
            done_count += 1  # code parts unchanged: any model is fine for the comments
        elif b["type"] == "code":
            todo.append(b)  # an old paragraph-style translation of a listing is redone
        elif not force and b["translation"] and b["cache_key"] == cache_key(b["text"], target_lang, model, glossary_rev):
            done_count += 1
        else:
            todo.append(b)
    return blocks, todo, done_count


def batch_sizes(todo: list[dict]) -> list[int]:
    """Number of source characters per model call, as run_translate_job batches them."""
    out: list[int] = []
    cur_n = cur_chars = 0
    for b in todo:
        n = len(b["text"])
        if cur_n and (cur_chars + n > MAX_BATCH_CHARS or cur_n >= MAX_BATCH_ITEMS):
            out.append(cur_chars)
            cur_n, cur_chars = 0, 0
        cur_n += 1
        cur_chars += n
    if cur_n:
        out.append(cur_chars)
    return out


async def run_translate_job(job_id: int, doc_id: int, params: dict) -> None:
    scope = params.get("scope", "doc")
    cfg = {**load_settings(), "_purpose": "translate", "_doc_id": doc_id}
    target_lang = params.get("target_lang") or cfg.get("target_lang") or "zh"
    model = cfg.get("model") or ""
    glossary_rev = int(cfg.get("glossary_rev") or 0)

    with get_db() as db:
        doc = db.execute("SELECT title, domain_guess, summary_md, target_lang FROM documents WHERE id=?", (doc_id,)).fetchone()
    if not doc:
        _job_update(job_id, status="error", error="document not found")
        return
    if params.get("target_lang") is None:
        target_lang = doc["target_lang"] or target_lang

    blocks, todo, done_count = plan_blocks(doc_id, scope, params, target_lang, model, glossary_rev)
    # code listings: only the comments go to the model; a listing without any is kept as is
    no_comments = []
    for b in todo:
        if b["type"] == "code":
            b["units"] = code_blocks.comment_units(b["text"], b["meta"])
            if not b["units"]:
                no_comments.append(b)
    for b in no_comments:
        _store_translation(b, b["text"], target_lang, model, glossary_rev)
        todo.remove(b)
        done_count += 1
    for b in todo:
        if b["type"] in ("paragraph", "list"):
            units = sentence_units(b["src"])
            if 2 <= len(units) <= MAX_SENT_UNITS:
                b["segs"] = [seg for seg, _ in units]
                b["units"] = [u for _, u in units]
            elif len(units) == 1:
                b["single_unit"] = units[0][1]
    _job_update(job_id, total=len(blocks), done=done_count)

    batches: list[list[dict]] = []
    cur: list[dict] = []
    cur_chars = 0
    for b in todo:
        n = len(b["text"])
        if cur and (cur_chars + n > MAX_BATCH_CHARS or len(cur) >= MAX_BATCH_ITEMS):
            batches.append(cur)
            cur, cur_chars = [], 0
        cur.append(b)
        cur_chars += n
    if cur:
        batches.append(cur)

    failed_ids: list[int] = []
    last_error: str | None = None
    # waves of up to 3 concurrent batches (SEM): fast, while later waves still see
    # the previous waves' translations as cohesion context
    waves = [batches[i:i + WAVE] for i in range(0, len(batches), WAVE)]
    for wave in waves:
        if _job_status(job_id) == "cancelled":
            _job_update(job_id, status="cancelled")
            return
        outcomes = await asyncio.gather(
            *[_translate_batch(doc_id, doc, b, target_lang, model, glossary_rev, cfg) for b in wave],
            return_exceptions=True,
        )
        for batch, results in zip(wave, outcomes):
            if isinstance(results, BaseException):
                failed_ids.extend(b["id"] for b in batch)
                last_error = f"{type(results).__name__}: {results}"[:500]
                _job_update(job_id, failed=len(failed_ids), error=last_error)
                set_job_result(job_id, failed_ids=failed_ids)
                done_count += len(batch)
                _job_update(job_id, done=done_count)
                continue
            done_count = _store_batch(job_id, batch, results, failed_ids, done_count, target_lang, model, glossary_rev)

    set_job_result(job_id, failed_ids=failed_ids)
    status = "done" if not failed_ids else "done_with_errors"
    if failed_ids and len(failed_ids) == len(todo) and todo:
        status = "error"  # nothing succeeded (bad key / network) — surface the error
    _job_update(job_id, status=status, error=(last_error if failed_ids else None))


def _store_batch(job_id, batch, results, failed_ids, done_count, target_lang, model, glossary_rev) -> int:
    for b in batch:
        if b["id"] in results:
            text, sents = results[b["id"]]
            _store_translation(b, text, target_lang, model, glossary_rev, sents)
        else:
            failed_ids.append(b["id"])
    done_count += len(batch)
    _job_update(job_id, done=done_count, failed=len(failed_ids))
    if failed_ids:
        set_job_result(job_id, failed_ids=failed_ids)
    return done_count


async def _translate_batch(
    doc_id: int, doc, batch: list[dict], target_lang: str, model: str, glossary_rev: int, cfg: dict
) -> dict[int, tuple[str, list[tuple[str, str]] | None]]:
    """Translate one batch → {block_id: (translation, [(src_sentence, tgt_sentence)] | None)}."""
    texts = "\n".join(b["src"] for b in batch)
    terms = _glossary_for_batch(doc_id, texts)
    first = batch[0]
    trail = _heading_trail(doc_id, first["page_no"], first["order_idx"])
    digests = _prev_digests(doc_id, target_lang, first["id"])
    messages = prompts.build_translation_messages(
        batch=[{"id": b["id"], "text": b["src"], "type": b["type"], "units": b.get("units")} for b in batch],
        domain_guess=doc["domain_guess"],
        doc_title=doc["title"],
        target_lang=target_lang,
        style=cfg.get("style") or "academic",
        glossary_terms=terms,
        summary=doc["summary_md"],
        heading_trail=trail,
        prev_digests=digests,
    )
    ids = [b["id"] for b in batch]
    async with SEM:
        content = await chat_completion(cfg, messages, json_mode=False, temperature=0.2)
    parsed = prompts.parse_translation_items(content, ids)
    if not parsed:
        # one strict retry
        messages.append({"role": "assistant", "content": content})
        messages.append({"role": "user", "content": "Your reply was not valid JSON. Reply again with ONLY the JSON object."})
        async with SEM:
            content = await chat_completion(cfg, messages, temperature=0.0)
        parsed = prompts.parse_translation_items(content, ids)

    out: dict[int, tuple[str, list[tuple[str, str]] | None]] = {}
    for b in batch:
        item = parsed.get(b["id"])
        if not item:
            continue
        sents = item.get("sentences")
        units = b.get("units")
        ph = b.get("placeholders") or []
        if b["type"] == "code":
            if not (sents and len(sents) == len(units or [])):
                # one string back instead of a list: one comment per line
                lines = [x for x in (item.get("translation") or "").split("\n") if x.strip()]
                sents = lines if len(lines) == len(units or []) else None
            if sents:
                out[b["id"]] = (code_blocks.rebuild(b["text"], b["meta"], [str(x) for x in sents]), None)
            continue
        if sents and units and len(sents) == len(units):
            sents = [repair_placeholders(x, PH_RE.findall(u)) for x, u in zip(sents, units)]
            out[b["id"]] = (join_units(b["segs"], sents, target_lang), list(zip(units, sents)))
        elif sents:  # count mismatch: keep the text, drop the alignment
            text = item.get("translation") or join_units([0] * len(sents), sents, target_lang)
            out[b["id"]] = (repair_placeholders(text, ph), None)
        elif item.get("translation") is not None:
            text = repair_placeholders(item["translation"], ph)
            pairs = [(b["single_unit"], text.strip())] if b.get("single_unit") else None
            out[b["id"]] = (text, pairs)
    return out


def store_sentences(db, block_id: int, pairs: list[tuple[str, str]] | None) -> None:
    db.execute("DELETE FROM sentences WHERE block_id=?", (block_id,))
    for i, (src, tgt) in enumerate(pairs or []):
        db.execute(
            "INSERT INTO sentences (block_id, idx, src_text, tgt_text, edited) VALUES (?, ?, ?, ?, 0)",
            (block_id, i, src, tgt),
        )


def _store_translation(
    block: dict, text: str, target_lang: str, model: str, glossary_rev: int,
    pairs: list[tuple[str, str]] | None = None,
) -> None:
    ck = cache_key(block["text"], target_lang, model, glossary_rev)
    with get_db() as db:
        store_sentences(db, block["id"], pairs)
        db.execute(
            "INSERT INTO translations (block_id, lang, model, prompt_ver, text, edited, cache_key)"
            " VALUES (?, ?, ?, ?, ?, 0, ?)"
            " ON CONFLICT(block_id, lang) DO UPDATE SET text=excluded.text, model=excluded.model,"
            " prompt_ver=excluded.prompt_ver, cache_key=excluded.cache_key, edited=0,"
            " updated_at=datetime('now')",
            (block["id"], target_lang, model, prompts.PROMPT_VER, text, ck),
        )


def start_translate_job(doc_id: int, params: dict) -> int:
    blocks = select_blocks(doc_id, params.get("scope", "doc"), params.get("page_no"), params.get("block_ids"))
    job_id = create_job(doc_id, "translate", len(blocks), params)
    try:
        loop = asyncio.get_running_loop()
        loop.create_task(run_translate_job(job_id, doc_id, params))
    except RuntimeError:
        # no running loop (sync context) — run in a fresh loop on a thread
        import threading

        def _runner():
            asyncio.run(run_translate_job(job_id, doc_id, params))

        threading.Thread(target=_runner, daemon=True).start()
    return job_id
