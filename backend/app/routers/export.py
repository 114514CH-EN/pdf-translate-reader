"""Export endpoints: translated PDF, bilingual PDF, Markdown."""
from __future__ import annotations

import tempfile
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from ..db import get_db
from ..services.settings_store import load_settings

router = APIRouter(prefix="/api/documents/{doc_id}/export", tags=["export"])


@router.post("")
def export_document(doc_id: int, payload: dict):
    fmt = payload.get("format") or "pdf_translated"
    cfg = load_settings()
    lang = payload.get("lang") or cfg.get("target_lang") or "zh"
    with get_db() as db:
        doc = db.execute("SELECT title FROM documents WHERE id=?", (doc_id,)).fetchone()
    if doc is None:
        raise HTTPException(404, "文档不存在")

    tmp_dir = Path(tempfile.gettempdir()) / "pdf_translate_exports"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    safe_title = "".join(ch for ch in doc["title"] if ch not in '\\/:*?"<>|').strip() or "document"
    suffix = uuid.uuid4().hex[:8]

    try:
        if fmt == "pdf_translated":
            from ..services.export_pdf_inplace import export_translated_pdf

            out = tmp_dir / f"{safe_title}_译_{suffix}.pdf"
            export_translated_pdf(doc_id, out, lang)
            media = "application/pdf"
        elif fmt == "pdf_bilingual":
            from ..services.export_pdf_bilingual import export_bilingual_pdf

            out = tmp_dir / f"{safe_title}_双语_{suffix}.pdf"
            export_bilingual_pdf(doc_id, out, lang)
            media = "application/pdf"
        elif fmt in ("pdf_side_by_side", "pdf_alternate"):
            from ..services.export_pdf_facing import export_facing_pdf

            tag = "对照" if fmt == "pdf_side_by_side" else "交替"
            out = tmp_dir / f"{safe_title}_{tag}_{suffix}.pdf"
            export_facing_pdf(doc_id, out, lang, "side_by_side" if fmt == "pdf_side_by_side" else "alternate")
            media = "application/pdf"
        elif fmt == "md":
            from ..services.export_md import export_markdown

            out = tmp_dir / f"{safe_title}_{suffix}.md"
            export_markdown(doc_id, out, lang, bilingual=bool(payload.get("bilingual")))
            media = "text/markdown"
        else:
            raise HTTPException(400, f"未知导出格式: {fmt}")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"导出失败: {e}") from e

    return FileResponse(str(out), media_type=media, filename=out.name)
