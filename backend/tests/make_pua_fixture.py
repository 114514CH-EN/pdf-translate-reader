"""Writes data/pua-math.pdf: an exercise-sheet-like page whose math letters are private-use
code points, the way LaTeX's arev package writes its math-italic v and w (U+EBF6, U+EBF7)
in an ordinary oblique text font, under a centred bold title and a plain author line.

Not run by the tests (they read the PDF it wrote); needs fontTools and the DejaVu fonts:
    python tests/make_pua_fixture.py
"""
from pathlib import Path

import pymupdf as fitz
from fontTools.ttLib import TTFont

FONTS = Path("/usr/share/fonts/truetype/dejavu")
OUT = Path(__file__).with_name("data") / "pua-math.pdf"


def pua_oblique(dest: Path) -> None:
    f = TTFont(FONTS / "DejaVuSans-Oblique.ttf")
    for table in f["cmap"].tables:
        if table.isUnicode():
            for code, letter in ((0xEBF6, "v"), (0xEBF7, "w"), (0xEBE9, "i"), (0xEBE1, "a"), (0xEBF5, "u")):
                table.cmap[code] = table.cmap[ord(letter)]
    f.save(dest)


def main() -> None:
    tmp = OUT.with_suffix(".ttf")
    pua_oblique(tmp)
    sym = FONTS / "DejaVuMathTeXGyre.ttf"  # a math font for the bars, like arev's MathDesign symbols
    doc = fitz.open()
    page = doc.new_page(width=595.28, height=841.89)
    reg, bold = str(FONTS / "DejaVuSans.ttf"), str(FONTS / "DejaVuSans-Bold.ttf")

    def put(x, y, text, font, name, size=10.9):
        page.insert_text((x, y), text, fontsize=size, fontfile=font, fontname=name)
        return x + fitz.Font(fontfile=font).text_length(text, fontsize=size)

    def centred(y, text, font, name, size):
        w = fitz.Font(fontfile=font).text_length(text, fontsize=size)
        put(306 - w / 2, y, text, font, name, size)

    centred(82, "Signals and Systems 2 - Practice Sheet 4", bold, "ArevSansBold", 14.35)
    centred(99, "Demo Lecturer", reg, "ArevSansRoman", 14.35)
    put(72, 140, "Question 1", bold, "ArevSansBold", 14.35)
    x = put(72, 166, "Compute the inner product ", reg, "ArevSansRoman")
    x = put(x, 166, "\uebf6", str(tmp), "ArevSansOblique")
    x = put(x, 166, " \u00b7 ", reg, "ArevSansRoman")
    x = put(x, 166, "\uebf7", str(tmp), "ArevSansOblique")
    put(x, 166, " first.", reg, "ArevSansRoman")
    body = ("The inner product of two complex vectors adds up the products of each entry of the "
            "first with the conjugate of the matching entry of the second, so the answer is a complex number.")
    page.insert_textbox(fitz.Rect(72, 180, 540, 230), body, fontsize=10.9, fontfile=reg, fontname="ArevSansRoman")
    x = put(72, 250, "Next work out ", reg, "ArevSansRoman")
    # the bars from a math font, the letter from the oblique text font: three spans, as LaTeX writes them
    x = put(x, 250, "\u2225", str(sym), "MathDesignSymbol")
    x = put(x, 250, "\uebf6", str(tmp), "ArevSansOblique")
    x = put(x, 250, "\u2225", str(sym), "MathDesignSymbol")
    put(x, 250, " as well.", reg, "ArevSansRoman")
    # whole math-italic words with one remapped letter, each piece its own span
    obl = str(tmp)
    x = put(72, 280, "The score ", reg, "ArevSansRoman")
    for piece in ("CS", "\uebe9", "m"):
        x = put(x, 280, piece, obl, "ArevSansOblique")
    x = put(x, 280, "(", reg, "ArevSansRoman")
    x = put(x, 280, "d", obl, "ArevSansOblique")
    x = put(x, 280, ") compares ", reg, "ArevSansRoman")
    for piece in ("\uebf6", "ec"):
        x = put(x, 280, piece, obl, "ArevSansOblique")
    put(x, 280, "(d) with itself.", reg, "ArevSansRoman")
    # a sentence with several math-italic words in it is still upright prose
    x = put(72, 310, "Here the words are {", reg, "ArevSansRoman")
    for word in (("c", "\uebe1", "t"), ("dog",), ("h", "\uebf5", "t"), ("s", "\uebe9", "t")):
        for piece in word:
            x = put(x, 310, piece, obl, "ArevSansOblique")
        x = put(x, 310, ", ", reg, "ArevSansRoman")
    put(x, 310, "end} and that is all.", reg, "ArevSansRoman")
    # a letter carrying a superscript stacked over a subscript (c with 1 over 1), set as
    # three pieces: the oblique letter, a small raised digit, a small lowered digit at the
    # same x. PDF readers break the line at each such stack
    y = 430
    x = put(72, y, "Find the new points ", reg, "ArevSansRoman")
    for i, (up, down) in enumerate((("1", "1"), ("1", "2"), ("0", "1"), ("0", "2"))):
        x = put(x, y, "c", obl, "ArevSansOblique")
        put(x + 0.2, y - 3.6, up, reg, "ArevSansRoman", 7.6)
        x = put(x + 0.2, y + 2.4, down, reg, "ArevSansRoman", 7.6)
        x = put(x, y, (" and ", " from ", " and ", ", after one step.")[i], reg, "ArevSansRoman")
    # a lone superscript after a plain italic letter, beside a formula on the same line
    y = 446
    x = put(72, y, "The error of ", reg, "ArevSansRoman")
    x = put(x, y, "C", obl, "ArevSansOblique")
    x = put(x + 0.2, y - 3.6, "0", reg, "ArevSansRoman", 7.6)
    x = put(x, y, " is ", reg, "ArevSansRoman")
    for piece in ("\uebf6", "ec"):
        x = put(x, y, piece, obl, "ArevSansOblique")
    put(x, y, " long.", reg, "ArevSansRoman")
    doc.subset_fonts()
    doc.save(OUT, garbage=4, deflate=True)
    tmp.unlink()


if __name__ == "__main__":
    main()
