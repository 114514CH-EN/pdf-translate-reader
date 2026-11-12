"""Document upload / list / delete + extraction pipeline entry."""
from __future__ import annotations

import json
import re
import sqlite3
import shutil
from pathlib import Path

import pymupdf as fitz
from fastapi import APIRouter, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool

from ..config import UPLOAD_DIR
from ..db import get_db, rows_to_dicts
from ..services.extract import EXTRACT_VER, extract_page, restore_placeholders
from ..services.structure import build_blocks

router = APIRouter(prefix="/api/documents", tags=["documents"])

ALLOWED_EXT = {".pdf"}


def _doc_dir(doc_id: int) -> Path:
    return UPLOAD_DIR / str(doc_id)


@router.get("")
def list_documents():
    with get_db() as db:
        rows = db.execute(
            "SELECT id, title, page_count, source_lang, target_lang, domain_guess, status,"
            " created_at, updated_at, last_opened_at FROM documents ORDER BY last_opened_at DESC, id DESC"
        ).fetchall()
    return rows_to_dicts(rows)


@router.post("")
async def upload_document(file: UploadFile):
    ext = Path(file.filename or "").suffix.lower()
    if ext not in ALLOWED_EXT:
        raise HTTPException(400, "仅支持 PDF 文件")

    title = Path(file.filename or "untitled.pdf").stem
    data = await file.read()
    if not data:
        raise HTTPException(400, "空文件")
    try:
        probe = fitz.open(stream=data, filetype="pdf")
    except Exception as e:
        raise HTTPException(400, "无法打开这个文件：它不是有效的 PDF，或文件已损坏") from e
    try:
        if probe.needs_pass and not probe.authenticate(""):
            raise HTTPException(400, "这个 PDF 设置了打开密码，请先用 PDF 阅读器去除密码后再上传")
        if probe.page_count == 0:
            raise HTTPException(400, "这个 PDF 没有页面")
    finally:
        probe.close()

    with get_db() as db:
        cur = db.execute(
            "INSERT INTO documents (title, file_path, status) VALUES (?, ?, ?)",
            (title, "", "extracting"),
        )
        doc_id = cur.lastrowid

    doc_dir = _doc_dir(doc_id)
    doc_dir.mkdir(parents=True, exist_ok=True)
    pdf_path = doc_dir / "original.pdf"
    pdf_path.write_bytes(data)

    try:
        # parsing is CPU-bound: keep it off the event loop so the app stays responsive
        await run_in_threadpool(_extract_document, doc_id, pdf_path)
    except Exception as e:
        with get_db() as db:
            db.execute("DELETE FROM documents WHERE id=?", (doc_id,))
        shutil.rmtree(doc_dir, ignore_errors=True)
        if isinstance(e, (fitz.FileDataError, fitz.EmptyFileError)) or "open" in type(e).__name__.lower():
            raise HTTPException(400, "无法打开这个文件：它不是有效的 PDF，或文件已损坏") from e
        raise HTTPException(500, f"PDF 解析失败: {e}") from e

    with get_db() as db:
        db.execute(
            "UPDATE documents SET file_path=?, status='ready', updated_at=datetime('now'),"
            " last_opened_at=datetime('now') WHERE id=?",
            (str(pdf_path), doc_id),
        )
    with get_db() as db:
        n_text = db.execute(
            "SELECT COUNT(*) FROM blocks WHERE doc_id=? AND type!='image' AND trim(text)!=''", (doc_id,)
        ).fetchone()[0]
    warning = None
    if n_text == 0:
        warning = "未检测到可提取的文字层：这可能是扫描版/图片版 PDF，暂不支持翻译（需先用 OCR 工具转换为可搜索 PDF）。"
    return {"doc_id": doc_id, "warning": warning}


