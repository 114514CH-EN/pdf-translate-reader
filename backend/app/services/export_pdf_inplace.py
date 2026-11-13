"""Layout-faithful translated PDF: redact (remove) source text, insert translation in place."""
from __future__ import annotations

import json
from pathlib import Path

import pymupdf as fitz

from ..db import get_db
from .export_common import MathImages, block_html, font_archive, math_body, parse_md_table
from .page_assets import inline_math_rects, remove_math_line_art


def export_translated_pdf(doc_id: int, out_path: Path, lang: str) -> Path:
    with get_db() as db:
        doc_row = db.execute("SELECT file_path FROM documents WHERE id=?", (doc_id,)).fetchone()
        if doc_row is None:
            raise ValueError("document not found")
        src_path = doc_row["file_path"]
        blocks = db.execute(
            "SELECT b.*, t.text AS translation, t.layout_json AS layout_json FROM blocks b"
            " LEFT JOIN translations t ON t.block_id=b.id AND t.lang=?"
            " WHERE b.doc_id=? ORDER BY b.page_no, b.order_idx",
            (lang, doc_id),
        ).fetchall()

    # What the reader added themselves (text boxes, pictures, lines) is not in the PDF.
    # Its place is the block's own box; "hidden" and the look of pictures / lines are kept with
    # the original side ("__src__"); a text box nobody translated is written in its own words.
    with get_db() as db:
        own_src = {
            r["block_id"]: (r["text"], json.loads(r["layout_json"] or "null") or {})
            for r in db.execute(
                "SELECT t.block_id, t.text, t.layout_json FROM translations t JOIN blocks b ON b.id=t.block_id"
                " WHERE b.doc_id=? AND t.lang='__src__' AND b.meta_json LIKE '%\"user\"%'", (doc_id,))
        }
    own_hidden = {bid for bid, (_t, lay) in own_src.items() if lay.get("hidden")}
    if lang != "__src__":
        fixed = []
        for r in blocks:
            d = dict(r)
            if '"user"' in (d["meta_json"] or "") and d["type"] != "image":
                src_text, src_layout = own_src.get(d["id"], (None, {}))
                if d["id"] in own_hidden:
                    d["layout_json"] = json.dumps({**(json.loads(d["layout_json"] or "null") or {}), "hidden": True})
                elif not d["translation"]:
                    d["translation"] = src_text or d["text"]
                    d["layout_json"] = json.dumps({k: v for k, v in src_layout.items() if k != "bbox"}) if src_layout else d["layout_json"]
            fixed.append(d)
        blocks = fixed

    if lang == "__src__":
        # the original with the reader's edits: a block that was only moved, restyled or hidden
        # (no new text) is redrawn from its own text
        fixed = []
        for r in blocks:
            d = dict(r)
            if not d["translation"] and d["layout_json"] and d["type"] not in ("table", "code", "image", "formula"):
                d["translation"] = json.loads(d["meta_json"] or "{}").get("ph") or d["text"]
            fixed.append(d)
        blocks = fixed
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

    # pictures whose text was translated (「翻译图片文字」): the painted copy goes over the original,
    # before any translated text of the page is written on top
    from . import image_translate
    from ..config import UPLOAD_DIR

    doc_dir = UPLOAD_DIR / str(doc_id)
    if lang != "__src__" and (doc_dir / "imgtr").is_dir():
        for r in blocks:
            if r["type"] != "image":
                continue
            bbox = json.loads(r["bbox_json"] or "[]")
            if len(bbox) != 4:
                continue
            png = image_translate.png_path(doc_dir, r["page_no"], image_translate.image_key(bbox))
            if png.exists():
                page = pdf.load_page(r["page_no"] - 1)
                try:
                    page.insert_image(fitz.Rect(bbox) & page.rect, filename=str(png), overlay=True)
                except Exception:
                    pass  # the export still works with the original picture

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
            elif r["type"] == "code":
                for rect, _text, _info in _code_comments(r, meta):
                    page.add_redact_annot(rect, fill=False, cross_out=False)
            else:
                page.add_redact_annot(bbox, fill=False, cross_out=False)
        page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE, graphics=fitz.PDF_REDACT_LINE_ART_NONE)
        # fraction bars of inline math would stay at the old place, across the translation
        try:
            remove_math_line_art(page, inline_math_rects(
                [{"type": r["type"], "meta": json.loads(r["meta_json"] or "{}")} for r in rows]))
        except Exception:
            pass
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
            # the reader's own formatting from edit mode: size, bold, colour, alignment, place, hidden
            layout = json.loads(r["layout_json"] or "null") or {}
            if layout.get("hidden"):
                continue
            if layout:
                style = dict(style)
                if layout.get("scale"):
                    style["size"] = (style.get("size") or 12) * float(layout["scale"])
                for key in ("bold", "color", "align"):
                    if key in layout:
                        style[key] = layout[key]
                if layout.get("bbox") and r["type"] not in ("table", "code"):
                    bbox = fitz.Rect(layout["bbox"]) & page.rect
            if r["type"] == "table" and meta.get("cells"):
                if "{{m" in trans:
                    arch = mi.add_to(arch)
                _draw_table(page, meta, trans, style, arch, css, mi, page_no)
            elif r["type"] == "code":
                for rect, text, info in _code_comments(r, meta):
                    box = fitz.Rect(rect.x0, rect.y0, max(rect.x1, page.rect.x1 - 30), rect.y1 + 1)
                    cstyle = {**style, "color": info.get("cc", style.get("color", 0)),
                              "size": (style.get("size") or 10) * 0.95, "bold": False}
                    page.insert_htmlbox(box, block_html(text, cstyle), css=css, archive=arch,
                                        scale_low=0.5, overlay=True)
            else:
                body = math_body(trans, meta, page_no, mi)
                if body is not None:
                    arch = mi.add_to(arch)
                _draw_block(page, bbox, trans, style, arch, css, body)

    # pictures and lines the reader put on the pages
    for r in blocks:
        if r["type"] != "image" or '"user"' not in (r["meta_json"] or "") or r["id"] in own_hidden:
            continue
        try:
            meta = json.loads(r["meta_json"] or "{}")
            page = pdf.load_page(r["page_no"] - 1)
            box = fitz.Rect(json.loads(r["bbox_json"]))
            if meta.get("shape"):
                look = own_src.get(r["id"], (None, {}))[1]
                colour = int(look.get("color") or 0x1A1A1A)
                rgb = ((colour >> 16 & 255) / 255, (colour >> 8 & 255) / 255, (colour & 255) / 255)
                w = float(meta.get("width") or 1.5) * float(look.get("scale") or 1)  # thickness is the "scale" of a shape
                if meta["shape"] == "rect":
                    page.draw_rect(box + (w / 2, w / 2, -w / 2, -w / 2), color=rgb, width=w)
                elif meta["shape"] == "ellipse":
                    page.draw_oval(box + (w / 2, w / 2, -w / 2, -w / 2), color=rgb, width=w)
                else:
                    p1, p2 = shape_ends(box, meta.get("dir"), bool(meta.get("rev")))
                    if meta["shape"] == "arrow":
                        tip, wings, neck = arrow_head(p1, p2, w)
                        page.draw_line(fitz.Point(p1), fitz.Point(neck), color=rgb, width=w, lineCap=1)
                        page.draw_polyline([fitz.Point(tip), fitz.Point(wings[0]), fitz.Point(wings[1]), fitz.Point(tip)],
                                           color=rgb, fill=rgb, width=0.2, closePath=True)
                    else:
                        page.draw_line(fitz.Point(p1), fitz.Point(p2), color=rgb, width=w, lineCap=1)
            elif meta.get("file"):
                png = doc_dir / "images" / str(meta["file"])
                if png.exists():
                    page.insert_image(box, filename=str(png), keep_proportion=False, overlay=True)
        except Exception:
            pass  # the export still works without this one

    # formulas the reader rewrote in edit mode: the picture of the new formula goes over the old one
    from . import formula_edit

    for r in blocks:
        if r["type"] != "formula" or not (r["translation"] or "").strip():
            continue
        png = formula_edit.png_path(doc_dir, r["id"], r["translation"])
        if not png.exists():
            continue  # no picture for this text: the original formula stays
        try:
            page = pdf.load_page(r["page_no"] - 1)
            meta = json.loads(r["meta_json"] or "{}")
            area = fitz.Rect(meta.get("crop") or json.loads(r["bbox_json"])) & page.rect
            page.draw_rect(area, color=None, fill=(1, 1, 1), overlay=True)
            pix = fitz.Pixmap(str(png))
            scale = min(area.width / pix.width, area.height / pix.height, 1 / 4)  # drawn at 4x: 4 px = 1 pt; never enlarged
            w, h = pix.width * scale, pix.height * scale
            cx, cy = (area.x0 + area.x1) / 2, (area.y0 + area.y1) / 2
            page.insert_image(fitz.Rect(cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2), pixmap=pix, overlay=True)
        except Exception:
            pass  # the export still works; this formula keeps its original look

    # highlights made in the translation pane sit on the translated text
    from .export_common import add_highlight_annots, load_highlights

    for page_no, hls in load_highlights(doc_id, "src" if lang == "__src__" else "tgt").items():
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


