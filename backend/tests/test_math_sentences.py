"""Formula placeholders, sentence alignment, translation worker (mocked LLM), polish, facing export."""
from __future__ import annotations

import asyncio
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pymupdf as fitz

from app.services.extract import _assign_math_runs
from app.services.sentence_split import auto_align, join_units, sentence_units
from app.services.structure import build_blocks


def _span(text, x0, x1, font="Calibri", size=11.0, y=100.0):
    return {"text": text, "font": font, "size": size, "flags": 0, "color": 0,
            "origin": [x0, y], "bbox": [x0, y - 0.85 * size, x1, y + 0.25 * size]}


def _payload(lines):
    raw = [{"type": 0, "bbox": [0, 0, 500, 300], "lines": [
        {"bbox": [min(s["bbox"][0] for s in spans), min(s["bbox"][1] for s in spans),
                  max(s["bbox"][2] for s in spans), max(s["bbox"][3] for s in spans)], "spans": spans}
        for spans in lines]}]
    runs = _assign_math_runs(raw, [0])
    return {"width": 595, "height": 842, "raw_blocks": raw, "images": [], "tables": [], "math_runs": runs}


def test_inline_math_becomes_placeholder_and_display_math_a_formula_block():
    payload = _payload([
        [_span("The pulse width is ", 50, 140), _span("𝑇𝑝", 140, 152, font="CambriaMath"),
         _span(" and it starts at ", 152, 230), _span("𝑡= 0", 230, 255, font="CambriaMath"), _span(".", 255, 258)],
        [_span("ℎ(𝑡) = 𝑓(𝑡) + 𝑔(𝑡)", 150, 300, font="CambriaMath", y=116)],
    ])
    blocks = build_blocks(payload, 1)
    para = next(b for b in blocks if b["type"] == "paragraph")
    formula = next(b for b in blocks if b["type"] == "formula")
    assert re.fullmatch(r"The pulse width is \{\{m\d+\}\} and it starts at \{\{m\d+\}\}\.", para["meta"]["ph"])
    assert len(para["meta"]["math"]) == 2
    assert formula["meta"]["ph"].startswith("{{m") and formula["bbox"][0] >= 149
    # bullets from Symbol fonts are not formulas
    p2 = _payload([[_span("•", 40, 45, font="Symbol"), _span(" Code – a single file", 48, 200)]])
    assert "ph" not in build_blocks(p2, 1)[0]["meta"]


def test_sentence_units_rejoin_pdf_lines_and_keep_items():
    t = "1.1.\nPlot the pulse (Fig. 1(a) for Pulse A)\n1.2.\nFind the DFT using fft() then apply fftshift() to centre the\ntransform. Adjust the axis."
    u = sentence_units(t)
    assert [s for _, s in u] == [
        "1.1. Plot the pulse (Fig. 1(a) for Pulse A)",
        "1.2. Find the DFT using fft() then apply fftshift() to centre the transform.",
        "Adjust the axis.",
    ]
    assert join_units([a for a, _ in u], ["一", "二", "三"], "zh") == "一\n二三"
    assert auto_align("One. Two.", "一。二。") == [("One.", "一。"), ("Two.", "二。")]
    assert auto_align("One. Two.", "一二。") is None


def _make_doc(tmp_path: Path) -> int:
    from app.db import get_db, init_db
    from app.services.extract import extract_page

    init_db()
    pdf_path = tmp_path / "doc.pdf"
    d = fitz.open()
    p = d.new_page()
    p.insert_text((72, 72), "Introduction", fontsize=18)
    p.insert_textbox(fitz.Rect(72, 90, 520, 160), "This is the first sentence. Here is the second one. And a third.", fontsize=11)
    p.insert_textbox(fitz.Rect(72, 170, 520, 200), "A single sentence about the pulse.", fontsize=11)
    d.save(str(pdf_path))
    with get_db() as db:
        doc_id = db.execute(
            "INSERT INTO documents (title, file_path, status) VALUES ('t', ?, 'ready')", (str(pdf_path),)
        ).lastrowid
        payload = extract_page(fitz.open(pdf_path).load_page(0), None)
        pid = db.execute(
            "INSERT INTO pages (doc_id, page_no, width, height, extract_json) VALUES (?,1,?,?,?)",
            (doc_id, payload["width"], payload["height"], json.dumps(payload)),
        ).lastrowid
        for b in build_blocks(payload, 1):
            db.execute(
                "INSERT INTO blocks (doc_id, page_id, page_no, order_idx, type, level, bbox_json, style_json,"
                " meta_json, text, font_size, bold, list_marker, stable_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (doc_id, pid, 1, b["order_idx"], b["type"], b["level"], json.dumps(b["bbox"]),
                 json.dumps(b["style"]), json.dumps(b["meta"]), b["text"], b["font_size"], b["bold"],
                 b["list_marker"], b["stable_key"]),
            )
    return doc_id