def _extract_document(doc_id: int, pdf_path: Path, db=None) -> None:
    if db is None:
        with get_db() as conn:
            _extract_document(doc_id, pdf_path, conn)
        return
    img_dir = _doc_dir(doc_id) / "images"
    shutil.rmtree(_doc_dir(doc_id) / "assets", ignore_errors=True)  # cached page meta depends on blocks
    doc = fitz.open(pdf_path)
    try:
        db.execute("DELETE FROM pages WHERE doc_id=?", (doc_id,))
        for page_no in range(doc.page_count):
            page = doc.load_page(page_no)
            payload = extract_page(page, img_dir)
            cur = db.execute(
                "INSERT INTO pages (doc_id, page_no, width, height, extract_json, status)"
                " VALUES (?, ?, ?, ?, ?, 'done')",
                (
                    doc_id,
                    page_no + 1,
                    payload["width"],
                    payload["height"],
                    json.dumps(payload, ensure_ascii=False),
                ),
            )
            page_id = cur.lastrowid
            blocks = build_blocks(payload, page_no + 1)
            for b in blocks:
                db.execute(
                    "INSERT INTO blocks (doc_id, page_id, page_no, order_idx, type, level,"
                    " bbox_json, style_json, meta_json, text, font_size, bold, list_marker, stable_key)"
                    " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        doc_id,
                        page_id,
                        b["page_no"],
                        b["order_idx"],
                        b["type"],
                        b["level"],
                        json.dumps(b["bbox"]),
                        json.dumps(b["style"], ensure_ascii=False),
                        json.dumps(b["meta"], ensure_ascii=False),
                        b["text"],
                        b["font_size"],
                        b["bold"],
                        b["list_marker"],
                        b["stable_key"],
                    ),
                )
        db.execute(
            "UPDATE documents SET page_count=?, updated_at=datetime('now') WHERE id=?",
            (doc.page_count, doc_id),
        )
    finally:
        doc.close()


def _norm(text: str) -> str:
    from ..services.extract import _MATH_DUP

    return " ".join(_MATH_DUP.sub(r"\1", text or "").split()).lower()


