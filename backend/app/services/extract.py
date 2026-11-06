"""Low-level page extraction: raw text blocks, tables, images (PyMuPDF)."""
from __future__ import annotations

import base64
import re
from pathlib import Path

import pymupdf as fitz


def _sniff_ext(data: bytes) -> str:
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if data[:2] == b"\xff\xd8":
        return "jpg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return "png"


def _bands(centers: list[float], n: int) -> list[float]:
    """Representative centers of n clusters along one axis (simple quantile seeding)."""
    if not centers:
        return [0.0] * n
    s = sorted(centers)
    return [s[min(len(s) - 1, int((i + 0.5) * len(s) / n))] for i in range(n)]


def _words_in_bbox(words: list[tuple], bbox: list[float]) -> str:
    """Assemble cell text from word geometry (reading order), avoiding tbl.extract() quirks."""
    x0, y0, x1, y1 = bbox
    picked = []
    for w in words:
        wx0, wy0, wx1, wy1, word = w[0], w[1], w[2], w[3], w[4]
        wcx, wcy = (wx0 + wx1) / 2, (wy0 + wy1) / 2
        if x0 - 1 <= wcx <= x1 + 1 and y0 - 1 <= wcy <= y1 + 1:
            picked.append((wcy, wx0, max(wy1 - wy0, 1.0), word))
    if not picked:
        return ""
    # group into visual lines by vertical center (robust to sub/superscripts).
    # Math fonts may report absurdly tall boxes → cap heights at 1.5× median.
    hs = sorted(p[2] for p in picked)
    cap = 1.5 * hs[len(hs) // 2]
    picked = [(p[0], p[1], min(p[2], cap), p[3]) for p in picked]
    picked.sort()
    lines: list[list[tuple]] = []
    for p in picked:
        if lines:
            line = lines[-1]
            lcy = sum(q[0] for q in line) / len(line)
            lh = max(q[2] for q in line)
            if abs(p[0] - lcy) <= 0.6 * max(lh, p[2]):
                line.append(p)
                continue
        lines.append([p])
    parts = [q[3] for line in lines for q in sorted(line, key=lambda q: q[1])]
    text = " ".join(parts)
    text = re.sub(r"\s+([,.;:!?)\]}])", r"\1", text)
    text = re.sub(r"([(\[{])\s+", r"\1", text)
    return text.strip()


# Word-exported math fonts often map every glyph to the same char twice (the
# second copy has zero advance) → "𝑁𝑁", "𝑇𝑇". Collapse such pairs.
_MATH_DUP = re.compile("([\U0001D400-\U0001D7FF])\\1")


def _fix_text(text: str, dedupe: bool) -> str:
    return _MATH_DUP.sub(r"\1", text) if dedupe and text else text


def _page_has_dup_glyphs(page: fitz.Page) -> bool:
    """Detect the zero-width duplicate-glyph pattern in math fonts."""
    try:
        raw = page.get_text("rawdict")
    except Exception:
        return False
    for blk in raw.get("blocks", []):
        for ln in blk.get("lines", []) if blk.get("type") == 0 else []:
            for sp in ln.get("spans", []):
                chars = sp.get("chars", [])
                for a, b in zip(chars, chars[1:]):
                    if (
                        a["c"] == b["c"]
                        and "\U0001D400" <= a["c"] <= "\U0001D7FF"
                        and abs(b["bbox"][2] - b["bbox"][0]) < 0.05
                    ):
                        return True
    return False


def _cluster_bounds(xs: list[float], lo: float, hi: float, tol: float = 8.0) -> list[float]:
    """Collapse x-edges closer than ``tol`` (padding/separator slivers) into one boundary."""
    xs = sorted(x for x in xs if lo - 1 <= x <= hi + 1)
    groups: list[list[float]] = []
    for x in xs:
        if groups and x - groups[-1][-1] <= tol:
            groups[-1].append(x)
        else:
            groups.append([x])
    bounds = []
    for g in groups:
        if min(g) <= lo + tol:
            bounds.append(lo)
        elif max(g) >= hi - tol:
            bounds.append(hi)
        else:
            bounds.append(sum(g) / len(g))
    out = sorted(set([lo, hi] + bounds))
    return out


def _nearest(bounds: list[float], x: float) -> int:
    return min(range(len(bounds)), key=lambda i: abs(bounds[i] - x))


def _clean_split(words: list[tuple], bbox: list[float], bounds: list[float], c0: int, c1: int,
                 min_gap: float = 8.0) -> bool:
    """Can a cell spanning columns c0..c1 be split at the interior column bounds?

    True when its words occupy ≥2 columns and every interior boundary falls in a
    clear horizontal gap (≥ ``min_gap``) of the words' x-projection — i.e. the
    row simply had no vertical rules. Normal word spacing (~3pt) never splits.
    """
    x0, y0, x1, y1 = bbox
    inside = [w for w in words if x0 - 1 <= (w[0] + w[2]) / 2 <= x1 + 1 and y0 - 1 <= (w[1] + w[3]) / 2 <= y1 + 1]
    if not inside:
        return False
    cols = set()
    for w in inside:
        cx = (w[0] + w[2]) / 2
        cols.add(next((k for k in range(c0, c1) if cx <= bounds[k + 1]), c1 - 1))
    if len(cols) < 2:
        return False
    occ: list[list[float]] = []
    for a, b in sorted((w[0], w[2]) for w in inside):
        if occ and a <= occ[-1][1]:
            occ[-1][1] = max(occ[-1][1], b)
        else:
            occ.append([a, b])
    for k in range(c0 + 1, c1):
        b = bounds[k]
        left = max((o[1] for o in occ if o[1] <= b), default=None)
        right = min((o[0] for o in occ if o[0] >= b), default=None)
        if any(o[0] < b < o[1] for o in occ):
            return False  # a word straddles the boundary
        if left is not None and right is not None and right - left < min_gap:
            return False
    return True


def _normalize_table(tbl, words: list[tuple]) -> tuple[int, int, list[dict]]:
    """Turn a PyMuPDF table into a clean (row, col, colspan) grid.

    Fixes the common failure modes of ``find_tables`` on Word/LaTeX output:
    sliver columns from cell padding / fill gaps, body rows without vertical
    rules collapsed into one full-width cell, and wrapped text creating
    sub-rows.
    """
    rows = [r for r in tbl.rows if any(c is not None for c in r.cells)]
    if not rows:
        return 0, 0, []
    tx0, ty0, tx1, ty1 = tbl.bbox
    xs = [v for r in rows for c in r.cells if c is not None for v in (c[0], c[2])]
    bounds = _cluster_bounds(xs, tx0, tx1)
    n_cols = len(bounds) - 1

    def col_range(c) -> tuple[int, int]:
        if c[2] - c[0] < 10:  # sliver: attribute by center
            cx = (c[0] + c[2]) / 2
            k = next((k for k in range(n_cols) if cx <= bounds[k + 1]), n_cols - 1)
            return k, k + 1
        a, b = _nearest(bounds, c[0]), _nearest(bounds, c[2])
        a = min(a, n_cols - 1)
        return a, max(b, a + 1)

    grid_rows: list[dict] = []  # each: {y0, y1, cells: {c0: [c0, c1, bbox]}}
    for r in rows:
        cells = [list(c) for c in r.cells if c is not None]
        ry0 = min(c[1] for c in cells)
        ry1 = max(c[3] for c in cells)
        parent = grid_rows[-1] if grid_rows else None
        is_sub = parent is not None and ry0 >= parent["y0"] - 1 and ry1 <= parent["y1"] + 1
        target = parent if is_sub else {"y0": ry0, "y1": ry1, "cells": {}}
        for c in cells:
            a, b = col_range(c)
            # merge into an existing cell overlapping this column range
            hit = next((k for k, v in target["cells"].items() if v[0] < b and a < v[1]), None)
            if hit is None:
                target["cells"][a] = [a, b, c]
            else:
                v = target["cells"].pop(hit)
                bb = [min(v[2][0], c[0]), min(v[2][1], c[1]), max(v[2][2], c[2]), max(v[2][3], c[3])]
                na, nb = min(v[0], a), max(v[1], b)
                target["cells"][na] = [na, nb, bb]
        if not is_sub:
            grid_rows.append(target)

    out: list[dict] = []
    for ri, gr in enumerate(grid_rows):
        y0, y1 = gr["y0"], gr["y1"]
        for a in sorted(gr["cells"]):
            ca, cb, bb = gr["cells"][a]
            bb = [bb[0], y0, bb[2], y1]  # cells fill the row height
            if cb - ca > 1 and _clean_split(words, bb, bounds, ca, cb):
                for k in range(ca, cb):
                    out.append({"row": ri, "col": k, "bbox": [bounds[k], y0, bounds[k + 1], y1]})
            else:
                cell = {"row": ri, "col": ca, "bbox": [max(bb[0], bounds[ca]) if cb - ca == 1 else bounds[ca], y0,
                                                       bounds[cb], y1]}
                if cb - ca > 1:
                    cell["colspan"] = cb - ca
                out.append(cell)
    return len(grid_rows), n_cols, out


def _page_rules(page: fitz.Page) -> tuple[list[tuple[float, float, float]], list[tuple[float, float, float]]]:
    """Horizontal (y, x0, x1) and vertical (x, y0, y1) rules drawn on the page.

    Collinear pieces (Word draws a border per cell) are joined into one rule.
    """
    hs: list[tuple[float, float, float]] = []
    vs: list[tuple[float, float, float]] = []
    try:
        drawings = page.get_drawings()
    except Exception:
        return [], []
    for dr in drawings:
        for it in dr.get("items", []):
            if it[0] == "l":
                a, b = it[1], it[2]
                if abs(a.y - b.y) < 0.8:
                    hs.append(((a.y + b.y) / 2, min(a.x, b.x), max(a.x, b.x)))
                elif abs(a.x - b.x) < 0.8:
                    vs.append(((a.x + b.x) / 2, min(a.y, b.y), max(a.y, b.y)))
            elif it[0] == "re":
                r = it[1]
                if r.height < 2.0 and r.width > 2.0:
                    hs.append(((r.y0 + r.y1) / 2, r.x0, r.x1))
                elif r.width < 2.0 and r.height > 2.0:
                    vs.append(((r.x0 + r.x1) / 2, r.y0, r.y1))

    def join(segs: list[tuple[float, float, float]]) -> list[tuple[float, float, float]]:
        out: list[list[float]] = []
        for pos, a, b in sorted(segs, key=lambda t: (round(t[0] * 2) / 2, t[1])):
            last = out[-1] if out else None
            if last and abs(last[0] - pos) < 0.8 and a <= last[2] + 2.0:
                last[2] = max(last[2], b)
            else:
                out.append([pos, a, b])
        return [(o[0], o[1], o[2]) for o in out]

    return join(hs), join(vs)


_SENTENCE_END = re.compile(r"[.:;!?。：；！？)\]]\s*$")


def _merge_wrapped_rows(cells: list[dict], n_rows: int, rules: tuple, words: list[tuple]) -> tuple[int, list[dict]]:
    """Rejoin table rows that are really the wrapped lines of tall cells.

    Without rules between them, ``find_tables`` turns every text line of a
    tall Word cell ("Adequate / understanding of / the problem. / …") into a
    row of its own; translated line by line, the fragments come out broken,
    shrunk, or left in English. Rows are joined when they sit between the same
    two horizontal rules, the band is boxed by vertical rules, and the column
    text clearly runs on from line to line. Data tables with one record per
    line (no continuation) and booktabs tables (no vertical rules) are left alone.
    """
    hs, vs = rules
    if n_rows < 3 or not hs or not vs:
        return n_rows, cells
    tx0 = min(c["bbox"][0] for c in cells)
    tx1 = max(c["bbox"][2] for c in cells)
    ty0 = min(c["bbox"][1] for c in cells)
    ty1 = max(c["bbox"][3] for c in cells)
    width = tx1 - tx0
    ys = sorted({round(y, 1) for y, a, b in hs
                 if ty0 - 40 <= y <= ty1 + 40 and min(b, tx1) - max(a, tx0) >= 0.6 * width})
    if len(ys) < 2:
        return n_rows, cells
    rows: dict[int, list[dict]] = {}
    for c in cells:
        rows.setdefault(c["row"], []).append(c)
    row_y = {r: (min(c["bbox"][1] for c in cs) + max(c["bbox"][3] for c in cs)) / 2 for r, cs in rows.items()}

    def band_of(y: float) -> int | None:
        for k in range(len(ys) - 1):
            if ys[k] - 0.5 <= y <= ys[k + 1] + 0.5:
                return k
        return None

    bands: dict[int, list[int]] = {}
    for r in sorted(rows):
        k = band_of(row_y[r])
        bands.setdefault(k if k is not None else -1 - r, []).append(r)

    def boxed(k: int) -> bool:
        y0, y1 = ys[k], ys[k + 1]
        h = y1 - y0
        inner = [x for x, a, b in vs if tx0 + 4 < x < tx1 - 4 and min(b, y1) - max(a, y0) >= 0.9 * h]
        return len(inner) >= 1

    def runs_on(rs: list[int]) -> bool:
        cont = total = 0
        for a, b in zip(rs, rs[1:]):
            by_col_a = {c["col"]: c.get("text", "") for c in rows[a]}
            for c in rows[b]:
                prev, nxt = (by_col_a.get(c["col"]) or "").strip(), (c.get("text") or "").strip()
                if not prev or not nxt:
                    continue
                total += 1
                if nxt[:1].islower() or not _SENTENCE_END.search(prev):
                    cont += 1
        return total >= 3 and cont >= 0.6 * total

    for c in cells:  # text is needed to judge continuity
        if "text" not in c:
            c["text"] = _words_in_bbox(words, c["bbox"])
    merge = {k for k, rs in bands.items() if k >= 0 and len(rs) >= 2 and boxed(k) and runs_on(rs)}
    if not merge:
        return n_rows, cells

    out: list[dict] = []
    new_row = 0
    for k in sorted(bands, key=lambda k: min(row_y[r] for r in bands[k])):
        rs = bands[k]
        if k not in merge:
            for r in rs:
                for c in rows[r]:
                    out.append({**c, "row": new_row})
                new_row += 1
            continue
        cols: dict[int, dict] = {}
        for r in rs:
            for c in rows[r]:
                cur = cols.get(c["col"])
                if cur is None:
                    cols[c["col"]] = {k2: v for k2, v in c.items() if k2 != "text"}
                else:
                    b0, b1 = cur["bbox"], c["bbox"]
                    cur["bbox"] = [min(b0[0], b1[0]), b0[1], max(b0[2], b1[2]), b0[3]]
                    if c.get("colspan", 1) > cur.get("colspan", 1):
                        cur["colspan"] = c["colspan"]
        for col in sorted(cols):
            c = cols[col]
            bb = c["bbox"]
            # the cell is the whole band between the two rules (inside the border)
            c["bbox"] = [bb[0], ys[k] + 0.5, bb[2], ys[k + 1] - 0.5]
            c["row"] = new_row
            out.append(c)
        new_row += 1
    for c in out:
        c.pop("text", None)
    return new_row, out


EXTRACT_VER = 17  # v17: a text line broken by Word math into several PDF blocks (fractions, cases) is one line again; v16: wrapped lines of tall ruled table cells rejoined into one cell; v15: code blocks (monospace listings, only comments translated), Courier "o" sub-bullets, brackets pulled into formulas; v8: cell text inset/alignment + hanging list indents; v7: inline bold no longer splits paragraphs; v6 tab-stop segments; v5 mixed-cell placeholders
# v6: tab-stop segments split; v5: formula placeholders inside mixed table cells; v4: same-baseline lines merged; v3: math runs (formula placeholders {{mN}}), formula blocks, math table cells


# ---- math detection ---------------------------------------------------------------
# Formulas are never re-typeset from extracted text (Word/LaTeX math fonts often have
# broken ToUnicode maps, sub/superscripts lose their position). Instead each math run
# gets a placeholder and the reader/exporters show a crop of the original rendering.

MATH_FONT_RE = re.compile(
    r"math|cmmi|cmsy|cmex|cmbsy|cmmib|msam|msbm|symbol|stix|xits|asana|mt-?extra|euclid|rsfs|esint|"
    r"wasy|lmmath|latinmodern-math|mathjax|eusm|eufm|txsy|pxsy|txmi|pxmi|ntxmi|newtxmath",
    re.I,
)
_MONO_RE = re.compile(r"courier|consola|mono|menlo|lucidaconsole", re.I)
MATH_CHAR_RE = re.compile("[\U0001D400-\U0001D7FF\u2200-\u22FF\u2190-\u21FF\u27F0-\u27FF\u2A00-\u2AFF\u0391-\u03C9\u221A\u2202\u2207]")
_BRIDGE_RE = re.compile(r"^[\s=+\-−±×·∙/()\[\]{}|,.:;<>^_'′″0-9]*$")
PH_RE = re.compile(r"\{\{m\d+\}\}")


def restore_placeholders(translation: str, runs: list[dict]) -> str | None:
    """Turn the formula text an old translation copied verbatim back into {{mN}}.

    Translations made before formula placeholders existed contain the (often
    garbled) extracted math text, e.g. "𝑇𝑠𝑠𝑠𝑠". The model copies it as-is, so
    it can be located again and replaced — no re-translation needed.
    Returns None when nothing could be mapped.
    """
    text = _MATH_DUP.sub(r"\1", translation)
    # index map over the translation without whitespace (models drop/insert spaces in math)
    keep = [i for i, ch in enumerate(text) if not ch.isspace()]
    compact = "".join(text[i] for i in keep)
    out, last, pos, hit = [], 0, 0, 0
    for run in runs:
        needle = "".join(_MATH_DUP.sub(r"\1", run.get("text") or "").split())
        if not needle:
            continue
        j = compact.find(needle, pos)
        if j < 0:
            continue
        start, end = keep[j], keep[j + len(needle) - 1] + 1
        out.append(text[last:start])
        out.append("{{" + run["id"] + "}}")
        last, pos, hit = end, j + len(needle), hit + 1
    if not hit:
        return None
    out.append(text[last:])
    return "".join(out)


# Word bullets set in Symbol / Wingdings come out as private-use code points
_PUA_BULLETS = {
    "\uf0b7": "•", "\uf0a7": "▪", "\uf0a8": "□", "\uf06c": "●", "\uf06e": "■", "\uf071": "❑",
    "\uf076": "❖", "\uf0d8": "➢", "\uf0e0": "➢", "\uf0fc": "✓", "\uf0fe": "☑", "\uf02d": "–",
}
_SYMBOL_FONT = re.compile(r"symbol|wingding|webding", re.I)


def _fix_bullets(text: str, font: str) -> str:
    if text and _SYMBOL_FONT.search(font or "") and any(ch in _PUA_BULLETS for ch in text):
        return "".join(_PUA_BULLETS.get(ch, ch) for ch in text)
    return text


_PAIRS = {"[": "]", "(": ")", "{": "}"}
_CLOSERS = {v: k for k, v in _PAIRS.items()}


def _unbalanced(text: str) -> tuple[str | None, str | None]:
    """(closer still needed, opener still needed) for a formula's text."""
    need_close = need_open = None
    for o, c in _PAIRS.items():
        n = text.count(o) - text.count(c)
        if n > 0:
            need_close = c
        elif n < 0:
            need_open = o
    if text.count("|") % 2 == 1:
        need_close = need_close or "|"
    return need_close, need_open


def _split_span(sp: dict, n: int) -> tuple[dict, dict]:
    """Split a span after n characters; widths estimated from Helvetica metrics."""
    t = sp.get("text") or ""
    size = sp.get("size") or 10
    x0, y0, x1, y1 = sp["bbox"]
    try:
        whole = fitz.get_text_length(t, fontname="helv", fontsize=size) or 1.0
        part = fitz.get_text_length(t[:n], fontname="helv", fontsize=size)
    except Exception:
        whole, part = float(len(t) or 1), float(n)
    xm = x0 + (x1 - x0) * part / whole
    a = {**sp, "text": t[:n], "bbox": [x0, y0, round(xm, 2), y1]}
    b = {**sp, "text": t[n:], "bbox": [round(xm, 2), y0, x1, y1],
         "origin": [round(xm, 2), (sp.get("origin") or [x0, y1])[1]]}
    return a, b


def _absorb_brackets(spans: list[dict]) -> list[dict]:
    """Pull a bracket that closes (or opens) a formula into the formula's span.

    Word often sets "[1 1 0 1" in Cambria Math but the closing "]" in the body
    font; the formula crop would then stop just before the bracket and the
    translation loses it.
    """
    out = list(spans)
    i = 0
    while i < len(out):
        sp = out[i]
        if not MATH_FONT_RE.search(sp.get("font") or ""):
            i += 1
            continue
        # contiguous math-font spans form the formula text
        j = i
        text = ""
        while j < len(out) and MATH_FONT_RE.search(out[j].get("font") or ""):
            text += out[j].get("text") or ""
            j += 1
        need_close, need_open = _unbalanced(text.strip())
        if need_close and j < len(out):
            nxt = out[j]
            t = nxt.get("text") or ""
            if t[:1] == need_close and not MATH_FONT_RE.search(nxt.get("font") or ""):
                a, b = _split_span(nxt, 1)
                a["force_m"] = True
                out[j:j + 1] = [a, b] if b["text"] else [a]
                j += 1
        if need_open and i > 0:
            prv = out[i - 1]
            t = prv.get("text") or ""
            if t[-1:] == need_open and not MATH_FONT_RE.search(prv.get("font") or ""):
                a, b = _split_span(prv, len(t) - 1)
                b["force_m"] = True
                out[i - 1:i] = [a, b] if a["text"] else [b]
                j += 1
        i = j
    return out


def _is_math_span(sp: dict) -> bool:
    if sp.get("force_m"):
        return True
    t = (sp.get("text") or "").strip()
    if not t or t in "•·▪‣●○◦■□◆◇–—-*":  # list bullets often come from Symbol fonts
        return False
    if MATH_FONT_RE.search(sp.get("font") or ""):
        return True
    n_math = len(MATH_CHAR_RE.findall(t))
    return n_math > 0 and n_math >= 0.5 * len(t.replace(" ", ""))


def _merge_math_rows(raw_blocks: list[dict]) -> list[dict]:
    """Rejoin one visual line that the PDF split into several blocks around math.

    Word equations (stacked fractions, piecewise "cases", limits) are often written
    as separate text blocks: "the gain is G(s) =" | "K" | "s + p" | "for s > 0".
    As separate blocks the translation of each part is placed on its own and the
    pieces overlap or leave gaps. Short (one-row) blocks that sit on the same row,
    touch each other and include math become one block with one line, spans in
    reading order (left to right).
    """
    def info(rb):
        spans = [sp for ln in rb["lines"] for sp in ln["spans"] if (sp.get("text") or "").strip()]
        size = max((sp["size"] for sp in spans), default=0)
        return spans, size

    cand: list[int] = []
    for i, rb in enumerate(raw_blocks):
        spans, size = info(rb)
        if not spans or size <= 0:
            continue
        x0, y0, x1, y1 = rb["bbox"]
        if y1 - y0 > 3.2 * size and not all(_is_math_span(sp) for sp in spans):
            continue  # a paragraph, not a row fragment (a tall all-math block — the rows
            # of a "cases" brace, a matrix — still joins the "f(t) = {" beside it)
        if any(_MONO_RE.search(sp.get("font") or "") for sp in spans):
            continue  # code listings keep their own lines
        cand.append(i)
    if len(cand) < 2:
        return raw_blocks

    sizes = sorted(sp["size"] for rb in raw_blocks for sp in info(rb)[0])
    body = sizes[len(sizes) // 2] if sizes else 0.0

    def script_math(i):
        """All math, set smaller than the body text: a numerator, denominator or limit."""
        spans, size = info(raw_blocks[i])
        return size <= 0.85 * body and all(_is_math_span(sp) for sp in spans)

    parent = {i: i for i in cand}

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for n, a in enumerate(cand):
        ba = raw_blocks[a]["bbox"]
        sa = info(raw_blocks[a])[1]
        for b in cand[n + 1:]:
            bb = raw_blocks[b]["bbox"]
            sb = info(raw_blocks[b])[1]
            short, tall = (ba, bb) if ba[3] - ba[1] <= bb[3] - bb[1] else (bb, ba)
            cy = (short[1] + short[3]) / 2
            tol = 0.15 * max(sa, sb)
            gap = max(bb[0] - ba[2], ba[0] - bb[2])
            if tall[1] - tol <= cy <= tall[3] + tol:
                if gap <= 3.0 * max(sa, sb):
                    parent[find(b)] = find(a)
                continue
            # stacked: a fraction's numerator over its denominator
            x_overlap = min(ba[2], bb[2]) - max(ba[0], bb[0])
            v_gap = max(ba[1], bb[1]) - min(ba[3], bb[3])
            narrow = min(ba[2] - ba[0], bb[2] - bb[0])
            if (x_overlap >= 0.5 * narrow and v_gap <= 0.35 * max(sa, sb)
                    and script_math(a) and script_math(b)):
                parent[find(b)] = find(a)

    groups: dict[int, list[int]] = {}
    for i in cand:
        groups.setdefault(find(i), []).append(i)
    merged: dict[int, dict] = {}
    drop: set[int] = set()
    for members in groups.values():
        if len(members) < 2:
            continue
        spans = [sp for i in members for sp in info(raw_blocks[i])[0]]
        if not any(_is_math_span(sp) for sp in spans):
            continue
        spans.sort(key=lambda sp: (round(sp["bbox"][0], 1), sp["bbox"][1]))
        out: list[dict] = []
        for sp in spans:
            sp = dict(sp)
            if out:
                prev = out[-1]
                t0, t1 = prev.get("text") or "", sp.get("text") or ""
                gap = sp["bbox"][0] - prev["bbox"][2]
                if gap > 0.2 * max(sp["size"], prev["size"]) and not t0.endswith(" ") and not t1.startswith(" "):
                    prev["text"] = t0 + " "
            out.append(sp)
        box = _union([raw_blocks[i]["bbox"] for i in members])
        first = min(members)
        merged[first] = {"type": 0, "bbox": box, "lines": [{"bbox": box, "spans": out}]}
        # the row's text baseline: formulas in it are aligned to it, not to their own
        # lowest line ("0  t<0" of a cases formula)
        bases = sorted(sp["origin"][1] for sp in out
                       if (sp.get("text") or "").strip() and not _is_math_span(sp))
        if bases:
            merged[first]["baseline"] = bases[len(bases) // 2]
        drop.update(m for m in members if m != first)
    if not merged:
        return raw_blocks
    return [merged.get(i, rb) for i, rb in enumerate(raw_blocks) if i not in drop]


def _assign_math_runs(raw_blocks: list[dict], counter: list[int]) -> list[dict]:
    """Mark math spans (sp["m"] = run id) and return run descriptors for the page."""
    runs: list[dict] = []
    for blk in raw_blocks:
        flat: list[tuple[int, int, dict]] = []  # (line_idx, span_idx, span)
        for li, ln in enumerate(blk["lines"]):
            for si, sp in enumerate(ln["spans"]):
                flat.append((li, si, sp))
        if not flat:
            continue
        line_size = []
        for ln in blk["lines"]:
            sizes = [sp["size"] for sp in ln["spans"] if (sp.get("text") or "").strip()]
            line_size.append(max(sizes) if sizes else 0)
        is_m = [_is_math_span(sp) for _, _, sp in flat]
        if not any(is_m):
            continue
        # bridge operators/spaces/sub-scripts between or next to math spans on the same line
        for k, (li, si, sp) in enumerate(flat):
            if is_m[k]:
                continue
            prev_m = k > 0 and is_m[k - 1] and flat[k - 1][0] == li
            next_m = k + 1 < len(flat) and is_m[k + 1] and flat[k + 1][0] == li
            t = sp.get("text") or ""
            small = sp["size"] < 0.82 * (line_size[li] or sp["size"])
            if (prev_m and next_m and _BRIDGE_RE.match(t) and len(t.strip()) <= 4) or (
                (prev_m or next_m) and small and len(t.strip()) <= 6
            ):
                is_m[k] = True
        # union-find by geometry (sub/superscripts can sit on separate "lines")
        idx = [k for k in range(len(flat)) if is_m[k] and (flat[k][2].get("text") or "").strip()]
        parent = {k: k for k in idx}

        def find(a):
            while parent[a] != a:
                parent[a] = parent[parent[a]]
                a = parent[a]
            return a

        for i, a in enumerate(idx):
            ba, sa = flat[a][2]["bbox"], flat[a][2]["size"]
            for b in idx[i + 1:]:
                bb, sb = flat[b][2]["bbox"], flat[b][2]["size"]
                tol = 0.55 * max(sa, sb)
                h_gap = max(bb[0] - ba[2], ba[0] - bb[2])
                v_ok = min(ba[3], bb[3]) - max(ba[1], bb[1]) > -0.3 * max(sa, sb)
                if not v_ok and h_gap < 0 and len(blk["lines"]) == 1:
                    # one visual line: pieces stacked above each other are a fraction or limits
                    v_ok = True
                if h_gap <= tol and v_ok:
                    parent[find(b)] = find(a)
        groups: dict[int, list[int]] = {}
        for k in idx:
            groups.setdefault(find(k), []).append(k)
        # spaces between members of a run belong to it too
        for k in range(len(flat)):
            if is_m[k] and k not in parent:
                for nb in (k - 1, k + 1):
                    if nb in parent and flat[nb][0] == flat[k][0]:
                        groups[find(nb)].append(k)
                        break
        for members in sorted(groups.values(), key=lambda g: min(g)):
            counter[0] += 1
            rid = f"m{counter[0]}"
            boxes, size, base = [], 0.0, None
            text = ""
            for k in sorted(members):
                sp = flat[k][2]
                sp["m"] = rid
                text += sp.get("text") or ""
                if (sp.get("text") or "").strip():
                    boxes.append(sp["bbox"])
                    if sp["size"] >= size:
                        size, base = sp["size"], sp["origin"][1]
            if not boxes:
                continue
            x0, y0, x1, y1 = _union(boxes)
            row_base = blk.get("baseline")
            if row_base is not None and y0 < row_base < y1:
                base = row_base
            pad = 0.12 * size
            runs.append({
                "id": rid,
                "bbox": [round(x0 - 0.5, 2), round(y0 - pad, 2), round(x1 + 0.5, 2), round(y1 + pad, 2)],
                "baseline": round(base if base is not None else y1, 2),
                "size": size,
                "text": text.strip(),
            })
    return runs


def _span_box(sp: dict) -> list[float]:
    """Span bbox with sane vertical extent.

    Some fonts (Cambria Math, symbol fonts) report ascender/descender boxes
    several lines tall, which inflates block boxes and makes overlays overlap.
    Rebuild the vertical extent from the baseline when it is implausible.
    """
    b = list(sp.get("bbox") or (0, 0, 0, 0))
    size = float(sp.get("size") or 0)
    if size > 0 and (b[3] - b[1]) > 1.6 * size:
        oy = float((sp.get("origin") or (0, b[3]))[1])
        b[1], b[3] = oy - 0.85 * size, oy + 0.25 * size
    return b


def _union(boxes: list[list[float]]) -> list[float]:
    return [min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)]


def _to_png(data: bytes) -> bytes | None:
    """Normalise any embedded image (jpx/jbig2/CMYK/alpha…) to browser-safe PNG."""
    try:
        pix = fitz.Pixmap(data)
        if pix.colorspace and pix.colorspace.n not in (1, 3):
            pix = fitz.Pixmap(fitz.csRGB, pix)
        return pix.tobytes("png")
    except Exception:
        return None


def _has_ruling(page: fitz.Page) -> bool:
    """Does the page draw any lines / rectangles? find_tables() (lines strategy)
    only finds tables made of vector rulings, and indexing every character of a
    text-only page for it is the slowest step of extraction."""
    try:
        for d in page.get_cdrawings():
            for it in d.get("items", ()):
                if it and it[0] in ("l", "re", "qu"):
                    return True
            if d.get("rect") and d.get("fill") is not None:
                return True  # filled boxes (shaded table cells) count too
        return False
    except Exception:
        return True


def _has_columns(raw_blocks: list[dict]) -> bool:
    """≥3 visual rows split into separate text pieces by wide gaps (tab-aligned
    columns of a table without rulings)."""
    rows: dict[int, list[tuple[float, float, float]]] = {}
    for blk in raw_blocks:
        for ln in blk.get("lines", []):
            if not any((sp.get("text") or "").strip() for sp in ln.get("spans", [])):
                continue
            b = ln["bbox"]
            size = max((sp.get("size", 0) for sp in ln.get("spans", [])), default=10) or 10
            rows.setdefault(round((b[1] + b[3]) / 2 / 3), []).append((b[0], b[2], size))
    split = 0
    for segs in rows.values():
        segs.sort()
        if any(segs[i + 1][0] - segs[i][1] >= 2 * segs[i][2] for i in range(len(segs) - 1)):
            split += 1
            if split >= 3:
                return True
    return False


def _cell_style(spans: list[tuple], bbox: list[float]) -> dict:
    """Dominant text color / boldness / size of spans whose center lies in the cell,
    plus where the text sits in it (inset + horizontal alignment) so translated
    cells can be laid out like the source."""
    x0, y0, x1, y1 = bbox
    colors: dict[int, int] = {}
    sizes: dict[float, int] = {}
    bold_chars = total = 0
    tb = [1e9, 1e9, -1e9, -1e9]
    for sx0, sy0, sx1, sy1, color, is_bold, n, size in spans:
        cx, cy = (sx0 + sx1) / 2, (sy0 + sy1) / 2
        if x0 - 1 <= cx <= x1 + 1 and y0 - 1 <= cy <= y1 + 1:
            colors[color] = colors.get(color, 0) + n
            sizes[size] = sizes.get(size, 0) + n
            total += n
            bold_chars += n if is_bold else 0
            tb = [min(tb[0], sx0), min(tb[1], sy0), max(tb[2], sx1), max(tb[3], sy1)]
    if not total:
        return {}
    out = {"color": max(colors, key=colors.get), "bold": bold_chars * 2 > total,
           "size": max(sizes, key=sizes.get)}
    # tall math glyph boxes may poke out of the cell — clamp instead of giving up
    lg, rg, tg = tb[0] - x0, max(x1 - tb[2], 0.0), max(tb[1] - y0, 0.0)
    w = x1 - x0
    if lg >= -1:
        lg = max(lg, 0.0)
        out["inset"] = [round(lg, 1), round(tg, 1), round(rg, 1)]
        tw = tb[2] - tb[0]
        if lg > 6 and tw < 0.85 * w and abs(lg - rg) <= max(3.0, 0.06 * w):
            out["align"] = "center"
        elif rg < 0.4 * lg and lg > 0.3 * w and tw < 0.6 * w:
            out["align"] = "right"
    return out


def extract_page(page: fitz.Page, img_dir: Path | None = None) -> dict:
    """Return raw extraction payload for one page.

    {
      "width": pt, "height": pt,
      "raw_blocks": [ {type, bbox, lines:[{bbox, text, spans:[{text,font,size,flags,color,origin}]}]} ],
      "images": [ {bbox, file, width, height} ],
      "tables": [ {bbox, n_rows, n_cols, cells:[{row,col,bbox,text}]} ],
    }
    """
    raw = page.get_text("dict")
    dedupe_spans = _page_has_dup_glyphs(page)
    width, height = page.rect.width, page.rect.height

    raw_blocks: list[dict] = []
    images: list[dict] = []
    img_idx = 0
    for blk in raw.get("blocks", []):
        if blk.get("type") == 0:
            lines = []
            for ln in blk.get("lines", []):
                spans = []
                for sp in ln.get("spans", []):
                    spans.append(
                        {
                            "text": _fix_bullets(_fix_text(sp.get("text", ""), dedupe_spans), sp.get("font", "")),
                            "font": sp.get("font", ""),
                            "size": round(sp.get("size", 0), 2),
                            "flags": sp.get("flags", 0),
                            "color": sp.get("color", 0),
                            "origin": list(sp.get("origin", (0, 0))),
                            "bbox": [round(v, 2) for v in _span_box(sp)],
                        }
                    )
                spans = _absorb_brackets(spans)
                boxes = [_span_box(sp) for sp in ln.get("spans", []) if (sp.get("text") or "").strip()]
                lines.append({"bbox": _union(boxes) if boxes else list(ln["bbox"]), "spans": spans})
            line_boxes = [ln["bbox"] for ln in lines if ln["spans"]]
            raw_blocks.append({"type": 0, "bbox": _union(line_boxes) if line_boxes else list(blk["bbox"]), "lines": lines})
        elif blk.get("type") == 1:
            data = blk.get("image") or b""
            entry = {"bbox": list(blk["bbox"]), "width": blk.get("width"), "height": blk.get("height")}
            is_web = data[:8] == b"\x89PNG\r\n\x1a\n" or data[:2] == b"\xff\xd8"
            if data and (not is_web or (blk.get("ext") == "jpeg" and blk.get("colorspace") == 4)):
                data = _to_png(data) or data  # jpx/jbig2/CMYK/masked → PNG the browser can show
            if data and img_dir is not None:
                img_dir.mkdir(parents=True, exist_ok=True)
                ext = _sniff_ext(data)
                fname = f"img_{page.number + 1:04d}_{img_idx:02d}.{ext}"
                (img_dir / fname).write_bytes(data)
                entry["file"] = fname
                img_idx += 1
            elif data:
                entry["b64"] = base64.b64encode(data).decode("ascii")
            images.append(entry)

    # span geometry + color for per-cell styling (e.g. white header text on a dark fill)
    span_info: list[tuple] = []
    for blk in raw.get("blocks", []):
        for ln in blk.get("lines", []) if blk.get("type") == 0 else []:
            for sp in ln.get("spans", []):
                txt = (sp.get("text") or "").strip()
                if not txt:
                    continue
                b = _span_box(sp) if sp.get("bbox") else ln["bbox"]
                bold = bool(sp.get("flags", 0) & 16) or "bold" in (sp.get("font") or "").lower()
                span_info.append((b[0], b[1], b[2], b[3], int(sp.get("color", 0)), bold, len(txt),
                                  round(sp.get("size", 0) or 0, 1)))

    raw_blocks = _merge_math_rows(raw_blocks)
    math_runs = _assign_math_runs(raw_blocks, [0])
    math_spans = [
        (sp["bbox"], len((sp.get("text") or "").replace(" ", "")), bool(sp.get("m")))
        for blk in raw_blocks for ln in blk["lines"] for sp in ln["spans"] if (sp.get("text") or "").strip()
    ]

    tables: list[dict] = []
    try:
        dedupe = dedupe_spans
        try:  # glyph-accurate boxes: math fonts report huge ascenders otherwise
            words = page.get_text("words", flags=fitz.TEXTFLAGS_WORDS | fitz.TEXT_ACCURATE_BBOXES)
        except Exception:
            words = page.get_text("words")  # (x0,y0,x1,y1,word,block,line,word_no)
        words = [(w[0], w[1], w[2], w[3], _fix_text(w[4], dedupe)) for w in words]
        # find_tables() is by far the slowest step (it indexes every character and,
        # with pymupdf_layout installed, runs an ONNX model) — only call it on
        # pages that can contain a table at all
        finder = page.find_tables() if (_has_ruling(page) or _has_columns(raw_blocks)) else None
        rules = _page_rules(page) if finder and finder.tables else ([], [])
        for tbl in (finder.tables if finder else []):
            try:
                n_rows, n_cols, cells = _normalize_table(tbl, words)
                n_rows, cells = _merge_wrapped_rows(cells, n_rows, rules, words)
            except Exception:
                n_rows, n_cols, cells = 0, 0, []
            if not cells:
                continue
            for cell in cells:
                cell["text"] = _words_in_bbox(words, cell["bbox"])
                cell.update(_cell_style(span_info, cell["bbox"]))
                # math cell → shown as a crop of the original rendering
                x0, y0, x1, y1 = cell["bbox"]
                tot = mth = 0
                for sb, n, is_m in math_spans:
                    cx, cy = (sb[0] + sb[2]) / 2, (sb[1] + sb[3]) / 2
                    if x0 - 1 <= cx <= x1 + 1 and y0 - 1 <= cy <= y1 + 1:
                        tot += n
                        mth += n if is_m else 0
                if tot and mth >= 0.5 * tot:
                    cell["math"] = True
                elif mth:
                    # text + formula in one cell: protect the formula with a placeholder
                    inside = [
                        m for m in math_runs
                        if x0 - 1 <= (m["bbox"][0] + m["bbox"][2]) / 2 <= x1 + 1
                        and y0 - 1 <= (m["bbox"][1] + m["bbox"][3]) / 2 <= y1 + 1
                    ]
                    inside.sort(key=lambda m: (round(m["baseline"]), m["bbox"][0]))
                    for m in inside:  # keep the crop off the cell borders
                        mb = m["bbox"]
                        m["bbox"] = [max(mb[0], x0 + 0.8), max(mb[1], y0 + 0.8), min(mb[2], x1 - 0.8), min(mb[3], y1 - 0.8)]
                    ph = restore_placeholders(cell["text"], inside) if inside else None
                    if ph:
                        cell["ph"] = ph
                        cell["math_ids"] = [m["id"] for m in inside if "{{" + m["id"] + "}}" in ph]
            if not any(c["text"] for c in cells):
                continue
            tables.append(
                {
                    # merged rows can reach past what find_tables saw (the last wrapped line)
                    "bbox": [min(tbl.bbox[0], min(c["bbox"][0] for c in cells)),
                             min(tbl.bbox[1], min(c["bbox"][1] for c in cells)),
                             max(tbl.bbox[2], max(c["bbox"][2] for c in cells)),
                             max(tbl.bbox[3], max(c["bbox"][3] for c in cells))],
                    "n_rows": n_rows,
                    "n_cols": n_cols,
                    "cells": cells,
                }
            )
    except Exception:
        pass

    return {
        "ver": EXTRACT_VER,
        "width": width,
        "height": height,
        "raw_blocks": raw_blocks,
        "images": images,
        "tables": tables,
        "math_runs": math_runs,
    }
