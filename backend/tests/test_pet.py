"""Desktop-pet appearance endpoints: upload, background removal, animated GIF."""
from io import BytesIO

from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

from app.main import app


def _png_on_white() -> bytes:
    """A dark ring on a white background, with a white hole inside the ring."""
    im = Image.new("RGB", (120, 120), "white")
    d = ImageDraw.Draw(im)
    d.ellipse((20, 20, 100, 100), fill=(30, 60, 160))
    d.ellipse((50, 50, 70, 70), fill="white")  # enclosed white: must survive
    out = BytesIO()
    im.save(out, format="PNG")
    return out.getvalue()


def _gif_on_white(frames: int = 4) -> bytes:
    imgs = []
    for i in range(frames):
        im = Image.new("RGB", (80, 80), "white")
        ImageDraw.Draw(im).rectangle((10 + i * 5, 20, 40 + i * 5, 60), fill=(200, 40, 40))
        imgs.append(im.convert("P"))
    out = BytesIO()
    imgs[0].save(out, format="GIF", save_all=True, append_images=imgs[1:], duration=80, loop=0)
    return out.getvalue()


def test_upload_strip_keeps_enclosed_colour():
    with TestClient(app) as c:
        c.delete("/api/pet/avatar")
        assert c.get("/api/pet/avatar").status_code == 404
        r = c.post("/api/pet/avatar", files={"file": ("me.png", _png_on_white(), "image/png")})
        assert r.status_code == 200, r.text
        r = c.post("/api/pet/avatar/strip")
        assert r.status_code == 200, r.text
        assert r.json()["animated"] is False
        im = Image.open(BytesIO(c.get("/api/pet/avatar").content)).convert("RGBA")
        assert im.getpixel((2, 2))[3] == 0  # border background removed
        assert im.getpixel((35, 60))[3] == 255  # the ring itself stays
        assert im.getpixel((60, 60))[3] == 255  # white enclosed by the ring stays
        c.delete("/api/pet/avatar")


def test_animated_gif_becomes_apng():
    with TestClient(app) as c:
        r = c.post("/api/pet/avatar", files={"file": ("walk.gif", _gif_on_white(), "image/gif")})
        assert r.status_code == 200, r.text
        r = c.post("/api/pet/avatar/strip")
        assert r.status_code == 200, r.text
        assert r.json()["animated"] is True
        im = Image.open(BytesIO(c.get("/api/pet/avatar").content))
        assert im.format == "PNG" and getattr(im, "n_frames", 1) == 4
        assert im.convert("RGBA").getpixel((1, 1))[3] == 0
        c.delete("/api/pet/avatar")


def test_upload_validation():
    with TestClient(app) as c:
        assert c.post("/api/pet/avatar", files={"file": ("x.txt", b"hello", "text/plain")}).status_code == 400
        assert c.post("/api/pet/avatar", files={"file": ("x.png", b"", "image/png")}).status_code == 400
        svg = b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>'
        assert c.post("/api/pet/avatar", files={"file": ("x.svg", svg, "image/svg+xml")}).status_code == 200
        assert c.post("/api/pet/avatar/strip").status_code == 400  # SVG is not stripped
        c.delete("/api/pet/avatar")
        assert c.post("/api/pet/avatar/strip").status_code == 404
