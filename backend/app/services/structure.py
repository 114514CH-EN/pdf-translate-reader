"""Turn raw page extraction into typed translation blocks with layout metadata."""
from __future__ import annotations

import hashlib
import re
import statistics

BOLD_BIT = 16
ITALIC_BIT = 2

_BULLETS = "•·▪‣●○◦◆◇■□➢➤✓✔❖–—-"
_LIST_RE = re.compile(
    r"^\s*(?P<marker>(?:[" + _BULLETS + r"])|(?:\d{1,3}[.)])|(?:[a-zA-Z][.)])|(?:[ivxIVX]{1,5}[.)]))\s+"
)
# Word's second-level bullet is a Courier New "o"; it only counts as a marker
# when it is a span of its own in a monospace / symbol font (never the word "o")
_O_BULLET_FONT = re.compile(r"courier|symbol|wingding|mono", re.I)
_MONO_FONT = re.compile(
    r"mono|courier|consolas|menlo|monaco|inconsolata|lucida ?console|lucidasanstypewriter|sourcecode|"
    r"source ?code|fira ?code|jetbrains|cascadia|cmtt|lmmono|sfmono|andale|typewriter|nimbusmon|"
    r"letter ?gothic|ocr-?[ab]|prestige|fixedsys",
    re.I,
)


def _o_bullet(spans: list[dict]) -> bool:
    """First visible span is a lone "o" in Courier/Symbol, followed by more text."""
    seen = [sp for sp in spans if (sp.get("text") or "").strip()]
    return (
        len(seen) >= 2
        and seen[0]["text"].strip() == "o"
        and bool(_O_BULLET_FONT.search(seen[0].get("font") or ""))
    )


def _line_marker(text: str, spans: list[dict]) -> str | None:
    m = _LIST_RE.match(text)
    if m:
        return m.group("marker")
    if _o_bullet(spans):
        return "o"
    return None


def _norm_text(t: str) -> str:
    return re.sub(r"\s+", " ", t).strip()


def stable_key(page_no: int, order_idx: int, text: str) -> str:
    raw = f"{page_no}|{order_idx}|{_norm_text(text).lower()}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:12]


def _span_style(spans: list[dict]) -> dict:
    """Char-weighted dominant style of a line/block."""
    sizes: dict[float, int] = {}
    fonts: dict[str, int] = {}
    bold_chars = italic_chars = total = 0
    color = 0
    for sp in spans:
        t = sp.get("text", "")
        n = len(t)
        if n == 0:
            continue
        total += n
        size = sp.get("size", 0)
        sizes[size] = sizes.get(size, 0) + n
        font = sp.get("font", "")
        fonts[font] = fonts.get(font, 0) + n
        flags = sp.get("flags", 0)
        if flags & BOLD_BIT or "bold" in font.lower():
            bold_chars += n
        if flags & ITALIC_BIT or "italic" in font.lower() or "oblique" in font.lower():
            italic_chars += n
        if color == 0:
            color = sp.get("color", 0)
    if total == 0:
        return {"size": 0, "font": "", "bold": False, "italic": False, "color": 0}
    dom_size = max(sizes, key=lambda k: sizes[k]) if sizes else 0
    dom_font = max(fonts, key=lambda k: fonts[k]) if fonts else ""
    return {
        "size": round(dom_size, 2),
        "font": dom_font,
        "bold": bold_chars / total > 0.5,
        "italic": italic_chars / total > 0.5,
        "color": color,
    }


def _line_texts(raw_block: dict) -> tuple[list[str], list[list[dict]], list[list[float]]]:
    texts, span_lists, bboxes = [], [], []
    for ln in raw_block.get("lines", []):
        spans = ln.get("spans", [])
        line = "".join(sp.get("text", "") for sp in spans).strip()
        if line:
            texts.append(line)
            span_lists.append(spans)
            bboxes.append(list(ln["bbox"]))
    return texts, span_lists, bboxes


def _alignment(raw_block: dict) -> str:
    xs0, xs1, xcs = [], [], []
    for ln in raw_block.get("lines", []):
        x0, _, x1, _ = ln["bbox"]
        xs0.append(x0)
        xs1.append(x1)
        xcs.append((x0 + x1) / 2)
    if len(xs0) < 2:
        return "left"

    def spread(v: list[float]) -> float:
        return max(v) - min(v) if v else 0.0

    if spread(xs0) < 3:
        return "left"
    if spread(xs1) < 3:
        return "right"
    if spread(xcs) < 3 and spread(xs0) >= 3:
        return "center"
    return "left"


