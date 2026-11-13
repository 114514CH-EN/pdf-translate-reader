import os
import sys
from pathlib import Path

if getattr(sys, "frozen", False):  # PyInstaller build (PDFTranslate.exe)
    BASE_DIR = Path(sys.executable).resolve().parent  # data\ lives next to the exe
    BUNDLE_DIR = Path(getattr(sys, "_MEIPASS", BASE_DIR))  # read-only bundled files
else:
    BASE_DIR = Path(__file__).resolve().parent.parent.parent  # F:\pdf_translate
    BUNDLE_DIR = BASE_DIR
# PDFTR_DATA_DIR: run against another data folder (the tests use a temporary one)
DATA_DIR = Path(os.environ["PDFTR_DATA_DIR"]) if os.environ.get("PDFTR_DATA_DIR") else BASE_DIR / "data"
UPLOAD_DIR = DATA_DIR / "uploads"
DB_PATH = DATA_DIR / "pdf_translate.db"
CONFIG_PATH = DATA_DIR / "config.json"
FRONTEND_DIST = BUNDLE_DIR / "frontend" / "dist"

HOST = "127.0.0.1"
PORT = 8765

PROMPT_VER = "v2"

# Bumped on every backend change the frontend depends on. The launcher and the
# web page compare it to detect an old server process that is still running.
APP_VERSION = "2026.11.13-4"

for d in (DATA_DIR, UPLOAD_DIR):
    d.mkdir(parents=True, exist_ok=True)


def load_config() -> dict:
    import json
    if CONFIG_PATH.exists():
        try:
            return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def save_config(cfg: dict) -> None:
    import json
    CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