def shape_ends(box, direction, rev: bool = False):
    """Start and end of a line / arrow lying in its box (the same rule as the page view)."""
    mx, my = (box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2
    a, b = {"h": ((box.x0, my), (box.x1, my)), "v": ((mx, box.y0), (mx, box.y1)),
            "d2": ((box.x0, box.y1), (box.x1, box.y0))}.get(direction, ((box.x0, box.y0), (box.x1, box.y1)))
    return (b, a) if rev else (a, b)


def arrow_head(p1, p2, width: float):
    """(tip, (wing, wing), where the shaft stops) for an arrow from p1 to p2."""
    import math

    dx, dy = p2[0] - p1[0], p2[1] - p1[1]
    length = math.hypot(dx, dy) or 1.0
    ux, uy = dx / length, dy / length
    head = min(max(7.0, width * 4.5), length * 0.6)
    bx, by = p2[0] - ux * head, p2[1] - uy * head
    half = head * 0.42
    wings = ((bx - uy * half, by + ux * half), (bx + uy * half, by - ux * half))
    return p2, wings, (p2[0] - ux * head * 0.7, p2[1] - uy * head * 0.7)


def _code_comments(r, meta: dict) -> list[tuple]:
    """(comment area on the page, translated comment incl. marker, line info) per commented line."""
    from .code_blocks import split_line, translation_fits

    if not translation_fits(r["text"], r["translation"], meta):
        return []
    out = []
    for line, info in zip(r["translation"].split("\n"), (meta.get("code") or {}).get("lines") or []):
        if info.get("cx") is None:
            continue
        _code, head, comment = split_line(line, info.get("ci"))
        if comment:
            rect = fitz.Rect(info["cx"] - 0.5, info["y0"], max(info["x1"], info["cx"] + 1) + 0.5, info["y1"])
            out.append((rect, head + comment, info))
    return out


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
