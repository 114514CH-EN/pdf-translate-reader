"""Reading helpers: position memory, in-document search, per-page progress,
translation estimates and highlights."""
from __future__ import annotations

import json
import re

from fastapi import APIRouter, HTTPException

from ..db import get_db
from ..services import usage
from ..services.settings_store import load_settings

router = APIRouter(tags=["reading"])


def _doc_or_404(db, doc_id: int):
    doc = db.execute("SELECT id, target_lang, page_count FROM documents WHERE id=?", (doc_id,)).fetchone()
    if doc is None:
        raise HTTPException(404, "文档不存在")
    return doc


# ---------------------------------------------------------------- position
@router.put("/api/documents/{doc_id}/position")
def save_position(doc_id: int, payload: dict):
    try:
        page = max(1, int(payload.get("page") or 1))
        frac = min(max(float(payload.get("frac") or 0), 0.0), 1.0)
    except (TypeError, ValueError) as e:
        raise HTTPException(400, "page / frac 无效") from e
    with get_db() as db:
        db.execute("UPDATE documents SET last_page=?, last_frac=? WHERE id=?", (page, round(frac, 4), doc_id))
    return {"ok": True}


# ---------------------------------------------------------------- search
def _snippet(text: str, start: int, end: int, width: int = 48) -> dict:
    a = max(0, start - width)
    b = min(len(text), end + width)
    pre = ("…" if a > 0 else "") + text[a:start]
    post = text[end:b] + ("…" if b < len(text) else "")
    return {"pre": pre, "match": text[start:end], "post": post}


@router.get("/api/documents/{doc_id}/search")
def search(doc_id: int, q: str, limit: int = 300):
    """Case-insensitive search over the source text and the translation of every block."""
    q = (q or "").strip()
    if not q:
        return {"q": q, "total": 0, "results": []}
    with get_db() as db:
        doc = _doc_or_404(db, doc_id)
        rows = db.execute(
            "SELECT b.id, b.page_no, b.type, b.text, b.bbox_json, p.height AS page_h, t.text AS translation FROM blocks b"
            " JOIN pages p ON p.id=b.page_id"
            " LEFT JOIN translations t ON t.block_id=b.id AND t.lang=?"
            " WHERE b.doc_id=? AND b.type != 'image' ORDER BY b.page_no, b.order_idx",
            (doc["target_lang"] or "zh", doc_id),
        ).fetchall()
    pat = re.compile(re.escape(q), re.I)
    results, total = [], 0
    for r in rows:
        try:
            y = json.loads(r["bbox_json"] or "[0,0,0,0]")[1] / max(r["page_h"] or 842, 1)
        except (ValueError, IndexError, TypeError):
            y = 0.0
        for field, raw in (("src", r["text"]), ("tgt", r["translation"])):
            if not raw:
                continue
            if r["type"] == "table":  # markdown grid → readable cells
                raw = "\n".join(ln for ln in raw.splitlines() if not re.fullmatch(r"\s*\|?[\s:|-]+\|?\s*", ln))
                raw = re.sub(r"(\s*\|\s*)+", " · ", raw).strip(" ·")
            text = re.sub(r"\{\{m\d+\}\}", "▢", re.sub(r"\s+", " ", raw))  # formulas show as a box
            for m in pat.finditer(text):
                total += 1
                if len(results) < limit:
                    results.append({"block_id": r["id"], "page_no": r["page_no"], "field": field,
                                    "type": r["type"], "y": round(y, 4), **_snippet(text, m.start(), m.end())})
    return {"q": q, "total": total, "results": results}


