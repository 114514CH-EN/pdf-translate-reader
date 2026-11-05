"""Page visual assets: text-free background, figure detection, table normalisation."""
from __future__ import annotations

import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pymupdf as fitz

from app.services import page_assets
from app.services.extract import _fix_text, extract_page
from app.services.structure import build_blocks


def make_figure_pdf(path: Path) -> None:
    doc = fitz.open()
    p = doc.new_page()
    p.insert_text((72, 72), "Figure test document", fontsize=18)
    p.insert_textbox(fitz.Rect(72, 90, 520, 150), "This paragraph describes the plot shown below.", fontsize=11)
    sh = p.new_shape()  # vector plot
    sh.draw_line((100, 350), (400, 350))
    sh.draw_line((100, 350), (100, 180))
    sh.finish(color=(0, 0, 0), width=1)
    sh.draw_polyline([(100 + i * 3, 270 - 70 * math.sin(i / 10)) for i in range(100)])
    sh.finish(color=(0, 0, 1), width=1.5, closePath=False)
    sh.commit()
    p.insert_text((230, 370), "time (s)", fontsize=9)
    p.insert_text((180, 395), "Figure 1: Output voltage versus time.", fontsize=10)
    pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 60, 40), True)  # raster with alpha
    pix.clear_with(200)
    p.insert_image(fitz.Rect(100, 430, 280, 550), pixmap=pix)
    p.draw_rect(fitz.Rect(70, 600, 520, 660), color=None, fill=(0.85, 0.95, 0.85))  # shading
    p.insert_textbox(fitz.Rect(76, 606, 514, 656), "Note: shaded box behind a paragraph is not a figure.", fontsize=11)
    p.draw_line((72, 700), (520, 700))  # rule
    # table with horizontal rules only (no vertical lines) + header fill with sliver gaps
    y = 720
    for x0, x1 in ((72, 220), (226, 370), (376, 520)):
        p.draw_rect(fitz.Rect(x0, y, x1, y + 18), color=None, fill=(0, 0.45, 0.2))
    for i, (a, b, c) in enumerate((("Quantity", "Symbol", "Value"), ("Samples", "N", "512"), ("Interval", "T", "0.1 us"))):
        yy = y + 13 + i * 20
        col = (1, 1, 1) if i == 0 else (0, 0, 0)
        p.insert_text((76, yy), a, fontsize=10, color=col)
        p.insert_text((230, yy), b, fontsize=10, color=col)
        p.insert_text((380, yy), c, fontsize=10, color=col)
        p.draw_line((72, y + 18 + i * 20 + 1), (520, y + 18 + i * 20 + 1), color=(0.5, 0.5, 0.5))
    doc.save(str(path))


def _blocks(page):
    return build_blocks(extract_page(page, None), page.number + 1)


def test_figures_detected_and_filtered(tmp_path):
    pdf_path = tmp_path / "fig.pdf"
    make_figure_pdf(pdf_path)
    page = fitz.open(pdf_path).load_page(0)
    blocks = _blocks(page)
    text = [b["bbox"] for b in blocks if b["type"] not in ("table", "image")]
    tables = [b["bbox"] for b in blocks if b["type"] == "table"]
    figs = page_assets.detect_figures(page, text, tables)
    assert len(figs) == 2, figs
    plot, img = figs
    # plot includes its axis label but not the caption
    assert plot.y1 >= 370 and plot.y1 < 384
    assert abs(img.x0 - 100) < 1 and abs(img.y1 - 550) < 1
    # shading box, rule and table are not figures
    assert all(f.y0 < 600 for f in figs)


def test_background_has_graphics_but_no_text(tmp_path):
    pdf_path = tmp_path / "fig.pdf"
    make_figure_pdf(pdf_path)
    with fitz.open(pdf_path) as pdf:
        page = page_assets.text_free_page(pdf, 1)
        assert page.get_text().strip() == ""
        assert page.get_drawings(), "vector art must survive"
        assert page.get_image_info(), "raster images must survive"
    meta = page_assets.page_meta(tmp_path, pdf_path, 1, [])
    assert meta["has_bg"] is True
    png = page_assets.render_background(tmp_path, pdf_path, 1)
    assert png.exists() and png.stat().st_size > 1000