def _merge_paragraphs(items: list[dict]) -> list[dict]:
    """Merge vertically adjacent same-style text blocks (gap < 1.5x line height)."""
    if not items:
        return []
    out: list[dict] = []
    cur = items[0]
    for nxt in items[1:]:
        same_col = abs(cur["bbox"][0] - nxt["bbox"][0]) < 4
        gap = nxt["bbox"][1] - cur["bbox"][3]
        lh = max(cur.get("line_height", 12), 1.0)
        same_style = (
            cur["type"] == nxt["type"] == "paragraph"
            and abs(cur["style"]["size"] - nxt["style"]["size"]) < 0.5
            and cur["style"]["bold"] == nxt["style"]["bold"]
        )
        if same_col and same_style and -0.4 * lh <= gap < 1.5 * lh:
            if cur.get("ph") or nxt.get("ph"):
                cur["ph"] = (cur.get("ph") or cur["text"]).rstrip() + "\n" + (nxt.get("ph") or nxt["text"]).lstrip()
                cur["math"] = (cur.get("math") or []) + (nxt.get("math") or [])
            cur["text"] = cur["text"].rstrip() + "\n" + nxt["text"].lstrip()
            cur["bbox"] = [
                min(cur["bbox"][0], nxt["bbox"][0]),
                min(cur["bbox"][1], nxt["bbox"][1]),
                max(cur["bbox"][2], nxt["bbox"][2]),
                max(cur["bbox"][3], nxt["bbox"][3]),
            ]
            cur["line_height"] = max(cur.get("line_height", lh), nxt.get("line_height", lh))
            cur["geo"] = (cur.get("geo") or []) + (nxt.get("geo") or [])
            continue
        out.append(cur)
        cur = nxt
    out.append(cur)
    return out


def _bbox_in(inner: list[float], outer: list[float], tol: float = 1.0) -> bool:
    return (
        inner[0] >= outer[0] - tol
        and inner[1] >= outer[1] - tol
        and inner[2] <= outer[2] + tol
        and inner[3] <= outer[3] + tol
    )


def _center_in(inner: list[float], outer: list[float], tol: float = 1.0) -> bool:
    cx, cy = (inner[0] + inner[2]) / 2, (inner[1] + inner[3]) / 2
    return outer[0] - tol <= cx <= outer[2] + tol and outer[1] - tol <= cy <= outer[3] + tol


def _reading_order(items: list[dict], page_width: float) -> list[dict]:
    """Order blocks: full-width blocks split the page into bands;
    inside a band, columns L→R then y; the full-width block closes its band."""
    if not items:
        return []
    by_id = {id(b): b for b in items}
    full_w = [
        b
        for b in items
        if (b["bbox"][2] - b["bbox"][0]) > 0.6 * page_width and b["type"] != "table"
    ]
    full_w.sort(key=lambda b: b["bbox"][1])
    full_ids = {id(b) for b in full_w}
    rest = [b for b in items if id(b) not in full_ids]

    # band edges: y-ranges between consecutive full-width blocks
    edges = [0.0] + [b["bbox"][3] for b in full_w]
    ordered: list[dict] = []
    for i, y0 in enumerate(edges):
        y1 = full_w[i]["bbox"][1] if i < len(full_w) else float("inf")
        band = [b for b in rest if y0 <= (b["bbox"][1] + b["bbox"][3]) / 2 < y1]
        ordered.extend(_order_band(band, page_width))
        if i < len(full_w):
            ordered.append(full_w[i])
    # anything left (shouldn't happen) keeps y order
    placed = {id(b) for b in ordered}
    leftover = [by_id[k] for k in by_id if k not in placed]
    if leftover:
        ordered.extend(sorted(leftover, key=lambda b: (b["bbox"][1], b["bbox"][0])))
    return ordered


def _order_band(band_blocks: list[dict], page_width: float) -> list[dict]:
    if not band_blocks:
        return []
    if len(band_blocks) == 1:
        return band_blocks
    # cluster x-centers into columns
    centers = sorted((((b["bbox"][0] + b["bbox"][2]) / 2, b) for b in band_blocks), key=lambda t: t[0])
    clusters: list[list[dict]] = [[centers[0][1]]]
    cluster_x: list[list[float]] = [[centers[0][1]["bbox"][0], centers[0][1]["bbox"][2]]]
    for _, b in centers[1:]:
        placed = False
        for i, xr in enumerate(cluster_x):
            cx = (b["bbox"][0] + b["bbox"][2]) / 2
            if xr[0] - 0.15 * page_width <= cx <= xr[1] + 0.15 * page_width:
                clusters[i].append(b)
                cluster_x[i][0] = min(cluster_x[i][0], b["bbox"][0])
                cluster_x[i][1] = max(cluster_x[i][1], b["bbox"][2])
                placed = True
                break
        if not placed:
            clusters.append([b])
            cluster_x.append([b["bbox"][0], b["bbox"][2]])
    clusters.sort(key=lambda c: min(x["bbox"][0] for x in c))
    out: list[dict] = []
    for col in clusters:
        out.extend(sorted(col, key=lambda b: (round(b["bbox"][1], 1), b["bbox"][0])))
    return out


