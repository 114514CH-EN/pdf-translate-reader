from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .config import APP_VERSION, FRONTEND_DIST
from .db import init_db
from .routers import assistant, documents, export, glossary, notes, pages, reading, settings, translate

app = FastAPI(title="PDF Translate Reader", docs_url="/api/docs", openapi_url="/api/openapi.json")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

def _backup_first() -> None:
    """Back up the library before any migration below touches it."""
    from .services import backup

    try:
        p = backup.make_backup()
        if p:
            print(f"[backup] {p.name}")
    except Exception as e:  # never block startup
        print(f"[backup] failed: {e}")


_backup_first()
init_db()


def _encrypt_keys() -> None:
    from .services.settings_store import migrate_secrets

    try:
        if migrate_secrets():
            print("[settings] API keys are now stored encrypted")
    except Exception as e:
        print(f"[settings] key migration failed: {e}")


_encrypt_keys()
documents.upgrade_old_documents()


def _close_stale_jobs() -> None:
    """Jobs still 'running' from a previous process can never finish — mark them."""
    from .db import get_db

    with get_db() as db:
        db.execute(
            "UPDATE jobs SET status='cancelled', error='应用重启，任务中断', updated_at=datetime('now')"
            " WHERE status IN ('pending','running')"
        )


_close_stale_jobs()


def _cleanup_orphans() -> None:
    """Pages/blocks left behind by documents deleted under an old version."""
    from .db import get_db

    with get_db() as db:
        db.execute("DELETE FROM pages WHERE doc_id NOT IN (SELECT id FROM documents)")
        db.execute("DELETE FROM blocks WHERE doc_id NOT IN (SELECT id FROM documents)")


_cleanup_orphans()
documents.migrate_formula_placeholders()

app.include_router(documents.router)
app.include_router(pages.router)
app.include_router(settings.router)
app.include_router(translate.router)
app.include_router(glossary.router)
app.include_router(notes.router)
app.include_router(assistant.router)
app.include_router(export.router)
app.include_router(reading.router)


@app.get("/api/health")
def health():
    return {"ok": True, "version": APP_VERSION}


if FRONTEND_DIST.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIST), html=True), name="frontend")