# ---------------------------------------------------------------- progress
@router.get("/api/documents/{doc_id}/progress")
def progress(doc_id: int):
    """Per page: translatable blocks, translated, failed in the latest translate job."""
    with get_db() as db:
        doc = _doc_or_404(db, doc_id)
        rows = db.execute(
            "SELECT b.page_no, COUNT(*) n, SUM(CASE WHEN t.id IS NOT NULL AND t.text != '' THEN 1 ELSE 0 END) done"
            " FROM blocks b LEFT JOIN translations t ON t.block_id=b.id AND t.lang=?"
            " WHERE b.doc_id=? AND b.type NOT IN ('image','formula') AND trim(b.text) != ''"
            " GROUP BY b.page_no",
            (doc["target_lang"] or "zh", doc_id),
        ).fetchall()
        job = db.execute(
            "SELECT id, status, result_json FROM jobs WHERE doc_id=? AND kind='translate' ORDER BY id DESC LIMIT 1",
            (doc_id,),
        ).fetchone()
        failed_pages: dict[int, int] = {}
        if job and job["result_json"]:
            ids = json.loads(job["result_json"] or "{}").get("failed_ids") or []
            if ids:
                q = "SELECT b.page_no, COUNT(*) c FROM blocks b LEFT JOIN translations t ON t.block_id=b.id AND t.lang=?" \
                    " WHERE b.id IN (%s) AND (t.id IS NULL OR t.text='') GROUP BY b.page_no" % ",".join("?" * len(ids))
                for r in db.execute(q, (doc["target_lang"] or "zh", *ids)):
                    failed_pages[r["page_no"]] = r["c"]
    by_page = {r["page_no"]: r for r in rows}
    pages = []
    for n in range(1, (doc["page_count"] or 0) + 1):
        r = by_page.get(n)
        pages.append({"page_no": n, "total": r["n"] if r else 0, "done": (r["done"] or 0) if r else 0,
                      "failed": failed_pages.get(n, 0)})
    return {"pages": pages, "job_status": job["status"] if job else None}


