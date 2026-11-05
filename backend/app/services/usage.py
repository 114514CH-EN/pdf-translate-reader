"""Token usage log + cost / time estimates.

Every model call goes through llm_client, which calls `record()`. Callers tag
the cfg dict with `_purpose` (translate / assistant / lookup / glossary /
polish / summary) and `_doc_id`. Prices are per 1M tokens, entered by the user
in 设置 → 用量与费用 (they change too often to hard-code).
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone

from ..db import get_db

_CJK = re.compile(r"[　-鿿＀-￯]")


def estimate_tokens(text: str) -> int:
    """Rough token count: ~0.6 per CJK character, ~0.3 per other character."""
    if not text:
        return 0
    cjk = len(_CJK.findall(text))
    return int(round(cjk * 0.6 + (len(text) - cjk) * 0.3))


# DeepSeek official prices, yuan per 1M tokens, off-peak (peak = 2×) — from the
# DeepSeek pricing page of Nov 2026. Offered as a one-click fill in the settings.
DEEPSEEK_PRICING = {
    "deepseek-flash": {"in": 1.0, "in_hit": 0.02, "out": 4.0, "peak_mult": 2.0},
    "deepseek-v4-pro": {"in": 4.5, "in_hit": 0.15, "out": 13.5, "peak_mult": 2.0},
}
# 北京时间周一至周五 9:00–12:00、14:00–18:00 为高峰（法定节假日无法自动识别，按工作日计）
DEEPSEEK_PEAK = {"enabled": True, "utc_offset": 8, "weekdays_only": True, "ranges": [[9, 12], [14, 18]]}


def is_peak(cfg: dict, when: datetime | None = None) -> bool:
    peak = (cfg.get("pricing") or {}).get("peak") or {}
    if not peak.get("enabled"):
        return False
    t = (when or datetime.now(timezone.utc)).astimezone(timezone(timedelta(hours=float(peak.get("utc_offset", 8)))))
    if peak.get("weekdays_only", True) and t.weekday() >= 5:
        return False
    h = t.hour + t.minute / 60
    return any(float(a) <= h < float(b) for a, b in peak.get("ranges") or [])


def record(cfg: dict, prompt_tokens: int, completion_tokens: int, estimated: bool = False,
           cache_hit: int = 0) -> None:
    try:
        with get_db() as db:
            db.execute(
                "INSERT INTO usage_log (doc_id, purpose, provider, model, prompt_tokens, completion_tokens,"
                " cache_hit_tokens, peak, estimated) VALUES (?,?,?,?,?,?,?,?,?)",
                (cfg.get("_doc_id"), cfg.get("_purpose") or "other", cfg.get("provider"), cfg.get("model"),
                 int(prompt_tokens or 0), int(completion_tokens or 0), int(cache_hit or 0),
                 1 if is_peak(cfg) else 0, 1 if estimated else 0),
            )
    except Exception:  # accounting must never break a translation
        pass


def price_for(cfg: dict, model: str | None) -> dict | None:
    """{'in', 'in_hit', 'out', 'peak_mult'} per 1M tokens for this model, or None when not set."""
    pricing = (cfg.get("pricing") or {}).get("models") or {}
    p = pricing.get(model or "") or pricing.get("*")
    if not p:
        return None
    try:
        pin = float(p.get("in") or 0)
        return {"in": pin, "in_hit": float(p.get("in_hit") if p.get("in_hit") not in (None, "") else pin),
                "out": float(p.get("out") or 0), "peak_mult": float(p.get("peak_mult") or 1)}
    except (TypeError, ValueError):
        return None


def cost(cfg: dict, model: str | None, prompt_tokens: int, completion_tokens: int,
         cache_hit: int = 0, peak: bool = False) -> float | None:
    p = price_for(cfg, model)
    if p is None:
        return None
    hit = min(max(int(cache_hit or 0), 0), int(prompt_tokens or 0))
    base = ((prompt_tokens - hit) * p["in"] + hit * p["in_hit"] + completion_tokens * p["out"]) / 1_000_000
    return base * (p["peak_mult"] if peak else 1.0)


def summary(cfg: dict, days: int = 30) -> dict:
    since = (f"-{int(days)} days",)
    with get_db() as db:
        rows = db.execute(
            "SELECT purpose, model, peak, SUM(prompt_tokens) pt, SUM(completion_tokens) ct,"
            " SUM(cache_hit_tokens) hit, COUNT(*) n, MAX(estimated) est FROM usage_log"
            " WHERE created_at >= datetime('now', ?) GROUP BY purpose, model, peak ORDER BY purpose",
            since,
        ).fetchall()
        by_day = db.execute(
            "SELECT date(created_at) d, SUM(prompt_tokens + completion_tokens) t FROM usage_log"
            " WHERE created_at >= datetime('now', ?) GROUP BY d ORDER BY d",
            since,
        ).fetchall()
        by_doc = db.execute(
            "SELECT u.doc_id, d.title, u.model, u.peak, SUM(u.prompt_tokens) pt, SUM(u.completion_tokens) ct,"
            " SUM(u.cache_hit_tokens) hit FROM usage_log u LEFT JOIN documents d ON d.id=u.doc_id"
            " WHERE u.created_at >= datetime('now', ?) AND u.doc_id IS NOT NULL GROUP BY u.doc_id, u.model, u.peak",
            since,
        ).fetchall()
    groups: dict[tuple, dict] = {}
    for r in rows:
        g = groups.setdefault((r["purpose"], r["model"]), {
            "purpose": r["purpose"], "model": r["model"], "prompt_tokens": 0, "completion_tokens": 0,
            "cache_hit_tokens": 0, "peak_calls": 0, "calls": 0, "estimated": False, "cost": 0.0})
        c = cost(cfg, r["model"], r["pt"] or 0, r["ct"] or 0, r["hit"] or 0, bool(r["peak"]))
        g["prompt_tokens"] += r["pt"] or 0
        g["completion_tokens"] += r["ct"] or 0
        g["cache_hit_tokens"] += r["hit"] or 0
        g["calls"] += r["n"]
        g["peak_calls"] += r["n"] if r["peak"] else 0
        g["estimated"] = g["estimated"] or bool(r["est"])
        g["cost"] = None if c is None or g["cost"] is None else g["cost"] + c
    docs: dict[int, dict] = {}
    for r in by_doc:
        d = docs.setdefault(r["doc_id"], {"doc_id": r["doc_id"], "title": r["title"] or "（已删除）",
                                          "tokens": 0, "cost": 0.0})
        d["tokens"] += (r["pt"] or 0) + (r["ct"] or 0)
        c = cost(cfg, r["model"], r["pt"] or 0, r["ct"] or 0, r["hit"] or 0, bool(r["peak"]))
        d["cost"] = None if c is None or d["cost"] is None else d["cost"] + c
    gl = list(groups.values())
    priced = [g["cost"] for g in gl if g["cost"] is not None]
    return {
        "days": days,
        "currency": (cfg.get("pricing") or {}).get("currency") or "¥",
        "groups": gl,
        "total_tokens": sum(g["prompt_tokens"] + g["completion_tokens"] for g in gl),
        "total_cost": sum(priced) if priced else None,
        "peak_now": is_peak(cfg),
        "by_day": [{"date": r["d"], "tokens": r["t"] or 0} for r in by_day],
        "by_doc": sorted(docs.values(), key=lambda d: -d["tokens"]),
    }
