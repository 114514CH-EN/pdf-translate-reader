"""Notes CRUD."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from ..db import get_db, rows_to_dicts

router = APIRouter(prefix="/api/notes", tags=["notes"])


@router.get("")
def list_notes(doc_id: int):
    with get_db() as db:
        rows = db.execute("SELECT * FROM notes WHERE doc_id=? ORDER BY page_no, id", (doc_id,)).fetchall()
    return rows_to_dicts(rows)


@router.post("")
def create_note(payload: dict):
    if not payload.get("doc_id"):
        raise HTTPException(400, "doc_id 必填")
    with get_db() as db:
        cur = db.execute(
            "INSERT INTO notes (doc_id, page_no, block_id, content) VALUES (?, ?, ?, ?)",
            (payload["doc_id"], payload.get("page_no"), payload.get("block_id"), payload.get("content") or ""),
        )
        row = db.execute("SELECT * FROM notes WHERE id=?", (cur.lastrowid,)).fetchone()
    return dict(row)


@router.put("/{note_id}")
def update_note(note_id: int, payload: dict):
    fields = {}
    for key in ("content", "page_no", "block_id"):
        if key in payload:
            fields[key] = payload[key]
    if not fields:
        raise HTTPException(400, "无更新字段")
    cols = ", ".join(f"{k}=?" for k in fields)
    with get_db() as db:
        db.execute(f"UPDATE notes SET {cols}, updated_at=datetime('now') WHERE id=?", (*fields.values(), note_id))
        row = db.execute("SELECT * FROM notes WHERE id=?", (note_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "笔记不存在")
    return dict(row)


@router.delete("/{note_id}")
def delete_note(note_id: int):
    with get_db() as db:
        db.execute("DELETE FROM notes WHERE id=?", (note_id,))
    return {"ok": True}