def _bold_frac(spans: list[dict]) -> float:
    total = bold = 0
    for sp in spans:
        n = len(sp.get("text", "").strip())
        total += n
        if sp.get("flags", 0) & BOLD_BIT or "bold" in sp.get("font", "").lower():
            bold += n
    return bold / total if total else 0.0


_MARKER_ONLY = re.compile(r"^(?:[•·▪‣●○◦◆◇■□➢➤✓✔❖–—-]|o|\(?\d{1,3}(?:\.\d{1,3})*[.)]?|\(?[a-zA-Z][.)]|\([ivxIVX]{1,5}\)|[ivxIVX]{1,5}[.)])$")


def _hang_indent(spans: list[dict], x0: float) -> float | None:
    """Hanging indent of a numbered/bulleted first line ("1.1.⇥Plot …", "•⇥Code …").

    Returns the distance (pt) from the block's left edge to where the text after
    the marker starts, when the marker is followed by a clear tab gap.
    """
    acc = ""
    marker_end = None
    for i, sp in enumerate(spans):
        t = sp.get("text", "")
        if marker_end is None:
            acc += t
            st = acc.strip()
            if not st:
                continue
            if _MARKER_ONLY.match(st):
                marker_end = sp["bbox"][2]
                continue
            # marker and text in one span: "1.1. Plot" — no measurable tab
            return None
        if not t.strip():
            continue
        start = sp["bbox"][0]
        size = sp.get("size", 10) or 10
        if start - marker_end >= 0.6 * size:
            return round(start - x0, 1)
        return None
    return None


def _style_runs(
    lines: list[str], span_lists: list[list[dict]], bboxes: list[list[float]], phs: list[str] | None = None
) -> list[tuple[list, list, list, list]]:
    """Split a raw block's lines into runs of homogeneous style (size class + bold)."""
    phs = phs if phs is not None else list(lines)
    runs = []
    cur: tuple[list, list, list, list] = ([], [], [], [])
    cur_sig: tuple | None = None
    widest = max((b[2] - b[0] for b in bboxes), default=0.0)
    for text, spans, bbox, ph in zip(lines, span_lists, bboxes, phs):
        text_spans = [sp for sp in spans if not sp.get("m")] or spans  # math fonts don't set the style
        st = _span_style(text_spans)
        # only a (nearly) fully bold line starts a new run — inline bold phrases
        # inside a body line ("using **two triangular waves**. Plot …") do not
        sig = (round(st["size"] * 2) / 2, _bold_frac(text_spans) > 0.9)  # 0.5pt buckets
        if cur_sig is not None and sig != cur_sig and cur[0]:
            prev_text, prev_box = cur[0][-1], cur[2][-1]
            mid_sentence = not re.search(r"[.:;?!。：；？！)）]\s*$", prev_text)
            same_size = sig[0] == cur_sig[0]
            # a sentence running on across a bold change is one paragraph:
            #   "…will not be\n**marked.**"  (into bold)
            #   "**…a long bold sentence that wraps\nonto** a normal line" (out of a full-width bold line)
            if same_size and mid_sentence and (
                sig[1] or (prev_box[2] - prev_box[0]) >= 0.8 * widest
            ):
                cur_sig = sig
                cur[0].append(text)
                cur[1].append(spans)
                cur[2].append(bbox)
                cur[3].append(ph)
                continue
            runs.append(cur)
            cur = ([], [], [], [])
        cur_sig = sig
        cur[0].append(text)
        cur[1].append(spans)
        cur[2].append(bbox)
        cur[3].append(ph)
    if cur[0]:
        runs.append(cur)
    return runs


_PH_RE = re.compile(r"\{\{m\d+\}\}")


