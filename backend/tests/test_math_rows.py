"""One text line that the PDF split into several blocks around math (fractions, cases)."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pymupdf as fitz

from app.services.extract import _assign_math_runs, _merge_math_rows
from app.services.page_assets import inline_math_rects, remove_math_line_art


def _span(text, x0, y0, x1, y1, size=12.0, math=False, base=None):
    return {"text": text, "font": "CambriaMath" if math else "Calibri", "size": size, "flags": 0,
            "color": 0, "origin": [x0, base if base is not None else y1 - 2], "bbox": [x0, y0, x1, y1]}


def _block(*spans):
    xs = [s["bbox"] for s in spans]
    box = [min(b[0] for b in xs), min(b[1] for b in xs), max(b[2] for b in xs), max(b[3] for b in xs)]
    return {"type": 0, "bbox": box, "lines": [{"bbox": box, "spans": list(spans)}]}


def _fraction_line():
    """"The gain is G(s) = K/(s+p) for every s", written as 4 blocks."""
    return [
        _block(_span("The gain is ", 72, 343, 228, 356, base=353),
               _span("G(s) =", 228, 343, 268, 356, math=True, base=353)),
        _block(_span("K", 277, 338, 282, 349, size=8.5, math=True, base=346)),
        _block(_span("s+p", 271, 349, 294, 360, size=8.5, math=True, base=358)),
        _block(_span(" for every s", 300, 343, 420, 356, base=353)),
        # the next paragraph, a line below: must stay on its own
        _block(_span("Next line of text", 72, 377, 200, 389, base=387)),
    ]


def test_fraction_pieces_join_the_line():
    blocks = _merge_math_rows(_fraction_line())
    assert len(blocks) == 2
    row = blocks[0]
    assert len(row["lines"]) == 1
    text = "".join(sp["text"] for sp in row["lines"][0]["spans"])
    assert text.startswith("The gain is") and text.rstrip().endswith("for every s")
    runs = _assign_math_runs(blocks, [0])
    # "G(s) =", numerator and denominator are one formula, aligned to the text baseline
    assert len(runs) == 1
    assert runs[0]["bbox"][1] < 339 and runs[0]["bbox"][3] > 359
    assert runs[0]["baseline"] == 353


def test_cases_brace_joins_its_rows():
    """"f(t) = {" beside the three rows of a cases formula is one formula."""
    lhs = _block(_span("f(t) = {", 246, 76, 289, 91, math=True, base=87))
    rows = {"type": 0, "bbox": [288, 63, 375, 106], "lines": [
        {"bbox": [288, 63, 375, 76], "spans": [_span("1   −1 < t < 0", 288, 63, 375, 76, math=True)]},
        {"bbox": [288, 77, 375, 91], "spans": [_span("−1   0 < t < 1", 288, 77, 375, 91, math=True)]},
        {"bbox": [288, 92, 375, 106], "spans": [_span("0   otherwise", 288, 92, 375, 106, math=True)]},
    ]}
    blocks = _merge_math_rows([lhs, rows])
    assert len(blocks) == 1
    assert blocks[0]["bbox"] == [246, 63, 375, 106]


def test_plain_text_rows_are_left_alone():
    left = _block(_span("Left column", 72, 100, 250, 112))
    right = _block(_span("Right column", 300, 100, 500, 112))
    assert len(_merge_math_rows([left, right])) == 2


def test_fraction_bar_removed_from_the_background():
    doc = fitz.open()
    page = doc.new_page()
    page.draw_line((270, 350), (295, 350), width=0.6)  # fraction bar of an inline formula
    page.draw_rect(fitz.Rect(60, 300, 500, 400), width=1)  # a frame around the paragraph
    rects = inline_math_rects([{"type": "paragraph", "meta": {"math": [{"bbox": [268, 337, 297, 362]}]}},
                               {"type": "formula", "meta": {"math": [{"bbox": [60, 300, 500, 400]}]}}])
    assert rects == [[268, 337, 297, 362]]
    remove_math_line_art(page, rects)
    kinds = [tuple(round(v) for v in d["rect"]) for d in page.get_drawings()]
    assert (60, 300, 500, 400) in kinds  # the frame only touches the box: kept
    assert all(r[1] != 350 or r[3] != 350 for r in kinds)  # the bar is gone


def test_kept_translations_follow_renumbered_formulas():
    from app.routers.documents import _run_map

    old = [{"id": "m8", "bbox": [228, 342, 268, 357]}, {"id": "m9", "bbox": [276, 338, 282, 349]},
           {"id": "m18", "bbox": [124, 447, 159, 463]}]
    new = [{"id": "m6", "bbox": [228, 332, 346, 366]}, {"id": "m10", "bbox": [124, 447, 159, 463]}]
    assert _run_map(old, new) == {"m8": "m6", "m9": "m6", "m18": "m10"}