def test_table_without_vertical_rules_is_split_into_columns(tmp_path):
    pdf_path = tmp_path / "fig.pdf"
    make_figure_pdf(pdf_path)
    payload = extract_page(fitz.open(pdf_path).load_page(0), None)
    assert payload["tables"], "table not found"
    t = payload["tables"][-1]
    assert t["n_cols"] == 3, t
    grid = {(c["row"], c["col"]): c for c in t["cells"]}
    assert grid[(0, 0)]["text"] == "Quantity" and grid[(0, 2)]["text"] == "Value"
    assert grid[(1, 1)]["text"] == "N" and grid[(2, 2)]["text"] == "0.1 us"
    assert grid[(0, 0)]["color"] == 0xFFFFFF  # white header text kept for rendering


def test_interleave_places_figures_and_drops_labels():
    blocks = [
        {"id": 1, "bbox": [72, 90, 500, 120]},
        {"id": 2, "bbox": [230, 360, 260, 372]},  # label inside figure
        {"id": 3, "bbox": [180, 384, 340, 398]},  # caption
    ]
    seq = page_assets.interleave(blocks, [[100, 180, 400, 373]])
    kinds = [(k, v["id"] if k == "block" else "fig") for k, v in seq]
    assert kinds == [("block", 1), ("figure", "fig"), ("block", 3)]


def test_math_duplicate_glyphs_collapsed():
    assert _fix_text("𝑁𝑁 and 𝑇𝑇𝑝𝑝", True) == "𝑁 and 𝑇𝑝"
    assert _fix_text("𝑁𝑁", False) == "𝑁𝑁"
    assert _fix_text("book", True) == "book"  # ASCII doubles untouched


def _load_doc(pdf_path: Path) -> int:
    import json

    from app.db import get_db, init_db

    init_db()
    with get_db() as db:
        doc_id = db.execute(
            "INSERT INTO documents (title, file_path, status) VALUES ('fig', ?, 'ready')", (str(pdf_path),)
        ).lastrowid
        page = fitz.open(pdf_path).load_page(0)
        payload = extract_page(page, None)
        page_id = db.execute(
            "INSERT INTO pages (doc_id, page_no, width, height, extract_json) VALUES (?,1,?,?,?)",
            (doc_id, payload["width"], payload["height"], "{}"),
        ).lastrowid
        for b in build_blocks(payload, 1):
            bid = db.execute(
                "INSERT INTO blocks (doc_id, page_id, page_no, order_idx, type, level, bbox_json, style_json,"
                " meta_json, text, font_size, bold, list_marker, stable_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (doc_id, page_id, 1, b["order_idx"], b["type"], b["level"], json.dumps(b["bbox"]),
                 json.dumps(b["style"]), json.dumps(b["meta"]), b["text"], b["font_size"], b["bold"],
                 b["list_marker"], b["stable_key"]),
            ).lastrowid
            db.execute("INSERT INTO translations (block_id, lang, text) VALUES (?, 'zh', ?)", (bid, "译文"))
    return doc_id


def test_bilingual_and_markdown_exports_include_figures(tmp_path):
    from app.services.export_md import export_markdown
    from app.services.export_pdf_bilingual import export_bilingual_pdf

    pdf_path = tmp_path / "fig.pdf"
    make_figure_pdf(pdf_path)
    doc_id = _load_doc(pdf_path)

    out = export_bilingual_pdf(doc_id, tmp_path / "bi.pdf", "zh")
    with fitz.open(out) as pdf:
        assert sum(len(p.get_drawings()) for p in pdf) > 0, "vector figure missing"
        assert sum(len(p.get_image_info()) for p in pdf) > 0, "raster figure missing"

    md = export_markdown(doc_id, tmp_path / "out.md", "zh").read_text(encoding="utf-8")
    assert md.count("data:image/png;base64,") == 2


def test_inplace_export_keeps_fills(tmp_path):
    from app.services.export_pdf_inplace import export_translated_pdf

    pdf_path = tmp_path / "fig.pdf"
    make_figure_pdf(pdf_path)
    doc_id = _load_doc(pdf_path)
    out = export_translated_pdf(doc_id, tmp_path / "tr.pdf", "zh")
    with fitz.open(out) as pdf:
        page = pdf.load_page(0)
        # green header fill still there (redaction no longer paints white boxes)
        pix = page.get_pixmap(clip=fitz.Rect(150, 722, 151, 723))
        r, g, b = pix.pixel(0, 0)[:3]
        assert g > r + 40 and g > b + 20, (r, g, b)
        assert "Quantity" not in page.get_text()
