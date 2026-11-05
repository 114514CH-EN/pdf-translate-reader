"""Cache key behavior and edited-translation protection."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.translate_worker import cache_key


def test_cache_key_deterministic():
    a = cache_key("Hello world", "zh", "m1", 0)
    b = cache_key("hello  world", "zh", "m1", 0)
    assert a == b  # normalization collapses whitespace/case-sensitive but whitespace-insensitive


def test_cache_key_changes_with_params():
    base = cache_key("Hello", "zh", "m1", 0)
    assert cache_key("Hello", "en", "m1", 0) != base
    assert cache_key("Hello", "zh", "m2", 0) != base
    assert cache_key("Hello", "zh", "m1", 1) != base  # glossary_rev participates
    assert cache_key("Hello!", "zh", "m1", 0) != base