def _line_texts_ph(raw_block: dict, seen: set) -> tuple[list[str], list[list[dict]], list[list[float]], list[str]]:
    """Like _line_texts, plus the line text with math runs replaced by {{mN}} placeholders."""
    texts, span_lists, bboxes, phs = [], [], [], []
    for ln in raw_block.get("lines", []):
        spans = ln.get("spans", [])
        line = "".join(sp.get("text", "") for sp in spans).strip()
        if not line:
            continue
        ph = ""
        for sp in spans:
            rid = sp.get("m")
            if rid:
                if rid not in seen:
                    seen.add(rid)
                    ph += "{{" + rid + "}}"
            else:
                ph += sp.get("text", "")
        ph = re.sub(r"(\}\})(?=\{\{)", r"\1 ", ph).strip()
        bb = list(ln["bbox"])
        if bboxes and _same_row(bboxes[-1], bb):
            # Word tab stops ("4.1.⇥Demonstrate…", "Task 2 – …⇥[15 marks]") split one visual
            # line into several PDF lines on the same baseline — they are one line of text.
            texts[-1] = texts[-1] + "  " + line
            span_lists[-1] = span_lists[-1] + spans
            prev = bboxes[-1]
            bboxes[-1] = [min(prev[0], bb[0]), min(prev[1], bb[1]), max(prev[2], bb[2]), max(prev[3], bb[3])]
            phs[-1] = (phs[-1] + "  " + ph).strip()
            continue
        texts.append(line)
        span_lists.append(spans)
        bboxes.append(bb)
        phs.append(ph)
    return texts, span_lists, bboxes, phs


def _same_row(a: list[float], b: list[float]) -> bool:
    """b continues a on the same visual line (to its right, ≥60% vertical overlap)."""
    h = min(a[3] - a[1], b[3] - b[1])
    if h <= 0:
        return False
    overlap = min(a[3], b[3]) - max(a[1], b[1])
    return overlap >= 0.6 * h and b[0] >= a[2] - 1


def _same_row_any(a: list[float], b: list[float]) -> bool:
    """a and b share a visual line (≥60% vertical overlap), in either order."""
    h = min(a[3] - a[1], b[3] - b[1])
    return h > 0 and min(a[3], b[3]) - max(a[1], b[1]) >= 0.6 * h


def _split_tab_segments(raw_blocks: list[dict]) -> list[dict]:
    """Detach short right-hand tab-stop segments into blocks of their own.

    Word headings like "Task 3 – Complex Values …⇥[20 marks]" are one visual line
    whose right part sits at the right margin. Kept in one block, the translation
    wraps onto a second line inside a one-line box; as separate blocks each part
    keeps its own position (title left, "[20 分]" right).
    """
    out: list[dict] = []
    for rb in raw_blocks:
        lines = rb.get("lines", [])
        if len(lines) < 2 or rb.get("display"):  # a display formula is one picture
            out.append(rb)
            continue
        keep: list[dict] = []
        for ln in lines:
            text = "".join(sp.get("text", "") for sp in ln.get("spans", [])).strip()
            size = max((sp.get("size", 0) for sp in ln.get("spans", [])), default=0) or 10
            far = max(24.0, 2.0 * size)
            # a short segment far from a line on the same row: a right-hand tab stop, or a
            # label of its own (diagram boxes "Anti-alias" … "Sampler" come in any order)
            apart = text and len(text) <= 24 and any(
                _same_row_any(k["bbox"], ln["bbox"])
                and max(ln["bbox"][0] - k["bbox"][2], k["bbox"][0] - ln["bbox"][2]) >= far
                for k in keep
            )
            if apart:
                out.append({"type": 0, "bbox": list(ln["bbox"]), "lines": [ln]})
                continue
            keep.append(ln)
        if keep:
            bb = [min(l["bbox"][0] for l in keep), min(l["bbox"][1] for l in keep),
                  max(l["bbox"][2] for l in keep), max(l["bbox"][3] for l in keep)]
            out.append({**rb, "bbox": bb, "lines": keep})
    return out


def _is_formula_line(ph: str) -> bool:
    if "{{m" not in ph:
        return ph == ""  # continuation line of a run (sub/superscript on its own line)
    rest = _PH_RE.sub("", ph)
    return bool(re.fullmatch(r"[\s,.;:]*(\(\s*\d+(\.\d+)*\s*\))?[\s,.;:]*", rest))


def _is_mono(sp: dict) -> bool:
    return bool(_MONO_FONT.search(sp.get("font") or ""))


def _is_code_line(spans: list[dict]) -> bool:
    """A line (almost) entirely set in a monospace font — a code listing.

    A lone Courier "o" sub-bullet or an inline `identifier` in a sentence is not.
    """
    total = mono = 0
    for sp in spans:
        n = len((sp.get("text") or "").replace(" ", ""))
        total += n
        mono += n if _is_mono(sp) else 0
    return total >= 3 and mono >= 0.85 * total


