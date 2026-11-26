"""Write tests/data/sample-paper.pdf: a small two-column paper made up for the tests — title,
authors, abstract, numbered sections, citations like [2, 3], a figure and a table with
captions, and a numbered reference list. Run: python tests/make_paper_fixture.py"""
from __future__ import annotations

from pathlib import Path

import pymupdf as fitz

OUT = Path(__file__).parent / "data" / "sample-paper.pdf"

W, H = 595, 842
M = 54  # page margin
GAP = 18
COL = (W - 2 * M - GAP) / 2

INTRO = [
    "Signals sampled on a lattice are rarely clean: every sensor adds its own noise, and the noise "
    "grows near the edges of the grid [1]. The usual answer is a smoothing filter, which removes the "
    "noise but also blurs the features one wants to keep.",
    "Earlier filters [2, 3] trade one problem for the other. A box filter is fast but rounds every "
    "corner; an adaptive filter keeps corners but needs a noise model that is seldom known. In this "
    "paper we propose a gentle filter that needs neither.",
    "Section 2 describes the filter, Section 3 measures it, and Section 4 sums up. Figure 1 shows the "
    "main result at a glance, and Table 1 lists the errors on three test lattices.",
]
METHOD = [
    "Our filter follows the classic two-stage design of [4]. The first stage estimates how much each "
    "sample differs from its neighbours; the second stage averages only over neighbours that differ "
    "by less than a threshold chosen from the data itself.",
    "Because the threshold comes from the samples, the filter has no parameter to tune. Its cost is "
    "two passes over the lattice, the same order as a box filter, and it runs on any regular grid.",
    "A further benefit is that the filter never moves an edge: a sample on one side of a step is "
    "never averaged with a sample on the other side, so the step stays where it was.",
]
RESULTS = [
    "We compare the gentle filter with a box filter of the same width on three lattices with known "
    "edges. Figure 1 plots the response across a single step: the box filter spreads the step over "
    "five samples, while the gentle filter keeps it within one.",
    "Table 1 gives the mean error after filtering. The gentle filter is best on all three lattices, "
    "and its advantage grows with the noise, as the analysis in [3] predicts for any edge-aware method.",
]
CONCL = [
    "A filter that chooses its own threshold removes most of the noise on a lattice without moving "
    "its edges. Extending it to irregular grids is left for future work.",
]
REFS = [
    "[1] A. Example. Noise on sampled lattices. Journal of Made-up Signals, 12(3):1-9, 2019.",
    "[2] C. Person and D. Body. Box filters revisited. In Proc. of the Imaginary Conference, pages 10-18, 2020.",
    "[3] E. Name. Smoothing without tears: edge-aware filters on grids. arXiv:2001.00001, 2020.",
    "[4] F. Writer. A Classic Design for Lattice Filters. Made-up Press, 2015.",
]


class Column:
    def __init__(self, page: fitz.Page, x: float, top: float, bottom: float):
        self.page, self.x, self.y, self.bottom = page, x, top, bottom

    def text(self, s: str, size: float = 10, font: str = "tiro", after: float = 6, indent: bool = False) -> None:
        rect = fitz.Rect(self.x, self.y, self.x + COL, self.bottom)
        left = self.page.insert_textbox(rect, ("   " if indent else "") + s, fontsize=size, fontname=font,
                                        align=fitz.TEXT_ALIGN_JUSTIFY if size <= 10 else fitz.TEXT_ALIGN_LEFT)
        assert left >= 0, f"does not fit: {s[:40]}"
        # height used = box height - space left
        self.y = self.bottom - left + after

    def heading(self, s: str) -> None:
        self.y += 4
        self.text(s, size=11.5, font="tibo", after=4)


