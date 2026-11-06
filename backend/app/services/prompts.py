"""Prompt construction for context-faithful translation."""
from __future__ import annotations

import json
import re

PROMPT_VER = "v2"  # v2: sentence-aligned output for multi-sentence blocks

TARGET_NAMES = {"zh": "Simplified Chinese", "en": "English", "ja": "Japanese", "ko": "Korean"}

STYLE_NAMES = {"academic": "academic/technical", "general": "general"}


def build_translation_messages(
    *,
    batch: list[dict],
    domain_guess: str | None,
    doc_title: str,
    target_lang: str,
    style: str,
    glossary_terms: list[dict],
    summary: str | None,
    heading_trail: list[str],
    prev_digests: list[str],
) -> list[dict]:
    tgt = TARGET_NAMES.get(target_lang, target_lang)
    sys_lines = [
        f"You are a professional translator rendering a document from English into {tgt}.",
        f"Document title: {doc_title!r}. Domain: {domain_guess or 'general'}.",
        f"Style: {STYLE_NAMES.get(style, style)}. Use domain-appropriate terminology (contextual, not dictionary-literal).",
        "Preserve the Markdown structure exactly: keep heading levels, list markers, and table pipes/cell-by-cell content.",
        "Translate ONLY the text content; do not add, drop or reorder items. Keep math symbols, code and numbers as-is.",
        "Tokens like {{m3}} are FORMULA PLACEHOLDERS: copy each one verbatim exactly once, at the grammatically "
        "correct position in the translation; never translate, alter, drop or invent them.",
        "Variables, symbols and units written in the text (x, y, A, R1, Vin, f_c, kΩ, dB, Hz, 10 nF) and labels of "
        "figures or circuits that are names (R, C, Q1, DSP) stay exactly as written — never translate or spell them out.",
        "Some blocks are given as numbered sentences ([1], [2], …, marked sentences=N). For those, return "
        '"sentences": an array of exactly N strings where item i translates source sentence [i] — keep the 1:1 '
        "alignment, never merge or split sentences, and do not include the [i] labels. Keep item numbers/bullets "
        "that start a sentence (e.g. '1.2.', '•').",
        "Blocks of type=code are source-code comments, one per numbered item: translate each comment's words "
        "only and keep identifiers, function names, file names and numbers exactly as written; no comment markers.",
        'Output STRICT JSON only: {"translations":[{"id": <int>, "translation": <string>} | {"id": <int>, "sentences": [<string>, …]}]}'
        " — one entry per input block, same ids.",
        "No commentary outside the JSON.",
    ]

    user_parts: list[str] = []
    if glossary_terms:
        gl = "\n".join(
            f"- {t['src_term']} = {t['tgt_term']}" + (f" ({t['note']})" if t.get("note") else "")
            for t in glossary_terms
        )
        user_parts.append(
            "Glossary (binding — MUST use these translations consistently):\n" + gl
        )
    ctx_bits = []
    if summary:
        ctx_bits.append(f"Document summary: {summary}")
    if heading_trail:
        ctx_bits.append("Current section path: " + " > ".join(heading_trail[-5:]))
    if prev_digests:
        ctx_bits.append("Previous translations (for cohesion; do not re-translate): " + " | ".join(prev_digests))
    if ctx_bits:
        user_parts.append("Context:\n" + "\n".join(ctx_bits))

    body = []
    for b in batch:
        units = b.get("units")
        if units:
            numbered = "\n".join(f"[{i + 1}] {u}" for i, u in enumerate(units))
            body.append(f"<<<id={b['id']} type={b.get('type', 'paragraph')} sentences={len(units)}>>>\n{numbered}")
        else:
            body.append(f"<<<id={b['id']} type={b.get('type', 'paragraph')}>>>\n{b['text']}")
    user_parts.append("Blocks to translate:\n\n" + "\n\n".join(body))

    return [
        {"role": "system", "content": "\n".join(sys_lines)},
        {"role": "user", "content": "\n\n".join(user_parts)},
    ]


def _load_json_obj(content: str):
    txt = (content or "").strip()
    if txt.startswith("```"):
        txt = re.sub(r"^```(?:json)?\s*", "", txt)
        txt = re.sub(r"\s*```$", "", txt)
    try:
        return json.loads(txt)
    except Exception:
        m = re.search(r"\{[\s\S]*\}", txt)
        if m:
            try:
                return json.loads(m.group(0))
            except Exception:
                return None
    return None


def parse_translation_items(content: str, expected_ids: list[int]) -> dict[int, dict]:
    """{id: {"translation": str|None, "sentences": list[str]|None}} from model output."""
    data = _load_json_obj(content)
    out: dict[int, dict] = {}
    if not isinstance(data, dict):
        return out
    items = data.get("translations")
    if items is None and "id" in data:
        items = [data]
    for it in items or []:
        if not isinstance(it, dict) or "id" not in it:
            continue
        try:
            bid = int(it["id"])
        except Exception:
            continue
        sents = it.get("sentences")
        if isinstance(sents, list) and sents and all(isinstance(x, str) for x in sents):
            out[bid] = {"translation": it.get("translation"), "sentences": [re.sub(r"^\[\d+\]\s*", "", x) for x in sents]}
        elif isinstance(it.get("translation"), str):
            out[bid] = {"translation": it["translation"], "sentences": None}
    return out