_COMMENT_HEAD = re.compile(r"^(%+|//+|#+)\s?")


def comment_start(line: str) -> int | None:
    """Index where a line comment starts (MATLAB %, C/JS //, Python/shell #), or None.

    Quotes are skipped (MATLAB: ' after an identifier or bracket is a transpose,
    not a string). A "%" or "#" followed by an operand (``a % b``) is not a comment:
    a comment has to read like words.
    """
    quote = None
    prev = ""
    i = 0
    while i < len(line):
        ch = line[i]
        if quote:
            if ch == quote:
                quote = None
        elif ch == '"' or (ch == "'" and not (prev.isalnum() or prev in ")]}'_.")):
            quote = ch
        elif ch in "%#" or line.startswith("//", i):
            if ch == "#" and i == 0 and re.match(r"#\s*(include|define|if|ifdef|ifndef|endif|else|pragma|undef|!)", line):
                pass
            else:
                rest = _COMMENT_HEAD.sub("", line[i:])
                words = re.findall(r"[A-Za-z\u00C0-\uFFFF]{2,}", rest)
                if words and (i == 0 or line[i - 1].isspace() or ch != "#"):
                    if len(words) >= 2 or len(rest.strip()) == len(words[0]):
                        return i
        if not ch.isspace():
            prev = ch
        i += 1
    return None


def _code_item(span_lists: list[list[dict]], bboxes: list[list[float]], style: dict) -> dict:
    """A code listing: lines keep their indentation; only comments get translated.

    meta.code.lines[i] = {y0, y1, x0, x1, cx?, ci?, cc?}: line box, where the comment
    starts (page x and character index) and its colour. The viewer shows the code
    part as a crop of the original page and lays the translated comment from cx.
    Fragments on the same row (code and comment drawn separately) form one line.
    """
    size = style.get("size") or 10
    widths = []
    for spans in span_lists:
        for sp in spans:
            t = sp.get("text") or ""
            if len(t) >= 4 and _is_mono(sp):
                widths.append((sp["bbox"][2] - sp["bbox"][0]) / len(t))
    cw = statistics.median(widths) if widths else size * 0.55

    # rows: fragments whose boxes overlap vertically are one line, left to right
    frags = sorted(zip(bboxes, span_lists), key=lambda f: (f[0][1], f[0][0]))
    rows: list[list[tuple[list[float], list[dict]]]] = []
    for bb, spans in frags:
        if rows:
            last = rows[-1][-1][0]
            h = min(last[3] - last[1], bb[3] - bb[1])
            if h > 0 and min(last[3], bb[3]) - max(last[1], bb[1]) >= 0.6 * h:
                rows[-1].append((bb, spans))
                continue
        rows.append([(bb, spans)])
    x_left = min(b[0] for b in bboxes)

    texts, lines = [], []
    for row in rows:
        row.sort(key=lambda f: f[0][0])
        spans = [sp for _, sps in row for sp in sps if sp.get("text")]
        # build the line from geometry: indentation and gaps become spaces
        text, starts = "", []
        cursor = x_left
        for sp in spans:
            t = sp.get("text") or ""
            gap = sp["bbox"][0] - cursor
            if gap > 0.5 * cw:
                text += " " * round(gap / cw)
            starts.append(len(text))
            text += t
            cursor = max(cursor, sp["bbox"][2])
        full = text.rstrip()
        bb = [min(f[0][0] for f in row), min(f[0][1] for f in row),
              max(f[0][2] for f in row), max(f[0][3] for f in row)]
        info: dict = {"y0": round(bb[1], 2), "y1": round(bb[3], 2), "x0": round(bb[0], 2), "x1": round(bb[2], 2)}
        ci = comment_start(full)
        if ci is not None:
            info["ci"] = ci
            cx = None
            for sp, st in zip(spans, starts):
                t = sp.get("text") or ""
                if st <= ci < st + len(t):
                    cx = sp["bbox"][0] + (ci - st) * cw
                    info["cc"] = sp.get("color", 0)
                    break
            info["cx"] = round(cx if cx is not None else x_left + ci * cw, 2)
        texts.append(full)
        lines.append(info)
    return {
        "type": "code",
        "text": "\n".join(texts),
        "bbox": [x_left, min(b[1] for b in bboxes), max(b[2] for b in bboxes), max(b[3] for b in bboxes)],
        "style": style,
        "line_height": size * 1.2,
        "list_marker": None,
        "code": {"lines": lines, "cw": round(cw, 3)},
        "_parts": (span_lists, bboxes),
    }


