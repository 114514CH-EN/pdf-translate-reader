"""「翻译图片文字」: OCR of a picture in a page, translation painted back. The LLM is a stub."""
from __future__ import annotations

import io
import sys
from pathlib import Path

import pymupdf as fitz
import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.main import app  # noqa: E402
from app.services import image_translate, ocr  # noqa: E402

FONTS = [Path("C:/Windows/Fonts/arial.ttf"), Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")]
FONT = next((p for p in FONTS if p.exists()), None)
pytestmark = pytest.mark.skipif(FONT is None or not ocr.available(), reason="needs a Latin font and the OCR models")

WORDS = {"Output voltage": "输出电压", "Time (s)": "时间 (s)"}


def _picture() -> Image.Image:
    im = Image.new("RGB", (640, 360), "white")
    d = ImageDraw.Draw(im)
    d.rectangle((60, 40, 600, 290), outline="black", width=2)
    d.text((230, 8), "Output voltage", font=ImageFont.truetype(str(FONT), 24), fill=(0, 0, 160))
    d.text((290, 320), "Time (s)", font=ImageFont.truetype(str(FONT), 20), fill="black")
    d.text((70, 296), "250", font=ImageFont.truetype(str(FONT), 16), fill="black")
    return im


def _pdf() -> bytes:
    buf = io.BytesIO()
    _picture().save(buf, format="PNG")
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((72, 80), "A page with one chart on it.", fontsize=12)
    page.insert_image(fitz.Rect(72, 120, 392, 300), stream=buf.getvalue())
    return doc.tobytes()


def test_reads_the_lines_of_a_picture():
    lines = {ln.text: ln for ln in ocr.recognize(_picture())}
    assert "Output voltage" in lines and "Time (s)" in lines
    x0, y0, x1, y1 = lines["Output voltage"].box
    assert 215 < x0 < 240 and 0 <= y0 < 16 and 390 < x1 < 430 and y1 < 44


def test_numbers_and_translated_text_are_left_alone():
    assert image_translate.needs_translation("Output voltage", "zh")
    assert not image_translate.needs_translation("250", "zh")
    assert not image_translate.needs_translation("10 kΩ", "zh")
    assert not image_translate.needs_translation("输出电压", "zh")
    assert image_translate.needs_translation("输出电压", "en")


def test_reply_lines_are_matched_by_number():
    got = image_translate.parse_reply("[2] 时间 (s)\n说明：无\n[1] 输出电压\n[9] 多余", 2)
    assert got == {0: "输出电压", 1: "时间 (s)"}


def test_paint_keeps_everything_else_pixel_identical():
    src = _picture()
    lines = [{"box": list(ln.box), "rot": ln.rot, "src": ln.text, "tgt": WORDS.get(ln.text)} for ln in ocr.recognize(src)]
    out = image_translate.paint(src, lines)
    assert out.size == src.size
    assert out.crop((0, 44, 640, 310)).tobytes() == src.crop((0, 44, 640, 310)).tobytes()  # frame and "250"
    assert out.crop((200, 0, 440, 40)).tobytes() != src.crop((200, 0, 440, 40)).tobytes()  # the title changed
    # the new title is drawn in the title's own colour
    import numpy as np

    px = np.asarray(out.crop((200, 0, 440, 40))).astype(int)
    assert int(((px[:, :, 2] > 120) & (px[:, :, 0] < 60)).sum()) > 50


def test_translate_one_picture_through_the_api(monkeypatch):
    asked = []

    async def fake_llm(cfg, messages, **kw):
        asked.append(messages[-1]["content"])
        return "\n".join(f"[{i + 1}] {WORDS.get(line.split('] ', 1)[1], line)}"
                         for i, line in enumerate(messages[-1]["content"].splitlines()))

    monkeypatch.setattr(image_translate, "chat_completion", fake_llm)
    from app.services import llm_client

    monkeypatch.setattr(llm_client, "has_credentials", lambda cfg: True)
    with TestClient(app) as c:
        doc_id = c.post("/api/documents", files={"file": ("chart.pdf", _pdf(), "application/pdf")}).json()["doc_id"]
        base = f"/api/documents/{doc_id}/pages/1"
        blocks = c.get(f"{base}/blocks").json()["blocks"]
        img = next(b for b in blocks if b["type"] == "image")
        assert not img.get("image_tr")
        text = next(b for b in blocks if b["type"] == "paragraph")
        assert c.post(f"{base}/images/{text['id']}/translate").status_code == 404  # only pictures

        r = c.post(f"{base}/images/{img['id']}/translate")
        assert r.status_code == 200, r.text
        info = r.json()
        assert info["translated"] == 2 and info["url"]
        assert "250" not in asked[0] and "Output voltage" in asked[0]  # numbers are not sent at all
        png = c.get(info["url"])
        assert png.status_code == 200 and png.headers["content-type"] == "image/png"
        # same shape as the picture's place on the page (320 x 180 pt)
        w, h = Image.open(io.BytesIO(png.content)).size
        assert abs(w / h - 320 / 180) < 0.01

        again = next(b for b in c.get(f"{base}/blocks").json()["blocks"] if b["type"] == "image")
        assert again["image_tr"]["url"] == info["url"]

        # the in-place PDF export carries the translated picture
        from app.services.export_pdf_inplace import export_translated_pdf
        from app.config import DATA_DIR

        out = export_translated_pdf(doc_id, Path(DATA_DIR) / "imgtr-test.pdf", "zh")
        with fitz.open(out) as pdf:
            assert len(pdf[0].get_images()) == 2

        assert c.delete(f"{base}/images/{img['id']}/translation").json() == {"ok": True}
        gone = next(b for b in c.get(f"{base}/blocks").json()["blocks"] if b["type"] == "image")
        assert not gone.get("image_tr")
        assert c.get(info["url"]).status_code == 404
