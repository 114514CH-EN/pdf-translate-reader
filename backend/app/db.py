import sqlite3
from contextlib import contextmanager
from pathlib import Path

from .config import DB_PATH

_SCHEMA = (Path(__file__).parent / "schema.sql").read_text(encoding="utf-8")


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


@contextmanager
def get_db():
    conn = _connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    with get_db() as db:
        db.executescript(_SCHEMA)
        # lightweight migrations for DBs created before new columns
        cols = {r["name"] for r in db.execute("PRAGMA table_info(documents)").fetchall()}
        if "questions_json" not in cols:
            db.execute("ALTER TABLE documents ADD COLUMN questions_json TEXT")
        if "last_page" not in cols:  # reading position (page + fraction scrolled into it)
            db.execute("ALTER TABLE documents ADD COLUMN last_page INTEGER")
            db.execute("ALTER TABLE documents ADD COLUMN last_frac REAL")
        ccols = {r["name"] for r in db.execute("PRAGMA table_info(chat_messages)").fetchall()}
        if "meta_json" not in ccols:  # sources / mode of assistant answers
            db.execute("ALTER TABLE chat_messages ADD COLUMN meta_json TEXT")
        ucols = {r["name"] for r in db.execute("PRAGMA table_info(usage_log)").fetchall()}
        if "cache_hit_tokens" not in ucols:
            db.execute("ALTER TABLE usage_log ADD COLUMN cache_hit_tokens INTEGER NOT NULL DEFAULT 0")
            db.execute("ALTER TABLE usage_log ADD COLUMN peak INTEGER NOT NULL DEFAULT 0")
        tcols = {r["name"] for r in db.execute("PRAGMA table_info(translations)").fetchall()}
        if "layout_json" not in tcols:  # the reader's own formatting of a translated block (edit mode)
            db.execute("ALTER TABLE translations ADD COLUMN layout_json TEXT")
        jcols = {r["name"] for r in db.execute("PRAGMA table_info(jobs)").fetchall()}
        if "result_json" not in jcols:
            db.execute("ALTER TABLE jobs ADD COLUMN result_json TEXT")


def rows_to_dicts(rows) -> list[dict]:
    return [dict(r) for r in rows]