def _merge_code(items: list[dict]) -> list[dict]:
    """Join code fragments that belong to one listing.

    PyMuPDF may hand a listing over in pieces (the code column, the comment
    column, a short comment detached as a tab segment); fragments that touch
    or overlap vertically and sit side by side or one under the other are one
    listing.
    """
    code = [it for it in items if it["type"] == "code"]
    if len(code) < 2:
        return items

    def near(a: dict, b: dict) -> bool:
        x, y = a["bbox"], b["bbox"]
        size = a["style"].get("size") or 10
        if abs((b["style"].get("size") or 10) - size) >= 1:
            return False
        v_gap = max(y[1] - x[3], x[1] - y[3])
        h_gap = max(y[0] - x[2], x[0] - y[2])
        return v_gap < 1.0 * size and h_gap < 8 * size

    merged = True
    while merged:
        merged = False
        for a_i in range(len(code)):
            for b_i in range(a_i + 1, len(code)):
                a, b = code[a_i], code[b_i]
                if near(a, b):
                    sl, bl = a["_parts"]
                    sl2, bl2 = b["_parts"]
                    code[a_i] = _code_item(sl + sl2, bl + bl2, a["style"])
                    del code[b_i]
                    merged = True
                    break
            if merged:
                break
    # keep the listing where its first fragment was
    out, placed = [], False
    for it in items:
        if it["type"] != "code":
            out.append(it)
        elif not placed:
            out.extend(code)
            placed = True
    return out


