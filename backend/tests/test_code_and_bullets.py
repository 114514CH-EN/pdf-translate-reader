"""Code listings (only comments translated), Courier "o" sub-bullets, brackets kept with formulas."""
from __future__ import annotations

import asyncio
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pymupdf as fitz

from app.services import code_blocks
from app.services.extract import _absorb_brackets, extract_page
from app.services.structure import build_blocks, comment_start

LISTING = [
    ("data = load('samples.csv');", "% Load the samples"),
    ("n = numel(data);", "% Count the samples"),
    ("for k = 1:n", None),
    ("    total = total + data(k);", "% Add each sample"),
    ("end", None),
]


def _listing_page() -> fitz.Page:
    d = fitz.open()
    p = d.new_page()
    p.insert_text((72, 80), "Use the following code to sum the samples:", fontname="helv", fontsize=11)
    y = 104
    for code, comment in LISTING:
        p.insert_text((80, y), code, fontname="cour", fontsize=10)
        if comment:
            p.insert_text((80 + 34 * 6.0, y), comment, fontname="cour", fontsize=10, color=(0, 0.5, 0))
        y += 12
    p.insert_text((72, y + 16), "Then report the total.", fontname="helv", fontsize=11)
    # second-level bullets as Word writes them: a Courier "o", a tab, then the text
    for i, item in enumerate(["Alphabet size", "Entropy in bits", "Average length"]):
        yy = y + 50 + i * 20.6
        p.insert_text((90, yy), "o", fontname="cour", fontsize=11)
        p.insert_text((108, yy), item, fontname="helv", fontsize=11)
    return p


def test_listing_becomes_a_code_block_with_comment_columns():
    blocks = build_blocks(extract_page(_listing_page(), None), 1)
    code = [b for b in blocks if b["type"] == "code"]
    assert len(code) == 1
    b = code[0]
    lines = b["text"].split("\n")
    assert len(lines) == len(LISTING)
    assert lines[3].startswith("    total = total")  # indentation kept
    info = b["meta"]["code"]["lines"]
    assert [i.get("ci") is not None for i in info] == [c is not None for _, c in LISTING]
    # every comment starts in the same column, at the comment's x on the page
    cxs = {round(i["cx"]) for i in info if "cx" in i}
    assert len(cxs) == 1 and abs(cxs.pop() - (80 + 34 * 6.0)) < 2
    assert all(i["cc"] != 0 for i in info if "cx" in i)  # green comments
    # the prose around it is not code
    assert any(x["type"] == "paragraph" and "following code" in x["text"] for x in blocks)


def test_courier_o_sub_bullets_are_list_items():
    blocks = build_blocks(extract_page(_listing_page(), None), 1)
    items = [b for b in blocks if b.get("list_marker") == "o"]
    assert [" ".join(b["text"].split()) for b in items] == ["o Alphabet size", "o Entropy in bits", "o Average length"]
    assert all(b["type"] == "list" and (b["meta"].get("hang") or 0) > 10 for b in items)


def test_item_gaps_count_marker_lines():
    from app.services.structure import _item_gaps

    # an "o" line starts an item even though "o" is not a regex marker on its own text
    geo = [("o Alpha", [90, 100, 150, 113], True), ("continued", [90, 114, 150, 127], False),
           ("o Beta", [90, 134, 150, 147], True)]
    assert _item_gaps(geo, 11) == [0.0, 6.0]


def test_comment_detection():
    assert comment_start("x = a' * b;  % transpose") == 13
    assert comment_start("y = a % b") is None  # modulo, not a comment
    assert comment_start("fprintf('%d items', n);") is None  # inside a string
    assert comment_start("for i in range(3):  # loop over items") == 20
    assert comment_start("#include <stdio.h>") is None
    assert comment_start("int k = 0; // the counter") == 11


def test_code_translation_round_trip():
    text = "\n".join((c + "   " + m) if m else c for c, m in LISTING)
    ci = [len(c) + 3 if m else None for c, m in LISTING]
    meta = {"code": {"lines": [{"ci": x} if x is not None else {} for x in ci]}}
    units = code_blocks.comment_units(text, meta)
    assert units == ["Load the samples", "Count the samples", "Add each sample"]
    out = code_blocks.rebuild(text, meta, ["载入样本", "% 统计样本数", "累加每个样本"])
    assert out.split("\n")[0] == "data = load('samples.csv');   % 载入样本"
    assert out.split("\n")[1].endswith("% 统计样本数") and "% %" not in out
    assert out.split("\n")[2] == "for k = 1:n"
    assert code_blocks.translation_fits(text, out, meta)
    # a listing translated as one paragraph (old extractor) does not fit
    assert not code_blocks.translation_fits(text, "data = load(...)；% 载入样本 n = numel(data)；", meta)


