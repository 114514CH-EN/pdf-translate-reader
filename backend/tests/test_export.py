"""In-place export: translations replace source text at the original geometry."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pymupdf

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tests.test_smoke_extract import make_fixture, FIXTURE


def test_inplace_export(tmp_path):
    # build a small DB-backed document via the app services
    import json

    from app.db import get_db, init_db
    from app.services.export_pdf_inplace import export_translated_pdf
    from app.services.extract import extract_page
    from app.services.structure import build_blocks

    init_db()
    make_fixture(FIXTURE)
    with get_db() as db:
        cur = db.execute("INSERT INTO documents (title, file_path, status) VALUES ('t', ?, 'ready')", (str(FIXTURE),))
        doc_id = cur.lastrowid
        pdf = pymupdf.open(FIXTURE)
        payload = extract_page(pdf.load_page(0), None)
        cur = db.execute(
            "INSERT INTO pages (doc_id, page_no, width, height, extract_json) VALUES (?,1,?,?,?)",
            (doc_id, payload["width"], payload["height"], json.dumps({})),
        )
        page_id = cur.lastrowid
        for b in build_blocks(payload, 1):
            cur = db.execute(
                "INSERT INTO blocks (doc_id, page_id, page_no, order_idx, type, level, bbox_json, style_json,"
                " meta_json, text, font_size, bold, list_marker, stable_key)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    doc_id, page_id, 1, b["order_idx"], b["type"], b["level"],
                    json.dumps(b["bbox"]), json.dumps(b["style"]), json.dumps(b["meta"]),
                    b["text"], b["font_size"], b["bold"], b["list_marker"], b["stable_key"],
                ),
            )
            db.execute(
                "INSERT INTO translations (block_id, lang, text, model) VALUES (?, 'zh', ?, 'fake')",
                (cur.lastrowid, f"译文{b['order_idx']}内容"),
            )

    out = tmp_path / "out.pdf"
    export_translated_pdf(doc_id, out, "zh")
    pdf = pymupdf.open(out)
    page = pdf.load_page(0)
    text = page.get_text()
    # source removed, translation present & extractable (copyable)
    assert "SIGNALS" not in text
    assert "译文0内容" in text
    # translation inside original bbox tolerance (±2pt)
    blocks = [b for b in build_blocks(payload, 1)]
    title = blocks[0]
    hits = page.search_for("译文0内容")
    assert hits, "inserted text not found"
    h = hits[0]
    assert abs(h.x0 - title["bbox"][0]) < 2
    # a CJK font's line box starts higher than its glyphs (Noto CJK ascent ≈ 1.16 em)
    assert abs(h.y0 - title["bbox"][1]) < 5
    assert pdf.page_count == 1
