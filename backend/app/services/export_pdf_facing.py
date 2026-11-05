"""Bilingual page-by-page PDFs built from the layout-faithful translation.

* side_by_side — one wide sheet per page: original on the left, translation on the right
* alternate    — original page followed by its translated page (print duplex / flip)
"""
from __future__ import annotations

import tempfile
from pathlib import Path

import pymupdf as fitz

from ..db import get_db
from .export_common import add_highlight_annots, load_highlights
from .export_pdf_inplace import export_translated_pdf


def export_facing_pdf(doc_id: int, out_path: Path, lang: str, layout: str = "side_by_side") -> Path:
    with get_db() as db:
        row = db.execute("SELECT file_path FROM documents WHERE id=?", (doc_id,)).fetchone()
    if row is None:
        raise ValueError("document not found")
    with tempfile.TemporaryDirectory(prefix="pdftr_facing_") as tmp:
        tr_path = export_translated_pdf(doc_id, Path(tmp) / "tr.pdf", lang)
        src = fitz.open(row["file_path"])
        tr = fitz.open(tr_path)
        out = fitz.open()
        src_hl = load_highlights(doc_id, "src")
        tgt_hl = load_highlights(doc_id, "tgt")
        try:
            if layout == "alternate":
                for i in range(src.page_count):
                    out.insert_pdf(src, from_page=i, to_page=i)
                    add_highlight_annots(out[-1], src_hl.get(i + 1, []))
                    out.insert_pdf(tr, from_page=i, to_page=i)  # carries the translation-pane highlights
            else:
                gap = 18
                for i in range(src.page_count):
                    r = src.load_page(i).rect
                    page = out.new_page(width=r.width * 2 + gap, height=r.height)
                    page.show_pdf_page(fitz.Rect(0, 0, r.width, r.height), src, i)
                    page.show_pdf_page(fitz.Rect(r.width + gap, 0, r.width * 2 + gap, r.height), tr, i)
                    add_highlight_annots(page, src_hl.get(i + 1, []))
                    add_highlight_annots(page, tgt_hl.get(i + 1, []), dx=r.width + gap)
                    page.draw_line((r.width + gap / 2, 18), (r.width + gap / 2, r.height - 18),
                                   color=(0.8, 0.8, 0.8), width=0.5)
            out.save(str(out_path), garbage=4, deflate=True)
        finally:
            out.close()
            tr.close()
            src.close()
    return out_path
