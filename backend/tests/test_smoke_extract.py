"""Smoke test: generate a fixture PDF and run extraction + structure building."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER

import pymupdf

from app.services.extract import extract_page
from app.services.structure import build_blocks

FIXTURE = Path(__file__).parent / "fixture.pdf"


def make_fixture(path: Path) -> None:
    styles = getSampleStyleSheet()
    h1 = ParagraphStyle("h1", parent=styles["Title"], fontSize=22, alignment=TA_CENTER)
    h2 = ParagraphStyle("h2", parent=styles["Heading1"], fontSize=15)
    body = styles["BodyText"]
    doc = SimpleDocTemplate(str(path), pagesize=letter)
    story = [
        Paragraph("COMMUNICATION SYSTEMS: LAB 2", h1),
        Spacer(1, 12),
        Paragraph("Introduction", h2),
        Paragraph(
            "This lab is designed to introduce you to frequency representations of data using the Fourier transform.",
            body,
        ),
        Paragraph("Learning Outcomes", h2),
        Paragraph("1. Calculate Fourier transforms of common pulses", body),
        Paragraph("2. Understand the effects of different properties", body),
        Paragraph("Mark Distribution", h2),
        Table(
            [["Section", "Marks"], ["Task 1 - pulses, FFT", "35"], ["Task 2 - scaling", "15"], ["Total", "100"]],
            style=TableStyle(
                [
                    ("GRID", (0, 0), (-1, -1), 0.5, colors.black),
                    ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ]
            ),
        ),
    ]
    doc.build(story)


def main() -> None:
    make_fixture(FIXTURE)
    pdf = pymupdf.open(FIXTURE)
    page = pdf.load_page(0)
    payload = extract_page(page, img_dir=None)
    blocks = build_blocks(payload, page_no=1)
    print(f"page {payload['width']:.0f}x{payload['height']:.0f}, tables={len(payload['tables'])}, images={len(payload['images'])}")
    for b in blocks:
        print(f"[{b['order_idx']:02d}] {b['type']:8s} lvl={b['level']} size={b['font_size']} bbox={[round(v) for v in b['bbox']]} text={b['text'][:60]!r}")
    types = {b["type"] for b in blocks}
    assert "heading" in types, "expected headings"
    assert "table" in types, "expected table block"
    assert "paragraph" in types or "list" in types, "expected body text"
    md = [b for b in blocks if b["type"] == "table"][0]["text"]
    assert "Task 1" in md and "Total" in md, "table markdown content"
    print("SMOKE OK")


if __name__ == "__main__":
    main()