def parse_translation_response(content: str, expected_ids: list[int]) -> dict[int, str]:
    """Parse model output into {id: translation}. Tolerates code fences / stray text."""
    txt = content.strip()
    if txt.startswith("```"):
        txt = re.sub(r"^```(?:json)?\s*", "", txt)
        txt = re.sub(r"\s*```$", "", txt)
    data = None
    try:
        data = json.loads(txt)
    except Exception:
        m = re.search(r"\{[\s\S]*\}", txt)
        if m:
            try:
                data = json.loads(m.group(0))
            except Exception:
                data = None
    out: dict[int, str] = {}
    if isinstance(data, dict):
        items = data.get("translations")
        if items is None and "id" in data:
            items = [data]
        for it in items or []:
            if isinstance(it, dict) and "id" in it and "translation" in it:
                try:
                    out[int(it["id"])] = str(it["translation"])
                except Exception:
                    continue
    return out


def build_term_messages(sample: str, target_lang: str, domain_guess: str | None) -> list[dict]:
    tgt = TARGET_NAMES.get(target_lang, target_lang)
    sys = (
        f"You extract domain terminology for a document and give context-appropriate {tgt} translations. "
        "For example in a lab manual, 'lab' = '实验', 'Task' = '任务', 'Marks' = '分数' — not dictionary meanings. "
        'Output STRICT JSON: {"terms":[{"src": "...", "tgt": "...", "note": "..."}]} with 25-60 terms. '
        "note is a short reason/context (one line). No commentary."
    )
    user = f"Domain guess: {domain_guess or 'unknown'}\n\nDocument sample:\n{sample[:6000]}"
    return [{"role": "system", "content": sys}, {"role": "user", "content": user}]


def parse_terms_response(content: str) -> list[dict]:
    txt = content.strip()
    if txt.startswith("```"):
        txt = re.sub(r"^```(?:json)?\s*", "", txt)
        txt = re.sub(r"\s*```$", "", txt)
    data = None
    try:
        data = json.loads(txt)
    except Exception:
        m = re.search(r"\{[\s\S]*\}", txt)
        if m:
            try:
                data = json.loads(m.group(0))
            except Exception:
                return []
    terms = []
    for it in (data or {}).get("terms", []):
        if isinstance(it, dict) and it.get("src") and it.get("tgt"):
            terms.append(
                {"src_term": str(it["src"]).strip(), "tgt_term": str(it["tgt"]).strip(), "note": str(it.get("note") or "").strip()}
            )
    return terms


# ---- consistency polish ---------------------------------------------------------------

def build_polish_messages(items: list[dict], glossary_terms: list[dict], target_lang: str) -> list[dict]:
    """items: [{id, source, translation, missing: [{src, tgt}]}]"""
    tgt = TARGET_NAMES.get(target_lang, target_lang)
    sys = (
        f"You are a meticulous {tgt} copy editor. Revise each translation MINIMALLY so that the required term "
        "renderings are used. Change nothing else: keep meaning, punctuation, line breaks, Markdown table pipes and "
        'cell order. Output STRICT JSON: {"revisions":[{"id": <int>, "translation": <string>}]} for every item.'
    )
    lines = []
    for it in items:
        req = "; ".join(f"{m['src']} → {m['tgt']}" for m in it["missing"])
        lines.append(
            f"<<<id={it['id']}>>>\nRequired terms: {req}\nSource: {it['source']}\nCurrent translation: {it['translation']}"
        )
    return [{"role": "system", "content": sys}, {"role": "user", "content": "\n\n".join(lines)}]


def build_heading_polish_messages(headings: list[dict], target_lang: str) -> list[dict]:
    """headings: [{id, level, source, translation}] — unify recurring patterns."""
    tgt = TARGET_NAMES.get(target_lang, target_lang)
    sys = (
        f"You review the {tgt} translations of all headings of one document for consistency. Headings that share a "
        "source pattern (e.g. 'Task 1 – …', 'Task 2 – …', '[15 marks]', 'Chapter 3') must use the same target "
        "pattern and wording style; the same source term must be rendered the same way everywhere. Only return "
        'headings you actually change. Output STRICT JSON: {"revisions":[{"id": <int>, "translation": <string>}]}'
        ' (empty list if all are consistent).'
    )
    body = "\n".join(
        f"id={h['id']} H{h.get('level') or 1} | {h['source']} | {h['translation']}" for h in headings
    )
    return [{"role": "system", "content": sys}, {"role": "user", "content": "id | level | source | current translation\n" + body}]


def parse_revisions(content: str) -> dict[int, str]:
    data = _load_json_obj(content)
    out: dict[int, str] = {}
    for it in (data or {}).get("revisions", []) if isinstance(data, dict) else []:
        if isinstance(it, dict) and "id" in it and isinstance(it.get("translation"), str):
            try:
                out[int(it["id"])] = it["translation"]
            except Exception:
                pass
    return out
