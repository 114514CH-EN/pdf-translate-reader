"""Regressions found in the 2026-11-05 project review."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pymupdf as fitz

from app.services.extract import _has_columns, _has_ruling, extract_page
from app.services.structure import build_blocks

LOREM = "Signal processing transforms data between the time and frequency domains. " * 3


def test_same_width_blocks_do_not_crash_reading_order():
    # two-column page whose boxes share x-centres (justified text) used to raise
    # "'<' not supported between instances of 'dict' and 'dict'"
    d = fitz.open()
    p = d.new_page()
    for y in (80, 220, 360):
        p.insert_textbox(fitz.Rect(72, y, 290, y + 120), LOREM, fontsize=9.5)
        p.insert_textbox(fitz.Rect(310, y, 528, y + 120), LOREM, fontsize=9.5)
    blocks = build_blocks(extract_page(p, None), 1)
    assert len(blocks) >= 6
    # left column is read before the right one
    xs = [b["bbox"][0] for b in blocks]
    assert xs.index(min(xs)) < xs.index(max(xs))


def test_table_detection_is_skipped_on_plain_text_pages():
    d = fitz.open()
    p = d.new_page()
    p.insert_textbox(fitz.Rect(72, 72, 520, 400), LOREM * 3, fontsize=11)
    payload = extract_page(p, None)
    assert not _has_ruling(p) and not _has_columns(payload["raw_blocks"])
    assert payload["tables"] == []
    p2 = d.new_page()
    p2.draw_line((72, 100), (520, 100))
    assert _has_ruling(p2)


def test_bold_end_of_sentence_stays_in_paragraph():
    d = fitz.open()
    p = d.new_page()
    p.insert_text((72, 100), "Every figure must carry your ID. Figures without an ID will not be", fontsize=11, fontname="helv")
    p.insert_text((72, 114), "marked.", fontsize=11, fontname="hebo")
    p.insert_text((72, 160), "Heading In Bold", fontsize=11, fontname="hebo")
    p.insert_text((72, 174), "Body text right under the bold heading line.", fontsize=11, fontname="helv")
    texts = [b["text"] for b in build_blocks(extract_page(p, None), 1)]
    assert any(t.endswith("will not be\nmarked.") for t in texts), texts
    assert "Heading In Bold" in texts, texts


def test_upload_rejects_broken_and_locked_pdfs(tmp_path):
    from fastapi.testclient import TestClient

    from app.main import app

    locked = tmp_path / "locked.pdf"
    d = fitz.open()
    d.new_page().insert_text((72, 72), "secret")
    d.save(str(locked), encryption=fitz.PDF_ENCRYPT_AES_256, user_pw="pw", owner_pw="ow")
    with TestClient(app) as c:
        r = c.post("/api/documents", files={"file": ("x.pdf", b"not a pdf", "application/pdf")})
        assert r.status_code == 400 and "不是有效的 PDF" in r.json()["detail"]
        r = c.post("/api/documents", files={"file": ("l.pdf", locked.read_bytes(), "application/pdf")})
        assert r.status_code == 400 and "密码" in r.json()["detail"]
