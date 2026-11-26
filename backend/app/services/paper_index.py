"""What a reader of a paper looks things up by: the reference list, the figures and tables,
and the sections — found in a document's blocks, so it works for any PDF, not only an
imported paper.

  refs     key ("12", or "smith2020" for author–year lists) → the entry's text, where it is,
           and what to search for to find that paper
  figs     "fig:3" / "tab:2" → the caption, where it is, and the figure's area on the page
  outline  the PDF's own bookmarks when it has them, else its headings
  style    "numeric" | "author-year" | "" — how the text cites
"""
from __future__ import annotations

import re

import pymupdf as fitz

_REF_HEAD = re.compile(
    r"^\s*(?:[IVX\d]+\.?\s*)?(references|bibliography|reference list|works cited|literature cited|参考文献)\s*$",
    re.I,
)
_STOP_HEAD = re.compile(r"^\s*(?:[A-Z]\.?\s+)?(appendix|appendices|supplementary|acknowledg|附录)", re.I)
_NUM_BRACKET = re.compile(r"(?:^|\n)\s*\[(\d{1,3})\]\s*")
_NUM_DOT = re.compile(r"(?:^|\n)\s*(\d{1,3})\.\s+(?=[A-ZÀ-ɏ])")
_YEAR = re.compile(r"\b((?:19|20)\d{2})([a-z])?\b")
_CAPTION = re.compile(
    r"^\s*(fig(?:ure)?\.?|table|tab\.|图|表)\s*(\d{1,3}|[IVX]{1,5})\s*[.:：\-—|]?\s*", re.I
)
_DOI = re.compile(r"\b(10\.\d{4,9}/[^\s\"<>,;]+)")
_ARXIV = re.compile(r"arxiv[:\s]*(\d{4}\.\d{4,5}|[a-z\-]+/\d{7})", re.I)


def _kind(word: str) -> str:
    w = word.lower()
    return "tab" if w.startswith(("tab", "表")) else "fig"


def _roman(s: str) -> str:
    vals = {"I": 1, "V": 5, "X": 10}
    if not re.fullmatch(r"[IVX]+", s):
        return s
    total = 0
    for i, ch in enumerate(s):
        v = vals[ch]
        total += -v if i + 1 < len(s) and vals[s[i + 1]] > v else v
    return str(total)


def guess_title(entry: str) -> str:
    """What to search for to find a referenced paper: its DOI or arXiv id when it gives one,
    a quoted title, else the part after the authors."""
    m = _DOI.search(entry)
    if m:
        return m.group(1).rstrip(".")
    m = _ARXIV.search(entry)
    if m:
        return m.group(1)
    m = re.search(r"[“\"]([^”\"]{12,})[”\"]", entry)
    if m:
        return m.group(1).strip(" ,.")
    body = re.sub(r"^\s*\[\d+\]\s*|^\s*\d+\.\s*", "", entry)
    # authors end at the year in author–year lists: "Smith, J. and Doe, A. (2020). Title. Venue"
    y = re.search(r"\(?(?:19|20)\d{2}[a-z]?\)?\.\s+", body)
    if y and y.start() < 0.5 * len(body):
        rest = body[y.end():]
        return re.split(r"\.\s+(?=[A-Z])", rest, maxsplit=1)[0].strip(" .")
    parts = [p.strip() for p in re.split(r"\.\s+(?=[A-Z])", body) if p.strip()]
    # put the authors back together: "C. Person and D. Body" was cut at every initial
    merged: list[str] = []
    for p in parts:
        prev = merged[-1] if merged else ""
        initial_end = bool(re.search(r"(?:^|[\s,])[A-Z]$", prev))
        namelike = len(p.split()) <= 3 or bool(re.match(r"[A-Z][\w'\-]+,", p))
        if merged and initial_end and namelike:
            merged[-1] = f"{prev}. {p}"
        else:
            merged.append(p)
    if len(merged) >= 2:
        return merged[1].strip(" .")
    return (merged[0] if merged else body).strip(" .")


def _first_author_key(entry: str) -> str:
    body = re.sub(r"^\s*\[\d+\]\s*|^\s*\d+\.\s*", "", entry)
    m = re.match(r"\s*([A-ZÀ-ɏ][A-Za-zÀ-ɏ'\-]+)", body)
    y = _YEAR.search(body)
    if not (m and y):
        return ""
    return (m.group(1) + y.group(1) + (y.group(2) or "")).lower()


