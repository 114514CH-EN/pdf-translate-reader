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


def test_stacked_scripts_are_formulas_and_lone_superscripts_stay_up():
    with fitz.open(PDF) as d:
        page = extract_page(d[0])
    ph = next(b["meta"]["ph"] for b in build_blocks(page, 1) if "Find the new points" in b["text"])
    line = ph[ph.index("Find the new points"):].split("\n")
    assert re.fullmatch(r"Find the new points \{\{m\d+\}\} and \{\{m\d+\}\} from \{\{m\d+\}\} and \{\{m\d+\}\}, after one step\.", line[0])
    m = re.fullmatch(r"The error of C\{\{(m\d+)\}\} is \{\{m\d+\}\} long\.", line[1])
    assert m
    sup = next(r for r in page["math_runs"] if r["id"] == m.group(1))
    # aligned on the text's baseline: the crop sits above it, like the superscript it is
    assert sup["bbox"][3] <= sup["baseline"]


def _sp(text, x0, x1, base, size=10.0, font="Demo-Roman"):
    top = base - 0.8 * size
    return {"text": text, "font": font, "size": size, "flags": 0, "color": 0,
            "origin": [x0, base], "bbox": [x0, top, x1, top + size]}


def test_line_broken_at_stacked_scripts_is_joined_again():
    """How the PDF reader hands such a line over: the first piece ends on the raised
    script, the next starts with the lowered one at the same x, a third piece in a block
    of its own. Rejoined, it is one line again, in order, without a break."""
    from app.services.extract import _join_split_rows

    base = 130.0
    a = [_sp("2. Find the points ", 82, 180, base), _sp("c", 180, 185, base, font="Demo-Oblique"),
         _sp("1", 185.2, 189, base - 3.6, 7.6)]
    b = [_sp("1", 185.2, 189, base + 2.4, 7.6), _sp(" and ", 189, 210, base), _sp("c", 210, 215, base, font="Demo-Oblique"),
         _sp("1", 215.2, 219, base - 3.6, 7.6)]
    c = [_sp("2", 215.2, 219, base + 2.4, 7.6), _sp(", after one step.", 219, 300, base)]
    nxt = [_sp("of the update rule.", 96, 200, base + 13)]
    blocks = [{"type": 0, "bbox": [], "lines": [{"bbox": [82, 120, 189, 133], "spans": a}, {"bbox": [185, 120, 219, 135], "spans": b},
                                                  {"bbox": [96, 133, 200, 146], "spans": nxt}]},
              {"type": 0, "bbox": [], "lines": [{"bbox": [215, 120, 300, 135], "spans": c}]}]
    out = _join_split_rows(blocks)
    assert len(out) == 1 and len(out[0]["lines"]) == 2
    assert "".join(sp["text"] for sp in out[0]["lines"][0]["spans"]) == "2. Find the points c11 and c12, after one step."
    assert "".join(sp["text"] for sp in out[0]["lines"][1]["spans"]) == "of the update rule."
    # two columns side by side are not joined
    left = [_sp("left column text", 72, 290, base)]
    right = [_sp("right column text", 310, 540, base)]
    cols = [{"type": 0, "bbox": [], "lines": [{"bbox": [72, 120, 290, 133], "spans": left}]},
            {"type": 0, "bbox": [], "lines": [{"bbox": [310, 120, 540, 133], "spans": right}]}]
    assert len(_join_split_rows(cols)) == 2


def test_table_borders_drawn_as_one_path_hide_nothing():
    """Word draws a table's borders after the text, as one path of thin filled rectangles.
    Its outline is the whole table — the text inside is not hidden by it. A real opaque
    box drawn over text (an old chart under a new one) still hides that text."""
    from app.services.extract import _hidden_spans

    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text((100, 120), "Inside a bordered table cell", fontsize=11)
    page.insert_text((100, 400), "Under a white box", fontsize=11)
    shape = page.new_shape()
    for r in ((58, 72, 529, 72.6), (58, 72, 58.6, 458), (93, 72, 93.6, 458), (528.4, 72, 529, 458), (58, 457.4, 529, 458)):
        shape.draw_rect(fitz.Rect(r))
    shape.finish(color=None, fill=(0, 0, 0))  # one path, five filled hairline rectangles
    shape.draw_rect(fitz.Rect(90, 385, 300, 410))
    shape.finish(color=None, fill=(1, 1, 1))  # an opaque box over the second line
    shape.commit()
    hidden = {k[0] for k in _hidden_spans(page)}
    assert "Inside a bordered table cell" not in hidden
    assert "Under a white box" in hidden


def test_misread_formula_glyphs_on_a_latin_page():
    """Word's Cambria Math with a broken character map: on an English page, short pieces in
    Indic or Ethiopic script are formula glyphs (shown from the page). A page written in
    such a script keeps its text."""
    from app.services.extract import _is_math_span, _mark_misread_glyphs

    def page(*texts):
        return [{"lines": [{"spans": [{"text": t, "font": "CIDFont+F4", "size": 10} for t in texts]}]}]

    english = page("For a turning point of the surface we need both slopes to vanish, so", "\u0c21\u0beb", "=",
                   "\u0c21\u0bec", "= 0", "\u0b36", "\u1240", "and the rest of this sentence is plain English text.")
    _mark_misread_glyphs(english)
    flags = [sp.get("_misread", False) for sp in english[0]["lines"][0]["spans"]]
    assert flags == [False, True, False, True, False, True, True, False]
    assert _is_math_span(english[0]["lines"][0]["spans"][1])
    hindi = page("\u092f\u0939 \u090f\u0915 \u0935\u093e\u0915\u094d\u092f \u0939\u0948", "\u0939\u0948",
                 "\u0915\u093e", "\u0914\u0930 \u092f\u0939 \u092d\u0940 \u0939\u093f\u0902\u0926\u0940 \u092e\u0947\u0902")
    _mark_misread_glyphs(hindi)
    assert not any(sp.get("_misread") for sp in hindi[0]["lines"][0]["spans"])
