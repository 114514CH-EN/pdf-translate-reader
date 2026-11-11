"""A one-page PDF with a ruled 4x3 table and a picture — the release workflow checks the exe handles both."""
import sys

import pymupdf

doc = pymupdf.open()
page = doc.new_page()
page.insert_text((72, 70), "Measured values of the test circuit", fontsize=12)
for r in range(4):
    for c in range(3):
        box = pymupdf.Rect(72 + c * 120, 100 + r * 30, 192 + c * 120, 130 + r * 30)
        page.draw_rect(box, color=(0, 0, 0), width=0.8)
        page.insert_text((box.x0 + 6, box.y0 + 20), f"cell {r}{c}", fontsize=11)
# a small picture too: 「翻译图片文字」 must find its models in the packaged app
pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 200, 80), False)
pix.set_rect(pix.irect, (235, 240, 250))
page.insert_image(pymupdf.Rect(72, 260, 272, 340), pixmap=pix)
doc.save(sys.argv[1] if len(sys.argv) > 1 else "table.pdf")
