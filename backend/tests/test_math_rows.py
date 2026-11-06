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


# --- LaTeX-style pages: numerators in the text font, pieces in other blocks ---------

def _line(*spans):
    xs = [s["bbox"] for s in spans]
    return {"bbox": [min(b[0] for b in xs), min(b[1] for b in xs), max(b[2] for b in xs), max(b[3] for b in xs)],
            "spans": list(spans)}


def _cm(text, x0, y0, x1, y1, size=11.0, font="CMR10", base=None):
    sp = _span(text, x0, y0, x1, y1, size=size, base=base)
    sp["font"] = font
    return sp


def test_inline_fraction_keeps_lines_in_order():
    """A two-line paragraph whose 2nd line has "G(s) = K/(s+p)": the numerator is a line
    of another block. The lines must stay two lines, words in reading order."""
    l1 = _line(_cm("The gain of the first stage is written with the usual symbols and", 71, 119, 524, 130, base=127))
    l2 = _line(_cm("so the gain is ", 71, 132, 160, 143, base=141),
               _cm("G", 160, 132, 168, 143, font="CMMI10", base=141), _cm("(", 168, 132, 172, 143, base=141),
               _cm("s", 172, 132, 177, 143, font="CMMI10", base=141), _cm(") =", 177, 132, 190, 143, base=141))
    num = _line(_cm("K", 196, 129, 202, 137, size=8, font="CMMI8", base=135))
    den = _line(_cm("s+p", 192, 139, 206, 147, size=8, font="CMMI8", base=145),
                _cm(", which falls with frequency.", 208, 132, 330, 143, base=141))
    a = {"type": 0, "bbox": [71, 119, 524, 143], "lines": [l1, l2]}
    b = {"type": 0, "bbox": [192, 129, 330, 147], "lines": [num, den]}
    out = _merge_math_rows([a, b])
    assert len(out) == 1
    texts = ["".join(sp["text"] for sp in ln["spans"]) for ln in out[0]["lines"]]
    assert len(texts) == 2 and texts[0].startswith("The gain of the first stage")
    assert texts[1].startswith("so the gain is") and texts[1].rstrip().endswith("which falls with frequency.")
    runs = _assign_math_runs(out, [0])
    assert len(runs) == 1 and runs[0]["bbox"][1] < 130 and runs[0]["bbox"][3] > 146


def test_formulas_on_consecutive_lines_stay_apart():
    """"… sampled signal x(t)" / "x[n] = x(nT) …": two formulas, not one spanning both lines."""
    l1 = _line(_cm("A continuous-time signal ", 51, 75, 164, 87, size=10, base=84),
               _cm("x(t)", 164, 75, 185, 87, size=10, font="CMMI10", base=84))
    l2 = _line(_cm("onds, giving the sequence ", 51, 87, 178, 99, size=10, base=96),
               _cm("x[n] = x(nT)", 180, 87, 229, 99, size=10, font="CMMI10", base=96),
               _cm(". Its spectrum repeats", 229, 87, 293, 99, size=10, base=96))
    runs = _assign_math_runs([{"type": 0, "bbox": [51, 75, 293, 99], "lines": [l1, l2]}], [0])
    assert [r["text"] for r in runs] == ["x(t)", "x[n] = x(nT)"]


def test_cases_text_stays_in_the_formula():
    """"0, otherwise" inside a cases brace is part of the display formula, not prose."""
    lhs = _line(_cm("H(jω) = {", 113, 127, 160, 156, font="CMMI10", base=143))  # the brace spans both rows
    r1 = _line(_cm("T, |ω| < π/T", 165, 128, 225, 141, font="CMMI10", base=138))
    r2 = _line(_cm("0,", 165, 143, 175, 155, font="CMMI10", base=152), _cm("otherwise", 185, 143, 225, 155, base=152))
    out = _merge_math_rows([{"type": 0, "bbox": [113, 128, 225, 155], "lines": [lhs, r1]},
                            {"type": 0, "bbox": [165, 143, 225, 155], "lines": [r2]}])
    spans = [sp for rb in out for ln in rb["lines"] for sp in ln["spans"] if sp["text"] == "otherwise"]
    assert spans and spans[0].get("force_m")


def test_vector_parentheses_join_the_formula():
    """PowerPoint draws the ( ) of s(t) as paths: the formula box must include them."""
    from app.services.extract import extract_page

    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((72, 100), "If", fontname="helv", fontsize=20)
    page.insert_text((100, 100), "st", fontname="symb", fontsize=20)  # math-font letters "s t"
    shape = page.new_shape()  # one path for the pair, as PowerPoint writes it
    shape.draw_rect(fitz.Rect(109, 82, 112, 104))
    shape.draw_rect(fitz.Rect(121, 82, 124, 104))
    shape.finish(color=None, fill=(0, 0, 0))
    shape.commit()
    page.insert_text((150, 100), "is the message", fontname="helv", fontsize=20)
    runs = extract_page(page, None)["math_runs"]
    assert runs and runs[0]["bbox"][2] >= 124 and runs[0]["bbox"][0] <= 101


def test_nothing_to_translate():
    from app.services.translate_worker import has_words, placeholders_wrong

    assert not has_words("(1)") and not has_words("{{m3}}") and not has_words("+")
    assert has_words("Fig. 2") and has_words("{{m1}} is the gain")
    assert placeholders_wrong("gain {{m1}} and {{m2}}", "增益 {{m1}}")
    assert placeholders_wrong("gain {{m1}}", "增益 {{m1}}{{m1}}")
    assert not placeholders_wrong("gain {{m1}} and {{m2}}", "{{m2}} 与增益 {{m1}}")


def test_diagram_labels_in_one_block_are_split():
    """Box labels of a block diagram that the PDF put into one block, in any order."""
    from app.services.structure import _split_tab_segments

    sampler = {"bbox": [177, 246, 210, 255], "spans": [_span("Sampler", 177, 246, 210, 255, size=9)]}
    anti = {"bbox": [91, 247, 130, 256], "spans": [_span("Anti-alias", 91, 247, 130, 256, size=9)]}
    out = _split_tab_segments([{"type": 0, "bbox": [91, 246, 210, 256], "lines": [sampler, anti]}])
    assert len(out) == 2