def _split_entries(blocks: list[dict]) -> tuple[str, list[dict]]:
    text = "\n".join(b["text"] for b in blocks)
    for style, pat in (("numeric", _NUM_BRACKET), ("numeric", _NUM_DOT)):
        marks = list(pat.finditer(text))
        nums = [int(m.group(1)) for m in marks]
        # a real list counts up from 1 (allowing for an entry lost here and there)
        if len(marks) >= 2 and nums[0] <= 2 and sum(1 for a, b in zip(nums, nums[1:]) if b == a + 1) >= 0.7 * (len(nums) - 1):
            out = []
            for i, m in enumerate(marks):
                end = marks[i + 1].start() if i + 1 < len(marks) else len(text)
                body = re.sub(r"\s*\n\s*", " ", text[m.end():end]).strip()
                where = _locate(blocks, m.start(), text)
                out.append({"key": m.group(1), "text": f"[{m.group(1)}] {body}" if pat is _NUM_BRACKET else f"{m.group(1)}. {body}",
                            "page": where["page_no"], "block_id": where["id"], "y": _bbox(where)[1]})
            return style, out
    # author–year: one entry per block (or per line that starts with a surname and has a year)
    out = []
    for b in blocks:
        for line in re.split(r"\n(?=[A-ZÀ-ɏ][A-Za-zÀ-ɏ'\-]+,)", b["text"]):
            line = re.sub(r"\s*\n\s*", " ", line).strip()
            key = _first_author_key(line)
            if key and len(line) > 20:
                out.append({"key": key, "text": line, "page": b["page_no"], "block_id": b["id"], "y": _bbox(b)[1]})
    return ("author-year" if len(out) >= 2 else ""), out


def _locate(blocks: list[dict], offset: int, text: str) -> dict:
    pos = 0
    for b in blocks:
        pos += len(b["text"]) + 1
        if offset < pos:
            return b
    return blocks[-1]


def _bbox(b: dict) -> list[float]:
    return list(b.get("bbox") or [0, 0, 0, 0])


