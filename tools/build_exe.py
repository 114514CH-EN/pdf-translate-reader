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
双击 PDFTranslate-Pet.exe   → 桌宠版（http://127.0.0.1:8765/pet）

两个版本共用这个文件夹里的 data\\（文档、译文、笔记、设置），可以随时切换。
不需要安装 Python 或 Node.js。整个文件夹可以放到任何位置，也可以复制到 U 盘。

关闭：关掉黑色的命令行窗口，或在程序的「设置 → 数据与安全」里点「退出程序」。
升级：下载新版本，把旧文件夹里的 data\\ 复制到新文件夹即可，所有文档和译文都还在。
第一次使用：在 ⚙ 设置里填翻译 API（DeepSeek、OpenAI、Ollama 等），把 PDF 拖进窗口。

项目主页：https://114514ch-en.github.io/pdf-translate-reader/
源代码：  https://github.com/114514CH-EN/pdf-translate-reader
"""


def build() -> Path:
    import PyInstaller.__main__  # noqa: N813 — imported late: only the build needs it

    if not (ROOT / "frontend" / "dist" / "index.html").exists():
        sys.exit("frontend/dist 不存在：先在 frontend 目录运行 npm run build")
    sep = ";" if sys.platform == "win32" else ":"
    args = [
        str(ROOT / "launcher.py"),
        "--noconfirm", "--clean", "--onedir", "--console",
        "--name", NAME,
        "--icon", str(ROOT / "assets" / "app.ico"),
        "--distpath", str(ROOT / "dist"),
        "--workpath", str(ROOT / "build"),
        "--specpath", str(ROOT / "build"),
        "--add-data", f"{ROOT / 'frontend' / 'dist'}{sep}frontend/dist",
        "--add-data", f"{ROOT / 'backend' / 'app' / 'schema.sql'}{sep}backend/app",
        "--collect-submodules", "uvicorn",
        "--collect-submodules", "backend",
        "--collect-all", "pymupdf",
        "--hidden-import", "backend.app.main",
        "--exclude-module", "pkg_resources",
        "--exclude-module", "tkinter",
        "--exclude-module", "pytest",
    ]
    PyInstaller.__main__.run(args)
    exe = OUT / f"{NAME}.exe"
    if exe.exists():
        # the same program; the launcher starts the pet build when its name ends in "-Pet"
        shutil.copy2(exe, OUT / f"{NAME}-Pet.exe")
    (OUT / "使用说明.txt").write_text(README, encoding="utf-8-sig")
    return OUT


def pack(target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for p in sorted(OUT.rglob("*")):
            if p.is_file() and "data" not in p.relative_to(OUT).parts[:1]:
                z.write(p, Path(NAME) / p.relative_to(OUT))
    print(f"packed {target} ({target.stat().st_size / 1024 / 1024:.1f} MB)")


if __name__ == "__main__":
    if "--pack-only" not in sys.argv:
        build()
    if "--zip" in sys.argv:
        pack(Path(sys.argv[sys.argv.index("--zip") + 1]).resolve())
    print(f"完成：{OUT / (NAME + '.exe')}")
