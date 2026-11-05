"""Pet appearance: the one picture the pet wears, uploaded by the reader.

Nothing character-shaped ships with the app — the pet shows whatever image the
reader imports here, or whatever URL they point it at (that choice lives in the
browser, these endpoints only store and clean up an uploaded file).

Background removal lives here rather than in the browser because a GIF or an
animated WebP has to be re-encoded frame by frame, which canvas cannot do. The
result is written as APNG: the animation survives and each pixel gets real 8-bit
alpha instead of GIF's single transparent index.
"""
from __future__ import annotations

import contextlib
from io import BytesIO
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from PIL import Image, ImageSequence

from ..config import DATA_DIR

router = APIRouter(prefix="/api/pet", tags=["pet"])

PET_DIR = DATA_DIR / "pet"
MAX_BYTES = 12 * 1024 * 1024
STRIP_MAX_SIDE = 200
STRIP_TOLERANCE = 30

EXT_BY_TYPE = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
    "image/avif": ".avif",
}
EXT_BY_SUFFIX = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif"}


def _extension(upload: UploadFile) -> str | None:
    """The browser's content type, falling back to the file name."""
    ext = EXT_BY_TYPE.get((upload.content_type or "").lower())
    if ext:
        return ext
    suffix = Path(upload.filename or "").suffix.lower()
    if suffix in EXT_BY_SUFFIX:
        return ".jpg" if suffix == ".jpeg" else suffix
    return None


# The main picture is avatar.*; each pose may have its own picture, avatar-<slot>.*
# (walk / think / talk / listen / sleep). A pose without a picture uses the main one.
SLOTS = {"idle", "walk", "think", "talk", "listen", "sleep"}


def _slot(slot: str | None) -> str:
    s = (slot or "idle").strip().lower()
    if s not in SLOTS:
        raise HTTPException(400, f"未知的动作：{slot}（可选 {' / '.join(sorted(SLOTS))}）")
    return s


def _stem(slot: str) -> str:
    return "avatar" if slot == "idle" else f"avatar-{slot}"


def _files(slot: str) -> list[Path]:
    stem = _stem(slot)
    return sorted(p for p in PET_DIR.glob(f"{stem}.*") if p.stem == stem)


def _current(slot: str = "idle") -> Path | None:
    found = _files(slot)
    return found[0] if found else None


# ---------------------------------------------------------------- background

def _strip_frame(frame: Image.Image, tolerance: int = STRIP_TOLERANCE) -> Image.Image:
    """Make the border-connected background transparent.

    The flood fill starts at the four edges, so an area of the same colour that
    the character encloses (a white headdress, an eye highlight) is left alone.
    """
    rgba = frame.convert("RGBA")
    if max(rgba.size) > STRIP_MAX_SIDE:
        rgba.thumbnail((STRIP_MAX_SIDE, STRIP_MAX_SIDE), Image.LANCZOS)
    w, h = rgba.size
    if w < 2 or h < 2:
        return rgba

    buf = bytearray(rgba.tobytes())

    total = [0, 0, 0, 0]
    count = 0
    for x in range(w):
        for y in (0, h - 1):
            i = (y * w + x) * 4
            total[0] += buf[i]
            total[1] += buf[i + 1]
            total[2] += buf[i + 2]
            total[3] += buf[i + 3]
            count += 1
    for y in range(h):
        for x in (0, w - 1):
            i = (y * w + x) * 4
            total[0] += buf[i]
            total[1] += buf[i + 1]
            total[2] += buf[i + 2]
            total[3] += buf[i + 3]
            count += 1

    sr, sg, sb, sa = (t / count for t in total)
    if sa < 240:  # already on a transparent background
        return rgba

    n = w * h
    seen = bytearray(n)
    stack: list[int] = []

    def visit(p: int) -> None:
        if seen[p]:
            return
        seen[p] = 1
        i = p * 4
        if buf[i + 3] <= 8:
            return
        if abs(buf[i] - sr) > tolerance or abs(buf[i + 1] - sg) > tolerance or abs(buf[i + 2] - sb) > tolerance:
            return
        buf[i] = buf[i + 1] = buf[i + 2] = buf[i + 3] = 0
        stack.append(p)

    for x in range(w):
        visit(x)
        visit((h - 1) * w + x)
    for y in range(h):
        visit(y * w)
        visit(y * w + w - 1)

    while stack:
        p = stack.pop()
        x = p % w
        if x:
            visit(p - 1)
        if x < w - 1:
            visit(p + 1)
        if p >= w:
            visit(p - w)
        if p < n - w:
            visit(p + w)

    return Image.frombytes("RGBA", (w, h), bytes(buf))


def _encode_png(img: Image.Image) -> bytes:
    out = BytesIO()
    img.save(out, format="PNG", optimize=True)
    return out.getvalue()


