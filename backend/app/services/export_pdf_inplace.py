"""Layout-faithful translated PDF: redact (remove) source text, insert translation in place."""
from __future__ import annotations

import json
from pathlib import Path

import pymupdf as fitz

from ..db import get_db
from .export_common import MathImages, block_html, font_archive, math_body, parse_md_table


def export_translated_pdf(doc_id: int, out_path: Path, lang: str) -> Path:
    with get_db() as db:
        doc_row = db.execute("SELECT file_path FROM documents WHERE id=?", (doc_id,)).fetchone()
        if doc_row is None:
            raise ValueError("document not found")
        src_path = doc_row["file_path"]
        blocks = db.execute(
            "SELECT b.*, t.text AS translation FROM blocks b"
            " LEFT JOIN translations t ON t.block_id=b.id AND t.lang=?"
            " WHERE b.doc_id=? ORDER BY b.page_no, b.order_idx",
            (lang, doc_id),
        ).fetchall()

    arch, css = font_archive()
    pdf = fitz.open(src_path)
    orig = fitz.open(src_path)  # untouched copy: formula crops are rendered from it
    mi = MathImages(orig)
    keep_by_page: dict[int, list[fitz.Rect]] = {}
    for r in blocks:
        keep_by_page.setdefault(r["page_no"], []).extend(_kept_math_rects(r))
    by_page: dict[int, list] = {}
    for r in blocks:
        if r["translation"] and r["type"] not in ("image", "formula"):
            by_page.setdefault(r["page_no"], []).append(r)

    for page_no, rows in by_page.items():
        page = pdf.load_page(page_no - 1)
        # 1) remove ALL source text under translated blocks. fill=False: nothing is
        #    painted over the area, so figures, cell fills and colored boxes survive.
        for r in rows:
            bbox = fitz.Rect(json.loads(r["bbox_json"]))
            meta = json.loads(r["meta_json"] or "{}")
            if r["type"] == "table" and meta.get("cells"):
                for c in meta["cells"]:
                    if c.get("math"):
                        continue  # math cells keep the original glyphs
                    page.add_redact_annot(fitz.Rect(c["bbox"]), fill=False, cross_out=False)
            else:
                page.add_redact_annot(bbox, fill=False, cross_out=False)
        page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE, graphics=fitz.PDF_REDACT_LINE_ART_NONE)
        # Math fonts (e.g. Cambria Math) report glyph boxes several lines tall, so the
        # redactions above can delete glyphs of neighbouring formulas / untranslated
        # text. Every region that must stay original is therefore cleared and then
        # re-drawn from the untouched source page (vector, clipped to the region).
        _restore_regions(page, orig, page_no, keep_by_page.get(page_no, []))
        # 2) draw translations at the original geometry
        for r in rows:
            bbox = fitz.Rect(json.loads(r["bbox_json"]))
            style = json.loads(r["style_json"] or "{}")
            meta = json.loads(r["meta_json"] or "{}")
            trans = r["translation"]
            if r["type"] == "table" and meta.get("cells"):
                if "{{m" in trans:
                    arch = mi.add_to(arch)
                _draw_table(page, meta, trans, style, arch, css, mi, page_no)
            else:
                body = math_body(trans, meta, page_no, mi)
                if body is not None:
                    arch = mi.add_to(arch)
                _draw_block(page, bbox, trans, style, arch, css, body)

    # highlights made in the translation pane sit on the translated text
    from .export_common import add_highlight_annots, load_highlights

    for page_no, hls in load_highlights(doc_id, "tgt").items():
        if 1 <= page_no <= pdf.page_count:
            add_highlight_annots(pdf.load_page(page_no - 1), hls)
    try:
        pdf.subset_fonts()
    except Exception:
        pass
    pdf.save(str(out_path), garbage=4, deflate=True, clean=True)
    pdf.close()
    orig.close()
    mi.cleanup()
    return out_path


def _kept_math_rects(r) -> list[fitz.Rect]:
    """Regions that keep their original rendering in the exported page."""
    meta = json.loads(r["meta_json"] or "{}")
    bbox = fitz.Rect(json.loads(r["bbox_json"]))
    if r["type"] == "formula":
        return [bbox]
    if r["type"] == "image" or not (r["text"] or "").strip():
        return []
    if not r["translation"]:
        return [bbox + (-1, -1, 1, 1)]  # untranslated block: original as-is
    if r["type"] == "table":
        return [fitz.Rect(c["bbox"]) for c in meta.get("cells", []) if c.get("math")]
    return []


def _restore_regions(page, orig, page_no: int, rects: list[fitz.Rect]) -> None:
    rects = [fitz.Rect(r) & page.rect for r in rects]
    rects = [r for r in rects if not r.is_empty]
    if not rects:
        return
    for r in rects:
        page.add_redact_annot(r, fill=False, cross_out=False)
    page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE, graphics=fitz.PDF_REDACT_LINE_ART_NONE)
    for r in rects:
        try:
            page.show_pdf_page(r, orig, page_no - 1, clip=r)
        except Exception:
            pix = orig.load_page(page_no - 1).get_pixmap(clip=r, matrix=fitz.Matrix(4, 4))
            page.insert_image(r, pixmap=pix)


def _draw_block(page, bbox: fitz.Rect, text: str, style: dict, arch, css, body: str | None = None) -> None:
    box = fitz.Rect(bbox.x0, bbox.y0, bbox.x1, max(bbox.y1, bbox.y0 + (style.get("size") or 12) * 1.4))
    html = block_html(text, style, body=body)
    page.insert_htmlbox(box, html, css=css, archive=arch, scale_low=0.55, overlay=True)


def _draw_table(page, meta: dict, trans: str, style: dict, arch, css, mi=None, page_no: int = 0) -> None:
    cells = meta.get("cells") or []
    n_rows = int(meta.get("n_rows") or 0)
    n_cols = int(meta.get("n_cols") or 0)
    grid = parse_md_table(trans)
    use_grid = grid is not None and len(grid) == n_rows and all(len(row) == n_cols for row in grid)

    if use_grid:
        for c in cells:
            if c.get("math"):
                continue
            r_i, c_i = int(c["row"]), int(c["col"])
            rect = fitz.Rect(c["bbox"])
            text = grid[r_i][c_i]
            if not text:
                continue
            cell_style = dict(style)
            if "color" in c:
                cell_style["color"] = c["color"]
            if c.get("bold") or (r_i == 0 and "bold" not in c):
                cell_style["bold"] = True
            inner = fitz.Rect(rect.x0 + 1.5, rect.y0 + 1.5, rect.x1 - 1.5, rect.y1 - 1)
            html = block_html(text, cell_style, scale=0.92, body=math_body(text, meta, page_no, mi, scale=0.92))
            page.insert_htmlbox(inner, html, css=css, archive=arch, scale_low=0.5, overlay=True)
    else:
        bbox = fitz.Rect(cells[0]["bbox"]) if cells else None
        if bbox is None:
            return
        for c in cells[1:]:
            bbox |= fitz.Rect(c["bbox"])
        html = block_html(trans, style, scale=0.9, body=math_body(trans, meta, page_no, mi, scale=0.9))
        page.insert_htmlbox(bbox, html, css=css, archive=arch, scale_low=0.45, overlay=True)
