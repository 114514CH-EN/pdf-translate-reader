"""Math letters in private-use code points, a centred title over a plain author line, and
reading order around centred lines (data/pua-math.pdf, written by make_pua_fixture.py)."""
from __future__ import annotations

import re
import sys
from pathlib import Path

import pymupdf as fitz

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.extract import extract_page  # noqa: E402
from app.services.structure import _reading_order, _style_runs, build_blocks  # noqa: E402

PDF = Path(__file__).with_name("data") / "pua-math.pdf"
V, W = "", ""  # arev's math-italic v and w


def blocks():
    with fitz.open(PDF) as d:
        return build_blocks(extract_page(d[0]), 1)


def test_private_use_math_letters_become_formula_runs():
    """arev writes the math-italic v and w as U+EBF6 / U+EBF7 in a plain oblique text font:
    no font of ours can draw them, so they are cropped from the page like any formula."""
    b = blocks()
    q = next(x for x in b if x["text"].startswith("Compute"))
    assert q["meta"]["ph"].startswith("Compute the inner product {{m")
    assert V not in q["meta"]["ph"] and W not in q["meta"]["ph"]
    norm = next(x for x in b if x["text"].startswith("Next work"))
    ph = norm["meta"]["ph"]
    assert ph.startswith("Next work out {{m2}} as well.")
    # a whole math-italic word, one of whose letters is remapped, is one formula
    assert "The score {{m3}}(d) compares {{m4}}(d) with itself." in ph
    assert not re.search("[\uE000-\uF8FF]", ph)
    # and words in formulas do not make the sentence around them italic
    assert "Here the words are {{{m5}}, dog, " in ph and not norm["style"]["italic"]


def test_centred_title_and_author_in_reading_order():
    b = blocks()
    assert [x["text"] for x in b[:3]] == ["Signals and Systems 2 - Practice Sheet 4", "Demo Lecturer", "Question 1"]
    assert b[0]["style"]["align"] == "center" and b[0]["style"]["bold"]
    assert b[1]["style"]["align"] == "center" and not b[1]["style"]["bold"]
    assert "align" not in b[2]["style"]  # "Question 1" starts at the margin
    assert not any(x["style"].get("align") for x in b if x["type"] == "paragraph")


def _line(text: str, x0: float, x1: float, y: float, bold: bool) -> tuple:
    font = "Demo-Bold" if bold else "Demo-Roman"
    span = {"text": text, "font": font, "size": 14.35, "flags": 16 if bold else 0, "bbox": [x0, y, x1, y + 14]}
    return text, [span], [x0, y, x1, y + 14]


def test_bold_title_and_plain_author_line_in_one_block_are_split():
    """One raw block, same size: a bold centred title over a plain centred "Demo Lecturer".
    The author line is not the bold sentence wrapping on (it does not start where it did)."""
    lines = [_line("Signals and Systems 2 - Practice Sheet 4", 96, 516, 69, True), _line("Demo Lecturer", 260, 352, 86, False)]
    runs = _style_runs(*map(list, zip(*lines)))
    assert [r[0] for r in runs] == [["Signals and Systems 2 - Practice Sheet 4"], ["Demo Lecturer"]]
    # a bold sentence that does wrap onto a plain line, from the same left edge, stays one
    wrap = [_line("A long bold sentence that keeps going across the whole width of the", 72, 540, 100, True),
            _line("column and ends here.", 72, 200, 116, False)]
    assert len(_style_runs(*map(list, zip(*wrap)))) == 1


def _it(text, x0, y0, x1, y1, typ="paragraph", size=10.9):
    return {"type": typ, "text": text, "bbox": [x0, y0, x1, y1], "style": {"size": size}}


def test_margin_labels_and_equation_numbers_follow_their_row():
    items = [
        _it("Part B - Filters", 36, 560, 169, 582, "heading"),
        _it("(10 points)", 475, 560, 556, 582),
        _it("B.1. Sketch the response", 54, 583, 264, 599),
        _it("Take", 72, 610, 90, 622),
        _it("x = [column] , y = [column]", 200, 600, 400, 650, "formula"),
        _it("(1)", 520, 618, 535, 632, "formula"),
        _it("Find the angle between them.", 72, 660, 160, 672),
    ]
    assert [b["text"] for b in _reading_order(items, 595.0)] == [
        "Part B - Filters", "(10 points)", "B.1. Sketch the response", "Take",
        "x = [column] , y = [column]", "(1)", "Find the angle between them.",
    ]


def test_two_columns_still_read_column_by_column():
    items = [
        _it("A Title Across The Top", 188, 85, 424, 102, "heading", 14),
        _it("Left one", 57, 150, 301, 300),
        _it("Left two", 57, 310, 301, 500),
        _it("Right one", 311, 150, 555, 320),
        _it("Right two", 311, 330, 555, 500),
    ]
    assert [b["text"] for b in _reading_order(items, 612.0)] == [
        "A Title Across The Top", "Left one", "Left two", "Right one", "Right two",
    ]


