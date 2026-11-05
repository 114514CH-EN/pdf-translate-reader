"""Glossary CRUD + CSV import/export."""
from __future__ import annotations

import csv
import io

from fastapi import APIRouter, HTTPException, UploadFile
from fastapi.responses import Response

from ..db import get_db, rows_to_dicts
from ..services.settings_store import bump_glossary_rev

router = APIRouter(prefix="/api/glossary", tags=["glossary"])


@router.get("")
def list_glossary(doc_id: int | None = None):
    with get_db() as db:
        if doc_id is None:
            rows = db.execute("SELECT * FROM glossary ORDER BY doc_id, id").fetchall()
        else:
            rows = db.execute(
                "SELECT * FROM glossary WHERE doc_id=? OR doc_id IS NULL ORDER BY (doc_id IS NULL), id", (doc_id,)
            ).fetchall()
    out = rows_to_dicts(rows)
    for r in out:
        r["scope"] = "global" if r["doc_id"] is None else "doc"
    return out


@router.post("")
def create_term(payload: dict):
    src = (payload.get("src_term") or "").strip()
    if not src:
        raise HTTPException(400, "src_term 必填")
    with get_db() as db:
        cur = db.execute(
            "INSERT INTO glossary (doc_id, src_term, tgt_term, note, origin, status, frequency)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                payload.get("doc_id"),
                src,
                (payload.get("tgt_term") or "").strip(),
                (payload.get("note") or "").strip(),
                payload.get("origin") or "manual",
                payload.get("status") or "approved",
                int(payload.get("frequency") or 0),
            ),
        )
        row = db.execute("SELECT * FROM glossary WHERE id=?", (cur.lastrowid,)).fetchone()
    bump_glossary_rev()
    return dict(row)


@router.put("/{term_id}")
def update_term(term_id: int, payload: dict):
    fields = {}
    for key in ("src_term", "tgt_term", "note", "status", "frequency", "origin"):
        if key in payload:
            fields[key] = payload[key]
    # scope: "global" → shared by every document (doc_id NULL); "doc" needs doc_id
    if payload.get("scope") == "global":
        fields["doc_id"] = None
    elif payload.get("scope") == "doc" and payload.get("doc_id") is not None:
        fields["doc_id"] = int(payload["doc_id"])
    if not fields:
        raise HTTPException(400, "无更新字段")
    cols = ", ".join(f"{k}=?" for k in fields)
    with get_db() as db:
        db.execute(f"UPDATE glossary SET {cols} WHERE id=?", (*fields.values(), term_id))
        row = db.execute("SELECT * FROM glossary WHERE id=?", (term_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "术语不存在")
    bump_glossary_rev()
    return dict(row)


@router.delete("/{term_id}")
def delete_term(term_id: int):
    with get_db() as db:
        db.execute("DELETE FROM glossary WHERE id=?", (term_id,))
    bump_glossary_rev()
    return {"ok": True}


@router.post("/import")
async def import_csv(file: UploadFile, doc_id: int | None = None, scope: str = "doc"):
    if scope == "global":
        doc_id = None
    raw = (await file.read()).decode("utf-8-sig", errors="replace")
    reader = csv.reader(io.StringIO(raw))
    rows = list(reader)
    if not rows:
        return {"imported": 0}
    start = 1 if rows and rows[0] and "src" in rows[0][0].lower() else 0
    imported = 0
    with get_db() as db:
        for r in rows[start:]:
            if len(r) < 2 or not r[0].strip():
                continue
            db.execute(
                "INSERT INTO glossary (doc_id, src_term, tgt_term, note, origin, status) VALUES (?, ?, ?, ?, 'import', 'approved')",
                (doc_id, r[0].strip(), r[1].strip(), r[2].strip() if len(r) > 2 else ""),
            )
            imported += 1
    bump_glossary_rev()
    return {"imported": imported}


@router.get("/export")
def export_csv(doc_id: int | None = None):
    with get_db() as db:
        if doc_id is None:
            rows = db.execute("SELECT * FROM glossary ORDER BY id").fetchall()
        else:
            rows = db.execute("SELECT * FROM glossary WHERE doc_id=? OR doc_id IS NULL ORDER BY id", (doc_id,)).fetchall()
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["src", "tgt", "note", "status", "origin"])
    for r in rows:
        w.writerow([r["src_term"], r["tgt_term"], r["note"] or "", r["status"], r["origin"]])
    return Response(
        buf.getvalue().encode("utf-8-sig"),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=glossary.csv"},
    )


@router.post("/extract-terms")
def extract_terms(doc_id: int):
    from ..services.glossary_extract import start_extract_terms

    with get_db() as db:
        doc = db.execute("SELECT id FROM documents WHERE id=?", (doc_id,)).fetchone()
    if doc is None:
        raise HTTPException(404, "文档不存在")
    return {"job_id": start_extract_terms(doc_id)}
