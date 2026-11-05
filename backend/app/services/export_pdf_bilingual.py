"""Bilingual PDF: source block (gray, small) followed by translation, flowing layout.

Figures (vector drawings / raster images detected on the original pages) are
copied in reading order with ``show_pdf_page`` — vector quality, not a raster.
"""
from __future__ import annotations

import json
from pathlib import Path

import pymupdf as fitz

from ..config import UPLOAD_DIR
from ..db import get_db
from . import page_assets
from .export_common import MathImages, block_html, font_archive, math_body


def export_bilingual_pdf(doc_id: int, out_path: Path, lang: str) -> Path:
    with get_db() as db:
        doc_row = db.execute("SELECT title, file_path FROM documents WHERE id=?", (doc_id,)).fetchone()
        blocks = db.execute(
            "SELECT b.*, t.text AS translation FROM blocks b"
            " LEFT JOIN translations t ON t.block_id=b.id AND t.lang=?"
            " WHERE b.doc_id=? ORDER BY b.page_no, b.order_idx",
            (lang, doc_id),
        ).fetchall()

    src_path = Path(doc_row["file_path"]) if doc_row and doc_row["file_path"] else None
    src = fitz.open(src_path) if src_path and src_path.exists() else None
    doc_dir = UPLOAD_DIR / str(doc_id)

    by_page: dict[int, list] = {}
    for r in blocks:
        by_page.setdefault(r["page_no"], []).append(r)

    arch, css = font_archive()
    mi = MathImages(src)
    out = fitz.open()
    A4 = fitz.paper_rect("a4")
    margin = 54
    bottom = A4.height - margin
    avail_w = A4.width - 2 * margin
    page = out.new_page(width=A4.width, height=A4.height)
    cursor_y = margin

    def new_page():
        nonlocal page, cursor_y
        page = out.new_page(width=A4.width, height=A4.height)
        cursor_y = margin

    def put_html(html: str):
        nonlocal cursor_y
        box_h = 200
        for _ in range(4):
            if cursor_y + box_h > bottom:
                if cursor_y > margin:
                    new_page()
                box_h = min(box_h, bottom - cursor_y)
            rect = fitz.Rect(margin, cursor_y, A4.width - margin, min(cursor_y + box_h, bottom))
            spare, _scale = page.insert_htmlbox(rect, html, css=css, archive=arch, scale_low=0.4, overlay=True)
            if spare >= 0:
                cursor_y += (rect.height - spare) + 8
                return
            box_h += 200
        new_page()

    def put_figure(page_no: int, rect: fitz.Rect):
        nonlocal cursor_y
        if src is None or rect.is_empty:
            return
        scale = min(1.0, avail_w / rect.width, (bottom - margin) / rect.height)
        w, h = rect.width * scale, rect.height * scale
        if cursor_y + h > bottom:
            new_page()
        x0 = margin + (avail_w - w) / 2
        target = fitz.Rect(x0, cursor_y, x0 + w, cursor_y + h)
        try:
            page.show_pdf_page(target, src, page_no - 1, clip=rect)
        except Exception:
            pix = src.load_page(page_no - 1).get_pixmap(clip=rect, dpi=page_assets.FIG_DPI)
            page.insert_image(target, pixmap=pix)
        cursor_y += h + 10

    title = doc_row["title"] if doc_row else "Bilingual Document"
    header = block_html(title, {"size": 16, "bold": True})
    page.insert_htmlbox(fitz.Rect(margin, cursor_y, A4.width - margin, cursor_y + 30), header,
                        css=css, archive=arch, scale_low=0.6, overlay=True)
    cursor_y += 36

    for page_no in sorted(by_page):
        rows = by_page[page_no]
        figures: list = []
        if src is not None:
            try:
                blk_dicts = [{"type": r["type"], "bbox": json.loads(r["bbox_json"] or "[]")} for r in rows]
                figures = page_assets.page_meta(doc_dir, src_path, page_no, blk_dicts).get("figures", [])
            except Exception:
                figures = []
        seq = page_assets.interleave(rows, figures, key=lambda r: json.loads(r["bbox_json"] or "[0,0,0,0]"))
        for kind, item in seq:
            if kind == "figure":
                _idx, rect = item
                put_figure(page_no, fitz.Rect(rect))
                continue
            r = item
            if r["type"] == "formula":
                put_figure(page_no, fitz.Rect(json.loads(r["bbox_json"])) + (-2, -2, 2, 2))
                continue
            if r["type"] == "image" or not (r["text"] or r["translation"]):
                continue  # raster images are emitted as figures
            meta = json.loads(r["meta_json"] or "{}")
            src_text = meta.get("ph") or r["text"]
            orig_size = float(json.loads(r["style_json"] or "{}").get("size") or 11)
            src_style = {"size": 9, "color": 0x888888}
            tgt_style = {
                "size": 11,
                "bold": bool(r["bold"]) or r["type"] == "heading",
                "color": 0x000000,
            }
            if r["type"] == "table":
                tgt_style["size"] = 9.5
            parts = []
            src_body = math_body(src_text, meta, page_no, mi, scale=9 * 0.95 / orig_size)
            tgt_body = math_body(r["translation"] or "", meta, page_no, mi, scale=tgt_style["size"] / orig_size)
            if src_body is not None or tgt_body is not None:
                arch = mi.add_to(arch)
            if r["text"]:
                parts.append(block_html(src_text, src_style, scale=0.95, body=src_body))
            if r["translation"]:
                parts.append(block_html(r["translation"], tgt_style, body=tgt_body))
            elif r["text"]:
                parts.append(block_html("(未翻译)", {"size": 9, "italic": True, "color": 0xcc4444}))
            put_html("".join(parts))

    try:
        out.subset_fonts()
    except Exception:
        pass
    out.save(str(out_path), garbage=4, deflate=True, clean=True)
    out.close()
    if src is not None:
        src.close()
    mi.cleanup()
    return out_path
