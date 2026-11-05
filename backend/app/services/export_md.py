"""Markdown export (translated-only or bilingual).

Figures are embedded as base64 PNG data URIs so the single .md file stays
self-contained (renders in Typora / VS Code / Obsidian).
"""
from __future__ import annotations

import base64
import json
from pathlib import Path

import pymupdf as fitz

from ..config import UPLOAD_DIR
from ..db import get_db
from . import page_assets
from .export_common import MathImages, math_markdown


def export_markdown(doc_id: int, out_path: Path, lang: str, bilingual: bool = False) -> Path:
    with get_db() as db:
        doc = db.execute("SELECT title, file_path FROM documents WHERE id=?", (doc_id,)).fetchone()
        blocks = db.execute(
            "SELECT b.*, t.text AS translation FROM blocks b"
            " LEFT JOIN translations t ON t.block_id=b.id AND t.lang=?"
            " WHERE b.doc_id=? ORDER BY b.page_no, b.order_idx",
            (lang, doc_id),
        ).fetchall()

    src_path = Path(doc["file_path"]) if doc and doc["file_path"] else None
    src = fitz.open(src_path) if src_path and src_path.exists() else None
    doc_dir = UPLOAD_DIR / str(doc_id)
    mi = MathImages(src)

    by_page: dict[int, list] = {}
    for r in blocks:
        by_page.setdefault(r["page_no"], []).append(r)

    lines = [f"# {doc['title'] if doc else 'Document'}", ""]
    fig_no = 0
    for page_no in sorted(by_page):
        rows = by_page[page_no]
        figures: list = []
        if src is not None:
            try:
                blk = [{"type": r["type"], "bbox": json.loads(r["bbox_json"] or "[]")} for r in rows]
                figures = page_assets.page_meta(doc_dir, src_path, page_no, blk).get("figures", [])
            except Exception:
                figures = []
        seq = page_assets.interleave(rows, figures, key=lambda r: json.loads(r["bbox_json"] or "[0,0,0,0]"))
        for kind, item in seq:
            if kind == "figure":
                _idx, rect = item
                try:
                    png = page_assets.figure_png_bytes(src.load_page(page_no - 1), rect)
                except Exception:
                    continue
                fig_no += 1
                b64 = base64.b64encode(png).decode("ascii")
                lines += [f"![图 {fig_no}（第 {page_no} 页）](data:image/png;base64,{b64})", ""]
                continue
            r = item
            if r["type"] == "image":
                continue  # raster images are emitted as figures
            meta = json.loads(r["meta_json"] or "{}")
            if r["type"] == "formula":
                if src is not None:
                    b64 = base64.b64encode(
                        page_assets.figure_png_bytes(src.load_page(page_no - 1), json.loads(r["bbox_json"]))
                    ).decode("ascii")
                    lines += [f"![formula](data:image/png;base64,{b64})", ""]
                continue
            src_text = math_markdown(meta.get("ph") or r["text"], meta, page_no, mi)
            if bilingual and r["text"]:
                lines += [f"> {src_text.replace(chr(10), chr(10) + '> ')}", ""]
            text = math_markdown(r["translation"], meta, page_no, mi) if r["translation"] else src_text
            if r["type"] == "heading":
                lvl = min(max(int(r["level"] or 1), 1), 4)
                lines += ["#" * lvl + " " + text.replace("\n", " "), ""]
            elif r["type"] == "list":
                marker = (r["list_marker"] or "").strip()
                for i, ln in enumerate(text.splitlines()):
                    s = ln.strip()
                    if s[:1] in "-*•" or s[:2].rstrip(").").isdigit():
                        lines.append(ln)
                    elif i == 0 and marker and marker[:1].isdigit():
                        lines.append(f"{marker} {ln}")
                    else:
                        lines.append("- " + ln)
                lines.append("")
            elif r["type"] == "table":
                lines += [text, ""]
            elif text.strip():
                lines += [text, ""]
    if src is not None:
        src.close()
    mi.cleanup()
    lines += _notes_section(doc_id)
    out_path.write_text("\n".join(lines), encoding="utf-8")
    return out_path


_COLOR_NAMES = {"yellow": "黄", "green": "绿", "blue": "蓝", "pink": "粉", "orange": "橙"}


def _notes_section(doc_id: int) -> list[str]:
    """Appendix with the reader's highlights and notes, in page order."""
    with get_db() as db:
        hls = db.execute("SELECT page_no, pane, text, color, note FROM highlights WHERE doc_id=? ORDER BY page_no, id",
                         (doc_id,)).fetchall()
        notes = db.execute("SELECT page_no, content FROM notes WHERE doc_id=? ORDER BY page_no, id",
                           (doc_id,)).fetchall()
    if not hls and not notes:
        return []
    out = ["", "---", "", "## 高亮与笔记", ""]
    items = [(h["page_no"] or 0, 0, h) for h in hls] + [(n["page_no"] or 0, 1, n) for n in notes]
    for page_no, kind, it in sorted(items, key=lambda x: (x[0], x[1])):
        if kind == 0:
            where = "原文" if it["pane"] == "src" else "译文"
            quote = " ".join((it["text"] or "").split())
            out.append(f"- **第 {page_no} 页 · {where} · {_COLOR_NAMES.get(it['color'], '')}色高亮**：“{quote}”")
            if it["note"]:
                out.append(f"  - 笔记：{it['note']}")
        else:
            out.append(f"- **第 {page_no} 页 · 笔记**：{it['content']}")
    out.append("")
    return out
