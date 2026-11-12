"""Shared helpers for PDF export (CJK font archive, cell-grid parsing)."""
from __future__ import annotations

import re
from pathlib import Path

import pymupdf as fitz

from ..config import DATA_DIR

FONT_DIR = DATA_DIR / "fonts"
CJK_CANDIDATES = [
    Path("C:/Windows/Fonts/msyh.ttc"),
    Path("C:/Windows/Fonts/msyhbd.ttc"),
    Path("C:/Windows/Fonts/simhei.ttf"),
    Path("C:/Windows/Fonts/simsun.ttc"),
    # Linux (the server version's Docker image installs WenQuanYi Micro Hei)
    Path("/usr/share/fonts/truetype/wqy/wqy-microhei.ttc"),
    Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"),
    Path("/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc"),
]

CSS_TMPL = """
@font-face {{ font-family: cjk; src: url('{fname}'); }}
* {{ font-family: cjk; }}
"""

# the bold cut that goes with each regular font — without it bold text (headings, the
# reader's own "加粗") comes out in the regular weight
BOLD_OF = {
    "msyh.ttc": "msyhbd.ttc",
    "msyh.ttf": "msyhbd.ttf",
    "NotoSansCJK-Regular.ttc": "NotoSansCJK-Bold.ttc",
    "wqy-microhei.ttc": None,
}
CSS_BOLD = "@font-face {{ font-family: cjk; font-weight: bold; src: url('{fname}'); }}\n"


def font_archive() -> tuple[fitz.Archive | None, str]:
    """Return (archive, css) using the first available CJK font (Windows, or the Linux paths)."""
    FONT_DIR.mkdir(parents=True, exist_ok=True)
    for src in CJK_CANDIDATES:
        if src.exists():
            dst = FONT_DIR / src.name
            if not dst.exists():
                dst.write_bytes(src.read_bytes())
            css = CSS_TMPL.format(fname=src.name)
            bold = BOLD_OF.get(src.name)
            if bold and (src.parent / bold).exists():
                try:
                    if not (FONT_DIR / bold).exists():
                        (FONT_DIR / bold).write_bytes((src.parent / bold).read_bytes())
                    css = CSS_BOLD.format(fname=bold) + css
                except OSError:
                    pass
            arch = fitz.Archive(str(FONT_DIR))
            return arch, css
    return None, "* { font-family: sans-serif; }"


def parse_md_table(md: str) -> list[list[str]] | None:
    """Parse a GFM table translation into a grid (excluding the separator row)."""
    lines = [ln for ln in md.splitlines() if ln.strip().startswith("|")]
    if len(lines) < 2:
        return None
    rows = []
    for i, ln in enumerate(lines):
        cells = [c.strip() for c in ln.strip().strip("|").split("|")]
        if i == 1 and all(re.fullmatch(r":?-{2,}:?", c or "-") for c in cells):
            continue
        rows.append(cells)
    return rows or None


