"""Tall ruled table cells rejoined; translations that kept English are retried."""
from __future__ import annotations

import asyncio
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pymupdf as fitz

from app.services.extract import _merge_wrapped_rows


def _rubric(lines_a, lines_b, y0=340.0, pitch=13.0):
    """find_tables output for a tall two-column cell: one 'row' per text line."""
    cells = [{"row": 0, "col": 0, "bbox": [48, 322, 128, 340]}, {"row": 0, "col": 1, "bbox": [128, 322, 213, 340]}]
    words = [(50, 325, 90, 337, "Grade"), (92, 325, 100, 337, "A"), (130, 325, 170, 337, "Grade"), (172, 325, 180, 337, "B")]
    for i, (a, b) in enumerate(zip(lines_a, lines_b)):
        y = y0 + i * pitch
        cells += [{"row": i + 1, "col": 0, "bbox": [48, y, 128, y + pitch]},
                  {"row": i + 1, "col": 1, "bbox": [128, y, 213, y + pitch]}]
        x = 50
        for w in a.split():
            words.append((x, y + 2, x + 6 * len(w), y + 11, w))
            x += 6 * len(w) + 3
        x = 130
        for w in b.split():
            words.append((x, y + 2, x + 6 * len(w), y + 11, w))
            x += 6 * len(w) + 3
    bottom = y0 + len(lines_a) * pitch + 8
    hs = [(312.6, 43, 214), (339.5, 43, 214), (bottom, 43, 214)]
    vs = [(42.2, 313, bottom), (127.3, 313, 339), (127.3, 340, bottom), (213.5, 313, bottom)]
    return cells, len(lines_a) + 1, (hs, vs), words


def test_wrapped_lines_of_a_tall_cell_become_one_cell():
    a = ["Reasonable", "understanding of", "the problem", "with minor", "errors."]
    b = ["Adequate", "understanding of", "the problem, but", "contains some", "omissions."]
    cells, n, rules, words = _rubric(a, b)
    n2, out = _merge_wrapped_rows(cells, n, rules, words)
    assert n2 == 2
    body = [c for c in out if c["row"] == 1]
    assert len(body) == 2 and body[0]["bbox"][3] > 340 + 5 * 13  # reaches the bottom rule


def test_one_record_per_line_tables_are_left_alone():
    a = ["Rectangular", "Triangular", "Gaussian", "Sinc"]
    b = ["T sinc(fT).", "T sinc2(fT).", "Gaussian.", "Rect."]
    cells, n, rules, words = _rubric(a, b)
    assert _merge_wrapped_rows(cells, n, rules, words)[0] == n
    # and without vertical rules (booktabs style) nothing is merged either
    a2 = ["Reasonable", "understanding of", "the problem"]
    cells, n, (hs, _vs), words = _rubric(a2, a2)
    assert _merge_wrapped_rows(cells, n, (hs, []), words)[0] == n


def test_worker_retries_blocks_left_in_english(tmp_path, monkeypatch):
    from app.db import get_db, init_db
    from app.services import translate_worker as tw
    from app.services.extract import extract_page
    from app.services.structure import build_blocks

    init_db()
    pdf = tmp_path / "l.pdf"
    d = fitz.open()
    p = d.new_page()
    p.insert_textbox(fitz.Rect(72, 72, 520, 120), "The receiver samples the signal twice per symbol period.", fontsize=11)
    p.insert_textbox(fitz.Rect(72, 140, 520, 200), "No more than one or two minor errors are allowed in the report.", fontsize=11)
    d.save(str(pdf))
    with get_db() as db:
        doc_id = db.execute("INSERT INTO documents (title, file_path, status) VALUES ('l', ?, 'ready')", (str(pdf),)).lastrowid
        payload = extract_page(fitz.open(pdf).load_page(0), None)
        pid = db.execute("INSERT INTO pages (doc_id, page_no, width, height, extract_json) VALUES (?,1,?,?,?)",
                         (doc_id, payload["width"], payload["height"], json.dumps(payload))).lastrowid
        for b in build_blocks(payload, 1):
            db.execute(
                "INSERT INTO blocks (doc_id, page_id, page_no, order_idx, type, level, bbox_json, style_json,"
                " meta_json, text, font_size, bold, list_marker, stable_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (doc_id, pid, 1, b["order_idx"], b["type"], b["level"], json.dumps(b["bbox"]),
                 json.dumps(b["style"]), json.dumps(b["meta"]), b["text"], b["font_size"], b["bold"],
                 b["list_marker"], b["stable_key"]))
    calls = []

    async def lazy_then_good(cfg, messages, **kw):
        user = messages[-1]["content"]
        calls.append(user)
        if "still contain untranslated English" in user:
            ids = [int(x) for x in re.findall(r"\d+", user.split("Blocks", 1)[1].split("still")[0])]
            return json.dumps({"translations": [{"id": i, "translation": "报告中最多允许一两个小错误。"} for i in ids]},
                              ensure_ascii=False)
        out = []
        for m in re.finditer(r"<<<id=(\d+) type=\w+(?: sentences=\d+)?>>>\n(.*?)(?=\n\n<<<id=|\Z)", user, re.S):
            bid, text = int(m.group(1)), m.group(2)
            # the model "forgets" the second block and copies it back in English
            out.append({"id": bid, "translation": text if "minor errors" in text else "接收机每个符号周期对信号采样两次。"})
        return json.dumps({"translations": out}, ensure_ascii=False)

    monkeypatch.setattr(tw, "chat_completion", lazy_then_good)
    job = tw.create_job(doc_id, "translate", 0, {"scope": "doc"})
    asyncio.run(tw.run_translate_job(job, doc_id, {"scope": "doc"}))
    with get_db() as db:
        rows = db.execute("SELECT b.text, t.text AS tr FROM blocks b JOIN translations t ON t.block_id=b.id"
                          " WHERE b.doc_id=? ORDER BY b.order_idx", (doc_id,)).fetchall()
    assert [r["tr"] for r in rows] == ["接收机每个符号周期对信号采样两次。", "报告中最多允许一两个小错误。"]
    assert len(calls) == 2  # one batch + one follow-up for the block left in English