def reextract_document(doc_id: int) -> int:
    """Re-run extraction for an existing document, keeping translations & notes.

    Translations / notes are carried over to the new block with the same page,
    type and (whitespace-normalised) source text. Returns #translations kept.
    """
    with get_db() as db:
        row = db.execute("SELECT file_path FROM documents WHERE id=?", (doc_id,)).fetchone()
        if row is None or not row["file_path"] or not Path(row["file_path"]).exists():
            return 0
        old_rows = db.execute(
            "SELECT id, page_no, type, text FROM blocks WHERE doc_id=? ORDER BY page_no, order_idx", (doc_id,)
        ).fetchall()
        old_blocks = {r["id"]: (r["page_no"], r["type"], _norm(r["text"])) for r in old_rows}
        old_trans = db.execute(
            "SELECT t.* FROM translations t JOIN blocks b ON b.id=t.block_id WHERE b.doc_id=?", (doc_id,)
        ).fetchall()
        old_notes = db.execute(
            "SELECT id, block_id FROM notes WHERE doc_id=? AND block_id IS NOT NULL", (doc_id,)
        ).fetchall()
        old_runs = _page_runs(db, doc_id)

        _extract_document(doc_id, Path(row["file_path"]), db)

        new_ids: dict[tuple, list[int]] = {}
        for r in db.execute("SELECT id, page_no, type, text FROM blocks WHERE doc_id=? ORDER BY page_no, order_idx", (doc_id,)):
            new_ids.setdefault((r["page_no"], r["type"], _norm(r["text"])), []).append(r["id"])
        remap: dict[int, int] = {}
        used: dict[tuple, int] = {}
        for old_id, key in old_blocks.items():
            cands = new_ids.get(key)
            if cands:
                i = used.get(key, 0)
                remap[old_id] = cands[min(i, len(cands) - 1)]
                used[key] = i + 1
        # same text whose kind changed between running text types
        # ("o for example …" was a paragraph, is now a list item)
        prose = ("paragraph", "list", "heading")
        taken = set(remap.values())
        loose: dict[tuple, list[int]] = {}
        for (pg, typ, txt), ids in new_ids.items():
            if typ in prose:
                loose.setdefault((pg, txt), []).extend(i for i in ids if i not in taken)
        for old_id, (pg, typ, txt) in old_blocks.items():
            if old_id in remap or typ not in prose:
                continue
            free = loose.get((pg, txt))
            if free:
                remap[old_id] = free.pop(0)
        kept = 0
        remap_notes: dict[int, int] = {}
        # blocks that were split by the new extractor (heading ⇥ "[20 marks]",
        # formula line + paragraph): split the old translation line-wise
        split_assign: dict[tuple[int, str], dict[int, str]] = {}
        new_rows = db.execute(
            "SELECT id, page_no, type, text, bbox_json FROM blocks WHERE doc_id=?", (doc_id,)
        ).fetchall()
        mapped_new = set(remap.values())
        by_page_new: dict[int, list] = {}
        for r in new_rows:
            if r["id"] not in mapped_new:
                bb = json.loads(r["bbox_json"] or "[0,0,0,0]")
                by_page_new.setdefault(r["page_no"], []).append((round(bb[1] / 4), bb[0], r))
        for lst in by_page_new.values():
            lst.sort(key=lambda x: (x[0], x[1]))
        compact = lambda t: "".join(_norm(t).split())  # noqa: E731
        for t in old_trans:
            if t["block_id"] in remap:
                continue
            page_no, _typ, old_norm = old_blocks.get(t["block_id"], (None, None, ""))
            cands = [x[2] for x in by_page_new.get(page_no, [])]
            target = compact(old_norm)
            for i in range(len(cands)):
                acc = ""
                # up to 10 pieces: a list the old extractor kept as one paragraph
                # ("o Alphabet size\no H(x)\n…") is now one block per item
                for k in range(i, min(i + 10, len(cands))):
                    acc += compact(cands[k]["text"])
                    if acc == target and k > i:
                        group = cands[i:k + 1]
                        lines = [ln for ln in t["text"].split("\n")]
                        texts = [g for g in group if g["type"] != "formula"]
                        out: dict[int, str] = {}
                        for g in group:
                            if g["type"] == "formula":
                                if lines and compact(lines[0]) == compact(g["text"]):
                                    lines.pop(0)
                                continue
                            if g is texts[-1]:
                                out[g["id"]] = "\n".join(lines).strip()
                            elif lines:
                                out[g["id"]] = lines.pop(0).strip()
                        if all(out.values()) and out:
                            split_assign[(t["block_id"], t["lang"])] = out
                        break
                    if len(acc) >= len(target):
                        break
                if (t["block_id"], t["lang"]) in split_assign:
                    break
        # blocks the old extractor had split but the new one keeps together
        # (e.g. a mostly-bold body line): join the old translations
        assigned_new = mapped_new | {nb for d in split_assign.values() for nb in d}
        consumed_old = set(remap) | {k[0] for k in split_assign}
        trans_by: dict[int, dict[str, sqlite3.Row]] = {}
        for t in old_trans:
            trans_by.setdefault(t["block_id"], {})[t["lang"]] = t
        old_by_page: dict[int, list] = {}
        for r in old_rows:
            old_by_page.setdefault(r["page_no"], []).append(r)
        merge_rows: list[tuple] = []
        for r in new_rows:
            if r["id"] in assigned_new or r["type"] in ("formula", "image", "table", "code"):
                continue
            target = compact(r["text"])
            cands = [o for o in old_by_page.get(r["page_no"], []) if o["id"] not in consumed_old]
            done_merge = False
            for i in range(len(cands)):
                if not target.startswith(compact(cands[i]["text"])) or not compact(cands[i]["text"]):
                    continue
                acc = ""
                for k in range(i, min(i + 4, len(cands))):
                    acc += compact(cands[k]["text"])
                    if acc == target and k > i:
                        group = cands[i:k + 1]
                        langs = {lg for g in group for lg in trans_by.get(g["id"], {})}
                        for lg in langs:
                            parts = [trans_by[g["id"]][lg] for g in group if lg in trans_by.get(g["id"], {})]
                            sep = "" if lg.lower().startswith(("zh", "ja", "ko")) else " "
                            text = sep.join(p["text"].strip() for p in parts)
                            merge_rows.append((r["id"], lg, parts[0]["model"], parts[0]["prompt_ver"], text,
                                               max(p["edited"] for p in parts)))
                        for g in group:  # notes follow the merged block
                            consumed_old.add(g["id"])
                            remap_notes[g["id"]] = r["id"]
                        done_merge = True
                        break
                    if not target.startswith(acc):
                        break
                if done_merge:
                    break
        for row in merge_rows:
            db.execute(
                "INSERT OR IGNORE INTO translations (block_id, lang, model, prompt_ver, text, edited, cache_key)"
                " VALUES (?,?,?,?,?,?,NULL)",
                row,
            )
            kept += 1
        for t in old_trans:
            for nb, text in split_assign.get((t["block_id"], t["lang"]), {}).items():
                db.execute(
                    "INSERT OR IGNORE INTO translations (block_id, lang, model, prompt_ver, text, edited, cache_key)"
                    " VALUES (?,?,?,?,?,?,NULL)",
                    (nb, t["lang"], t["model"], t["prompt_ver"], text, t["edited"]),
                )
                kept += 1
        for t in old_trans:
            nb = remap.get(t["block_id"])
            if nb is None:
                continue
            db.execute(
                "INSERT OR IGNORE INTO translations (block_id, lang, model, prompt_ver, text, edited, cache_key,"
                " created_at, updated_at, layout_json) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (nb, t["lang"], t["model"], t["prompt_ver"], t["text"], t["edited"], t["cache_key"],
                 t["created_at"], t["updated_at"], t["layout_json"]),
            )
            kept += 1
        for n in old_notes:
            nb = remap.get(n["block_id"]) or remap_notes.get(n["block_id"])
            db.execute("UPDATE notes SET block_id=? WHERE id=?", (nb, n["id"]))
        _renumber_placeholders(db, doc_id, old_runs, _page_runs(db, doc_id))
        _fix_absorbed_brackets(db, doc_id)
    return kept


