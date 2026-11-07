import os
import signal
import threading
import time

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import cloud
from .config import APP_VERSION, BASE_DIR, FRONTEND_DIST
from .db import init_db
from .routers import assistant, documents, export, glossary, notes, pages, pet, reading, settings, translate

app = FastAPI(title="PDF Translate Reader", docs_url="/api/docs", openapi_url="/api/openapi.json")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
# cloud mode (PDFTR_AUTH_URL set): login + session check on every API call; a no-op locally
app.middleware("http")(cloud.guard)
app.include_router(cloud.router)

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
app.include_router(pet.router)


@app.get("/api/health")
def health():
    # pid / base_dir let the launcher recognise (and stop) an older copy of itself
    if cloud.enabled():  # no process ids or paths for the outside world
        return {"ok": True, "version": APP_VERSION, "variants": ["main", "pet"], "cloud": True}
    return {"ok": True, "version": APP_VERSION, "variants": ["main", "pet"], "pid": os.getpid(),
            "base_dir": str(BASE_DIR), "cloud": False}


SHUTDOWN_HEADER = "x-pdftr-shutdown"


def _exit_soon() -> None:
    """Let the response go out, then stop uvicorn the way Ctrl+C does; hard exit as a backstop."""
    time.sleep(0.3)
    try:
        signal.raise_signal(signal.SIGINT)
    except Exception:
        pass
    time.sleep(6)
    os._exit(0)


@app.post("/api/shutdown")
def shutdown(request: Request):
    """Stop this server (the app's 「退出程序」 button, or a newer launcher replacing it).

    Works wherever the process runs — no process id needed. The custom header
    makes browsers send a CORS preflight first, which other sites do not pass,
    so a web page cannot close the app behind the reader's back.
    """
    if cloud.enabled():
        raise HTTPException(404, "服务器版不能从网页关闭")
    if request.headers.get(SHUTDOWN_HEADER) != "1":
        raise HTTPException(403, "缺少确认头")
    host = request.client.host if request.client else ""
    if host not in ("127.0.0.1", "::1", "localhost", "testclient"):
        raise HTTPException(403, "只能从本机关闭")
    threading.Thread(target=_exit_soon, daemon=True).start()
    return {"ok": True, "pid": os.getpid()}


@app.get("/pet", include_in_schema=False)
def pet_ui():
    """桌宠版界面。和主界面共用同一个后端、同一个 data/ —— 只是把侧栏的阅读
    助手换成了一个会走动、会被划词叫醒的桌宠。"""
    page = FRONTEND_DIST / "pet.html"
    if not page.exists():
        raise HTTPException(404, "桌宠版前端还没有构建：请先运行 run_pet.bat")
    return FileResponse(page)


if FRONTEND_DIST.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIST), html=True), name="frontend")
