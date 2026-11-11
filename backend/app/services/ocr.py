"""Text in pictures: find the lines, read them (PP-OCRv4 through onnxruntime).

No OpenCV: the page images of a document are upright, so the detector's
probability map is turned into axis-aligned boxes with a small connected-
component pass in numpy. Rotated axis labels (tall, narrow boxes) are read
turned by 90° both ways and the better reading wins.

Everything runs on this computer; no picture leaves it.
"""
from __future__ import annotations

import threading
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image

from ..config import BUNDLE_DIR

MODEL_DIRS = [Path(__file__).resolve().parents[1] / "ocr_models", Path(BUNDLE_DIR) / "backend" / "app" / "ocr_models"]

DET_MIN_SIDE, DET_MAX_SIDE = 736, 1600
DET_THRESH, BOX_THRESH, UNCLIP = 0.3, 0.5, 1.6
REC_H = 48

_lock = threading.Lock()
_sessions: dict = {}


@dataclass
class Line:
    box: tuple[int, int, int, int]  # x0, y0, x1, y1 in the picture's pixels
    text: str
    score: float
    rot: int = 0  # 0 upright; 90: reads bottom-to-top (turn the crop clockwise to read); 270: top-to-bottom


def available() -> bool:
    return _model_dir() is not None


def _model_dir() -> Path | None:
    for d in MODEL_DIRS:
        if (d / "det.onnx").exists() and (d / "rec.onnx").exists():
            return d
    return None


def _load():
    with _lock:
        if not _sessions:
            import onnxruntime as ort

            d = _model_dir()
            if d is None:
                raise RuntimeError("没有找到文字识别模型（backend/app/ocr_models）")
            opts = ort.SessionOptions()
            opts.log_severity_level = 3
            det = ort.InferenceSession(str(d / "det.onnx"), opts, providers=["CPUExecutionProvider"])
            rec = ort.InferenceSession(str(d / "rec.onnx"), opts, providers=["CPUExecutionProvider"])
            chars = rec.get_modelmeta().custom_metadata_map["character"].splitlines()
            _sessions.update(det=det, rec=rec, chars=["", *chars, " "])
        return _sessions


def _norm(img: Image.Image) -> np.ndarray:
    """PIL RGB → 1x3xHxW float, BGR order, scaled to [-1, 1] (what the models were trained on)."""
    a = np.asarray(img, dtype=np.float32)[:, :, ::-1]
    a = (a / 255.0 - 0.5) / 0.5
    return np.ascontiguousarray(a.transpose(2, 0, 1)[None])


# ------------------------------------------------------------------ detection

def _components(mask: np.ndarray, prob: np.ndarray) -> list[tuple[int, int, int, int, float]]:
    """8-connected components of a boolean map → (x0, y0, x1, y1, mean probability)."""
    h, w = mask.shape
    parent: list[int] = []
    stat: list[list[float]] = []  # x0, y0, x1, y1, sum, count

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    csum = np.concatenate([np.zeros((h, 1), dtype=np.float64), np.cumsum(prob, axis=1, dtype=np.float64)], axis=1)
    padded = np.zeros((h, w + 2), dtype=np.int8)
    padded[:, 1:-1] = mask
    diff = np.diff(padded, axis=1)
    prev: list[tuple[int, int, int]] = []  # (start, end exclusive, label)
    for y in range(h):
        starts = np.flatnonzero(diff[y] == 1)
        if starts.size == 0:
            prev = []
            continue
        ends = np.flatnonzero(diff[y] == -1)
        cur: list[tuple[int, int, int]] = []
        j = 0
        for s, e in zip(starts.tolist(), ends.tolist()):
            label = -1
            while j < len(prev) and prev[j][1] < s:  # runs of the row above that end before this one
                j += 1
            k = j
            while k < len(prev) and prev[k][0] <= e:  # touching (diagonals included)
                root = find(prev[k][2])
                if label < 0:
                    label = root
                elif root != label:
                    parent[root] = label
                    a, b = stat[label], stat[root]
                    stat[label] = [min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3]), a[4] + b[4], a[5] + b[5]]
                k += 1
            seg = float(csum[y, e] - csum[y, s])
            if label < 0:
                label = len(parent)
                parent.append(label)
                stat.append([s, y, e, y + 1, seg, e - s])
            else:
                a = stat[label]
                stat[label] = [min(a[0], s), a[1], max(a[2], e), y + 1, a[4] + seg, a[5] + (e - s)]
            cur.append((s, e, label))
        prev = cur
    return [(int(s[0]), int(s[1]), int(s[2]), int(s[3]), s[4] / max(s[5], 1))
            for i, s in enumerate(stat) if parent[i] == i]


