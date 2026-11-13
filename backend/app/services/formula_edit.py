"""Formulas the reader rewrote (edit mode → click a formula → LaTeX).

The LaTeX is stored like any other edit: as the block's translation (or, for the
original side, under the pseudo language ``__src__``). The page shows it with KaTeX.
PDF export has no TeX engine, so the browser also sends a picture of the rendered
formula; it is kept per block *and per LaTeX text* — after an undo the picture of the
older text is still the right one, and a LaTeX text without a picture simply exports
as the original formula.
"""
from __future__ import annotations

import hashlib
from pathlib import Path

MAX_PNG = 3_000_000
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def png_path(doc_dir: Path, block_id: int, tex: str) -> Path:
    key = hashlib.sha1(tex.strip().encode("utf-8")).hexdigest()[:16]
    return Path(doc_dir) / "formula" / f"{int(block_id)}_{key}.png"


def save_png(doc_dir: Path, block_id: int, tex: str, data: bytes) -> Path:
    if not tex.strip():
        raise ValueError("empty formula")
    if not data.startswith(PNG_MAGIC) or len(data) > MAX_PNG:
        raise ValueError("not a PNG picture, or too large")
    path = png_path(doc_dir, block_id, tex)
    path.parent.mkdir(parents=True, exist_ok=True)
    # one block keeps few pictures: older ones go once there are more than a handful
    old = sorted(path.parent.glob(f"{int(block_id)}_*.png"), key=lambda p: p.stat().st_mtime)
    for p in old[:-8]:
        try:
            p.unlink()
        except OSError:
            pass
    path.write_bytes(data)
    return path