def build_blocks(page_payload: dict, page_no: int) -> list[dict]:
    """Build typed blocks (heading/paragraph/list/table/image) with style + bbox metadata."""
    raw_blocks = page_payload.get("raw_blocks", [])
    tables = page_payload.get("tables", [])
    images = page_payload.get("images", [])
    page_width = page_payload.get("width", 612)

    table_zones = [t["bbox"] for t in tables]

    # --- text blocks outside tables, split into homogeneous style runs ---
    text_items: list[dict] = []
    all_sizes: list[float] = []
    runs_by_id = {r["id"]: r for r in page_payload.get("math_runs", [])}
    for rb in _split_tab_segments(raw_blocks):
        if any(_bbox_in(rb["bbox"], tz) for tz in table_zones):
            continue
        lines, span_lists, line_bboxes, ph_lines = _line_texts_ph(rb, set())
        if table_zones and lines:
            # drop lines that belong to a table (their raw block may poke out of
            # the table zone, e.g. tall math glyph boxes) — cells render them.
            keep = [
                i for i, lb in enumerate(line_bboxes)
                if not any(_center_in(lb, tz) for tz in table_zones)
            ]
            lines = [lines[i] for i in keep]
            span_lists = [span_lists[i] for i in keep]
            line_bboxes = [line_bboxes[i] for i in keep]
            ph_lines = [ph_lines[i] for i in keep]
        if not lines:
            continue
        # split display formulas (lines made only of math runs) and code (monospace
        # lines) from the text around them
        groups: list[tuple[str, list[int]]] = []
        for i, ph in enumerate(ph_lines):
            if _is_code_line(span_lists[i]):
                kind = "code"
            elif _is_formula_line(ph) and ("{{m" in ph or (groups and groups[-1][0] == "formula")):
                kind = "formula"
            else:
                kind = "text"
            if groups and groups[-1][0] == kind:
                groups[-1][1].append(i)
            else:
                groups.append((kind, [i]))
        segments = []
        for kind, ids in groups:
            seg = ([lines[i] for i in ids], [span_lists[i] for i in ids], [line_bboxes[i] for i in ids],
                   [ph_lines[i] for i in ids])
            if kind == "text":
                segments.extend(("text", r) for r in _style_runs(*seg))
            else:
                segments.append((kind, seg))
        for kind, (run_lines, run_spans, run_bboxes, run_phs) in segments:
            text = "\n".join(run_lines)
            ph_text = "\n".join(p for p in run_phs if p)
            flat = [sp for spans in run_spans for sp in spans]
            style = _span_style([sp for sp in flat if not sp.get("m")] or flat)
            run_ids = _PH_RE.findall(ph_text)
            math = [runs_by_id[r[2:-2]] for r in run_ids if r[2:-2] in runs_by_id]
            if kind == "code":
                text_items.append(_code_item(run_spans, run_bboxes, style))
                continue
            if kind == "formula":
                boxes = [m["bbox"] for m in math] + run_bboxes
                text_items.append(
                    {
                        "type": "formula",
                        "text": text,
                        "bbox": [min(b[0] for b in boxes), min(b[1] for b in boxes),
                                 max(b[2] for b in boxes), max(b[3] for b in boxes)],
                        "style": style,
                        "line_height": style["size"] * 1.2,
                        "list_marker": None,
                        "ph": ph_text,
                        "math": math,
                    }
                )
                continue
            bbox = [
                min(b[0] for b in run_bboxes),
                min(b[1] for b in run_bboxes),
                max(b[2] for b in run_bboxes),
                max(b[3] for b in run_bboxes),
            ]
            lh = (bbox[3] - bbox[1]) / max(len(run_lines), 1)
            all_sizes.extend([style["size"]] * len(text))
            marker = _line_marker(run_lines[0], run_spans[0])
            text_items.append(
                {
                    "type": "paragraph",
                    "text": text,
                    "bbox": bbox,
                    "style": style,
                    "line_height": round(max(lh, style["size"] * 1.15), 2),
                    "list_marker": marker,
                    "ph": ph_text if math else None,
                    "math": math,
                    "hang": _hang_indent(run_spans[0], bbox[0]),
                    "geo": [(t, list(bb), _line_marker(t, sp) is not None)
                            for t, bb, sp in zip(run_lines, run_bboxes, run_spans)],
                }
            )

    text_items = _merge_code(text_items)
    for it in text_items:
        it.pop("_parts", None)
    median_size = statistics.median(all_sizes) if all_sizes else 12.0

    # first pass: list vs text
    for it in text_items:
        if it["type"] in ("formula", "code"):
            it["level"] = 0
            continue
        if not _LETTER.search(_PH_RE.sub(" ", it.get("ph") or it["text"])) and it["text"].strip():
            # nothing to translate — an equation number "(1)", a "+" in a circuit, a page
            # number: shown as the original rendering, like a formula
            it["type"] = "formula"
            it["level"] = 0
            continue
        if it["list_marker"]:
            it["type"] = "list"
            it["level"] = 0
        else:
            it["type"] = "paragraph"
            it["level"] = 0

    # heading candidates: size clearly above body, or bold and slightly larger
    candidates = [
        it
        for it in text_items
        if it["type"] == "paragraph"
        and (
            it["style"]["size"] >= 1.15 * median_size
            or (it["style"]["bold"] and it["style"]["size"] >= 1.02 * median_size)
        )
    ]
    if candidates:
        sizes = sorted({c["style"]["size"] for c in candidates}, reverse=True)
        # rank sizes into up to 3 levels
        level_of_size = {}
        for i, s in enumerate(sizes[:3]):
            level_of_size[s] = i + 1
        for c in candidates:
            c["type"] = "heading"
            c["level"] = level_of_size.get(c["style"]["size"], 3)

    text_items = _merge_paragraphs(text_items)
    _formula_crops(text_items)
    # re-apply list level from indent after merge
    if text_items:
        base_x = min(b["bbox"][0] for b in text_items)
        for it in text_items:
            if it["type"] == "list":
                indent = it["bbox"][0] - base_x
                it["level"] = 0 if indent < 14 else 1 if indent < 30 else 2

    # --- assemble with tables + images ---
    items: list[dict] = list(text_items)
    for t in tables:
        md = _table_markdown(t)
        cell_math = [i for c in t["cells"] for i in c.get("math_ids", [])]
        items.append(
            {
                "type": "table",
                "text": md,
                "bbox": t["bbox"],
                "style": {"size": median_size, "font": "", "bold": False, "italic": False, "color": 0},
                "meta": {"cells": t["cells"], "n_rows": t["n_rows"], "n_cols": t["n_cols"]},
                "level": 0,
                "list_marker": None,
                "ph": _table_markdown(t, use_ph=True) if cell_math else None,
                "math": [runs_by_id[i] for i in cell_math if i in runs_by_id],
            }
        )
    for im in images:
        meta = {k: im[k] for k in ("file", "b64", "width", "height") if k in im}
        items.append(
            {
                "type": "image",
                "text": "",
                "bbox": im["bbox"],
                "style": {"size": 0, "font": "", "bold": False, "italic": False, "color": 0},
                "meta": meta,
                "level": 0,
                "list_marker": None,
            }
        )

    items = _reading_order(items, page_width)

    blocks = []
    for idx, it in enumerate(items):
        style = it["style"]
        blocks.append(
            {
                "page_no": page_no,
                "order_idx": idx,
                "type": it["type"],
                "level": it.get("level", 0),
                "text": it["text"],
                "bbox": [round(v, 2) for v in it["bbox"]],
                "style": style,
                "meta": _with_math(it),
                "font_size": style.get("size"),
                "bold": 1 if style.get("bold") else 0,
                "list_marker": it.get("list_marker"),
                "stable_key": stable_key(page_no, idx, it["text"]),
            }
        )
    return blocks