def esc(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def block_html(text: str, style: dict, *, scale: float = 1.0, body: str | None = None) -> str:
    size = (style.get("size") or 12) * scale
    weight = 700 if style.get("bold") else 400
    italic = "italic" if style.get("italic") else "normal"
    color = _css_color(style.get("color") or 0)
    align = style.get("align") or "left"
    if body is None:
        body = esc(text).replace("\n", "<br/>")
    return (
        f'<div style="font-size:{size:.2f}pt;font-weight:{weight};font-style:{italic};'
        f'color:{color};text-align:{align};line-height:1.3;">{body}</div>'
    )


def _css_color(color_int: int) -> str:
    if not color_int:
        return "#000000"
    r = (color_int >> 16) & 0xFF
    g = (color_int >> 8) & 0xFF
    b = color_int & 0xFF
    return f"#{r:02x}{g:02x}{b:02x}"


# ---- formulas: crops of the original rendering ---------------------------------------

PH_RE = re.compile(r"\{\{(m\d+)\}\}")


class MathImages:
    """Renders math runs of the ORIGINAL pdf to PNG crops for HTML boxes / Markdown."""

    def __init__(self, src_pdf: "fitz.Document | None"):
        import tempfile

        self.src = src_pdf
        self.dir = Path(tempfile.mkdtemp(prefix="pdftr_math_"))
        self._names: dict[tuple, str] = {}

    def png(self, page_no: int, run: dict) -> bytes:
        from .page_assets import math_png_bytes

        return math_png_bytes(self.src.load_page(page_no - 1), run["bbox"])

    def name(self, page_no: int, run: dict) -> str:
        key = (page_no, run["id"])
        if key not in self._names:
            fname = f"math_p{page_no}_{run['id']}.png"
            (self.dir / fname).write_bytes(self.png(page_no, run))
            self._names[key] = fname
        return self._names[key]

    def add_to(self, arch: "fitz.Archive | None") -> "fitz.Archive":
        arch = arch if arch is not None else fitz.Archive()
        arch.add(str(self.dir))
        return arch

    def cleanup(self) -> None:
        import shutil

        shutil.rmtree(self.dir, ignore_errors=True)


def math_body(text: str, meta: dict, page_no: int, mi: "MathImages | None", *, scale: float = 1.0) -> str | None:
    """HTML body with {{mN}} replaced by <img> crops; None when the text has no formulas."""
    if "{{m" not in (text or "") or mi is None or mi.src is None:
        return None
    runs = {r["id"]: r for r in (meta or {}).get("math", [])}
    out = []
    pos = 0
    for m in PH_RE.finditer(text):
        out.append(esc(text[pos:m.start()]).replace("\n", "<br/>"))
        run = runs.get(m.group(1))
        if run:
            x0, y0, x1, y1 = run["bbox"]
            out.append(f'<img src="{mi.name(page_no, run)}" width="{(x1 - x0) * scale:.1f}" height="{(y1 - y0) * scale:.1f}"/>')
        pos = m.end()
    out.append(esc(text[pos:]).replace("\n", "<br/>"))
    return "".join(out)


def math_markdown(text: str, meta: dict, page_no: int, mi: "MathImages | None") -> str:
    """Markdown with {{mN}} replaced by inline data-URI images of the original formula."""
    import base64

    if "{{m" not in (text or "") or mi is None or mi.src is None:
        return text
    runs = {r["id"]: r for r in (meta or {}).get("math", [])}

    def sub(m):
        run = runs.get(m.group(1))
        if not run:
            return ""
        b64 = base64.b64encode(mi.png(page_no, run)).decode("ascii")
        return f"![formula](data:image/png;base64,{b64})"

    return PH_RE.sub(sub, text)


# ---------------------------------------------------------------- highlights
HIGHLIGHT_RGB = {
    "yellow": (1.0, 0.86, 0.2), "green": (0.55, 0.85, 0.45), "blue": (0.5, 0.75, 1.0),
    "pink": (1.0, 0.6, 0.78), "orange": (1.0, 0.68, 0.3),
}


def load_highlights(doc_id: int, pane: str) -> dict[int, list[dict]]:
    import json as _json

    from ..db import get_db

    out: dict[int, list[dict]] = {}
    with get_db() as db:
        for r in db.execute("SELECT * FROM highlights WHERE doc_id=? AND pane=? ORDER BY id", (doc_id, pane)):
            d = dict(r)
            d["rects"] = _json.loads(d.get("rects_json") or "[]")
            out.setdefault(d["page_no"], []).append(d)
    return out


def add_highlight_annots(page, highlights: list[dict], dx: float = 0.0, dy: float = 0.0) -> None:
    """Real PDF highlight annotations (with the note as popup text) — kept by any PDF reader."""
    import pymupdf as fitz

    for h in highlights:
        rects = [fitz.Rect(r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy) for r in h.get("rects") or []]
        if not rects:
            continue
        try:
            annot = page.add_highlight_annot([r.quad for r in rects])
            annot.set_colors(stroke=HIGHLIGHT_RGB.get(h.get("color") or "yellow", HIGHLIGHT_RGB["yellow"]))
            if h.get("note"):
                annot.set_info(content=h["note"], title="笔记")
            annot.update()
        except Exception:
            continue