def test_upgrade_repairs_or_clears_broken_translations(monkeypatch):
    """A document read before v22: the private-use letters were plain text, so the model got
    the letters themselves (boxes on screen), or placeholders around a letter it then
    dropped. Re-extraction makes them formulas and mends what can be mended."""
    from fastapi.testclient import TestClient

    from app.db import get_db
    from app.main import app
    from app.routers.documents import reextract_document
    from app.services import extract

    old_rule = re.compile(extract.MATH_CHAR_RE.pattern.replace("-", ""))
    assert old_rule.pattern != extract.MATH_CHAR_RE.pattern
    with TestClient(app) as c:
        monkeypatch.setattr(extract, "MATH_CHAR_RE", old_rule)
        monkeypatch.setattr(extract, "_PUA_RE", re.compile("(?!)"))  # matches nothing, as before
        doc_id = c.post("/api/documents", files={"file": ("sheet.pdf", PDF.read_bytes())}).json()["doc_id"]
        monkeypatch.undo()
        blocks = {b["text"][:9]: b for b in c.get(f"/api/documents/{doc_id}/pages/1/blocks").json()["blocks"]}
        q, n = blocks["Compute t"], blocks["Next work"]
        assert V in q["text"] and "{{m" not in (q["meta"] or {}).get("ph", "")  # the old reading: letters as text
        old_n = n["meta"]["ph"]
        assert V in old_n
        ids = re.findall(r"\{\{(m\d+)\}\}", old_n)
        # what the model sent back then: the letters copied (boxes), or a letter dropped
        c.put(f"/api/blocks/{q['id']}/translation", json={"text": f"先算内积 {V} · {W}。"})
        c.put(f"/api/blocks/{n['id']}/translation", json={"text": f"再算出 {{{{{ids[0]}}}}}{{{{{ids[1]}}}}}。"})
        title = blocks["Signals a"]
        c.put(f"/api/blocks/{title['id']}/translation", json={"text": "信号与系统 2 - 练习题 4"})
        with get_db() as db:  # a hand-edited translation is not thrown away
            db.execute("UPDATE translations SET edited=1 WHERE block_id=?", (n["id"],))

        reextract_document(doc_id)
        after = {b["text"][:9]: b for b in c.get(f"/api/documents/{doc_id}/pages/1/blocks").json()["blocks"]}
        q2, n2 = after["Compute t"], after["Next work"]
        assert re.fullmatch(r"先算内积 \{\{m\d+\}\}。", q2["translation"]), q2["translation"]
        # hand-edited: kept (its placeholders renumbered onto the new formulas)
        want = re.findall(r"\{\{m\d+\}\}", n2["meta"]["ph"])
        assert n2["translation"].startswith(f"再算出 {want[0]}。")
        assert after["Signals a"]["translation"] == "信号与系统 2 - 练习题 4"
        c.delete(f"/api/documents/{doc_id}")


def test_upgrade_redoes_a_machine_translation_it_cannot_mend(monkeypatch):
    """Not hand-edited, and the letters were dropped rather than copied: nothing to swap
    back, so the translation is cleared and "translate all" redoes just this block."""
    from fastapi.testclient import TestClient

    from app.main import app
    from app.routers.documents import reextract_document
    from app.services import extract

    with TestClient(app) as c:
        monkeypatch.setattr(extract, "MATH_CHAR_RE", re.compile(extract.MATH_CHAR_RE.pattern.replace("-", "")))
        monkeypatch.setattr(extract, "_PUA_RE", re.compile("(?!)"))
        doc_id = c.post("/api/documents", files={"file": ("sheet.pdf", PDF.read_bytes())}).json()["doc_id"]
        monkeypatch.undo()
        q = next(b for b in c.get(f"/api/documents/{doc_id}/pages/1/blocks").json()["blocks"] if b["text"].startswith("Compute"))
        c.put(f"/api/blocks/{q['id']}/translation", json={"text": "先算内积 · 。"})  # the letters lost
        from app.db import get_db

        with get_db() as db:  # as the model wrote it, not a hand edit
            db.execute("UPDATE translations SET edited=0 WHERE block_id=?", (q["id"],))
        reextract_document(doc_id)
        q2 = next(b for b in c.get(f"/api/documents/{doc_id}/pages/1/blocks").json()["blocks"] if b["text"].startswith("Compute"))
        assert not q2.get("translation")
        c.delete(f"/api/documents/{doc_id}")


def test_control_codes_from_fonts_without_a_unicode_map():
    from app.services.extract import _fix_bullets

    # a bullet that comes out as a lone control code (0x88 from a math font's bullet)
    assert _fix_bullets("\x88", "F78") == "•" and _fix_bullets(" \x88 ", "F78") == " • "
    # TeX OT1 ligatures at 0x1B–0x1F, next to letters
    assert _fix_bullets("\x1cles and o\x1ece", "CMSS10") == "files and office"
    assert _fix_bullets("plain", "F78") == "plain"
