"""公式编辑: the picture of a rewritten formula is kept per LaTeX text and used by PDF export."""
from __future__ import annotations

import base64
import sys
from pathlib import Path

import pymupdf as fitz
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.db import get_db  # noqa: E402
from app.main import app  # noqa: E402
from app.services import formula_edit  # noqa: E402


def _pdf() -> bytes:
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((72, 100), "The gain of the filter is given below.", fontsize=12)
    page.insert_text((200, 160), "H = 1 / (1 + sRC)", fontsize=12)
    return doc.tobytes()


def _png(w: int = 240, h: int = 60) -> bytes:
    pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, w, h), False)
    pix.set_rect(pix.irect, (255, 255, 255))
    pix.set_rect(fitz.IRect(20, 20, w - 20, h - 20), (200, 0, 0))  # a red bar stands in for the formula
    return pix.tobytes("png")


def test_one_picture_per_text(tmp_path):
    a = formula_edit.png_path(tmp_path, 7, "x^2")
    assert a == formula_edit.png_path(tmp_path, 7, "  x^2 ") and a != formula_edit.png_path(tmp_path, 7, "x^3")
    formula_edit.save_png(tmp_path, 7, "x^2", _png())
    assert a.exists()
    for bad in (b"not a picture", b""):
        try:
            formula_edit.save_png(tmp_path, 7, "x^2", bad)
            raise AssertionError("accepted a non-PNG")
        except ValueError:
            pass


def test_rewritten_formula_is_exported():
    with TestClient(app) as c:
        doc_id = c.post("/api/documents", files={"file": ("formula.pdf", _pdf(), "application/pdf")}).json()["doc_id"]
        blocks = c.get(f"/api/documents/{doc_id}/pages/1/blocks").json()["blocks"]
        text, formula = blocks[0], blocks[-1]
        body = {"tex": "H=\\frac{1}{1+sRC}", "png": base64.b64encode(_png()).decode()}
        # only formulas take a picture
        assert c.put(f"/api/blocks/{text['id']}/formula-image", json=body).status_code == 400
        with get_db() as db:
            db.execute("UPDATE blocks SET type='formula' WHERE id=?", (formula["id"],))
        assert c.put(f"/api/blocks/{formula['id']}/formula-image", json={"tex": "x", "png": "!!"}).status_code == 400
        assert c.put(f"/api/blocks/{formula['id']}/formula-image", json=body).status_code == 200
        c.put(f"/api/blocks/{formula['id']}/translation", json={"text": body["tex"], "lang": "zh"})

        got = {b["id"]: b for b in c.get(f"/api/documents/{doc_id}/pages/1/blocks?lang=zh").json()["blocks"]}
        assert got[formula["id"]]["translation"] == body["tex"]

        r = c.post(f"/api/documents/{doc_id}/export", json={"format": "pdf_translated", "lang": "zh"})
        assert r.status_code == 200
        page = fitz.open(stream=r.content, filetype="pdf")[0]
        x0, y0, x1, y1 = formula["bbox"]
        pix = page.get_pixmap(clip=fitz.Rect(x0, y0, x1, y1), matrix=fitz.Matrix(3, 3))
        red = sum(1 for i in range(0, len(pix.samples), pix.n) if pix.samples[i] > 150 and pix.samples[i + 1] < 80)
        assert red > 50, "the picture of the new formula is not on the exported page"

        # back to the original: no picture is drawn
        c.put(f"/api/blocks/{formula['id']}/translation", json={"text": "", "lang": "zh"})
        r = c.post(f"/api/documents/{doc_id}/export", json={"format": "pdf_translated", "lang": "zh"})
        pix = fitz.open(stream=r.content, filetype="pdf")[0].get_pixmap(clip=fitz.Rect(x0, y0, x1, y1), matrix=fitz.Matrix(3, 3))
        red = sum(1 for i in range(0, len(pix.samples), pix.n) if pix.samples[i] > 150 and pix.samples[i + 1] < 80)
        assert red == 0
