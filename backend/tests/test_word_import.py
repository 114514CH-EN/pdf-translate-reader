"""Word documents in: .docx / .doc / .rtf / .odt are turned into a PDF on upload."""
from __future__ import annotations

import io
import sys
import unicodedata
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import UPLOAD_DIR  # noqa: E402
from app.main import app  # noqa: E402
from app.services import convert  # noqa: E402

W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'


def make_docx(paragraphs: list[str], table: list[list[str]] | None = None) -> bytes:
    """The smallest .docx Word and LibreOffice will open, written by hand (no extra package)."""
    body = "".join(f"<w:p><w:r><w:t>{t}</w:t></w:r></w:p>" for t in paragraphs)
    if table:
        rows = "".join(
            "<w:tr>" + "".join(f"<w:tc><w:p><w:r><w:t>{c}</w:t></w:r></w:p></w:tc>" for c in row) + "</w:tr>" for row in table
        )
        body += f"<w:tbl><w:tblPr><w:tblW w:w=\"0\" w:type=\"auto\"/></w:tblPr>{rows}</w:tbl><w:p/>"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr(
            "[Content_Types].xml",
            '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
            "</Types>",
        )
        z.writestr(
            "_rels/.rels",
            '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
            "</Relationships>",
        )
        z.writestr(  # every real Word file has one, and MuPDF will not open a .docx without it
            "word/_rels/document.xml.rels",
            '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
        )
        z.writestr("word/document.xml", f'<?xml version="1.0" encoding="UTF-8"?><w:document {W}><w:body>{body}</w:body></w:document>')
    return buf.getvalue()


TEXT = ["Operational amplifiers in the lab", "An ideal op-amp has infinite gain and no input current."]


def _all_text(c: TestClient, doc_id: int) -> str:
    blocks = c.get(f"/api/documents/{doc_id}/pages/1/blocks").json()["blocks"]
    # MuPDF's own layout sets "fi" as a ligature glyph; compare letters, not glyphs
    return unicodedata.normalize("NFKC", " ".join(b["text"] for b in blocks))


@pytest.mark.skipif(convert.find_soffice() is None, reason="LibreOffice is not installed here")
def test_docx_through_libreoffice():
    with TestClient(app) as c:
        r = c.post("/api/documents", files={"file": ("op-amp notes.docx", make_docx(TEXT, [["Rin", "Rf"], ["1 k", "10 k"]]))})
        assert r.status_code == 200, r.text
        j = r.json()
        assert j["converted_by"] == "LibreOffice" and j["warning"] is None
        docs = {d["id"]: d for d in c.get("/api/documents").json()}
        assert docs[j["doc_id"]]["title"] == "op-amp notes" and docs[j["doc_id"]]["page_count"] == 1
        text = _all_text(c, j["doc_id"])
        assert "infinite gain" in text and "Rin" in text  # the table came through
        # the Word file is kept beside the PDF made from it; no temporary files are left over
        assert (UPLOAD_DIR / str(j["doc_id"]) / "source.docx").read_bytes()[:2] == b"PK"
        assert not any((UPLOAD_DIR / "_convert").iterdir())
        c.delete(f"/api/documents/{j['doc_id']}")
        # an .rtf goes the same way
        r = c.post("/api/documents", files={"file": ("memo.rtf", rb"{\rtf1\ansi The cut-off frequency is set by R and C.\par}")})
        assert r.status_code == 200 and r.json()["converted_by"] == "LibreOffice"
        assert "cut-off frequency" in _all_text(c, r.json()["doc_id"])
        c.delete(f"/api/documents/{r.json()['doc_id']}")


def test_docx_without_an_office_program(monkeypatch):
    """Nothing installed: the built-in conversion still opens it, and says it is a simple one."""
    monkeypatch.setattr(convert, "find_soffice", lambda: None)
    monkeypatch.setattr(convert, "COM_APPS", [])
    with TestClient(app) as c:
        j = c.post("/api/documents", files={"file": ("notes.docx", make_docx(TEXT))}).json()
        assert j["converted_by"] == convert.SIMPLE and "简易转换" in j["warning"]
        assert "infinite gain" in _all_text(c, j["doc_id"])
        c.delete(f"/api/documents/{j['doc_id']}")


def test_what_cannot_be_opened(monkeypatch):
    monkeypatch.setattr(convert, "find_soffice", lambda: None)
    monkeypatch.setattr(convert, "COM_APPS", [])
    with TestClient(app) as c:
        before = len(c.get("/api/documents").json())
        # an old .doc needs Word, WPS or LibreOffice
        r = c.post("/api/documents", files={"file": ("old.doc", b"\xd0\xcf\x11\xe0 not really a doc")})
        assert r.status_code == 400 and "Word" in r.json()["detail"]
        # a broken .docx: the zip header is there, the rest is not
        r = c.post("/api/documents", files={"file": ("broken.docx", b"PK\x03\x04 not really a zip")})
        assert r.status_code == 400 and "转换失败" in r.json()["detail"]
        # other kinds of file
        r = c.post("/api/documents", files={"file": ("notes.txt", b"hello")})
        assert r.status_code == 400 and "Word" in r.json()["detail"]
        assert len(c.get("/api/documents").json()) == before


def test_misnamed_files_are_refused_before_any_converter():
    """LibreOffice would turn any bytes into a page of text; a file that is not what its
    extension says is turned away first."""
    with TestClient(app) as c:
        for name, data in [("notes.docx", b"just some text"), ("old.doc", b"PK\x03\x04zip"), ("x.rtf", b"plain"), ("y.odt", b"%PDF-1.7")]:
            r = c.post("/api/documents", files={"file": (name, data)})
            assert r.status_code == 400 and "不是有效的" in r.json()["detail"], name