def _encode_apng(frames: list[Image.Image], durations: list[int]) -> bytes:
    out = BytesIO()
    frames[0].save(
        out,
        format="PNG",
        save_all=True,
        append_images=frames[1:],
        duration=durations,
        loop=0,
        # every frame is complete and replaces the previous one (SOURCE, no
        # dispose): Pillow's dispose path fails on palette frames, and blending
        # OVER would leave trails wherever a frame turned transparent
        disposal=0,
        blend=0,
        optimize=True,
    )
    return out.getvalue()


def _strip_bytes(path: Path) -> tuple[bytes, bool]:
    """Strip the stored avatar. Returns (encoded bytes, kept the animation)."""
    with Image.open(path) as im:
        animated = bool(getattr(im, "is_animated", False)) and int(getattr(im, "n_frames", 1)) > 1
        if not animated:
            im.seek(0)
            return _encode_png(_strip_frame(im)), False

        rgba: list[Image.Image] = []
        durations: list[int] = []
        for frame in ImageSequence.Iterator(im):
            durations.append(int(frame.info.get("duration") or 100))
            rgba.append(_strip_frame(frame))
        if not rgba:
            raise ValueError("没有读到任何一帧")
        return _encode_apng(_shared_palette(rgba), durations), True


def _shared_palette(frames: list[Image.Image]) -> list[Image.Image]:
    """Quantize all frames against ONE palette (with alpha).

    An APNG has a single PLTE/tRNS for every frame, so quantizing each frame on
    its own would show later frames in the first frame's colours. Stacking the
    frames into one tall image and quantizing that once gives every frame the
    same palette. 动图按调色板存：120 帧从 5 MB 压到 3 MB 以内，看不出差别。
    """
    w, h = frames[0].size
    sheet = Image.new("RGBA", (w, h * len(frames)), (0, 0, 0, 0))
    for i, f in enumerate(frames):
        sheet.paste(f if f.size == (w, h) else f.resize((w, h)), (0, i * h))
    q = sheet.quantize(colors=256, method=Image.FASTOCTREE)
    return [q.crop((0, i * h, w, (i + 1) * h)) for i in range(len(frames))]


# ------------------------------------------------------------------ endpoints

@router.get("/avatars")
def list_avatars():
    """Which poses have their own uploaded picture."""
    return {"slots": sorted(s for s in SLOTS if _current(s) is not None)}


@router.get("/avatar")
def get_avatar(slot: str | None = Query(None)):
    path = _current(_slot(slot))
    if path is None:
        raise HTTPException(404, "还没有导入形象")
    return FileResponse(path, headers={"Cache-Control": "no-cache"})


@router.post("/avatar")
async def put_avatar(file: UploadFile, slot: str | None = Query(None)):
    s = _slot(slot)
    ext = _extension(file)
    if ext is None:
        raise HTTPException(400, "只支持 png / jpg / gif / webp / svg / avif")
    data = await file.read()
    if not data:
        raise HTTPException(400, "文件是空的")
    if len(data) > MAX_BYTES:
        raise HTTPException(413, "图片太大（上限 12 MB）")
    PET_DIR.mkdir(parents=True, exist_ok=True)
    for old in _files(s):
        old.unlink(missing_ok=True)
    (PET_DIR / f"{_stem(s)}{ext}").write_bytes(data)
    return {"ok": True, "url": _url(s), "slot": s, "bytes": len(data)}


@router.post("/avatar/strip")
def strip_avatar(slot: str | None = Query(None)):
    """去掉已导入形象的背景；动图会去完每一帧再存成 APNG，动画不丢。"""
    s = _slot(slot)
    path = _current(s)
    if path is None:
        raise HTTPException(404, "还没有导入形象")
    if path.suffix.lower() == ".svg":
        raise HTTPException(400, "SVG 是矢量的，不需要也不支持去背景")
    try:
        data, animated = _strip_bytes(path)
    except Exception as e:  # noqa: BLE001 - report whatever PIL said
        raise HTTPException(400, f"处理不了这张图：{type(e).__name__}: {e}") from e

    target = PET_DIR / f"{_stem(s)}.png"
    for old in _files(s):
        if old != target:
            with contextlib.suppress(OSError):
                old.unlink()
    target.write_bytes(data)
    return {"ok": True, "url": _url(s), "slot": s, "animated": animated, "bytes": len(data)}


@router.delete("/avatar")
def delete_avatar(slot: str | None = Query(None)):
    """Without ?slot= every picture goes (换回默认形象); with it only that pose's."""
    targets = [_slot(slot)] if slot else sorted(SLOTS)
    for s in targets:
        for old in _files(s):
            old.unlink(missing_ok=True)
    return {"ok": True}


def _url(slot: str) -> str:
    return "/api/pet/avatar" if slot == "idle" else f"/api/pet/avatar?slot={slot}"
