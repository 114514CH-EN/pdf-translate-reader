"""Page-level visual assets shared by the reader and the exporters.

* **Text-free background** — the original page rendered with every text glyph
  removed (redaction with images/vector art preserved). The reader paints it
  under the translated blocks, so figures, raster images, table rules, header
  fills, colored callouts and formulas drawn as vector art stay visible.
* **Figure regions** — clusters of vector drawings / raster images that are not
  tables, rules or text shading. Used by the bilingual PDF / Markdown export and
  the flow view to show figures in reading order.

Everything is cached on disk under ``uploads/<doc>/assets`` and keyed by
``ASSET_VER`` so improving the heuristics invalidates old caches automatically.
"""
from __future__ import annotations

import json
from pathlib import Path

import pymupdf as fitz

ASSET_VER = 3  # v3: fraction bars of inline math removed from the background
BG_SCALE = 2.0  # background raster = 2x PDF pt (crisp up to ~200% zoom)
ORIG_SCALE = 3.0  # full original render (with text): crops for untranslated blocks / formulas
FIG_DPI = 144


# ---------------------------------------------------------------- geometry ---

def _rect(b) -> fitz.Rect:
    return fitz.Rect(b) if not isinstance(b, fitz.Rect) else b


def _overlap_ratio(a: fitz.Rect, b: fitz.Rect) -> float:
    """|a ∩ b| / |a|."""
    inter = fitz.Rect(a) & b
    if inter.is_empty or a.is_empty:
        return 0.0
    return inter.get_area() / max(a.get_area(), 1e-6)


def _merge_rects(rects: list[fitz.Rect], pad: float = 4.0) -> list[fitz.Rect]:
    """Union rects that touch (within ``pad``) until stable."""
    out = [fitz.Rect(r) for r in rects]
    changed = True
    while changed:
        changed = False
        merged: list[fitz.Rect] = []
        for r in out:
            grown = fitz.Rect(r.x0 - pad, r.y0 - pad, r.x1 + pad, r.y1 + pad)
            for i, m in enumerate(merged):
                if grown.intersects(m):
                    merged[i] = m | r  # NB: Rect has no in-place |=
                    changed = True
                    break
            else:
                merged.append(fitz.Rect(r))
        out = merged
    return out


# ----------------------------------------------------------- figure finder ---

def _is_text_box(region: fitz.Rect, drawings: list[dict], text_rects: list[fitz.Rect]) -> bool:
    """A cluster made only of plain rectangles that encloses text = shading/frame."""
    grown = fitz.Rect(region.x0 - 1, region.y0 - 1, region.x1 + 1, region.y1 + 1)
    inside = [d for d in drawings if grown.contains(fitz.Rect(d["rect"]))]
    if not inside:
        return False
    for d in inside:
        items = d.get("items") or []
        if not items or any(it[0] not in ("re", "qu") for it in items):
            return False
    return any(_overlap_ratio(t, region) > 0.8 for t in text_rects)


def detect_figures(
    page: fitz.Page,
    text_rects: list,
    table_rects: list,
    *,
    min_side: float = 18.0,
) -> list[fitz.Rect]:
    """Find figure-like regions (vector drawings or raster images) on a page.

    Filters out: thin rules/underlines, table grids & header fills, shading boxes
    that are mostly covered by text, and page frames.
    """
    page_rect = page.rect
    page_area = page_rect.get_area()
    text_rects = [_rect(t) for t in text_rects]
    table_rects = [_rect(t) for t in table_rects]

    candidates: list[fitz.Rect] = []

    # raster images (display-list based → also finds images inside XObjects)
    try:
        for info in page.get_image_info():
            r = fitz.Rect(info["bbox"]) & page_rect
            if r.is_empty or r.width < 6 or r.height < 6:
                continue
            if any(_overlap_ratio(r, t) > 0.6 for t in table_rects):
                continue
            candidates.append(r)
    except Exception:
        pass

    # vector drawings, clustered
    try:
        drawings = page.get_drawings()
    except Exception:
        drawings = []
    if drawings:
        try:
            clusters = page.cluster_drawings(drawings=drawings, x_tolerance=6, y_tolerance=6)
        except Exception:
            clusters = _merge_rects([fitz.Rect(d["rect"]) for d in drawings], pad=6)
        for r in clusters:
            r = fitz.Rect(r) & page_rect
            if r.is_empty or r.width < min_side or r.height < min_side:
                continue  # rules, underlines, tiny marks
            if r.get_area() > 0.8 * page_area:
                continue  # page frame / full-page background
            if any(_overlap_ratio(r, t) > 0.5 for t in table_rects):
                continue  # table borders / header fills
            covered = sum((fitz.Rect(r) & t).get_area() for t in text_rects if r.intersects(t))
            if covered / max(r.get_area(), 1e-6) > 0.45:
                continue  # shading box behind a paragraph
            if _is_text_box(r, drawings, text_rects):
                continue  # callout / highlighted box: only plain rectangles + text
            candidates.append(r)

    figs = _merge_rects(candidates, pad=4)
    # pull in labels that sit (mostly) inside / on the edge of a figure
    # (longer text such as captions stays outside so it is translated)
    for i, f0 in enumerate(figs):
        f = fitz.Rect(f0)
        near = fitz.Rect(f0.x0 - 20, f0.y0 - 20, f0.x1 + 20, f0.y1 + 20)
        for t in text_rects:
            if _overlap_ratio(t, f0) > 0.6:
                f = f | t
            elif (
                t.height <= 24
                and t.width <= 0.5 * f0.width
                and near.intersects(t)
                and (near & t).get_area() > 0.5 * t.get_area()
            ):
                f = f | t
        figs[i] = f
    figs = _merge_rects(figs, pad=2)
    figs = [f for f in figs if f.width >= min_side and f.height >= min_side]
    figs.sort(key=lambda r: (round(r.y0), r.x0))
    return figs


