"""Translation jobs: start, status, SSE progress, cancel."""
from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from ..db import get_db
from ..services import translate_worker
from ..services.settings_store import load_settings

router = APIRouter(tags=["translate"])


@router.post("/api/translate")
def start_translate(payload: dict):
    doc_id = payload.get("doc_id")
    if not doc_id:
        raise HTTPException(400, "doc_id 必填")
    with get_db() as db:
        doc = db.execute("SELECT id FROM documents WHERE id=?", (doc_id,)).fetchone()
    if doc is None:
        raise HTTPException(404, "文档不存在")
    params = {
        "scope": payload.get("scope", "doc"),
        "page_no": payload.get("page_no"),
        "block_ids": payload.get("block_ids"),
        "force": bool(payload.get("force")),
        "overwrite_edits": bool(payload.get("overwrite_edits")),
        "target_lang": payload.get("target_lang"),
    }
    job_id = translate_worker.start_translate_job(int(doc_id), params)
    return {"job_id": job_id}


@router.post("/api/blocks/{block_id}/retranslate")
def retranslate_block(block_id: int):
    with get_db() as db:
        row = db.execute("SELECT doc_id FROM blocks WHERE id=?", (block_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "块不存在")
    job_id = translate_worker.start_translate_job(
        row["doc_id"], {"scope": "blocks", "block_ids": [block_id], "force": True}
    )
    return {"job_id": job_id}


@router.put("/api/blocks/{block_id}/translation")
def edit_translation(block_id: int, payload: dict):
    text = payload.get("text")
    if text is None:
        raise HTTPException(400, "text 必填")
    cfg = load_settings()
    lang = payload.get("lang") or cfg.get("target_lang") or "zh"
    with get_db() as db:
        row = db.execute("SELECT id FROM blocks WHERE id=?", (block_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "块不存在")
        db.execute(
            "INSERT INTO translations (block_id, lang, text, edited) VALUES (?, ?, ?, 1)"
            " ON CONFLICT(block_id, lang) DO UPDATE SET text=excluded.text, edited=1,"
            " updated_at=datetime('now')",
            (block_id, lang, text),
        )
        # whole-block edit invalidates the stored sentence alignment (auto-align takes over)
        db.execute("DELETE FROM sentences WHERE block_id=?", (block_id,))
    return {"ok": True}


@router.put("/api/blocks/{block_id}/formula-image")
def put_formula_image(block_id: int, payload: dict):
    """The picture of a formula the reader rewrote (rendered in the browser), for PDF export."""
    import base64
    import binascii

    from ..config import UPLOAD_DIR
    from ..services import formula_edit

    tex = str(payload.get("tex") or "")
    try:
        data = base64.b64decode(str(payload.get("png") or ""), validate=True)
    except (binascii.Error, ValueError) as e:
        raise HTTPException(400, "图片数据无效") from e
    with get_db() as db:
        row = db.execute("SELECT doc_id, type FROM blocks WHERE id=?", (block_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "块不存在")
    if row["type"] != "formula":
        raise HTTPException(400, "这个块不是公式")
    try:
        formula_edit.save_png(UPLOAD_DIR / str(row["doc_id"]), block_id, tex, data)
    except ValueError as e:
        raise HTTPException(400, "公式图片无效") from e
    return {"ok": True}


LAYOUT_ALIGN = ("left", "center", "right", "justify")


def clean_layout(raw) -> dict | None:
    """The reader's formatting of one translated block, reduced to what is understood.

    scale  font size × (0.4 … 3)      bold   true / false      color  0xRRGGBB
    align  left / center / right       bbox   [x0, y0, x1, y1] in page points (moved / resized)
    hidden true: nothing is shown in the block's place
    """
    if not isinstance(raw, dict):
        return None
    out: dict = {}
    try:
        if raw.get("scale") is not None:
            sc = round(min(3.0, max(0.4, float(raw["scale"]))), 3)
            if abs(sc - 1.0) > 0.001:
                out["scale"] = sc
        if isinstance(raw.get("bold"), bool):
            out["bold"] = raw["bold"]
        if raw.get("color") is not None:
            out["color"] = int(raw["color"]) & 0xFFFFFF
        if raw.get("align") in LAYOUT_ALIGN:
            out["align"] = raw["align"]
        box = raw.get("bbox")
        if isinstance(box, (list, tuple)) and len(box) == 4:
            x0, y0, x1, y1 = (round(float(v), 2) for v in box)
            if x1 - x0 >= 4 and y1 - y0 >= 4 and all(-2000 < v < 20000 for v in (x0, y0, x1, y1)):
                out["bbox"] = [x0, y0, x1, y1]
        if raw.get("hidden") is True:
            out["hidden"] = True
    except (TypeError, ValueError):
        raise HTTPException(400, "layout 的格式不对")
    return out or None


@router.put("/api/blocks/{block_id}/layout")
def edit_layout(block_id: int, payload: dict):
    """Formatting set in edit mode: size, bold, colour, alignment, position, hidden. null clears it."""
    cfg = load_settings()
    lang = payload.get("lang") or cfg.get("target_lang") or "zh"
    layout = clean_layout(payload.get("layout"))
    with get_db() as db:
        row = db.execute("SELECT id FROM blocks WHERE id=?", (block_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "块不存在")
        value = json.dumps(layout) if layout else None
        cur = db.execute("UPDATE translations SET layout_json=? WHERE block_id=? AND lang=?", (value, block_id, lang))
        if cur.rowcount == 0 and layout:
            # formatting a block that has no translation yet (hiding it, for example)
            db.execute("INSERT INTO translations (block_id, lang, text, edited, layout_json) VALUES (?, ?, '', 0, ?)",
                       (block_id, lang, value))
    return {"ok": True, "layout": layout}


@router.post("/api/documents/{doc_id}/replace")
def replace_in_translations(doc_id: int, payload: dict):
    """Find (and replace) text in every translation of a document — unifying a term, fixing a name.

    dry_run: only count. Returns the changed blocks with their text before, so the page can undo.
    """
    find = str(payload.get("find") or "")
    repl = str(payload.get("replace") or "")
    if not find:
        raise HTTPException(400, "请输入要查找的文字")
    if len(find) > 500 or len(repl) > 2000:
        raise HTTPException(400, "文字太长")
    cfg = load_settings()
    lang = payload.get("lang") or cfg.get("target_lang") or "zh"
    case = bool(payload.get("case_sensitive", True))
    dry = bool(payload.get("dry_run"))
    import re as _re

    pat = _re.compile(_re.escape(find), 0 if case else _re.IGNORECASE)
    changed: list[dict] = []
    hits = 0
    with get_db() as db:
        if db.execute("SELECT 1 FROM documents WHERE id=?", (doc_id,)).fetchone() is None:
            raise HTTPException(404, "文档不存在")
        rows = db.execute(
            "SELECT t.block_id, t.text, b.page_no FROM translations t JOIN blocks b ON b.id=t.block_id"
            " WHERE b.doc_id=? AND t.lang=? AND t.text != '' ORDER BY b.page_no, b.order_idx", (doc_id, lang),
        ).fetchall()
        for r in rows:
            n = len(pat.findall(r["text"]))
            if not n:
                continue
            hits += n
            # a formula placeholder must survive: never touch the inside of {{mN}}
            parts = _re.split(r"(\{\{m\d+\}\})", r["text"])
            new = "".join(p if _re.fullmatch(r"\{\{m\d+\}\}", p) else pat.sub(lambda _m: repl, p) for p in parts)
            if new == r["text"]:
                continue
            changed.append({"block_id": r["block_id"], "page": r["page_no"], "before": r["text"], "after": new})
            if not dry:
                db.execute("UPDATE translations SET text=?, edited=1, updated_at=datetime('now')"
                           " WHERE block_id=? AND lang=?", (new, r["block_id"], lang))
                db.execute("DELETE FROM sentences WHERE block_id=?", (r["block_id"],))
    return {"hits": hits, "blocks": len(changed), "pages": sorted({c["page"] for c in changed}),
            "changed": changed if not dry else [], "dry_run": dry}


@router.put("/api/blocks/{block_id}/sentences/{idx}")
def edit_sentence(block_id: int, idx: int, payload: dict):
    """Edit one aligned sentence; the block translation is rebuilt from all sentences."""
    from ..services.sentence_split import auto_align, join_units, sentence_units

    text = (payload.get("text") or "").strip()
    if not text:
        raise HTTPException(400, "text 必填")
    cfg = load_settings()
    with get_db() as db:
        blk = db.execute(
            "SELECT b.id, b.text, b.meta_json, d.target_lang FROM blocks b JOIN documents d ON d.id=b.doc_id WHERE b.id=?",
            (block_id,),
        ).fetchone()
        if blk is None:
            raise HTTPException(404, "块不存在")
        src_text = json.loads(blk["meta_json"] or "{}").get("ph") or blk["text"]
        lang = payload.get("lang") or blk["target_lang"] or cfg.get("target_lang") or "zh"
        rows = db.execute(
            "SELECT idx, src_text, tgt_text FROM sentences WHERE block_id=? ORDER BY idx", (block_id,)
        ).fetchall()
        pairs = [(r["src_text"], r["tgt_text"]) for r in rows]
        if not pairs:  # materialise the heuristic alignment first
            tr = db.execute("SELECT text FROM translations WHERE block_id=? AND lang=?", (block_id, lang)).fetchone()
            pairs = auto_align(src_text, tr["text"]) if tr else None
            if not pairs:
                raise HTTPException(409, "该块没有句级对齐，请编辑整块译文")
            for i, (a, b) in enumerate(pairs):
                db.execute(
                    "INSERT INTO sentences (block_id, idx, src_text, tgt_text) VALUES (?,?,?,?)", (block_id, i, a, b)
                )
        if not 0 <= idx < len(pairs):
            raise HTTPException(404, "句子不存在")
        db.execute(
            "UPDATE sentences SET tgt_text=?, edited=1 WHERE block_id=? AND idx=?", (text, block_id, idx)
        )
        tgts = [p[1] for p in pairs]
        tgts[idx] = text
        units = sentence_units(src_text)
        segs = [s for s, _ in units] if len(units) == len(tgts) else [0] * len(tgts)
        full = join_units(segs, tgts, lang)
        db.execute(
            "INSERT INTO translations (block_id, lang, text, edited) VALUES (?, ?, ?, 1)"
            " ON CONFLICT(block_id, lang) DO UPDATE SET text=excluded.text, edited=1, updated_at=datetime('now')",
            (block_id, lang, full),
        )
    return {"ok": True, "translation": full}


@router.post("/api/documents/{doc_id}/polish")
def start_polish(doc_id: int):
    from ..services.polish import start_polish_job

    with get_db() as db:
        if db.execute("SELECT id FROM documents WHERE id=?", (doc_id,)).fetchone() is None:
            raise HTTPException(404, "文档不存在")
    return {"job_id": start_polish_job(doc_id)}


def _job_payload(job: dict) -> dict:
    payload = {k: job.get(k) for k in ("id", "kind", "status", "total", "done", "failed", "error")}
    try:
        payload["result"] = json.loads(job.get("result_json") or "{}")
    except Exception:
        payload["result"] = {}
    try:
        payload["params"] = json.loads(job.get("params_json") or "{}")
    except Exception:
        payload["params"] = {}
    return payload


@router.get("/api/jobs/{job_id}")
def get_job(job_id: int):
    with get_db() as db:
        row = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "任务不存在")
    return _job_payload(dict(row))


@router.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: int):
    ok = translate_worker.cancel_job(job_id)
    return {"ok": ok}


@router.get("/api/jobs/{job_id}/events")
async def job_events(job_id: int):
    async def gen():
        last = None
        for _ in range(3600):  # ~30 min at 0.5s
            with get_db() as db:
                row = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
            if row is None:
                yield "event: error\ndata: " + json.dumps({"error": "job not found"}) + "\n\n"
                return
            job = dict(row)
            payload = _job_payload(job)
            if payload != last:
                last = payload
                event = "progress"
                if job["status"] in ("done", "done_with_errors", "error", "cancelled"):
                    event = "done" if job["status"] != "error" else "error"
                yield f"event: {event}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"
                if job["status"] in ("done", "done_with_errors", "error", "cancelled"):
                    return
            await asyncio.sleep(0.5)

    return StreamingResponse(gen(), media_type="text/event-stream")
