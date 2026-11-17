"""Word documents in: turn .docx / .doc / .rtf / .odt into a PDF, which the rest of the app reads.

The best result comes from the program that made the file, so this asks, in order:

  1. Microsoft Word   (Windows, through its COM interface, driven by PowerShell)
  2. WPS 文字          (Windows, the same interface under its own name)
  3. LibreOffice      (any system, `soffice --headless --convert-to pdf`)
  4. MuPDF            (built in, .docx only) — always there, but it lays the text out
                      itself: tables, lists and most styling are lost, so the upload says so

Nothing new has to be installed for any of these; each one that is missing is skipped.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

import pymupdf as fitz

WORD_EXT = {".docx", ".doc", ".rtf", ".odt"}
TIMEOUT = 180  # a long document in Word takes a while; a hung converter must not hang the upload

SIMPLE = "内置转换"


class ConvertError(Exception):
    """Shown to the user as it is."""


def _no_window() -> dict:
    if sys.platform == "win32":
        return {"creationflags": 0x08000000}  # CREATE_NO_WINDOW: no console flashing up
    return {}


# Paths travel in environment variables, so quotes or spaces in a file name cannot break
# the script. ReadOnly, no conversion prompt, not added to the recent list; the dummy
# password makes a protected file fail at once instead of waiting on a dialog.
_PS = r"""
$ErrorActionPreference = 'Stop'
$app = New-Object -ComObject $env:PDFTR_PROGID
try { $app.Visible = $false } catch {}
try { $app.DisplayAlerts = 0 } catch {}
try {
  $doc = $app.Documents.Open($env:PDFTR_SRC, $false, $true, $false, 'pdftr-no-password')
  try { $doc.ExportAsFixedFormat($env:PDFTR_OUT, 17) }
  catch { $doc.SaveAs2($env:PDFTR_OUT, 17) }
  $doc.Close(0)
} finally {
  try { $app.Quit() } catch {}
  [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($app)
}
"""

COM_APPS = [("Microsoft Word", "Word.Application"), ("WPS 文字", "KWps.Application")]


def _via_com(progid: str, src: Path, out: Path) -> bool:
    ps = shutil.which("powershell") or shutil.which("pwsh")
    if not ps:
        return False
    env = {**os.environ, "PDFTR_PROGID": progid, "PDFTR_SRC": str(src), "PDFTR_OUT": str(out)}
    try:
        subprocess.run(
            [ps, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", _PS],
            env=env, capture_output=True, timeout=TIMEOUT, check=False, **_no_window(),
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return _is_pdf(out)


def find_soffice() -> str | None:
    for name in ("soffice", "libreoffice"):
        p = shutil.which(name)
        if p:
            return p
    candidates = [
        Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "LibreOffice/program/soffice.exe",
        Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")) / "LibreOffice/program/soffice.exe",
        Path("/Applications/LibreOffice.app/Contents/MacOS/soffice"),
    ]
    for c in candidates:
        if c.is_file():
            return str(c)
    return None


def _via_libreoffice(src: Path, out: Path) -> bool:
    exe = find_soffice()
    if not exe:
        return False
    with tempfile.TemporaryDirectory(prefix="pdftr-lo-") as tmp:
        # a profile of its own: works even while LibreOffice is open on the desktop
        profile = Path(tmp, "profile").as_uri()
        try:
            subprocess.run(
                [exe, f"-env:UserInstallation={profile}", "--headless", "--norestore",
                 "--convert-to", "pdf", "--outdir", tmp, str(src)],
                capture_output=True, timeout=TIMEOUT, check=False, **_no_window(),
            )
        except (OSError, subprocess.TimeoutExpired):
            return False
        made = Path(tmp, src.stem + ".pdf")
        if not _is_pdf(made):
            return False
        shutil.move(str(made), out)
    return True


def _via_mupdf(src: Path, out: Path) -> bool:
    if src.suffix.lower() != ".docx":
        return False
    try:
        with fitz.open(src) as d:
            pdf = d.convert_to_pdf()
        out.write_bytes(pdf)
    except Exception:
        return False
    return _is_pdf(out)


def _is_pdf(p: Path) -> bool:
    try:
        if not p.is_file() or p.stat().st_size == 0:
            return False
        with fitz.open(p) as d:
            return d.is_pdf and d.page_count > 0
    except Exception:
        return False


# what the start of each kind of file looks like: LibreOffice would otherwise happily open a
# damaged or misnamed file as plain text and "convert" its bytes into a page of gibberish
_MAGIC = {".docx": (b"PK\x03\x04",), ".odt": (b"PK\x03\x04",), ".doc": (b"\xd0\xcf\x11\xe0",), ".rtf": (b"{\\rtf",)}


def office_to_pdf(data: bytes, ext: str, work: Path) -> tuple[bytes, str]:
    """The PDF for a Word file's bytes, and which program made it (SIMPLE: the built-in one)."""
    ext = ext.lower()
    if ext not in WORD_EXT:
        raise ConvertError("不支持这种文件")
    if not data.startswith(_MAGIC[ext]):
        raise ConvertError(f"这个文件不是有效的 {ext} 文档：它可能已损坏，或者扩展名不对")
    work.mkdir(parents=True, exist_ok=True)
    job = work / uuid.uuid4().hex
    job.mkdir()
    try:
        # a plain ASCII name: some converters trip over unusual characters in paths
        src = job / f"source{ext}"
        src.write_bytes(data)
        out = job / "out.pdf"
        if sys.platform == "win32":
            for name, progid in COM_APPS:
                if _via_com(progid, src, out):
                    return out.read_bytes(), name
        if _via_libreoffice(src, out):
            return out.read_bytes(), "LibreOffice"
        if _via_mupdf(src, out):
            return out.read_bytes(), SIMPLE
    finally:
        shutil.rmtree(job, ignore_errors=True)
    if ext == ".docx":
        raise ConvertError("这个 Word 文件转换失败：它可能已损坏，或设置了打开密码")
    raise ConvertError(
        f"打开 {ext} 文件需要电脑上装有 Microsoft Word、WPS 或 LibreOffice（都没找到，或转换失败）。"
        "也可以先在 Word 里另存为 .docx 或 PDF 再导入"
    )