# ---------------------------------------------------------------- estimate
@router.get("/api/documents/{doc_id}/translate-estimate")
def translate_estimate(doc_id: int, scope: str = "doc", page_no: int | None = None, force: bool = False):
    """Rough token / cost / time estimate before starting a translation."""
    from ..services.translate_worker import MAX_BATCH_CHARS, batch_sizes, plan_blocks

    cfg = load_settings()
    with get_db() as db:
        doc = _doc_or_404(db, doc_id)
        # seconds per model call, from recent finished jobs (fallback: ~25 s per batch)
        recent = db.execute(
            "SELECT (julianday(updated_at) - julianday(created_at)) * 86400 AS secs, done, total FROM jobs"
            " WHERE kind='translate' AND status IN ('done','done_with_errors') AND done > 0"
            " ORDER BY id DESC LIMIT 5"
        ).fetchall()
        glossary_n = db.execute(
            "SELECT COUNT(*) FROM glossary WHERE (doc_id=? OR doc_id IS NULL) AND status='approved'", (doc_id,)
        ).fetchone()[0]
    lang = doc["target_lang"] or cfg.get("target_lang") or "zh"
    _blocks, todo, done = plan_blocks(doc_id, scope, {"page_no": page_no, "force": force}, lang,
                                      cfg.get("model") or "", int(cfg.get("glossary_rev") or 0))
    sizes = batch_sizes(todo)
    src_tokens = sum(usage.estimate_tokens(b["text"]) for b in todo)
    # system prompt + glossary + rolling context per call; JSON wrapping on both sides
    overhead = len(sizes) * (700 + min(glossary_n, 80) * 12)
    prompt_tokens = int(src_tokens * 1.15 + overhead)
    out_ratio = 0.85 if lang.startswith(("zh", "ja", "ko")) else 1.1
    completion_tokens = int(src_tokens * out_ratio * 1.15 + len(sizes) * 40)
    per_call = None
    for r in recent:
        if r["secs"] and r["done"]:
            per_call = (per_call or []) + [r["secs"] / max(1, r["total"] / 6)]
    sec_per_call = sorted(per_call)[len(per_call) // 2] if per_call else 25.0
    waves = (len(sizes) + 2) // 3  # 3 concurrent calls
    # cache hits are unknown up front → priced as misses (an upper bound)
    c = usage.cost(cfg, cfg.get("model"), prompt_tokens, completion_tokens)
    c_peak = usage.cost(cfg, cfg.get("model"), prompt_tokens, completion_tokens, peak=True)
    peak_now = usage.is_peak(cfg)
    stale = sum(1 for b in todo if b.get("translation") and not force)
    return {
        "cost_offpeak": round(c, 4) if c is not None else None,
        "cost_peak": round(c_peak, 4) if c_peak is not None and c_peak != c else None,
        "peak_now": peak_now,
        "blocks": len(todo), "already_done": done, "stale": stale,
        "calls": len(sizes), "max_batch_chars": MAX_BATCH_CHARS,
        "prompt_tokens": prompt_tokens, "completion_tokens": completion_tokens,
        "total_tokens": prompt_tokens + completion_tokens,
        "cost": round(c_peak if peak_now else c, 4) if c is not None and c_peak is not None else None,
        "currency": (cfg.get("pricing") or {}).get("currency") or "¥",
        "model": cfg.get("model"), "seconds": int(waves * min(max(sec_per_call, 4.0), 120.0)),
    }


# ---------------------------------------------------------------- highlights
COLORS = {"yellow", "green", "blue", "pink", "orange"}


def _hl(row) -> dict:
    d = dict(row)
    d["rects"] = json.loads(d.pop("rects_json") or "[]")
    return d


@router.get("/api/highlights")
def list_highlights(doc_id: int):
    with get_db() as db:
        rows = db.execute("SELECT * FROM highlights WHERE doc_id=? ORDER BY page_no, id", (doc_id,)).fetchall()
    return [_hl(r) for r in rows]


@router.post("/api/highlights")
def create_highlight(payload: dict):
    try:
        doc_id = int(payload["doc_id"])
        page_no = int(payload["page_no"])
        rects = [[round(float(v), 2) for v in r[:4]] for r in payload.get("rects") or [] if len(r) >= 4]
    except (KeyError, TypeError, ValueError) as e:
        raise HTTPException(400, "doc_id / page_no / rects 无效") from e
    if not rects:
        raise HTTPException(400, "没有可高亮的区域")
    color = payload.get("color") if payload.get("color") in COLORS else "yellow"
    pane = "tgt" if payload.get("pane") == "tgt" else "src"
    with get_db() as db:
        _doc_or_404(db, doc_id)
        cur = db.execute(
            "INSERT INTO highlights (doc_id, page_no, pane, rects_json, text, color, note) VALUES (?,?,?,?,?,?,?)",
            (doc_id, page_no, pane, json.dumps(rects), (payload.get("text") or "")[:4000], color,
             (payload.get("note") or "")[:8000]),
        )
        row = db.execute("SELECT * FROM highlights WHERE id=?", (cur.lastrowid,)).fetchone()
    return _hl(row)


@router.put("/api/highlights/{hl_id}")
def update_highlight(hl_id: int, payload: dict):
    fields = {}
    if "note" in payload:
        fields["note"] = str(payload["note"] or "")[:8000]
    if payload.get("color") in COLORS:
        fields["color"] = payload["color"]
    if not fields:
        raise HTTPException(400, "无更新字段")
    cols = ", ".join(f"{k}=?" for k in fields)
    with get_db() as db:
        db.execute(f"UPDATE highlights SET {cols}, updated_at=datetime('now') WHERE id=?", (*fields.values(), hl_id))
        row = db.execute("SELECT * FROM highlights WHERE id=?", (hl_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "高亮不存在")
    return _hl(row)


@router.delete("/api/highlights/{hl_id}")
def delete_highlight(hl_id: int):
    with get_db() as db:
        db.execute("DELETE FROM highlights WHERE id=?", (hl_id,))
    return {"ok": True}