def _page_runs(db, doc_id: int) -> dict[int, list[dict]]:
    """page_no → math runs of the stored extraction."""
    out: dict[int, list[dict]] = {}
    for pg in db.execute("SELECT page_no, extract_json FROM pages WHERE doc_id=?", (doc_id,)):
        try:
            out[pg["page_no"]] = json.loads(pg["extract_json"] or "{}").get("math_runs", []) or []
        except Exception:
            out[pg["page_no"]] = []
    return out


def _run_map(old: list[dict], new: list[dict]) -> dict[str, str]:
    """Old formula id → the new formula at the same place (several old pieces of
    one formula can now be one run). ``new``: the candidates (e.g. the runs of one block)."""
    out: dict[str, str] = {}
    for o in old:
        ob = o.get("bbox") or [0, 0, 0, 0]
        cx, cy = (ob[0] + ob[2]) / 2, (ob[1] + ob[3]) / 2
        best = None
        for n in new:
            nb = n.get("bbox") or [0, 0, 0, 0]
            inside = nb[0] - 1 <= cx <= nb[2] + 1 and nb[1] - 1 <= cy <= nb[3] + 1
            ncx, ncy = (nb[0] + nb[2]) / 2, (nb[1] + nb[3]) / 2
            # inside a box first (smallest box wins), else the nearest box
            key = (0, (nb[2] - nb[0]) * (nb[3] - nb[1])) if inside else (1, (ncx - cx) ** 2 + (ncy - cy) ** 2)
            if best is None or key < best[0]:
                best = (key, n["id"])
        if best and (best[0][0] == 0 or best[0][1] < 60 ** 2):
            out[o["id"]] = best[1]
    return out


def _renumber_placeholders(db, doc_id: int, old_runs: dict, new_runs: dict) -> None:
    """Kept translations still name the formulas by their old ids ({{m18}}); the new
    extraction may number them differently (pieces of a fraction merged into one, or
    one old run that really was two formulas). Each translation is matched against the
    formulas of its *own* block."""
    same = all(
        [(r["id"], r.get("bbox")) for r in old_runs.get(pg, [])] == [(r["id"], r.get("bbox")) for r in runs]
        for pg, runs in new_runs.items()
    )
    if same:
        return
    rows = db.execute(
        "SELECT t.id, t.text, b.page_no, b.meta_json FROM translations t JOIN blocks b ON b.id=t.block_id"
        " WHERE b.doc_id=? AND t.text LIKE '%{{m%'", (doc_id,)
    ).fetchall()
    for r in rows:
        try:
            ph = json.loads(r["meta_json"] or "{}").get("ph") or ""
        except Exception:
            ph = ""
        want = re.findall(r"\{\{(m\d+)\}\}", ph)
        have = re.findall(r"\{\{(m\d+)\}\}", r["text"])
        if sorted(want) == sorted(have):
            continue
        olds = {o["id"]: o for o in old_runs.get(r["page_no"], [])}
        news = [n for n in new_runs.get(r["page_no"], []) if n["id"] in want]
        m = _run_map([olds[h] for h in have if h in olds], news)
        if len(have) == len(want) and len(set(m.get(h) for h in have)) < len(want):
            m = dict(zip(have, want))  # same count, ambiguous places: keep the order
        seen: set[str] = set()

        def sub(mt):
            rid = m.get(mt.group(1))
            if rid is None or rid in seen:
                return ""  # a piece of a formula that is now one picture, or gone
            seen.add(rid)
            return "{{" + rid + "}}"

        new = re.sub(r"\{\{(m\d+)\}\}", sub, r["text"])
        missing = [w for w in want if w not in seen]
        if missing:  # a formula the old translation did not have (merged in now)
            new = new.rstrip() + " " + " ".join("{{" + w + "}}" for w in missing)
        if new != r["text"]:
            db.execute("UPDATE translations SET text=? WHERE id=?", (new, r["id"]))


