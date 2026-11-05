"""Sentence splitting tests."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.sentence_split import split_sentences


def test_basic_english():
    s = split_sentences("This is one. This is two! Is this three? Yes.")
    assert len(s) == 4
    assert s[0] == "This is one."


def test_abbreviations_not_split():
    s = split_sentences("Dr. Smith arrived at 3.5 hours. Then he left.")
    assert len(s) == 2
    assert s[0].startswith("Dr. Smith")


def test_cjk():
    s = split_sentences("这是第一句。这是第二句！第三句呢？有。")
    assert len(s) == 4


def test_newlines_are_boundaries():
    s = split_sentences("Line one fragment\nLine two fragment.")
    assert len(s) == 2


def test_empty():
    assert split_sentences("") == []
    assert split_sentences("   ") == []