def _fake_llm(fail_ids=()):
    async def fake(cfg, messages, **kw):
        user = messages[-1]["content"]
        out = []
        for m in re.finditer(r"<<<id=(\d+) type=\w+(?: sentences=(\d+))?>>>\n(.*?)(?=\n\n<<<id=|\Z)", user, re.S):
            bid = int(m.group(1))
            if bid in fail_ids:
                continue
            if m.group(2):
                sents = re.findall(r"^\[\d+\] (.*)$", m.group(3), re.M)
                out.append({"id": bid, "sentences": ["译" + s for s in sents]})
            else:
                out.append({"id": bid, "translation": "译" + m.group(3)})
        return json.dumps({"translations": out}, ensure_ascii=False)
    return fake


def test_worker_stores_sentence_pairs_and_failed_ids(tmp_path, monkeypatch):
    from app.db import get_db
    from app.services import translate_worker as tw

    doc_id = _make_doc(tmp_path)
    with get_db() as db:
        ids = [r["id"] for r in db.execute("SELECT id FROM blocks WHERE doc_id=? ORDER BY order_idx", (doc_id,))]
    fail = ids[-1]
    monkeypatch.setattr(tw, "chat_completion", _fake_llm(fail_ids={fail}))
    job = tw.create_job(doc_id, "translate", 0, {"scope": "doc"})
    asyncio.run(tw.run_translate_job(job, doc_id, {"scope": "doc"}))
    with get_db() as db:
        j = db.execute("SELECT status, result_json FROM jobs WHERE id=?", (job,)).fetchone()
        sents = db.execute("SELECT src_text, tgt_text FROM sentences WHERE block_id=? ORDER BY idx", (ids[1],)).fetchall()
        tr = db.execute("SELECT text FROM translations WHERE block_id=?", (ids[1],)).fetchone()
    assert j["status"] == "done_with_errors"
    assert json.loads(j["result_json"])["failed_ids"] == [fail]
    assert [s["src_text"] for s in sents] == ["This is the first sentence.", "Here is the second one.", "And a third."]
    assert tr["text"] == "".join(s["tgt_text"] for s in sents)  # zh: joined without spaces


def test_placeholder_repair():
    from app.services.translate_worker import repair_placeholders

    assert repair_placeholders("宽度为 {{m1}}。", ["{{m1}}"]) == "宽度为 {{m1}}。"
    assert repair_placeholders("宽度为。", ["{{m1}}"]) == "宽度为。 {{m1}}"
    assert repair_placeholders("x {{m9}} y {{m1}}", ["{{m1}}"]) == "x  y {{m1}}"


def test_polish_enforces_glossary(tmp_path, monkeypatch):
    from app.db import get_db
    from app.services import polish

    doc_id = _make_doc(tmp_path)
    with get_db() as db:
        bid = db.execute("SELECT id FROM blocks WHERE doc_id=? AND text LIKE '%pulse%'", (doc_id,)).fetchone()["id"]
        db.execute("INSERT INTO translations (block_id, lang, text) VALUES (?, 'zh', '一句关于冲激的话。')", (bid,))
        db.execute("INSERT INTO glossary (doc_id, src_term, tgt_term, status) VALUES (NULL, 'pulse', '脉冲', 'approved')")

    async def fake(cfg, messages, **kw):
        ids = re.findall(r"<<<id=(\d+)>>>", messages[-1]["content"])
        return json.dumps({"revisions": [{"id": int(i), "translation": "一句关于脉冲的话。"} for i in ids]})

    monkeypatch.setattr(polish, "chat_completion", fake)
    items, _ = polish.find_candidates(doc_id, "zh")
    assert [i["id"] for i in items] == [bid]
    job = polish.create_job(doc_id, "polish", 0, {})
    asyncio.run(polish.run_polish_job(job, doc_id))
    with get_db() as db:
        assert db.execute("SELECT text FROM translations WHERE block_id=?", (bid,)).fetchone()["text"] == "一句关于脉冲的话。"
        res = json.loads(db.execute("SELECT result_json FROM jobs WHERE id=?", (job,)).fetchone()["result_json"])
    assert res["changed_ids"] == [bid]


def test_facing_exports(tmp_path):
    from app.db import get_db
    from app.services.export_pdf_facing import export_facing_pdf

    doc_id = _make_doc(tmp_path)
    with get_db() as db:
        for r in db.execute("SELECT id FROM blocks WHERE doc_id=?", (doc_id,)).fetchall():
            db.execute("INSERT INTO translations (block_id, lang, text) VALUES (?, 'zh', '译文')", (r["id"],))
    side = export_facing_pdf(doc_id, tmp_path / "side.pdf", "zh", "side_by_side")
    alt = export_facing_pdf(doc_id, tmp_path / "alt.pdf", "zh", "alternate")
    with fitz.open(side) as s, fitz.open(alt) as a:
        assert s.page_count == 1 and s[0].rect.width > 2 * 595
        assert a.page_count == 2
        assert "Introduction" in a[0].get_text() and "Introduction" not in a[1].get_text()