def _fix_absorbed_brackets(db, doc_id: int) -> None:
    """A bracket that now belongs to a formula ("[1 1 0 1" + "]") must not stay
    next to its placeholder in a kept translation, or it shows twice."""
    rows = db.execute(
        "SELECT t.id, t.text, b.meta_json, b.page_id FROM translations t JOIN blocks b ON b.id=t.block_id"
        " WHERE b.doc_id=? AND t.text LIKE '%{{m%'", (doc_id,)
    ).fetchall()
    run_text: dict[int, dict[str, str]] = {}
    for r in rows:
        if r["page_id"] not in run_text:
            pg = db.execute("SELECT extract_json FROM pages WHERE id=?", (r["page_id"],)).fetchone()
            try:
                runs = json.loads(pg["extract_json"] or "{}").get("math_runs", []) if pg else []
            except Exception:
                runs = []
            run_text[r["page_id"]] = {m["id"]: m.get("text") or "" for m in runs}
        texts = run_text[r["page_id"]]
        new = r["text"]
        for rid in set(re.findall(r"\{\{(m\d+)\}\}", new)):
            t = texts.get(rid, "").strip()
            if not t:
                continue  # a placeholder of a run that no longer exists ("" is in every string)
            ph = "{{" + rid + "}}"
            if t[-1:] in ")]}|" and ph + t[-1] in new:
                new = new.replace(ph + t[-1], ph)
            if t[:1] in "([{|" and t[0] + ph in new:
                new = new.replace(t[0] + ph, ph)
        if new != r["text"]:
            db.execute("UPDATE translations SET text=? WHERE id=?", (new, r["id"]))


UPGRADE = {"left": 0}  # documents still waiting for the new extractor (shown by /api/health)


def stale_documents() -> list[int]:
    """Documents extracted by an older extractor version."""
    with get_db() as db:
        docs = db.execute("SELECT id FROM documents WHERE status='ready'").fetchall()
        stale = []
        for d in docs:
            pg = db.execute(
                "SELECT extract_json FROM pages WHERE doc_id=? ORDER BY page_no LIMIT 1", (d["id"],)
            ).fetchone()
            try:
                ver = json.loads(pg["extract_json"] or "{}").get("ver", 1) if pg else EXTRACT_VER
            except Exception:
                ver = 1
            if ver < EXTRACT_VER:
                stale.append(d["id"])
    return stale


def upgrade_old_documents(background: bool = False) -> None:
    """Startup: re-parse docs extracted by an older extractor version.

    ``background``: in a thread, so a big library does not hold up the start of the
    app after an update — the page shows a notice until ``UPGRADE["left"]`` is 0.
    """
    stale = stale_documents()
    UPGRADE["left"] = len(stale)

    def run() -> None:
        for doc_id in stale:
            try:
                kept = reextract_document(doc_id)
                print(f"[upgrade] re-extracted document {doc_id} (kept {kept} translations)")
            except Exception as e:  # never block startup
                print(f"[upgrade] document {doc_id} failed: {e}")
            UPGRADE["left"] = max(0, UPGRADE["left"] - 1)
        try:
            migrate_formula_placeholders()
        except Exception as e:
            print(f"[upgrade] placeholder migration failed: {e}")
        UPGRADE["left"] = 0

    if background and stale:
        import threading

        threading.Thread(target=run, name="upgrade-documents", daemon=True).start()
    else:
        run()


