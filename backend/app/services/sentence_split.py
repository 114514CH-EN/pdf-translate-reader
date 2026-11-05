"""Rule-based sentence splitting (English + CJK), abbreviation-aware."""
from __future__ import annotations

import re

_ABBREV = {
    "mr", "mrs", "ms", "dr", "prof", "inc", "ltd", "co", "corp", "etc", "vs",
    "fig", "eq", "no", "vol", "pp", "approx", "dept", "est", "min", "max",
    "st", "jr", "sr", "ref", "ed", "al", "e.g", "i.e", "cf", "ca",
}

_SENT_END = re.compile(r"([。！？!?；;])|(\.)(\s|$|\")")


def split_sentences(text: str) -> list[str]:
    """Split block text into sentences; keeps trailing punctuation."""
    if not text or not text.strip():
        return []
    sents: list[str] = []
    for para in text.split("\n"):
        para = para.strip()
        if not para:
            continue
        if len(para) <= 2:
            sents.append(para)
            continue
        buf = ""
        i = 0
        n = len(para)
        while i < n:
            ch = para[i]
            buf += ch
            if ch in "。！？!?；;":
                # avoid splitting "!!!" or "..." style runs at the first char
                while i + 1 < n and para[i + 1] in "。！？!?；;":
                    i += 1
                    buf += para[i]
                sents.append(buf.strip())
                buf = ""
            elif ch == ".":
                nxt = para[i + 1] if i + 1 < n else ""
                if nxt == "":
                    sents.append(buf.strip())
                    buf = ""
                elif nxt.isspace() or nxt in '"”’\')':
                    # check abbreviation / decimal / single capital
                    prev_word = re.split(r"[\s(]", buf[:-1])[-1] if buf[:-1] else ""
                    is_decimal = i > 0 and para[i - 1].isdigit() and i + 1 < n and para[i + 1].isdigit()
                    is_abbrev = prev_word.lower().strip(".,") in _ABBREV or re.fullmatch(r"[A-Za-z]", prev_word or "")
                    is_initial = bool(re.fullmatch(r"[A-Z]", prev_word or ""))
                    is_item_no = bool(re.fullmatch(r"\(?\d+(\.\d+)*", prev_word or ""))  # "1.1." / "2."
                    if not (is_decimal or is_abbrev or is_initial or is_item_no):
                        if nxt in '"”’\')':
                            i += 1
                            buf += para[i]
                        sents.append(buf.strip())
                        buf = ""
            i += 1
        if buf.strip():
            sents.append(buf.strip())
    return [s for s in sents if s]


# ---- sentence units for PDF blocks -------------------------------------------------

_ITEM_LINE = re.compile(r"^\s*(\(?\d+(\.\d+)*[.)]?|[•·▪●○■◦\-–*]|\(?[a-zA-Z][.)]|[ivxIVX]{1,4}[.)])\s*$")
_ITEM_START = re.compile(r"^\s*([•·▪●○■◦–*]|\(?\d+(\.\d+)*[.)])\s+\S")
_CJK = re.compile(r"[\u3000-\u9fff\uff00-\uffef]")


def _segments(text: str) -> list[str]:
    """Undo PDF soft line wraps, keeping list-item / numbered-item boundaries.

    "1.1.\nPlot the pulse ...\n1.2.\nFind the DFT ...\ncontinued." →
    ["1.1. Plot the pulse ...", "1.2. Find the DFT ... continued."]
    """
    segs: list[str] = []
    marker: str | None = None
    for raw in text.split("\n"):
        line = raw.strip()
        if not line:
            continue
        if _ITEM_LINE.match(line):  # marker alone on its line
            marker = line
            segs.append("")
            continue
        if _ITEM_START.match(line) or not segs:
            segs.append(line if marker is None else f"{marker} {line}")
        else:
            prev = segs[-1]
            if marker is not None and prev == "":
                segs[-1] = f"{marker} {line}"
            elif prev.endswith("-") and line[:1].islower():
                segs[-1] = prev[:-1] + line  # de-hyphenate
            elif _CJK.search(prev[-1:]) or _CJK.search(line[:1]):
                segs[-1] = prev + line
            else:
                segs[-1] = (prev + " " + line).strip()
        marker = None
    return [s for s in segs if s]


def sentence_units(text: str) -> list[tuple[int, str]]:
    """[(segment_index, sentence)] for a PDF block (wrapped lines rejoined)."""
    out: list[tuple[int, str]] = []
    for si, seg in enumerate(_segments(text or "")):
        for sent in split_sentences(seg):
            out.append((si, sent))
    return out


def join_units(segment_ids: list[int], sentences: list[str], target_lang: str) -> str:
    """Rebuild a block translation from per-sentence translations."""
    sep = "" if target_lang in ("zh", "ja", "zh-TW", "zh-CN") else " "
    parts: list[str] = []
    prev_seg = None
    for seg, sent in zip(segment_ids, sentences):
        sent = sent.strip()
        if prev_seg is None:
            parts.append(sent)
        elif seg != prev_seg:
            parts.append("\n" + sent)
        else:
            parts.append(sep + sent)
        prev_seg = seg
    return "".join(parts)


def auto_align(src_text: str, tgt_text: str) -> list[tuple[str, str]] | None:
    """Heuristic sentence pairing for translations made without sentence output.

    Returns pairs only when both sides split into the same number of units.
    """
    src = [s for _, s in sentence_units(src_text)]
    tgt = [s for _, s in sentence_units(tgt_text)]
    if not src or len(src) != len(tgt):
        return None
    return list(zip(src, tgt))