def build(blocks: list[dict], toc: list | None = None, translations: dict | None = None) -> dict:
    """blocks: id, page_no, order_idx, type, level, text, bbox (a list) — in reading order."""
    translations = translations or {}
    blocks = sorted(blocks, key=lambda b: (b["page_no"], b["order_idx"]))
    # ---- references: after the last "References" heading, up to the next section that is not one
    start = None
    for i, b in enumerate(blocks):
        first = (b["text"] or "").strip().split("\n", 1)[0]
        if _REF_HEAD.match(first) and len((b["text"] or "").strip()) < 40:
            start = i
    refs: dict[str, dict] = {}
    style = ""
    if start is not None:
        head = blocks[start]
        body: list[dict] = []
        for b in blocks[start + 1:]:
            t = (b["text"] or "").strip()
            if b["type"] in ("image", "formula") or not t:
                continue
            if b["type"] == "heading" and (_STOP_HEAD.match(t) or not re.match(r"^\s*(\[\d+\]|\d+\.)", t)) \
                    and len(t) < 80 and b["page_no"] > head["page_no"]:
                break
            if _CAPTION.match(t):
                continue  # a figure's caption that the reading order put among the references
            if b["page_no"] == head["page_no"] and b["bbox"][3] < head["bbox"][1]:
                continue
            if _STOP_HEAD.match(t) and len(t) < 80:
                break
            body.append(b)
        style, entries = _split_entries(body) if body else ("", [])
        for e in entries:
            e["query"] = guess_title(e["text"])
            refs.setdefault(e["key"], e)
    # ---- figures and tables: a block (or a line of one) that starts with "Figure 3:" / "Table 2."
    figs: dict[str, dict] = {}
    by_page: dict[int, list[dict]] = {}
    for b in blocks:
        by_page.setdefault(b["page_no"], []).append(b)
    for b in blocks:
        if b["type"] in ("image", "formula", "table") or start is not None and b["id"] in {e["block_id"] for e in refs.values()}:
            continue
        lines = (b["text"] or "").split("\n")
        for li, line in enumerate(lines):
            m = _CAPTION.match(line)
            if not m or len(line.strip()) < len(m.group(0)) + 3:
                continue
            # "Figure 2 shows…" in running text is a mention, not a caption: a caption starts a
            # block or a line and is followed by a separator or a capital
            sep = m.group(0)[len(m.group(1)) + len(m.group(2)) + 1:].strip()
            if not sep and not re.match(r"[A-Z一-鿿(]", line[m.end():] or " "):
                continue
            if li > 0 and not sep:
                continue
            key = f"{_kind(m.group(1))}:{_roman(m.group(2))}"
            if key in figs:
                continue
            caption = " ".join(x.strip() for x in lines[li:]).strip()
            # the next caption in the same block ends this one ("Figure 1: … Table 1: …")
            for k in range(li + 1, len(lines)):
                if _CAPTION.match(lines[k]):
                    caption = " ".join(x.strip() for x in lines[li:k]).strip()
                    break
            area = _figure_area(b, by_page.get(b["page_no"], []), _kind(m.group(1)))
            figs[key] = {"key": key, "label": m.group(0).strip(" .:：-—|"), "caption": caption[:600],
                         "caption_zh": (translations.get(b["id"]) or "")[:600] if li == 0 else "",
                         "page": b["page_no"], "block_id": b["id"], "area": area,
                         "y": (area or _bbox(b))[1]}
    # ---- outline
    outline = []
    if toc:
        for level, title, page, *_ in toc:
            if page and page > 0 and str(title).strip():
                outline.append({"title": str(title).strip(), "level": int(level), "page": int(page), "block_id": None, "y": 0})
    else:
        heads = []
        for b in blocks:
            t = (b["text"] or "").strip()
            if b["type"] != "heading" or not t or len(t) > 160 or re.fullmatch(r"[\d\W]+", t):
                continue
            num = re.match(r"^(\d+(?:\.\d+)*)\.?\s+\S", t)
            heads.append((b, " ".join(t.split()), num.group(1).count(".") + 1 if num else 0,
                          round(float(b.get("font_size") or 0) * 2) / 2))
        # numbered headings say their depth ("2.3" is level 2); an unnumbered one takes the
        # level of numbered headings set in the same size, else ranks by size
        by_size: dict[float, int] = {}
        for _, _, depth, size in heads:
            if depth:
                by_size[size] = min(by_size.get(size, 9), depth)
        sizes = sorted({size for *_, size in heads}, reverse=True)

        def level_of(depth: int, size: float) -> int:
            if depth:
                return depth
            if size in by_size:
                return by_size[size]
            if by_size:
                if size > max(by_size):
                    return 1  # bigger than any section heading: the title, a part
                near = min(by_size, key=lambda t: abs(t - size))
                if abs(near - size) <= 1.5:
                    return by_size[near]  # "Abstract" a size below "1 Introduction"
            return sizes.index(size) + 1

        for b, title, depth, size in heads:
            level = level_of(depth, size)
            outline.append({"title": title, "title_zh": (translations.get(b["id"]) or "").strip(),
                            "level": max(1, min(level, 3)), "page": b["page_no"], "block_id": b["id"], "y": _bbox(b)[1]})
    return {"refs": refs, "figs": figs, "outline": outline, "style": style}


def _figure_area(caption: dict, page_blocks: list[dict], kind: str) -> list[float] | None:
    """The figure (or table) a caption belongs to: the image / table block nearest above it
    (tables are captioned above as often as below), overlapping it horizontally."""
    cx0, cy0, cx1, cy1 = _bbox(caption)
    best = None
    for b in page_blocks:
        if b["id"] == caption["id"]:
            continue
        if kind == "fig" and b["type"] not in ("image",):
            continue
        if kind == "tab" and b["type"] != "table":
            continue
        x0, y0, x1, y1 = _bbox(b)
        if min(x1, cx1) - max(x0, cx0) <= 0:
            continue
        gap = cy0 - y1 if y1 <= cy0 + 2 else (y0 - cy1 if y0 >= cy1 - 2 else None)
        if gap is None or gap > 120:
            continue
        if kind == "fig" and y0 > cy1:
            gap += 40  # figures are captioned below them: one above wins
        if best is None or gap < best[0]:
            best = (gap, [x0, y0, x1, y1])
    return best[1] if best else None


def pdf_toc(path: str) -> list:
    try:
        with fitz.open(path) as d:
            return d.get_toc(simple=True)
    except Exception:
        return []