def _item_gaps(geo: list[tuple], size: float | None = None) -> list[float] | None:
    """Extra vertical space (pt) above each numbered/bulleted item of a block.

    "2.1. …\n…\n2.2. …" — Word puts paragraph spacing between items; the
    translation is laid out in flow, so without this the items run together.
    geo entries are (line text, line bbox[, starts an item]).
    """
    if len(geo) < 2:
        return None

    def is_start(g: tuple) -> bool:
        if len(g) > 2 and g[2]:
            return True
        t = g[0]
        return bool(_LIST_RE.match(t) or _MARKER_ONLY.match(t.split()[0] if t.split() else ""))

    starts = [i for i, g in enumerate(geo) if is_start(g)]
    if len(starts) < 2 or starts[0] != 0:
        return None
    line_gaps = [geo[i][1][1] - geo[i - 1][1][3] for i in range(1, len(geo)) if i not in starts]
    normal = statistics.median(line_gaps) if line_gaps else min(
        geo[i][1][1] - geo[i - 1][1][3] for i in starts[1:])
    gaps = [0.0] + [round(max(0.0, geo[i][1][1] - geo[i - 1][1][3] - normal), 1) for i in starts[1:]]
    return gaps if any(g > 1.0 for g in gaps) else None


_LETTER = re.compile(r"[A-Za-z\u00c0-\u024f\u0370-\u03ff\u0400-\u04ff\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]")


def _formula_crops(items: list[dict]) -> None:
    """Crop of a formula block, short of the text lines above and below it.

    A formula's box (tall glyph boxes, padding) can reach into the neighbouring line;
    its crop would then show the bottoms / tops of the English letters next to the
    translation. Trimmed per text *line* (a paragraph's box is wider than its lines).
    """
    lines = []
    for it in items:
        if it["type"] in ("formula", "code"):
            continue
        for g in it.get("geo") or []:
            lines.append(g[1])
        if not it.get("geo"):
            lines.append(it["bbox"])
    for it in items:
        if it["type"] != "formula":
            continue
        x0, y0, x1, y1 = it["bbox"]
        top, bot = y0 - 1.5, y1 + 1.5
        cy = (y0 + y1) / 2
        for b in lines:
            if b[2] <= x0 or b[0] >= x1:
                continue
            if b[1] < top < b[3] <= cy:
                top = b[3]
            if cy <= b[1] < bot < b[3]:
                bot = b[1]
        if top > y0 - 1.5 or bot < y1 + 1.5:
            it["crop"] = [round(x0 - 1.5, 2), round(top, 2), round(x1 + 1.5, 2), round(bot, 2)]


def _with_math(it: dict) -> dict:
    meta = dict(it.get("meta") or {})
    if it.get("type") in ("paragraph", "list"):
        if it.get("hang"):
            meta["hang"] = it["hang"]
        gaps = _item_gaps(it.get("geo") or [], (it.get("style") or {}).get("size") or 11)
        if gaps:
            meta["item_gaps"] = gaps
    if it.get("type") == "code" and it.get("code"):
        meta["code"] = it["code"]
    if it.get("crop"):
        meta["crop"] = it["crop"]
    if it.get("math") and it.get("ph") and "{{m" in it["ph"]:
        meta["ph"] = it["ph"]
        meta["math"] = [{k: m[k] for k in ("id", "bbox", "baseline", "size")} for m in it["math"]]
    return meta


def _table_markdown(t: dict, use_ph: bool = False) -> str:
    grid: list[list[str]] = [["" for _ in range(t["n_cols"])] for _ in range(t["n_rows"])]
    for c in t.get("cells", []):
        r, co = c["row"], c["col"]
        if r < t["n_rows"] and co < t["n_cols"]:
            txt = (c.get("ph") if use_ph else None) or c.get("text") or ""
            grid[r][co] = txt.replace("\n", " ").replace("|", "\\|").strip()
    if t["n_rows"] == 0 or t["n_cols"] == 0:
        return ""
    lines = []
    header = grid[0]
    lines.append("| " + " | ".join(header) + " |")
    lines.append("| " + " | ".join("---" for _ in header) + " |")
    for row in grid[1:]:
        lines.append("| " + " | ".join(row) + " |")
    return "\n".join(lines)
