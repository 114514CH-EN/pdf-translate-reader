"""Automatic database backups (data/backups), taken at startup and on demand."""
from __future__ import annotations

import sqlite3
import time
from datetime import datetime
from pathlib import Path

from ..config import DATA_DIR, DB_PATH

BACKUP_DIR = DATA_DIR / "backups"
KEEP = 10
MIN_INTERVAL_S = 3600  # startup backups: at most one per hour


def list_backups() -> list[dict]:
    if not BACKUP_DIR.exists():
        return []
    out = []
    for p in sorted(BACKUP_DIR.glob("pdf_translate-*.db"), reverse=True):
        st = p.stat()
        out.append({"name": p.name, "size": st.st_size,
                    "created_at": datetime.fromtimestamp(st.st_mtime).isoformat(timespec="seconds")})
    return out


def make_backup(force: bool = False) -> Path | None:
    """Consistent copy via SQLite's online backup API; prunes to the newest KEEP."""
    if not DB_PATH.exists():
        return None
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    existing = sorted(BACKUP_DIR.glob("pdf_translate-*.db"))
    if not force and existing and time.time() - existing[-1].stat().st_mtime < MIN_INTERVAL_S:
        return None
    dest = BACKUP_DIR / f"pdf_translate-{datetime.now():%Y%m%d-%H%M%S}.db"
    src = sqlite3.connect(DB_PATH)
    try:
        dst = sqlite3.connect(dest)
        try:
            src.backup(dst)
        finally:
            dst.close()
    finally:
        src.close()
    for old in sorted(BACKUP_DIR.glob("pdf_translate-*.db"))[:-KEEP]:
        try:
            old.unlink()
        except OSError:
            pass
    return dest