def figure(page: fitz.Page, col: Column) -> None:
    h = 110
    r = fitz.Rect(col.x + 10, col.y, col.x + COL - 10, col.y + h)
    pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 220, 110), False)
    for x in range(220):
        for y in range(110):
            edge = 55 if x < 110 else 20  # a step: the gentle filter keeps it
            v = 235 if abs(y - edge) < 3 else 255
            pix.set_pixel(x, y, (v, v, 255) if abs(y - edge) < 3 else (255, 255, 255))
    page.insert_image(r, pixmap=pix)
    page.draw_rect(r, color=(0.4, 0.4, 0.4), width=0.6)
    page.draw_polyline([(r.x0 + 8, r.y0 + 60), (r.x0 + r.width / 2, r.y0 + 60), (r.x0 + r.width / 2, r.y0 + 25),
                        (r.x1 - 8, r.y0 + 25)], color=(0, 0, 0.6), width=1.4)
    col.y += h + 6
    col.text("Figure 1: Response across a single step: the gentle filter (solid) keeps the edge that a box "
             "filter of the same width would spread over five samples.", size=9, after=10)


def table(page: fitz.Page, col: Column) -> None:
    col.text("Table 1: Mean error after filtering on three test lattices (lower is better).", size=9, after=4)
    rows = [("Lattice", "Box", "Gentle"), ("Square", "0.41", "0.18"), ("Hexagonal", "0.37", "0.15"),
            ("Triangular", "0.52", "0.21")]
    x0, w = col.x + 20, COL - 40
    rh = 15
    y = col.y
    page.draw_line((x0, y), (x0 + w, y), width=0.8)
    for i, row in enumerate(rows):
        for j, cell in enumerate(row):
            page.insert_text((x0 + 4 + j * w / 3, y + 11), cell, fontsize=9, fontname="tibo" if i == 0 else "tiro")
        y += rh
        if i == 0:
            page.draw_line((x0, y), (x0 + w, y), width=0.5)
    page.draw_line((x0, y), (x0 + w, y), width=0.8)
    col.y = y + 12


def build() -> bytes:
    doc = fitz.open()
    p1 = doc.new_page(width=W, height=H)
    # (a box too small for its text is left empty by insert_textbox: each one is checked)
    for rect, text, size, font in [
        (fitz.Rect(M, 60, W - M, 90), "Gentle Filters for Noisy Lattices", 17, "tibo"),
        (fitz.Rect(M, 92, W - M, 112), "Ada Example and Bo Sample", 11, "tiro"),
        (fitz.Rect(M, 110, W - M, 130), "Department of Imaginary Engineering", 9.5, "tiit"),
        (fitz.Rect(M + 40, 134, W - M - 40, 154), "Abstract", 10.5, "tibo"),
    ]:
        assert p1.insert_textbox(rect, text, fontsize=size, fontname=font, align=fitz.TEXT_ALIGN_CENTER) >= 0, text
    assert p1.insert_textbox(fitz.Rect(M + 40, 156, W - M - 40, 232),
                      "Smoothing a noisy lattice usually blurs its edges. We describe a gentle filter that chooses "
                      "its own threshold from the samples, removes most of the noise, and never moves an edge. "
                      "On three test lattices it halves the error of a box filter at the same cost.",
                      fontsize=9.5, fontname="tiro", align=fitz.TEXT_ALIGN_JUSTIFY) >= 0
    left = Column(p1, M, 248, H - 60)
    left.heading("1  Introduction")
    for i, t in enumerate(INTRO):
        left.text(t, indent=i > 0)
    right = Column(p1, M + COL + GAP, 248, H - 60)
    right.heading("2  The Gentle Filter")
    for i, t in enumerate(METHOD):
        right.text(t, indent=i > 0)
    p1.insert_text((W / 2 - 3, H - 30), "1", fontsize=9, fontname="tiro")

    p2 = doc.new_page(width=W, height=H)
    left = Column(p2, M, 60, H - 60)
    left.heading("3  Results")
    for i, t in enumerate(RESULTS):
        left.text(t, indent=i > 0)
    figure(p2, left)
    table(p2, left)
    right = Column(p2, M + COL + GAP, 60, H - 60)
    right.heading("4  Conclusion")
    for t in CONCL:
        right.text(t)
    right.heading("References")
    for t in REFS:
        right.text(t, size=8.5, after=4)
    p2.insert_text((W / 2 - 3, H - 30), "2", fontsize=9, fontname="tiro")
    doc.set_metadata({"title": "Gentle Filters for Noisy Lattices", "author": "Ada Example; Bo Sample"})
    return doc.tobytes(garbage=3, deflate=True)


if __name__ == "__main__":
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_bytes(build())
    print(OUT)
