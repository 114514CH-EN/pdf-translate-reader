"""Code listings: only their comments are translated.

A code block's text is the listing line by line. meta.code.lines[i].ci is the
character index where line i's comment starts (None/absent: no comment). The
translation keeps every line, with the code part unchanged and the comment text
replaced:

    data = load('samples.csv');   % Load the samples
    data = load('samples.csv');   % 载入样本
"""
from __future__ import annotations

import re

_HEAD = re.compile(r"^(%+|//+|#+)\s?")


def _lines(meta: dict | None) -> list[dict]:
    return list(((meta or {}).get("code") or {}).get("lines") or [])


def split_line(line: str, ci: int | None) -> tuple[str, str, str]:
    """(code part incl. spacing, comment marker incl. one space, comment text)."""
    if ci is None or ci >= len(line):
        return line, "", ""
    code, rest = line[:ci], line[ci:]
    m = _HEAD.match(rest)
    head = m.group(0) if m else ""
    return code, head, rest[len(head):].strip()


def comment_units(text: str, meta: dict | None) -> list[str]:
    """The comment texts of a code block, in order (what the model translates)."""
    out = []
    for line, info in zip(text.split("\n"), _lines(meta)):
        _, _, comment = split_line(line, info.get("ci"))
        if comment:
            out.append(comment)
    return out


def rebuild(text: str, meta: dict | None, translated: list[str]) -> str:
    """The listing with each comment replaced by its translation."""
    it = iter(translated)
    out = []
    for line, info in zip(text.split("\n"), _lines(meta)):
        code, head, comment = split_line(line, info.get("ci"))
        if comment:
            tr = next(it, comment).strip().replace("\n", " ")
            tr = _HEAD.sub("", tr)  # the model sometimes repeats the "%"
            out.append(f"{code}{head}{tr}")
        else:
            out.append(line)
    return "\n".join(out)


def translation_fits(text: str, translation: str | None, meta: dict | None) -> bool:
    """The stored translation still matches the listing line for line (code parts equal).

    Translations made before code blocks existed (the listing translated as one
    paragraph) do not — those blocks get translated again.
    """
    if not translation:
        return False
    src = text.split("\n")
    tgt = translation.split("\n")
    infos = _lines(meta)
    if len(src) != len(tgt) or len(infos) != len(src):
        return False
    for s, t, info in zip(src, tgt, infos):
        ci = info.get("ci")
        if ci is None:
            if s.rstrip() != t.rstrip():
                return False
        elif t[:ci].rstrip() != s[:ci].rstrip():
            return False
    return True
