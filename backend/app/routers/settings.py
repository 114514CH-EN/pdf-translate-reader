"""App settings + API connection tests + usage statistics + backups."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from ..services import backup, usage
from ..services.llm_client import PRESETS, has_credentials, list_models, test_connection
from ..services.settings_store import load_settings, mask_key, save_settings

router = APIRouter(prefix="/api/settings", tags=["settings"])

_ASSISTANT_FIELDS = ("provider", "base_url", "model", "temperature", "max_tokens", "context_chars", "reply_lang",
                     "thinking")


def _nested() -> dict:
    from ..services.assistant import assistant_config

    cfg = load_settings()
    a = assistant_config()
    return {
        "api": {
            "provider": cfg.get("provider"),
            "base_url": cfg.get("base_url"),
            "api_key_masked": mask_key(cfg.get("api_key")),
            "model": cfg.get("model"),
        },
        "translation": {
            "target_lang": cfg.get("target_lang"),
            "style": cfg.get("style"),
            "thinking": cfg.get("thinking") or "off",
        },
        "ui": cfg.get("ui") or {},
        "assistant": {
            **{k: a.get(k) for k in _ASSISTANT_FIELDS},
            "api_key_masked": mask_key(a.get("api_key")),
            "configured": has_credentials(a) and bool(a.get("model") or PRESETS.get(a.get("provider") or "", {}).get("default_model")),
        },
        "pricing": {"currency": "¥", "models": {}, "peak": {"enabled": False}, **(cfg.get("pricing") or {})},
        "pricing_presets": {"deepseek": {"currency": "¥", "models": usage.DEEPSEEK_PRICING,
                                         "peak": usage.DEEPSEEK_PEAK, "as_of": "2026-11"}},
        "peak_now": usage.is_peak(cfg),
        "keys_encrypted": True,
    }


@router.get("")
def get_settings():
    return {**_nested(), "presets": PRESETS}


@router.put("")
def put_settings(payload: dict):
    flat: dict = {}
    api = payload.get("api") or {}
    for key in ("provider", "base_url", "model"):
        if key in api:
            flat[key] = api[key]
    if api.get("api_key"):
        flat["api_key"] = api["api_key"]
    tr = payload.get("translation") or {}
    for key in ("target_lang", "style"):
        if key in tr:
            flat[key] = tr[key]
    if tr.get("thinking") in ("off", "low", "high", "max"):
        flat["thinking"] = tr["thinking"]
    if "ui" in payload:
        flat["ui"] = payload["ui"]
    if isinstance(payload.get("pricing"), dict):
        p = payload["pricing"]
        models = {}
        for name, v in (p.get("models") or {}).items():
            try:
                m = {"in": float(v.get("in") or 0), "out": float(v.get("out") or 0),
                     "peak_mult": max(1.0, float(v.get("peak_mult") or 1))}
                if v.get("in_hit") not in (None, ""):
                    m["in_hit"] = float(v["in_hit"])
                models[str(name)] = m
            except (TypeError, ValueError, AttributeError):
                continue
        pk = p.get("peak") if isinstance(p.get("peak"), dict) else {}
        try:
            ranges = [[float(a), float(b)] for a, b in (pk.get("ranges") or usage.DEEPSEEK_PEAK["ranges"])][:6]
        except (TypeError, ValueError):
            ranges = usage.DEEPSEEK_PEAK["ranges"]
        flat["pricing"] = {
            "currency": str(p.get("currency") or "¥")[:4], "models": models,
            "peak": {"enabled": bool(pk.get("enabled")), "utc_offset": float(pk.get("utc_offset", 8)),
                     "weekdays_only": bool(pk.get("weekdays_only", True)), "ranges": ranges},
        }
    if isinstance(payload.get("assistant"), dict):
        cur = dict(load_settings().get("assistant") or {})
        cur.pop("same_as_translation", None)
        a = payload["assistant"]
        if a.get("copy_from_translation"):
            base = load_settings()
            for key in ("provider", "base_url", "model", "api_key"):
                cur[key] = base.get(key)
        for key in _ASSISTANT_FIELDS:
            if key in a:
                cur[key] = a[key]
        if a.get("api_key"):
            cur["api_key"] = a["api_key"]
        if a.get("clear_api_key"):
            cur["api_key"] = None
        flat["assistant"] = cur
    save_settings(flat)
    return _nested()


@router.post("/test-connection")
async def test_conn(payload: dict | None = None):
    """Test the translation API (default) or the reading assistant's own API."""
    if payload and payload.get("target") == "assistant":
        from ..services.assistant import AssistantNotConfigured, assistant_settings

        try:
            cfg = assistant_settings(purpose="test")
        except AssistantNotConfigured as e:
            from ..services.assistant import assistant_config

            a = assistant_config()
            if not has_credentials(a):
                return {"ok": False, "error": str(e)}
            # key present but no model yet: still connect so the model list can be offered
            preset = PRESETS.get(a.get("provider") or "", {})
            cfg = {"provider": a.get("provider"), "base_url": a.get("base_url") or preset.get("base_url") or "",
                   "api_key": a.get("api_key"), "model": "", "_purpose": "test"}
        return await test_connection(cfg)
    cfg = load_settings()
    if payload:
        api = payload.get("api") or payload
        for key in ("base_url", "model", "api_key", "provider"):
            if api.get(key):
                cfg[key] = api[key]
    if not has_credentials(cfg):
        return {"ok": False, "error": "尚未配置 API Key（本地 AI 请把服务商选为「自定义」并填写 Base URL，Key 可以不填）"}
    return await test_connection(cfg)


@router.post("/models")
def fetch_models(payload: dict | None = None):
    """拉取模型列表. Uses the saved settings of `target` (translation / assistant), overridden by
    what the form currently shows (provider / base_url, and a key the user just typed) — no save needed."""
    payload = payload or {}
    base = load_settings()
    if payload.get("target") == "assistant":
        from ..services.assistant import assistant_config

        a = assistant_config()
        cfg = {"provider": a.get("provider"), "base_url": a.get("base_url"), "api_key": a.get("api_key")}
    else:
        cfg = {"provider": base.get("provider"), "base_url": base.get("base_url"), "api_key": base.get("api_key")}
    for key in ("provider", "base_url"):
        if payload.get(key) is not None:
            cfg[key] = payload[key]
    if payload.get("api_key"):
        cfg["api_key"] = payload["api_key"]
    if not cfg.get("base_url"):
        cfg["base_url"] = PRESETS.get(cfg.get("provider") or "", {}).get("base_url") or ""
    if not cfg["base_url"]:
        return {"ok": False, "models": [], "error": "请先填写 Base URL"}
    if not has_credentials(cfg):
        return {"ok": False, "models": [], "error": "请先填写 API Key"}
    return list_models(cfg)


@router.get("/usage")
def get_usage(days: int = 30):
    return usage.summary(load_settings(), max(1, min(days, 3650)))


@router.get("/backups")
def get_backups():
    return {"dir": str(backup.BACKUP_DIR), "keep": backup.KEEP, "items": backup.list_backups()}


@router.post("/backups")
def create_backup():
    p = backup.make_backup(force=True)
    if p is None:
        raise HTTPException(500, "备份失败：找不到数据库文件")
    return {"name": p.name, "items": backup.list_backups()}
