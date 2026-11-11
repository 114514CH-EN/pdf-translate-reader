"""「翻译图片文字」: read the text in one picture of a page, translate it, paint it back.

The picture is the page region of an image block, rendered without the page's
own text (that text is translated as normal blocks). Each recognised line keeps
its place: the original ink is covered with the background colour around it and
the translation is drawn in the same colour, at the same height, with the same
alignment and rotation. Lines with nothing to translate (numbers, symbols) are
not touched, so axis ticks and formulas stay pixel-identical.

Result: uploads/<doc>/imgtr/p<page>_<key>.png + .json (the lines, for a later re-render).
"""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

import numpy as np
import pymupdf as fitz
from PIL import Image, ImageDraw, ImageFilter, ImageFont

from . import ocr
from .export_common import CJK_CANDIDATES
from .llm_client import chat_completion
from .page_assets import _publish, _tmp_for, text_free_page
from .prompts import TARGET_NAMES

RENDER_VER = 1
MIN_SCORE = 0.6
LATIN_FONTS = [Path("C:/Windows/Fonts/segoeui.ttf"), Path("C:/Windows/Fonts/arial.ttf"),
               Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")]


def image_key(bbox) -> str:
    """Stable across re-extraction: block ids change, the picture's place on the page does not."""
    return hashlib.sha1(",".join(str(round(float(v))) for v in bbox).encode()).hexdigest()[:12]


def out_dir(doc_dir: Path) -> Path:
    d = doc_dir / "imgtr"
    d.mkdir(parents=True, exist_ok=True)
    return d


def png_path(doc_dir: Path, page_no: int, key: str) -> Path:
    return doc_dir / "imgtr" / f"p{page_no}_{key}.png"


def info_path(doc_dir: Path, page_no: int, key: str) -> Path:
    return doc_dir / "imgtr" / f"p{page_no}_{key}.json"


def load_info(doc_dir: Path, page_no: int, key: str) -> dict | None:
    try:
        return json.loads(info_path(doc_dir, page_no, key).read_text(encoding="utf-8"))
    except Exception:
        return None


def remove(doc_dir: Path, page_no: int, key: str) -> None:
    for p in (png_path(doc_dir, page_no, key), info_path(doc_dir, page_no, key)):
        try:
            p.unlink()
        except OSError:
            pass


# ------------------------------------------------------------------ the picture

def render_region(pdf_path: Path, page_no: int, bbox) -> Image.Image:
    """The picture as the reader sees it in the translated view: the page without its text."""
    with fitz.open(pdf_path) as pdf:
        page = text_free_page(pdf, page_no)
        clip = fitz.Rect(bbox) & page.rect
        if clip.is_empty:
            raise ValueError("图片不在页面范围内")
        zoom = min(4.0, max(2.0, 1500 / max(clip.width, clip.height)))
        pix = page.get_pixmap(clip=clip, matrix=fitz.Matrix(zoom, zoom), alpha=False, annots=False)
        return Image.frombytes("RGB", (pix.width, pix.height), pix.samples)


# ----------------------------------------------------------------- translation

_CJK = re.compile(r"[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]")
_LATIN_WORD = re.compile(r"[A-Za-z]{2,}")


def needs_translation(text: str, target_lang: str) -> bool:
    """Numbers, units and symbols stay as they are; so does text already in the target language."""
    if target_lang.startswith("zh") or target_lang in ("ja", "ko"):
        return bool(_LATIN_WORD.search(text)) and len(_CJK.findall(text)) < len(text) / 2
    if target_lang == "en":
        return bool(_CJK.search(text))
    return bool(_LATIN_WORD.search(text) or _CJK.search(text))


def build_messages(texts: list[str], target_lang: str, doc_title: str = "") -> list[dict]:
    tgt = TARGET_NAMES.get(target_lang, target_lang)
    system = "\n".join([
        f"You translate the text found inside a figure, chart or screenshot of a document into {tgt}.",
        f"Document title: {doc_title!r}." if doc_title else "",
        "Each input line is one text line of the picture, in reading order, written as [n] text.",
        "Neighbouring lines may be parts of one sentence: translate so that they read naturally together,",
        "but keep exactly one output line per input line, with the same [n].",
        "These are labels: be short. Keep numbers, units, symbols, formulas, variable names, code,",
        "file names and product names unchanged. A line that needs no translation is returned unchanged.",
        "Recognition may have small errors (l/1, O/0): translate what was clearly meant.",
        "Output only the lines, nothing else.",
    ])
    user = "\n".join(f"[{i + 1}] {t}" for i, t in enumerate(texts))
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def parse_reply(reply: str, n: int) -> dict[int, str]:
    out: dict[int, str] = {}
    for m in re.finditer(r"^\s*\[(\d+)\]\s*(.*?)\s*$", reply, flags=re.M):
        i = int(m.group(1)) - 1
        if 0 <= i < n and m.group(2):
            out[i] = m.group(2)
    return out


# -------------------------------------------------------------------- painting

def _font(size: int, text: str) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    cjk = bool(_CJK.search(text))
    for p in (CJK_CANDIDATES if cjk else LATIN_FONTS + CJK_CANDIDATES):
        if p.exists():
            try:
                return ImageFont.truetype(str(p), size)
            except Exception:
                continue
    return ImageFont.load_default()


def _colours(a: np.ndarray, box) -> tuple[tuple[int, int, int], tuple[int, int, int], np.ndarray, bool]:
    """Background and ink colour of a line, the ink mask inside its box, and whether the background is flat."""
    x0, y0, x1, y1 = box
    h, w = a.shape[:2]
    X0, Y0, X1, Y1 = max(0, x0 - 3), max(0, y0 - 3), min(w, x1 + 3), min(h, y1 + 3)
    ring = np.concatenate([a[Y0:y0, X0:X1].reshape(-1, 3), a[y1:Y1, X0:X1].reshape(-1, 3),
                           a[y0:y1, X0:x0].reshape(-1, 3), a[y0:y1, x1:X1].reshape(-1, 3)])
    region = a[y0:y1, x0:x1].astype(np.int32)
    if ring.size == 0:
        ring = region.reshape(-1, 3)
    # the box's own most common colour is the safest background (the ring may cross a border line)
    flat_px = region.reshape(-1, 3)
    q = (flat_px // 16).astype(np.int32)
    codes = q[:, 0] * 256 + q[:, 1] * 16 + q[:, 2]
    top = np.bincount(codes).argmax()
    bg = np.median(flat_px[codes == top], axis=0)
    dist = np.abs(region - bg).sum(axis=2)
    ink = dist > 90
    if ink.sum() < 4:
        ink = dist > 45
    fg = np.median(region[ink], axis=0) if ink.any() else (np.array([0, 0, 0]) if bg.mean() > 128 else np.array([255, 255, 255]))
    flat = float(np.mean(np.abs(ring.astype(np.int32) - bg).sum(axis=1) < 60)) > 0.7
    return tuple(int(v) for v in bg), tuple(int(v) for v in fg), ink, flat


def _ink_box(ink: np.ndarray, box) -> tuple[int, int, int, int]:
    x0, y0, x1, y1 = box
    ys, xs = np.flatnonzero(ink.any(axis=1)), np.flatnonzero(ink.any(axis=0))
    if ys.size == 0 or xs.size == 0:
        return box
    return x0 + int(xs[0]), y0 + int(ys[0]), x0 + int(xs[-1]) + 1, y0 + int(ys[-1]) + 1


def _alignment(i: int, boxes: list[tuple[int, int, int, int]], vertical: bool) -> str:
    """left / center / right, from the other lines of the picture this one lines up with."""
    b = boxes[i]
    lo, hi = (1, 3) if vertical else (0, 2)
    size = (b[2] - b[0]) if vertical else (b[3] - b[1])
    tol = max(3, size * 0.25)
    votes = {"left": 0, "center": 0, "right": 0}
    for j, o in enumerate(boxes):
        if j == i:
            continue
        o_size = (o[2] - o[0]) if vertical else (o[3] - o[1])
        if not 0.7 < o_size / max(size, 1) < 1.4 or abs((o[hi] - o[lo]) - (b[hi] - b[lo])) < tol:
            continue  # only lines of a different length tell the edges apart
        if abs(o[lo] - b[lo]) <= tol:
            votes["left"] += 1
        elif abs(o[hi] - b[hi]) <= tol:
            votes["right"] += 1
        elif abs((o[lo] + o[hi]) - (b[lo] + b[hi])) <= 2 * tol:
            votes["center"] += 1
    best = max(votes, key=lambda k: votes[k])
    return best if votes[best] else ""


def _free_margins(a: np.ndarray, ib, bg) -> tuple[int, int]:
    """Empty background left and right of a line, up to the next thing in its row band."""
    x0, y0, x1, y1 = ib
    band = np.abs(a[y0:y1].astype(np.int32) - np.array(bg)).sum(axis=2).max(axis=0) < 60  # per column
    left = 0
    while x0 - left - 1 >= 0 and band[x0 - left - 1]:
        left += 1
    right = 0
    while x1 + right < band.size and band[x1 + right]:
        right += 1
    return left, right


def _guess_alignment(a: np.ndarray, ib, bg) -> str:
    """A lone label: text hugging one side of its free space is anchored there; else it is centred."""
    left, right = _free_margins(a, ib, bg)
    if left < 0.75 * right:
        return "left"
    if right < 0.5 * left and right < 1.5 * (ib[3] - ib[1]):
        return "right"
    return "center"


_DESCENDERS = set("gjpqy()[]{},;Q/|")


def _em(src: str, height: int) -> float:
    """Font size of the original line from the height of its ink."""
    if _CJK.search(src):
        return height / 0.92
    return height / (0.93 if set(src) & _DESCENDERS else 0.74)


def paint(img: Image.Image, lines: list[dict]) -> Image.Image:
    """lines: [{box, rot, src, tgt}] — every line with a tgt is replaced in a copy of the picture."""
    out = img.convert("RGB").copy()
    a = np.asarray(out)
    todo = [ln for ln in lines if ln.get("tgt")]
    measured = []
    for ln in todo:
        box = tuple(int(v) for v in ln["box"])
        bg, fg, ink, flat = _colours(a, box)
        measured.append((ln, box, bg, fg, _ink_box(ink, box), flat))
    ink_boxes = [m[4] for m in measured]
    blurred = None
    draw = ImageDraw.Draw(out)
    # 1. cover every original line first, so a longer translation is never wiped by its neighbour
    for ln, box, bg, fg, ib, flat in measured:
        pad = (max(0, ib[0] - 2), max(0, ib[1] - 2), min(out.width, ib[2] + 2), min(out.height, ib[3] + 2))
        if flat:
            draw.rectangle((pad[0], pad[1], pad[2] - 1, pad[3] - 1), fill=bg)
        else:  # a photo or gradient behind the text: a soft patch instead of a flat block
            if blurred is None:
                blurred = img.convert("RGB").filter(ImageFilter.GaussianBlur(max(6, (ib[3] - ib[1]) // 2)))
            patch = Image.blend(blurred.crop(pad), Image.new("RGB", (pad[2] - pad[0], pad[3] - pad[1]), bg), 0.6)
            out.paste(patch, pad[:2])
    # 2. write the translations
    for n, (ln, box, bg, fg, ib, flat) in enumerate(measured):
        rot = int(ln.get("rot") or 0)
        vertical = rot in (90, 270)
        length = (ib[3] - ib[1]) if vertical else (ib[2] - ib[0])   # along the text
        height = (ib[2] - ib[0]) if vertical else (ib[3] - ib[1])   # across it
        text = ln["tgt"]
        em = _em(ln.get("src") or "", height)
        size = max(8, int(round(em * (0.92 if _CJK.search(text) else 1.0))))
        room = max(length * 1.12, length + height)
        font = _font(size, text)
        tw = font.getlength(text) if hasattr(font, "getlength") else len(text) * size * 0.6
        while tw > room and size > max(7, int(em * 0.5)):
            size -= 1
            font = _font(size, text)
            tw = font.getlength(text) if hasattr(font, "getlength") else len(text) * size * 0.6
        l, t, r, b = font.getbbox(text) if hasattr(font, "getbbox") else (0, 0, int(tw), size)
        tile = Image.new("RGBA", (max(1, r - l + 2), max(1, b - t + 2)), (0, 0, 0, 0))
        ImageDraw.Draw(tile).text((1 - l, 1 - t), text, font=font, fill=fg + (255,))
        if rot == 90:
            tile = tile.transpose(Image.ROTATE_90)
        elif rot == 270:
            tile = tile.transpose(Image.ROTATE_270)
        align = _alignment(n, ink_boxes, vertical) or ("center" if vertical else _guess_alignment(a, ib, bg))
        cx, cy = (ib[0] + ib[2]) / 2, (ib[1] + ib[3]) / 2
        if vertical:
            x = cx - tile.width / 2
            # reading direction decides which end is the "start" of the line
            start_top = rot == 270
            if align == "center":
                y = cy - tile.height / 2
            elif (align == "left") == start_top:
                y = ib[1]
            else:
                y = ib[3] - tile.height
        else:
            y = cy - tile.height / 2
            x = ib[0] if align == "left" else ib[2] - tile.width if align == "right" else cx - tile.width / 2
        x = min(max(0, int(round(x))), max(0, out.width - tile.width))
        y = min(max(0, int(round(y))), max(0, out.height - tile.height))
        out.paste(tile, (x, y), tile)
    return out


# ------------------------------------------------------------------- the whole job

async def translate_image(doc_dir: Path, pdf_path: Path, page_no: int, bbox, target_lang: str, cfg: dict,
                          doc_title: str = "") -> dict:
    """OCR → translate → paint → save. Returns the stored info ({"lines": [...], "translated": n})."""
    from starlette.concurrency import run_in_threadpool

    key = image_key(bbox)
    img = await run_in_threadpool(render_region, pdf_path, page_no, bbox)
    found = await run_in_threadpool(ocr.recognize, img)
    lines = [{"box": list(ln.box), "rot": ln.rot, "src": ln.text, "score": round(ln.score, 3), "tgt": None} for ln in found]
    wanted = [i for i, ln in enumerate(lines) if ln["score"] >= MIN_SCORE and needs_translation(ln["src"], target_lang)]
    if wanted:
        reply = await chat_completion(cfg, build_messages([lines[i]["src"] for i in wanted], target_lang, doc_title),
                                      temperature=0.2, max_tokens=4096)
        got = parse_reply(reply, len(wanted))
        for k, i in enumerate(wanted):
            tgt = got.get(k)
            if tgt and tgt.strip() != lines[i]["src"].strip():
                lines[i]["tgt"] = tgt.strip()
    done = sum(1 for ln in lines if ln["tgt"])
    info = {"ver": RENDER_VER, "key": key, "bbox": [float(v) for v in bbox], "lang": target_lang,
            "size": list(img.size), "found": len(lines), "translated": done, "lines": lines}
    out_dir(doc_dir)
    if done:
        painted = await run_in_threadpool(paint, img, lines)
        out = png_path(doc_dir, page_no, key)
        tmp = _tmp_for(out)
        painted.save(tmp, format="PNG", optimize=True)
        _publish(tmp, out)
    else:
        try:
            png_path(doc_dir, page_no, key).unlink()
        except OSError:
            pass
    info_path(doc_dir, page_no, key).write_text(json.dumps(info, ensure_ascii=False), encoding="utf-8")
    return info
