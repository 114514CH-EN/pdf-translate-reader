"""Page blocks with translations + page visual assets (background layer / figures)."""
from __future__ import annotations

import json
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from ..config import UPLOAD_DIR
from ..db import get_db
from ..services import image_translate, page_assets

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
            "SELECT b.*, t.text AS translation, t.edited AS translation_edited, t.layout_json AS layout_json,"
            " s.text AS src_text, s.layout_json AS src_layout_json"
            " FROM blocks b LEFT JOIN translations t ON t.block_id=b.id AND t.lang=?"
            # the reader's edits of the ORIGINAL text are kept like a translation into a pseudo language
            " LEFT JOIN translations s ON s.block_id=b.id AND s.lang='__src__'"
            " WHERE b.doc_id=? AND b.page_no=? ORDER BY b.order_idx",
            (lang, doc_id, page_no),
        ).fetchall()
        doc = db.execute("SELECT target_lang, updated_at FROM documents WHERE id=?", (doc_id,)).fetchone()

    out = []
    for r in blocks:
        d = dict(r)
        d["bbox"] = json.loads(d.pop("bbox_json") or "[]")
        d["style"] = json.loads(d.pop("style_json") or "{}")
        d["meta"] = json.loads(d.pop("meta_json") or "{}")
        d["translated"] = bool(d.get("translation"))
        d["layout"] = json.loads(d.pop("layout_json", None) or "null")  # the reader's formatting (edit mode)
        src_text, src_layout = d.pop("src_text", None), json.loads(d.pop("src_layout_json", None) or "null")
        d["src_edit"] = {"text": src_text or None, "layout": src_layout} if (src_text or src_layout) else None
        out.append(d)

    # pictures whose text has been translated (「翻译图片文字」): the painted copy lies over the original
    doc_dir = UPLOAD_DIR / str(doc_id)
    if (doc_dir / "imgtr").is_dir():
        for d in out:
            if d["type"] == "image" and len(d["bbox"]) == 4:
                d["image_tr"] = _image_tr(doc_id, doc_dir, page_no, d["bbox"])

    _attach_sentences(out)
    meta = _page_meta(doc_id, page_no, out)
    # pages can be added, deleted and reordered: the pictures of "page 3" are only valid for one
    # arrangement of the document, so their address changes with it (browsers cache them hard)
    import zlib

    v = f"{page_assets.ASSET_VER}.{zlib.crc32(str(doc['updated_at'] if doc else '').encode()) & 0xFFFF:x}"
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


# ------------------------------------------------------- text inside pictures

def _image_tr(doc_id: int, doc_dir: Path, page_no: int, bbox) -> dict | None:
    key = image_translate.image_key(bbox)
    info = image_translate.load_info(doc_dir, page_no, key)
    if info is None:
        return None
    png = image_translate.png_path(doc_dir, page_no, key)
    url = None
    if png.exists():
        url = f"/api/documents/{doc_id}/pages/{page_no}/image-translations/{key}.png?v={int(png.stat().st_mtime)}"
    return {"url": url, "found": info.get("found", 0), "translated": info.get("translated", 0)}


def _image_block(doc_id: int, page_no: int, block_id: int) -> list[float]:
    with get_db() as db:
        row = db.execute(
            "SELECT type, bbox_json FROM blocks WHERE id=? AND doc_id=? AND page_no=?", (block_id, doc_id, page_no)
        ).fetchone()
    if row is None or row["type"] != "image":
        raise HTTPException(404, "图片不存在")
    bbox = json.loads(row["bbox_json"] or "[]")
    if len(bbox) != 4:
        raise HTTPException(404, "图片不存在")
    return bbox


@router.post("/{page_no}/images/{block_id}/translate")
async def translate_image(doc_id: int, page_no: int, block_id: int):
    """Read the text in one picture, translate it and paint it back in place."""
    from ..services import ocr
    from ..services.llm_client import has_credentials
    from ..services.settings_store import load_settings

    doc_dir, pdf_path = _doc_paths(doc_id)
    bbox = _image_block(doc_id, page_no, block_id)
    if not ocr.available():
        raise HTTPException(503, "这个安装里没有文字识别模型，无法翻译图片")
    cfg = {**load_settings(), "_purpose": "translate", "_doc_id": doc_id}
    if not has_credentials(cfg):
        raise HTTPException(400, "请先在 ⚙ 设置里填写翻译 API")
    with get_db() as db:
        doc = db.execute("SELECT title, target_lang FROM documents WHERE id=?", (doc_id,)).fetchone()
    target = (doc["target_lang"] if doc else None) or cfg.get("target_lang") or "zh"
    try:
        await image_translate.translate_image(doc_dir, pdf_path, page_no, bbox, target, cfg,
                                              doc_title=(doc["title"] if doc else "") or "")
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001 — the reader sees why (no network, wrong key, …)
        raise HTTPException(502, f"翻译图片失败：{str(e)[:200] or e.__class__.__name__}") from e
    return _image_tr(doc_id, doc_dir, page_no, bbox)


@router.delete("/{page_no}/images/{block_id}/translation")
def delete_image_translation(doc_id: int, page_no: int, block_id: int):
    doc_dir, _ = _doc_paths(doc_id)
    image_translate.remove(doc_dir, page_no, image_translate.image_key(_image_block(doc_id, page_no, block_id)))
    return {"ok": True}


@router.get("/{page_no}/image-translations/{key}.png")
def get_image_translation(doc_id: int, page_no: int, key: str):
    if not key.isalnum():
        raise HTTPException(404, "图片不存在")
    doc_dir, _ = _doc_paths(doc_id)
    png = image_translate.png_path(doc_dir, page_no, key)
    if not png.exists():
        raise HTTPException(404, "图片不存在")
    return FileResponse(png, media_type="image/png", headers={"Cache-Control": "max-age=86400"})