def migrate_formula_placeholders() -> int:
    """Startup: give pre-placeholder translations their formula placeholders back."""
    fixed = 0
    with get_db() as db:
        rows = db.execute(
            "SELECT t.id, t.text, b.meta_json, b.page_id FROM translations t JOIN blocks b ON b.id=t.block_id"
            " WHERE b.meta_json LIKE '%\"ph\"%' AND t.text NOT LIKE '%{{m%'"
        ).fetchall()
        runs_by_page: dict[int, dict] = {}
        for r in rows:
            meta = json.loads(r["meta_json"] or "{}")
            ids = [m["id"] for m in meta.get("math", [])]
            if not ids:
                continue
            if r["page_id"] not in runs_by_page:  # run texts live in the page payload
                pg = db.execute("SELECT extract_json FROM pages WHERE id=?", (r["page_id"],)).fetchone()
                payload = json.loads(pg["extract_json"] or "{}") if pg else {}
                runs_by_page[r["page_id"]] = {m["id"]: m for m in payload.get("math_runs", [])}
            runs = [runs_by_page[r["page_id"]][i] for i in ids if i in runs_by_page[r["page_id"]]]
            new = restore_placeholders(r["text"], runs)
            if new and new != r["text"]:
                db.execute("UPDATE translations SET text=? WHERE id=?", (new, r["id"]))
                fixed += 1
        # headings that used to be split over two PDF lines (Word tab stops) are one
        # line now — old translations still carry the line break and get squeezed
        heads = db.execute(
            "SELECT t.id, t.text FROM translations t JOIN blocks b ON b.id=t.block_id"
            " WHERE b.type NOT IN ('table','formula') AND instr(b.text, char(10))=0 AND instr(t.text, char(10))>0"
        ).fetchall()
        for h in heads:
            db.execute("UPDATE translations SET text=? WHERE id=?", ("  ".join(x.strip() for x in h["text"].split("\n")), h["id"]))
    if fixed:
        print(f"[upgrade] restored formula placeholders in {fixed} translations")
    return fixed


@router.post("/{doc_id}/reextract")
def reextract(doc_id: int):
    with get_db() as db:
        if db.execute("SELECT id FROM documents WHERE id=?", (doc_id,)).fetchone() is None:
            raise HTTPException(404, "文档不存在")
        busy = db.execute(
            "SELECT id FROM jobs WHERE doc_id=? AND status IN ('pending','running')", (doc_id,)
        ).fetchone()
    if busy:
        raise HTTPException(409, "该文档有正在进行的任务，请稍后再试")
    return {"ok": True, "kept_translations": reextract_document(doc_id)}


@router.get("/{doc_id}")
def get_document(doc_id: int):
    with get_db() as db:
        row = db.execute("SELECT * FROM documents WHERE id=?", (doc_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "文档不存在")
        edits = db.execute(
            "SELECT COUNT(*) AS n FROM translations t JOIN blocks b ON b.id=t.block_id"
            " WHERE b.doc_id=? AND t.lang='__src__' AND (t.text != '' OR t.layout_json IS NOT NULL)", (doc_id,)
        ).fetchone()
    try:
        # only bookkeeping: opening a document must never fail because something else is writing
        with get_db() as db:
            db.execute("PRAGMA busy_timeout=1500")
            db.execute("UPDATE documents SET last_opened_at=datetime('now') WHERE id=?", (doc_id,))
    except Exception:
        pass
    return {**dict(row), "src_edits": edits["n"]}  # blocks of the original the reader has edited


@router.get("/{doc_id}/file")
def get_document_file(doc_id: int):
    from fastapi.responses import FileResponse

    with get_db() as db:
        row = db.execute("SELECT file_path, title FROM documents WHERE id=?", (doc_id,)).fetchone()
    if row is None or not row["file_path"] or not Path(row["file_path"]).exists():
        raise HTTPException(404, "文件不存在")
    return FileResponse(row["file_path"], media_type="application/pdf", filename=row["title"] + ".pdf")


@router.get("/{doc_id}/images/{fname}")
def get_document_image(doc_id: int, fname: str):
    from fastapi.responses import FileResponse

    safe = Path(fname).name
    path = _doc_dir(doc_id) / "images" / safe
    if not path.exists():
        raise HTTPException(404, "图片不存在")
    return FileResponse(path)


@router.post("/{doc_id}/extract-terms")
def extract_terms(doc_id: int):
    from ..services.glossary_extract import start_extract_terms

    with get_db() as db:
        doc = db.execute("SELECT id FROM documents WHERE id=?", (doc_id,)).fetchone()
    if doc is None:
        raise HTTPException(404, "文档不存在")
    return {"job_id": start_extract_terms(doc_id)}


@router.delete("/{doc_id}")
def delete_document(doc_id: int):
    with get_db() as db:
        row = db.execute("SELECT id FROM documents WHERE id=?", (doc_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "文档不存在")
        db.execute("DELETE FROM documents WHERE id=?", (doc_id,))
    shutil.rmtree(_doc_dir(doc_id), ignore_errors=True)
    return {"ok": True}