# ------------------------------------------------------------- disk cache ---

def assets_dir(doc_dir: Path) -> Path:
    d = doc_dir / "assets"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _meta_path(doc_dir: Path, page_no: int) -> Path:
    return assets_dir(doc_dir) / f"page_{page_no:04d}_v{ASSET_VER}.json"


def bg_path(doc_dir: Path, page_no: int) -> Path:
    return assets_dir(doc_dir) / f"bg_{page_no:04d}_v{ASSET_VER}.png"


def orig_path(doc_dir: Path, page_no: int) -> Path:
    return assets_dir(doc_dir) / f"orig_{page_no:04d}_v{ASSET_VER}.png"


def render_original(doc_dir: Path, pdf_path: Path, page_no: int) -> Path:
    """The untouched page at ORIG_SCALE — the reader shows crops of it wherever the
    original glyphs must be kept (untranslated text, formulas, math cells)."""
    out = orig_path(doc_dir, page_no)
    if out.exists():
        return out
    with fitz.open(pdf_path) as pdf:
        page = pdf.load_page(page_no - 1)
        pix = page.get_pixmap(matrix=fitz.Matrix(ORIG_SCALE, ORIG_SCALE), alpha=False, annots=False)
        tmp = _tmp_for(out)
        pix.save(str(tmp))
    _publish(tmp, out)
    return out


def math_png_bytes(page: fitz.Page, bbox, scale: float = 4.0) -> bytes:
    clip = fitz.Rect(bbox) & page.rect
    return page.get_pixmap(clip=clip, matrix=fitz.Matrix(scale, scale), alpha=False, annots=False).tobytes("png")


def fig_path(doc_dir: Path, page_no: int, idx: int) -> Path:
    return assets_dir(doc_dir) / f"fig_{page_no:04d}_{idx:02d}_v{ASSET_VER}.png"


def page_meta(doc_dir: Path, pdf_path: Path, page_no: int, blocks: list[dict]) -> dict:
    """Cached {has_bg, figures:[[x0,y0,x1,y1],...]} for one page.

    ``blocks`` = DB block rows as dicts with ``type`` and ``bbox`` (list).
    """
    mp = _meta_path(doc_dir, page_no)
    if mp.exists():
        try:
            return json.loads(mp.read_text(encoding="utf-8"))
        except Exception:
            pass
    text_rects = [b["bbox"] for b in blocks if b.get("type") not in ("table", "image") and b.get("bbox")]
    table_rects = [b["bbox"] for b in blocks if b.get("type") == "table" and b.get("bbox")]
    with fitz.open(pdf_path) as pdf:
        page = pdf.load_page(page_no - 1)
        try:
            has_graphics = bool(page.get_drawings()) or bool(page.get_image_info())
        except Exception:
            has_graphics = True
        figs = detect_figures(page, text_rects, table_rects) if has_graphics else []
    meta = {
        "has_bg": has_graphics,
        "figures": [[round(v, 2) for v in f] for f in figs],
    }
    try:
        mp.write_text(json.dumps(meta), encoding="utf-8")
    except Exception:
        pass
    return meta


def text_free_page(pdf: fitz.Document, page_no: int) -> fitz.Page:
    """Strip every text glyph from a page in-place (vector art & images kept)."""
    page = pdf.load_page(page_no - 1)
    page.add_redact_annot(page.rect, fill=False, cross_out=False)
    page.apply_redactions(
        images=fitz.PDF_REDACT_IMAGE_NONE,
        graphics=fitz.PDF_REDACT_LINE_ART_NONE,
        text=fitz.PDF_REDACT_TEXT_REMOVE,
    )
    return page


