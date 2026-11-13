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
