"""Edit mode: formatting of a translated block, find & replace across a document."""
from __future__ import annotations

import sys
from pathlib import Path

import pymupdf as fitz
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.main import app  # noqa: E402
from app.routers.translate import clean_layout  # noqa: E402


def _pdf() -> bytes:
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((72, 100), "The filter removes noise from the signal.", fontsize=12)
    page.insert_text((72, 160), "A second paragraph about the filter response.", fontsize=12)
    return doc.tobytes()


def test_layout_is_reduced_to_known_fields():
    assert clean_layout({"scale": 9, "bold": True, "color": 0x1FF0000, "align": "middle", "junk": 1,
                         "bbox": [10, 20, 110, 60], "hidden": False}) == {
        "scale": 3.0, "bold": True, "color": 0xFF0000, "bbox": [10.0, 20.0, 110.0, 60.0]}
    assert clean_layout({"scale": 1}) is None and clean_layout({"bbox": [0, 0, 1, 1]}) is None
    assert clean_layout("nope") is None


def test_format_replace_and_export():
    with TestClient(app) as c:
        doc_id = c.post("/api/documents", files={"file": ("edit.pdf", _pdf(), "application/pdf")}).json()["doc_id"]
        blocks = c.get(f"/api/documents/{doc_id}/pages/1/blocks").json()["blocks"]
        a, b = blocks[0], blocks[1]
        c.put(f"/api/blocks/{a['id']}/translation", json={"text": "滤波器去除信号中的噪声，公式 {{m1}} 不变。", "lang": "zh"})
        c.put(f"/api/blocks/{b['id']}/translation", json={"text": "第二段讲滤波器的响应。", "lang": "zh"})

        r = c.put(f"/api/blocks/{a['id']}/layout", json={"lang": "zh", "layout": {"scale": 1.4, "bold": True, "color": 0xCC0000,
                                                                                 "align": "center", "bbox": [72, 80, 400, 130]}})
        assert r.json()["layout"]["scale"] == 1.4
        got = {x["id"]: x for x in c.get(f"/api/documents/{doc_id}/pages/1/blocks?lang=zh").json()["blocks"]}
        assert got[a["id"]]["layout"]["align"] == "center" and got[b["id"]]["layout"] is None

        # find & replace: count first, then change; placeholders are never touched
        dry = c.post(f"/api/documents/{doc_id}/replace", json={"find": "滤波器", "replace": "滤波电路", "lang": "zh", "dry_run": True}).json()
        assert dry["hits"] == 2 and dry["blocks"] == 2 and dry["changed"] == []
        assert c.post(f"/api/documents/{doc_id}/replace", json={"find": "m1", "replace": "x", "lang": "zh"}).json()["blocks"] == 0
        done = c.post(f"/api/documents/{doc_id}/replace", json={"find": "滤波器", "replace": "滤波电路", "lang": "zh"}).json()
        assert done["blocks"] == 2 and done["changed"][0]["before"].startswith("滤波器")
        got = {x["id"]: x for x in c.get(f"/api/documents/{doc_id}/pages/1/blocks?lang=zh").json()["blocks"]}
        assert got[a["id"]]["translation"].startswith("滤波电路") and "{{m1}}" in got[a["id"]]["translation"]
        assert got[a["id"]]["layout"]["bold"] is True  # formatting survives a text change

        # hidden blocks are left out of the in-place export, formatted ones are drawn
        c.put(f"/api/blocks/{b['id']}/layout", json={"lang": "zh", "layout": {"hidden": True}})
        from app.config import DATA_DIR
        from app.services.export_pdf_inplace import export_translated_pdf

        out = export_translated_pdf(doc_id, Path(DATA_DIR) / "edit-test.pdf", "zh")
        with fitz.open(out) as pdf:
            text = pdf[0].get_text()
        assert "噪声" in text and "响应" not in text and "second paragraph" not in text  # (PDF text may use variant code points)

        c.put(f"/api/blocks/{a['id']}/layout", json={"lang": "zh", "layout": None})
        got = {x["id"]: x for x in c.get(f"/api/documents/{doc_id}/pages/1/blocks?lang=zh").json()["blocks"]}
        assert got[a["id"]]["layout"] is None
