"""从零开始: a blank document, more pages, text boxes of one's own — and they survive re-extraction."""
from __future__ import annotations

import sys
from pathlib import Path

import pymupdf as fitz
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.main import app  # noqa: E402
from app.routers.documents import reextract_document  # noqa: E402


def test_write_a_document_from_nothing():
    with TestClient(app) as c:
        doc_id = c.post("/api/documents/blank", json={"title": "my: notes?"}).json()["doc_id"]
        docs = {d["id"]: d for d in c.get("/api/documents").json()}
        assert docs[doc_id]["title"] == "my notes" and docs[doc_id]["page_count"] == 1

        assert c.post(f"/api/documents/{doc_id}/pages").json() == {"page_no": 2, "page_count": 2}
        assert c.post(f"/api/documents/{doc_id}/pages/9/blocks", json={"bbox": [72, 90, 400, 130], "text": "x"}).status_code == 404
        assert c.post(f"/api/documents/{doc_id}/pages/1/blocks", json={"bbox": [72, 90, 75, 92], "text": "x"}).status_code == 400
        r = c.post(f"/api/documents/{doc_id}/pages/2/blocks", json={"bbox": [72, 90, 400, 130], "text": "Results of the experiment"})
        block_id = r.json()["block_id"]
        blocks = c.get(f"/api/documents/{doc_id}/pages/2/blocks").json()["blocks"]
        assert [b["id"] for b in blocks] == [block_id]
        assert blocks[0]["src_edit"]["text"] == "Results of the experiment" and blocks[0]["meta"]["user"] is True

        # the reader's own boxes are not in the PDF: a re-extraction must not lose them
        reextract_document(doc_id)
        again = c.get(f"/api/documents/{doc_id}/pages/2/blocks").json()["blocks"]
        assert len(again) == 1 and again[0]["src_edit"]["text"] == "Results of the experiment"

        out = c.post(f"/api/documents/{doc_id}/export", json={"format": "pdf_source_edited"})
        pdf = fitz.open(stream=out.content, filetype="pdf")
        assert pdf.page_count == 2 and "Results" in pdf[1].get_text()


def _png() -> bytes:
    pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 120, 80), False)
    pix.set_rect(pix.irect, (0, 90, 200))
    return pix.tobytes("png")


def test_pictures_lines_and_pages():
    with TestClient(app) as c:
        doc_id = c.post("/api/documents/blank", json={"title": "pages", "pages": 3}).json()["doc_id"]
        base = f"/api/documents/{doc_id}"
        # one thing on each page, to tell them apart afterwards
        a = c.post(f"{base}/pages/1/blocks", json={"bbox": [72, 90, 400, 130], "text": "first page"}).json()["block_id"]
        pic = c.post(f"{base}/pages/2/images", files={"file": ("p.png", _png(), "image/png")}, data={"bbox": "[100, 100, 220, 180]"})
        assert pic.status_code == 200
        assert c.post(f"{base}/pages/2/images", files={"file": ("p.txt", b"nope", "text/plain")}, data={"bbox": "[1,1,90,90]"}).status_code == 400
        line = c.post(f"{base}/pages/3/shapes", json={"bbox": [72, 300, 400, 306], "dir": "h"}).json()["block_id"]

        # the reader's own blocks are moved by their box; blocks of the PDF are not
        assert c.put(f"/api/blocks/{a}/bbox", json={"bbox": [72, 200, 400, 240]}).json()["bbox"] == [72.0, 200.0, 400.0, 240.0]
        c.put(f"/api/blocks/{line}/layout", json={"lang": "__src__", "layout": {"color": 0xCC0000}})

        # page 3 goes first: 3, 1, 2
        assert c.post(f"{base}/pages/3/move", json={"to": 1}).json() == {"page_no": 1, "page_count": 3}
        kinds = [[b["meta"].get("shape") or b["type"] for b in c.get(f"{base}/pages/{n}/blocks").json()["blocks"]] for n in (1, 2, 3)]
        assert kinds == [["line"], ["paragraph"], ["image"]]

        # exported: the line (red) on page 1, the text on page 2, the picture (blue) on page 3
        pdf = fitz.open(stream=c.post(f"{base}/export", json={"format": "pdf_translated", "lang": "zh"}).content, filetype="pdf")
        assert "page" in pdf[1].get_text() and "page" not in pdf[0].get_text()  # (ligatures: "ﬁrst")
        red = pdf[0].get_pixmap(clip=fitz.Rect(72, 298, 400, 308), matrix=fitz.Matrix(2, 2))
        assert any(red.samples[i] > 150 and red.samples[i + 1] < 80 for i in range(0, len(red.samples), red.n))
        blue = pdf[2].get_pixmap(clip=fitz.Rect(110, 110, 210, 170))
        assert blue.samples[2] > 150 and blue.samples[0] < 60

        # delete the middle page: the picture's page becomes page 2
        assert c.delete(f"{base}/pages/2").json() == {"page_count": 2}
        assert [b["type"] for b in c.get(f"{base}/pages/2/blocks").json()["blocks"]] == ["image"]
        assert c.delete(f"{base}/pages/2").status_code == 200 and c.delete(f"{base}/pages/1").status_code == 400  # the last page stays
        assert fitz.open(stream=c.get(f"{base}/file").content, filetype="pdf").page_count == 1