def test_worker_translates_only_comments(tmp_path, monkeypatch):
    from app.db import get_db, init_db
    from app.services import translate_worker as tw

    init_db()
    pdf_path = tmp_path / "code.pdf"
    _listing_page().parent.save(str(pdf_path))
    with get_db() as db:
        doc_id = db.execute("INSERT INTO documents (title, file_path, status) VALUES ('c', ?, 'ready')",
                            (str(pdf_path),)).lastrowid
        payload = extract_page(fitz.open(pdf_path).load_page(0), None)
        pid = db.execute("INSERT INTO pages (doc_id, page_no, width, height, extract_json) VALUES (?,1,?,?,?)",
                         (doc_id, payload["width"], payload["height"], json.dumps(payload))).lastrowid
        for b in build_blocks(payload, 1):
            db.execute(
                "INSERT INTO blocks (doc_id, page_id, page_no, order_idx, type, level, bbox_json, style_json,"
                " meta_json, text, font_size, bold, list_marker, stable_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (doc_id, pid, 1, b["order_idx"], b["type"], b["level"], json.dumps(b["bbox"]),
                 json.dumps(b["style"]), json.dumps(b["meta"]), b["text"], b["font_size"], b["bold"],
                 b["list_marker"], b["stable_key"]))
    sent = {}

    async def fake(cfg, messages, **kw):
        user = messages[-1]["content"]
        out = []
        for m in re.finditer(r"<<<id=(\d+) type=(\w+)(?: sentences=(\d+))?>>>\n(.*?)(?=\n\n<<<id=|\Z)", user, re.S):
            bid, typ = int(m.group(1)), m.group(2)
            if typ == "code":
                sent["code"] = m.group(4)
            if m.group(3):
                out.append({"id": bid, "sentences": ["译" + s for s in re.findall(r"^\[\d+\] (.*)$", m.group(4), re.M)]})
            else:
                out.append({"id": bid, "translation": "译" + m.group(4)})
        return json.dumps({"translations": out}, ensure_ascii=False)

    monkeypatch.setattr(tw, "chat_completion", fake)
    job = tw.create_job(doc_id, "translate", 0, {"scope": "doc"})
    asyncio.run(tw.run_translate_job(job, doc_id, {"scope": "doc"}))
    with get_db() as db:
        row = db.execute("SELECT b.text, b.meta_json, t.text AS tr FROM blocks b JOIN translations t ON t.block_id=b.id"
                         " WHERE b.doc_id=? AND b.type='code'", (doc_id,)).fetchone()
    # the model saw the comments only — never the code
    assert "load(" not in sent["code"] and "Load the samples" in sent["code"]
    lines = row["tr"].split("\n")
    assert lines[0].startswith("data = load('samples.csv');") and lines[0].endswith("% 译Load the samples")
    assert lines[2] == "for k = 1:n" and lines[4] == "end"
    assert code_blocks.translation_fits(row["text"], row["tr"], json.loads(row["meta_json"]))


def _span(text, x0, x1, font):
    return {"text": text, "font": font, "size": 11.0, "flags": 0, "color": 0,
            "origin": [x0, 100], "bbox": [x0, 90, x1, 103]}


def test_closing_bracket_joins_the_formula():
    spans = [_span("when ", 250, 276, "Calibri"), _span("[1 1 0 1", 276, 310, "CambriaMath"),
             _span("] also exists", 310, 370, "Calibri")]
    out = _absorb_brackets(spans)
    assert [s["text"] for s in out] == ["when ", "[1 1 0 1", "]", " also exists"]
    assert out[2].get("force_m") and out[2]["bbox"][0] == 310 and out[2]["bbox"][2] < 318
    # balanced formulas are left alone
    same = _absorb_brackets([_span("[1 1]", 0, 20, "CambriaMath"), _span("] x", 20, 40, "Calibri")])
    assert [s["text"] for s in same] == ["[1 1]", "] x"]
