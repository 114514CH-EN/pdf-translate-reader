"""Page blocks with translations + page visual assets (background layer / figures)."""
from __future__ import annotations

import json
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from ..config import UPLOAD_DIR
from ..db import get_db
from ..services import page_assets

router = APIRouter(prefix="/api/documents/{doc_id}/pages", tags=["pages"])


def _doc_paths(doc_id: int) -> tuple[Path, Path]:
    with get_db() as db:
        row = db.execute("SELECT file_path FROM documents WHERE id=?", (doc_id,)).fetchone()
    if row is None or not row["file_path"] or not Path(row["file_path"]).exists():
        raise HTTPException(404, "文档不存在")
    return UPLOAD_DIR / str(doc_id), Path(row["file_path"])


def _page_meta(doc_id: int, page_no: int, blocks: list[dict] | None = None) -> dict:
    doc_dir, pdf_path = _doc_paths(doc_id)
    if blocks is None:
        with get_db() as db:
            rows = db.execute(
                "SELECT type, bbox_json FROM blocks WHERE doc_id=? AND page_no=?", (doc_id, page_no)
            ).fetchall()
        blocks = [{"type": r["type"], "bbox": json.loads(r["bbox_json"] or "[]")} for r in rows]
    try:
        return page_assets.page_meta(doc_dir, pdf_path, page_no, blocks)
    except Exception:
        return {"has_bg": False, "figures": []}


def _attach_sentences(blocks: list[dict]) -> None:
    """block["sentences"] = [{idx, src, tgt, edited, auto}] when an alignment exists."""
    from ..services.sentence_split import auto_align

    ids = [b["id"] for b in blocks]
    by_block: dict[int, list] = {}
    if ids:
        with get_db() as db:
            rows = db.execute(
                "SELECT block_id, idx, src_text, tgt_text, edited FROM sentences WHERE block_id IN (%s) ORDER BY block_id, idx"
                % ",".join("?" * len(ids)),
                ids,
            ).fetchall()
        for r in rows:
            by_block.setdefault(r["block_id"], []).append(
                {"idx": r["idx"], "src": r["src_text"], "tgt": r["tgt_text"], "edited": bool(r["edited"]), "auto": False}
            )
    for b in blocks:
        sents = by_block.get(b["id"])
        if not sents and b.get("translation") and b["type"] in ("paragraph", "list", "heading"):
            pairs = auto_align((b.get("meta") or {}).get("ph") or b["text"], b["translation"])
            if pairs and len(pairs) > 1:
                sents = [{"idx": i, "src": s, "tgt": t, "edited": False, "auto": True} for i, (s, t) in enumerate(pairs)]
        b["sentences"] = sents or None


@router.get("/{page_no}/blocks")
def get_page_blocks(doc_id: int, page_no: int, lang: str = "zh"):
    with get_db() as db:
        page = db.execute(
            "SELECT * FROM pages WHERE doc_id=? AND page_no=?", (doc_id, page_no)
        ).fetchone()
        if page is None:
            raise HTTPException(404, "页面不存在")
        blocks = db.execute(
            "SELECT b.*, t.text AS translation, t.edited AS translation_edited"
            " FROM blocks b LEFT JOIN translations t ON t.block_id=b.id AND t.lang=?"
            " WHERE b.doc_id=? AND b.page_no=? ORDER BY b.order_idx",
            (lang, doc_id, page_no),
        ).fetchall()
        doc = db.execute("SELECT target_lang FROM documents WHERE id=?", (doc_id,)).fetchone()

    out = []
    for r in blocks:
        d = dict(r)
        d["bbox"] = json.loads(d.pop("bbox_json") or "[]")
        d["style"] = json.loads(d.pop("style_json") or "{}")
        d["meta"] = json.loads(d.pop("meta_json") or "{}")
        d["translated"] = bool(d.get("translation"))
        out.append(d)

    _attach_sentences(out)
    meta = _page_meta(doc_id, page_no, out)
    v = page_assets.ASSET_VER
    base = f"/api/documents/{doc_id}/pages/{page_no}"
    return {
        "page_no": page_no,
        "width": page["width"],
        "height": page["height"],
        "target_lang": doc["target_lang"] if doc else lang,
        "blocks": out,
        # text-free render of the original page: figures, images, rules, fills
        "background": f"{base}/background.png?v={v}" if meta.get("has_bg") else None,
        "original": f"{base}/original.png?v={v}",
        "figures": [
            {"bbox": f, "url": f"{base}/figures/{i}.png?v={v}"} for i, f in enumerate(meta.get("figures", []))
        ],
    }


@router.get("/{page_no}/background.png")
def get_page_background(doc_id: int, page_no: int):
    doc_dir, pdf_path = _doc_paths(doc_id)
    try:
        with get_db() as db:
            rows = db.execute(
                "SELECT type, meta_json FROM blocks WHERE doc_id=? AND page_no=?", (doc_id, page_no)
            ).fetchall()
        blocks = [{"type": r["type"], "meta": json.loads(r["meta_json"] or "{}")} for r in rows]
        path = page_assets.render_background(doc_dir, pdf_path, page_no, page_assets.inline_math_rects(blocks))
    except (ValueError, IndexError) as e:
        raise HTTPException(404, "页面不存在") from e
    return FileResponse(path, media_type="image/png", headers={"Cache-Control": "max-age=86400"})


@router.get("/{page_no}/original.png")
def get_page_original(doc_id: int, page_no: int):
    doc_dir, pdf_path = _doc_paths(doc_id)
    try:
        path = page_assets.render_original(doc_dir, pdf_path, page_no)
    except (ValueError, IndexError) as e:
        raise HTTPException(404, "页面不存在") from e
    return FileResponse(path, media_type="image/png", headers={"Cache-Control": "max-age=86400"})


@router.get("/{page_no}/figures/{idx}.png")
def get_page_figure(doc_id: int, page_no: int, idx: int):
    doc_dir, pdf_path = _doc_paths(doc_id)
    figs = _page_meta(doc_id, page_no).get("figures", [])
    if not 0 <= idx < len(figs):
        raise HTTPException(404, "图形不存在")
    path = page_assets.render_figure(doc_dir, pdf_path, page_no, idx, figs[idx])
    return FileResponse(path, media_type="image/png", headers={"Cache-Control": "max-age=86400"})
