"""Structure extraction tests on a generated fixture PDF."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pymupdf

from app.services.extract import extract_page
from app.services.structure import build_blocks
from tests.test_smoke_extract import make_fixture, FIXTURE


def _blocks():
    make_fixture(FIXTURE)
    pdf = pymupdf.open(FIXTURE)
    payload = extract_page(pdf.load_page(0), img_dir=None)
    return build_blocks(payload, page_no=1)


def test_block_types_and_order():
    blocks = _blocks()
    types = [b["type"] for b in blocks]
    assert types[0] == "heading"
    assert "table" in types
    assert all(b["bbox"] and len(b["bbox"]) == 4 for b in blocks)
    idx = [b["order_idx"] for b in blocks]
    assert idx == sorted(idx)


def test_heading_levels():
    blocks = _blocks()
    headings = [b for b in blocks if b["type"] == "heading"]
    sizes = [b["font_size"] for b in headings]
    assert max(sizes) == sizes[0] or max(sizes) in sizes
    # the 22pt title must outrank the 15pt section headings
    title = max(headings, key=lambda b: b["font_size"])
    sections = [b for b in headings if b is not title]
    assert title["level"] <= min(b["level"] for b in sections)


def test_table_markdown_and_cells():
    blocks = _blocks()
    table = [b for b in blocks if b["type"] == "table"][0]
    assert "Section" in table["text"] and "Marks" in table["text"]
    assert "Task 1 - pulses, FFT" in table["text"]
    cells = table["meta"]["cells"]
    assert len(cells) == 8  # 4x2
    header = {(c["row"], c["col"]): c["text"] for c in cells if c["row"] == 0}
    assert header[(0, 0)] == "Section"
    assert header[(0, 1)] == "Marks"


def test_list_detection():
    blocks = _blocks()
    lists = [b for b in blocks if b["type"] == "list"]
    assert len(lists) == 2
    assert lists[0]["list_marker"].startswith("1")


def test_stable_key_stable_across_runs():
    a, b = _blocks(), _blocks()
    assert [x["stable_key"] for x in a] == [x["stable_key"] for x in b]
