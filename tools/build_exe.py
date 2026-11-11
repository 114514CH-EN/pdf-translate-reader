"""Build the Windows app: dist/PDFTranslate/ with PDFTranslate.exe and PDFTranslate-Pet.exe.

Used by build_exe.bat (local) and by the release workflow (GitHub Actions,
windows-latest). Needs the built frontend (frontend/dist) and PyInstaller.

    python tools/build_exe.py            # build
    python tools/build_exe.py --zip X    # build, then pack dist/PDFTranslate into X
    python tools/build_exe.py --pack-only --zip X   # only pack an existing build
"""
from __future__ import annotations

import shutil
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NAME = "PDFTranslate"
OUT = ROOT / "dist" / NAME

README = """PDF 双语翻译阅读器（Windows 版）
================================

双击 PDFTranslate.exe       → 经典版（浏览器自动打开 http://127.0.0.1:8765）
双击 启动桌宠版.bat         → 桌宠版（http://127.0.0.1:8765/pet）
（第一次运行 PDFTranslate.exe 后，旁边会多出一个 PDFTranslate-Pet.exe，以后也可以直接双击它）

两个版本共用这个文件夹里的 data\\（文档、译文、笔记、设置），可以随时切换。
不需要安装 Python 或 Node.js。整个文件夹可以放到任何位置，也可以复制到 U 盘。

程序在后台运行，没有黑色的命令行窗口：任务栏右下角有一个图标（可能收在 ^ 里），
点它打开阅读器，右键可以打开桌宠版、查看运行日志或退出。
关闭：右键这个图标 → 退出，或在程序的「设置 → 数据与安全」里点「退出程序」。
想看到以前的命令行窗口：用 PDFTranslate.exe --console 启动。
升级：在程序的「设置 → 数据与安全」里点「检查更新」，有新版本时一键下载、替换、重启。
      也可以手动下载新版本，把旧文件夹里的 data\\ 复制到新文件夹，所有文档和译文都还在。
第一次使用：在 ⚙ 设置里填翻译 API（DeepSeek、OpenAI、Ollama 等），把 PDF 拖进窗口。

项目主页：https://114514ch-en.github.io/pdf-translate-reader/
源代码：  https://github.com/114514CH-EN/pdf-translate-reader
"""


def build() -> Path:
    import PyInstaller.__main__  # noqa: N813 — imported late: only the build needs it

    if not (ROOT / "frontend" / "dist" / "index.html").exists():
        sys.exit("frontend/dist 不存在：先在 frontend 目录运行 npm run build")
    used = probe_models()
    sep = ";" if sys.platform == "win32" else ":"
    args = [
        str(ROOT / "launcher.py"),
        "--noconfirm", "--clean", "--onedir", "--windowed",  # no black console window: tray icon + data/logs/app.log
        "--name", NAME,
        "--icon", str(ROOT / "assets" / "app.ico"),
        "--distpath", str(ROOT / "dist"),
        "--workpath", str(ROOT / "build"),
        "--specpath", str(ROOT / "build"),
        "--add-data", f"{ROOT / 'frontend' / 'dist'}{sep}frontend/dist",
        "--add-data", f"{ROOT / 'backend' / 'app' / 'schema.sql'}{sep}backend/app",
        "--add-data", f"{ROOT / 'VERSION'}{sep}.",
        "--add-data", f"{ROOT / 'backend' / 'app' / 'ocr_models'}{sep}backend/app/ocr_models",
        "--hidden-import", "onnxruntime",
        "--collect-submodules", "uvicorn",
        "--collect-submodules", "backend",
        "--collect-all", "pymupdf",
        "--hidden-import", "backend.app.main",
        "--exclude-module", "pkg_resources",
        "--exclude-module", "tkinter",
        "--exclude-module", "pytest",
    ]
    PyInstaller.__main__.run(args)
    # The pet build is the same program started with --pet. PDFTranslate-Pet.exe (a copy the
    # launcher makes on first run) is no longer shipped: it was 16 MB of the download.
    (OUT / "启动桌宠版.bat").write_text('@echo off\r\nstart "" "%~dp0PDFTranslate.exe" --pet\r\n', encoding="ascii")
    (OUT / "使用说明.txt").write_text(README, encoding="utf-8-sig")
    prune(used)
    return OUT


# Runs in a clean interpreter: which ONNX models does PyMuPDF's table finder really open?
PROBE = r"""
import json, os, sys, warnings
warnings.filterwarnings("ignore")
used = []
try:
    import onnxruntime as ort
    class Session(ort.InferenceSession):
        def __init__(self, path, *a, **k):
            used.append(os.path.basename(str(path)))
            super().__init__(path, *a, **k)
    ort.InferenceSession = Session
    import pymupdf
    doc = pymupdf.open()
    page = doc.new_page()
    for r in range(4):
        for c in range(3):
            box = pymupdf.Rect(72 + c * 120, 100 + r * 30, 192 + c * 120, 130 + r * 30)
            page.draw_rect(box, color=(0, 0, 0), width=0.8)
            page.insert_text((box.x0 + 6, box.y0 + 20), f"cell {r}{c}", fontsize=11)
    data = doc.tobytes()
    page = pymupdf.open(stream=data, filetype="pdf")[0]
    n = len(page.find_tables().tables)
    print(json.dumps({"used": used, "tables": n}))
except Exception as e:
    print(json.dumps({"used": [], "tables": 0, "error": repr(e)}))
"""


def probe_models() -> list[str]:
    import json
    import subprocess

    out = subprocess.run([sys.executable, "-c", PROBE], capture_output=True, text=True, timeout=300).stdout
    try:
        info = json.loads(out.strip().splitlines()[-1])
    except Exception:
        info = {"used": [], "tables": 0}
    print(f"model probe: {info}")
    return sorted(set(info["used"])) if info.get("tables") else []


def prune(used: list[str]) -> None:
    """Drop what the app never loads: PyMuPDF ships 19 ONNX models (50 MB) and opens 3,
    plus the C headers and import libraries of MuPDF."""
    saved = 0
    internal = OUT / "_internal"
    onnx = internal / "pymupdf" / "layout" / "resources" / "onnx"
    if used and onnx.is_dir() and all((onnx / n).exists() for n in used):
        for f in onnx.glob("*.onnx"):
            if f.name not in used:
                saved += f.stat().st_size
                f.unlink()
    else:
        print("model probe found nothing to rely on: keeping every model")
    devel = internal / "pymupdf" / "mupdf-devel"
    if devel.is_dir():
        saved += sum(f.stat().st_size for f in devel.rglob("*") if f.is_file())
        shutil.rmtree(devel, ignore_errors=True)
    print(f"pruned {saved / 1024 / 1024:.1f} MB")


def pack(target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for p in sorted(OUT.rglob("*")):
            rel = p.relative_to(OUT)
            # never shipped: the library, a half-applied update, the twin exe the launcher makes
            if p.is_file() and rel.parts[0] not in ("data", "_update", "_internal.old", f"{NAME}-Pet.exe"):
                z.write(p, Path(NAME) / p.relative_to(OUT))
    print(f"packed {target} ({target.stat().st_size / 1024 / 1024:.1f} MB)")


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):  # an English Windows console (cp1252) cannot print Chinese
        try:
            stream.reconfigure(errors="replace")
        except Exception:
            pass
    if "--pack-only" not in sys.argv:
        build()
    if "--zip" in sys.argv:
        pack(Path(sys.argv[sys.argv.index("--zip") + 1]).resolve())
    print(f"完成：{OUT / (NAME + '.exe')}")