def detect(img: Image.Image) -> list[tuple[int, int, int, int]]:
    w, h = img.size
    ratio = 1.0
    if min(w, h) < DET_MIN_SIDE:
        ratio = DET_MIN_SIDE / min(w, h)
    if max(w, h) * ratio > DET_MAX_SIDE:
        ratio = DET_MAX_SIDE / max(w, h)
    rw, rh = max(32, round(w * ratio / 32) * 32), max(32, round(h * ratio / 32) * 32)
    small = img.resize((rw, rh), Image.BILINEAR)
    det = _load()["det"]
    prob = det.run(None, {det.get_inputs()[0].name: _norm(small)})[0][0, 0]
    mask = prob > DET_THRESH
    grown = mask.copy()  # 2x2 dilation, as PaddleOCR does
    grown[:, 1:] |= mask[:, :-1]
    grown[1:, :] |= mask[:-1, :]
    grown[1:, 1:] |= mask[:-1, :-1]
    sx, sy = w / rw, h / rh
    boxes = []
    for x0, y0, x1, y1, score in _components(grown, prob):
        bw, bh = x1 - x0, y1 - y0
        if min(bw, bh) < 3 or score < BOX_THRESH:
            continue
        grow = bw * bh * UNCLIP / (2 * (bw + bh))  # the map marks a shrunken core of each line
        X0, Y0 = max(0, int((x0 - grow) * sx)), max(0, int((y0 - grow) * sy))
        X1, Y1 = min(w, int(round((x1 + grow) * sx))), min(h, int(round((y1 + grow) * sy)))
        if X1 - X0 >= 4 and Y1 - Y0 >= 4:
            boxes.append((X0, Y0, X1, Y1))
    boxes = _join_fragments(boxes)
    boxes.sort(key=lambda b: (round(b[1] / 10), b[0]))
    return boxes


def _tall(b) -> bool:
    return (b[3] - b[1]) > 1.6 * (b[2] - b[0]) and (b[3] - b[1]) > 24


def _join_fragments(boxes: list[tuple[int, int, int, int]]) -> list[tuple[int, int, int, int]]:
    """The detector cuts a line at wide word gaps: pieces that continue each other are one line again.

    Upright pieces join along x, rotated (tall) pieces along y — when they sit on the same
    line (70% overlap across it, similar thickness) with less than 0.7 of a line height between them.
    """
    boxes = list(boxes)
    changed = True
    while changed:
        changed = False
        for i in range(len(boxes)):
            for j in range(i + 1, len(boxes)):
                a, b = boxes[i], boxes[j]
                if _tall(a) != _tall(b):
                    continue
                along, across = ((1, 3), (0, 2)) if _tall(a) else ((0, 2), (1, 3))
                ta, tb = a[across[1]] - a[across[0]], b[across[1]] - b[across[0]]
                overlap = min(a[across[1]], b[across[1]]) - max(a[across[0]], b[across[0]])
                gap = max(a[along[0]], b[along[0]]) - min(a[along[1]], b[along[1]])
                if overlap >= 0.7 * min(ta, tb) and 0.75 < ta / max(tb, 1) < 1.33 and gap < 0.7 * min(ta, tb):
                    boxes[i] = (min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3]))
                    del boxes[j]
                    changed = True
                    break
            if changed:
                break
    return boxes


# ---------------------------------------------------------------- recognition

def _read(crop: Image.Image) -> tuple[str, float]:
    s = _load()
    w, h = crop.size
    rw = int(min(max(REC_H * w / max(h, 1), 16), 2400))
    x = _norm(crop.resize((rw, REC_H), Image.BILINEAR))
    out = s["rec"].run(None, {s["rec"].get_inputs()[0].name: x})[0][0]  # T x classes
    idx = out.argmax(axis=1)
    conf = out.max(axis=1)
    chars, scores, last = [], [], 0
    for i, c in zip(idx.tolist(), conf.tolist()):
        if i != 0 and i != last and i < len(s["chars"]):
            chars.append(s["chars"][i])
            scores.append(c)
        last = i
    text = "".join(chars).strip()
    return text, (float(np.mean(scores)) if scores else 0.0)


def recognize(img: Image.Image) -> list[Line]:
    """Every readable line of text in an RGB picture."""
    img = img.convert("RGB")
    lines: list[Line] = []
    for box in detect(img):
        crop = img.crop(box)
        w, h = crop.size
        if h > 1.6 * w and h > 24:  # a rotated label: try both directions
            a = _read(crop.transpose(Image.ROTATE_270))  # reads bottom-to-top in the picture
            b = _read(crop.transpose(Image.ROTATE_90))
            (text, score), rot = (a, 90) if a[1] >= b[1] else (b, 270)
            if len(text) < 2:  # a single upright glyph is just as tall and narrow
                t0, s0 = _read(crop)
                if s0 > score:
                    text, score, rot = t0, s0, 0
        else:
            (text, score), rot = _read(crop), 0
        if text:
            lines.append(Line(box, text, score, rot))
    return lines