def remove_math_line_art(page: fitz.Page, rects) -> None:
    """Delete vector art lying inside inline-math boxes (fraction bars, roots, brackets).

    Inline formulas in translated text are shown as crops of the original page,
    placed where they fall in the translated line. The bars of a stacked fraction
    are line art, not text, so redacting the text leaves them on the page at the
    old position, where they cross the translated text. Only art fully inside a box
    goes; table rules or frames that merely touch it stay.
    """
    rects = [fitz.Rect(r) + (-1, -1, 1, 1) for r in rects or []]
    rects = [r for r in rects if not r.is_empty]
    if not rects:
        return
    for r in rects:
        page.add_redact_annot(r, fill=False, cross_out=False)
    page.apply_redactions(
        images=fitz.PDF_REDACT_IMAGE_NONE,
        graphics=fitz.PDF_REDACT_LINE_ART_REMOVE_IF_COVERED,
        text=fitz.PDF_REDACT_TEXT_NONE,
    )


def inline_math_rects(blocks: list[dict]) -> list[list[float]]:
    """Boxes of inline math in text blocks (``meta`` dicts with ``math`` runs)."""
    out = []
    for b in blocks:
        if b.get("type") not in ("paragraph", "list", "heading"):
            continue
        for m in (b.get("meta") or {}).get("math") or []:
            if m.get("bbox"):
                out.append(m["bbox"])
    return out


def _tmp_for(out: Path) -> Path:
    import uuid

    return out.with_name(f"{out.stem}.{uuid.uuid4().hex[:8]}.tmp.png")


def _publish(tmp: Path, out: Path) -> None:
    """Atomic-ish rename; a concurrent request may have published the same file first."""
    try:
        tmp.replace(out)
    except OSError:
        if not out.exists():
            raise
    finally:
        try:
            if tmp.exists():
                tmp.unlink()
        except OSError:
            pass


def render_background(doc_dir: Path, pdf_path: Path, page_no: int, math_rects=None) -> Path:
    """``math_rects``: inline-math boxes of text blocks, whose line art is dropped too."""
    out = bg_path(doc_dir, page_no)
    if out.exists():
        return out
    with fitz.open(pdf_path) as pdf:
        page = text_free_page(pdf, page_no)
        if math_rects:
            try:
                remove_math_line_art(page, math_rects)
            except Exception:
                pass  # an older PyMuPDF without line-art redaction: keep the plain background
        pix = page.get_pixmap(matrix=fitz.Matrix(BG_SCALE, BG_SCALE), alpha=False, annots=False)
        tmp = _tmp_for(out)
        pix.save(str(tmp))
    _publish(tmp, out)
    return out


def render_figure(doc_dir: Path, pdf_path: Path, page_no: int, idx: int, bbox: list[float]) -> Path:
    out = fig_path(doc_dir, page_no, idx)
    if out.exists():
        return out
    with fitz.open(pdf_path) as pdf:
        page = pdf.load_page(page_no - 1)
        clip = fitz.Rect(bbox) & page.rect
        pix = page.get_pixmap(clip=clip, dpi=FIG_DPI, alpha=False, annots=False)
        tmp = _tmp_for(out)
        pix.save(str(tmp))
    _publish(tmp, out)
    return out


def figure_png_bytes(page: fitz.Page, bbox, dpi: int = FIG_DPI) -> bytes:
    clip = fitz.Rect(bbox) & page.rect
    return page.get_pixmap(clip=clip, dpi=dpi, alpha=False, annots=False).tobytes("png")


# -------------------------------------------------------- reading order ---

def interleave(blocks: list, figures: list, *, key=lambda b: b["bbox"]) -> list[tuple[str, object]]:
    """Merge one page's ordered blocks with its figures.

    Text blocks lying inside a figure (labels/axis ticks) are dropped — the
    figure image already shows them. Each figure is emitted right before the
    first remaining block whose top is below the figure top.
    Returns [("block", b) | ("figure", (idx, rect))].
    """
    figs = [(i, fitz.Rect(f)) for i, f in enumerate(figures)]
    kept = []
    for b in blocks:
        r = fitz.Rect(key(b))
        if any(_overlap_ratio(r, f) > 0.6 for _, f in figs):
            continue
        kept.append(b)
    out: list[tuple[str, object]] = []
    pending = sorted(figs, key=lambda x: x[1].y0)
    for b in kept:
        top = fitz.Rect(key(b)).y0
        while pending and pending[0][1].y0 <= top + 1:
            out.append(("figure", pending.pop(0)))
        out.append(("block", b))
    for f in pending:
        out.append(("figure", f))
    return out
