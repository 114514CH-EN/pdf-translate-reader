"""Settings persistence: SQLite settings table mirrored to data/config.json."""
from __future__ import annotations

import copy
import json
from typing import Any

from ..config import save_config
from ..db import get_db
from .llm_client import DEFAULT_CONFIG
from .secret_store import decrypt, encrypt, is_encrypted


def _stored() -> dict[str, Any]:
    with get_db() as db:
        row = db.execute("SELECT value_json FROM settings WHERE key='app_config'").fetchone()
    if row:
        try:
            return json.loads(row["value_json"])
        except Exception:
            pass
    return {}


def load_settings() -> dict[str, Any]:
    """Settings with API keys decrypted (keys are stored encrypted, see secret_store)."""
    cfg = copy.deepcopy(DEFAULT_CONFIG)
    cfg.update(_stored())
    cfg["api_key"] = decrypt(cfg.get("api_key"))
    if isinstance(cfg.get("assistant"), dict):
        cfg["assistant"] = dict(cfg["assistant"])
        cfg["assistant"]["api_key"] = decrypt(cfg["assistant"].get("api_key"))
    return cfg


def _for_storage(cfg: dict[str, Any]) -> dict[str, Any]:
    out = copy.deepcopy(cfg)
    out["api_key"] = encrypt(out.get("api_key"))
    if isinstance(out.get("assistant"), dict):
        out["assistant"]["api_key"] = encrypt(out["assistant"].get("api_key"))
    return out


def save_settings(cfg: dict[str, Any]) -> dict[str, Any]:
    merged = load_settings()
    merged.update(cfg)
    stored = _for_storage(merged)
    with get_db() as db:
        db.execute(
            "INSERT INTO settings (key, value_json) VALUES ('app_config', ?)"
            " ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",
            (json.dumps(stored, ensure_ascii=False),),
        )
    save_config(stored)  # data/config.json mirror never holds a plain key
    return merged


def migrate_secrets() -> bool:
    """Startup: re-save settings whose API keys are still stored in plain text."""
    raw = _stored()
    keys = [raw.get("api_key"), (raw.get("assistant") or {}).get("api_key")]
    if any(k and not is_encrypted(k) for k in keys):
        save_settings({})
        return True
    return False


def bump_glossary_rev() -> int:
    cfg = load_settings()
    rev = int(cfg.get("glossary_rev") or 0) + 1
    save_settings({"glossary_rev": rev})
    return rev


def mask_key(key: str | None) -> str | None:
    if not key:
        return None
    if len(key) <= 8:
        return "****"
    return key[:3] + "…" + key[-4:]


def public_settings() -> dict[str, Any]:
    cfg = load_settings()
    cfg["api_key_masked"] = mask_key(cfg.get("api_key"))
    cfg.pop("api_key", None)
    return cfg
