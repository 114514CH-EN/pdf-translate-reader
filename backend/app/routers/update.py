"""In-app update: look for a newer release on GitHub, download it, swap the files, restart.

Only the packaged Windows app (PDFTranslate.exe) can install by itself. Running
from source (run.bat) or on a server, the check still works and the page links
to the download instead.

What "install" does:
  1. downloads PDFTranslate-vX-windows.zip of the latest release — only from this
     project's own release page — into <app folder>\\_update\\, checking the size
     and the SHA-256 that GitHub publishes for the file;
  2. unpacks it next to the zip and writes apply_update.bat;
  3. starts that script and stops the app. The script waits for the app to exit,
     copies the new files over the old ones (data\\ is not in the zip and is never
     touched), starts the app again and removes _update\\.
"""
from __future__ import annotations

import hashlib
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import zipfile
from pathlib import Path

import httpx
from fastapi import APIRouter, HTTPException, Request

from .. import cloud
from ..config import BASE_DIR, BUNDLE_DIR

router = APIRouter(prefix="/api/update")

REPO = "114514CH-EN/pdf-translate-reader"
LATEST_URL = f"https://api.github.com/repos/{REPO}/releases/latest"
DOWNLOAD_PREFIX = f"https://github.com/{REPO}/releases/download/"
RELEASES_PAGE = f"https://github.com/{REPO}/releases/latest"
APP_NAME = "PDFTranslate"
UPDATE_HEADER = "x-pdftr-update"
FROZEN = bool(getattr(sys, "frozen", False))

STATE: dict = {"state": "idle", "done": 0, "total": 0, "error": "", "version": ""}
_LOCK = threading.Lock()
_CHECK: dict = {"at": 0.0, "data": None}


def release_version() -> str:
    """The release this copy was built from (the VERSION file; bundled into the exe)."""
    for folder in (BUNDLE_DIR, BASE_DIR):
        try:
            return (Path(folder) / "VERSION").read_text(encoding="utf-8").strip()
        except Exception:
            continue
    return ""


def _key(v: str) -> tuple[int, ...]:
    return tuple(int(n) for n in re.findall(r"\d+", v)[:4])


def is_newer(latest: str, current: str) -> bool:
    return bool(latest and current) and _key(latest) > _key(current)


def can_install() -> bool:
    return FROZEN and os.name == "nt" and not cloud.enabled()


def _update_dir() -> Path:
    return Path(BASE_DIR) / "_update"


def _fetch_latest() -> dict:
    """The latest release, reduced to what the page needs. Raises HTTPException."""
    try:
        r = httpx.get(LATEST_URL, timeout=12, follow_redirects=True,
                      headers={"Accept": "application/vnd.github+json", "User-Agent": "pdf-translate-reader"})
    except httpx.HTTPError:
        raise HTTPException(502, "连不上 GitHub，请检查网络后再试")
    if r.status_code in (403, 429):
        raise HTTPException(502, "GitHub 暂时限制了查询次数，过一会儿再试")
    if r.status_code != 200:
        raise HTTPException(502, f"GitHub 返回了 {r.status_code}")
    data = r.json()
    asset = next((a for a in data.get("assets") or []
                  if str(a.get("name", "")).startswith(APP_NAME + "-") and str(a.get("name", "")).endswith("-windows.zip")
                  and str(a.get("browser_download_url", "")).startswith(DOWNLOAD_PREFIX)), None)
    return {
        "latest": str(data.get("tag_name") or "").lstrip("v"),
        "notes": str(data.get("body") or "")[:6000],
        "page": str(data.get("html_url") or RELEASES_PAGE),
        "asset": {"name": asset["name"], "url": asset["browser_download_url"], "size": int(asset.get("size") or 0),
                  "digest": str(asset.get("digest") or "")} if asset else None,
    }


@router.get("/check")
def check(force: bool = False):
    """Is there a newer release? Cached for 10 minutes (GitHub limits anonymous queries)."""
    current = release_version()
    now = time.time()
    if force or not _CHECK["data"] or now - _CHECK["at"] > 600:
        _CHECK["data"] = _fetch_latest()
        _CHECK["at"] = now
    info = _CHECK["data"]
    return {
        "current": current,
        "latest": info["latest"],
        "newer": is_newer(info["latest"], current),
        "notes": info["notes"],
        "page": info["page"],
        "size": info["asset"]["size"] if info["asset"] else 0,
        # the app can only replace itself when it is the packaged Windows program
        "can_install": can_install() and bool(info["asset"]),
        "packaged": FROZEN,
        "failed": last_update_failed(),
    }


@router.get("/status")
def status():
    return dict(STATE)


def _set(**kw) -> None:
    with _LOCK:
        STATE.update(kw)


def _download(asset: dict, target: Path) -> None:
    sha = hashlib.sha256()
    done = 0
    _set(state="downloading", done=0, total=asset["size"])
    with httpx.stream("GET", asset["url"], timeout=httpx.Timeout(30, read=60), follow_redirects=True,
                      headers={"User-Agent": "pdf-translate-reader"}) as r:
        if r.status_code != 200:
            raise RuntimeError(f"下载失败（{r.status_code}）")
        with open(target, "wb") as f:
            for chunk in r.iter_bytes(1 << 18):
                f.write(chunk)
                sha.update(chunk)
                done += len(chunk)
                STATE["done"] = done
    if asset["size"] and done != asset["size"]:
        raise RuntimeError("下载不完整，请再试一次")
    want = asset.get("digest") or ""
    if want.startswith("sha256:") and sha.hexdigest() != want[7:].lower():
        raise RuntimeError("下载的文件校验不通过，已放弃更新")


def _unpack(zip_path: Path, folder: Path) -> Path:
    """Unpack into folder; returns the directory holding PDFTranslate.exe."""
    _set(state="unpacking")
    root = folder.resolve()
    with zipfile.ZipFile(zip_path) as z:
        if z.testzip() is not None:
            raise RuntimeError("下载的压缩包已损坏，请再试一次")
        for info in z.infolist():
            dest = (folder / info.filename).resolve()
            if root != dest and root not in dest.parents:
                raise RuntimeError("压缩包里有不该出现的路径，已放弃更新")
            parts = Path(info.filename).parts
            if len(parts) > 1 and parts[1].lower() == "data":
                continue  # never part of a release; never overwrite the library
            z.extract(info, folder)
    new = folder / APP_NAME
    if not (new / f"{APP_NAME}.exe").exists() or not (new / "_internal").is_dir():
        raise RuntimeError("压缩包里没有找到程序文件，已放弃更新")
    return new


# Runs after the app has exited. ASCII only (no code-page trouble); every path is
# relative to the script itself, so a folder with Chinese characters works too.
APPLY_BAT = r"""@echo off
setlocal
cd /d "%~dp0.."
set PID=__PID__
set EXE=__EXE__
set N=0
:wait
tasklist /FI "PID eq %PID%" 2>nul | find " %PID% " >nul
if errorlevel 1 goto swap
set /a N+=1
if %N% GEQ 25 taskkill /PID %PID% /T /F >nul 2>&1
if %N% GEQ 40 goto giveup
ping -n 2 127.0.0.1 >nul
goto wait
:swap
if exist "_internal.old" rmdir /S /Q "_internal.old" >nul 2>&1
if exist "_internal" ren "_internal" "_internal.old" >nul 2>&1
set TRY=0
:copy
xcopy "_update\PDFTranslate\*" "." /E /Y /Q /I /H /R >nul 2>&1
if not errorlevel 1 goto copied
set /a TRY+=1
if %TRY% GEQ 5 goto restore
ping -n 3 127.0.0.1 >nul
goto copy
:restore
if exist "_internal.old" (
  rmdir /S /Q "_internal" >nul 2>&1
  ren "_internal.old" "_internal" >nul 2>&1
)
echo update failed> "_update\failed.txt"
start "" "%EXE%" --no-browser
exit /b 1
:copied
copy /Y "PDFTranslate.exe" "PDFTranslate-Pet.exe" >nul 2>&1
if exist "_internal.old" rmdir /S /Q "_internal.old" >nul 2>&1
start "" "%EXE%" --no-browser
rmdir /S /Q "_update\PDFTranslate" >nul 2>&1
del /Q "_update\*.zip" >nul 2>&1
(goto) 2>nul & rmdir /S /Q "_update" >nul 2>&1
exit /b 0
:giveup
echo app did not exit> "_update\failed.txt"
exit /b 1
"""


def _start_swap(folder: Path) -> None:
    exe = Path(sys.executable).name
    if not re.fullmatch(r"[A-Za-z0-9_.-]+\.exe", exe):
        exe = f"{APP_NAME}.exe"
    bat = folder / "apply_update.bat"
    bat.write_text(APPLY_BAT.replace("__PID__", str(os.getpid())).replace("__EXE__", exe).replace("\n", "\r\n"),
                   encoding="ascii")
    flags = 0x00000200 | 0x08000000  # CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW: outlives this process
    # the restarted exe must not think it is a child of this one (PyInstaller passes state by env)
    env = {k: v for k, v in os.environ.items() if not k.startswith("_PYI_") and k != "_MEIPASS2"}
    env["PYINSTALLER_RESET_ENVIRONMENT"] = "1"
    subprocess.Popen(["cmd.exe", "/c", str(bat)], cwd=str(BASE_DIR), creationflags=flags, close_fds=True, env=env,
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _install(asset: dict, version: str) -> None:
    folder = _update_dir()
    try:
        shutil.rmtree(folder, ignore_errors=True)
        folder.mkdir(parents=True, exist_ok=True)
        zip_path = folder / "update.zip"
        local = os.environ.get("PDFTR_UPDATE_ZIP")  # the release workflow tests the swap with a local file
        if local:
            shutil.copyfile(local, zip_path)
        else:
            _download(asset, zip_path)
        _unpack(zip_path, folder)
        zip_path.unlink(missing_ok=True)
        _set(state="restarting")
        _start_swap(folder)
        time.sleep(1.0)  # let the page read "restarting"
        from ..main import _exit_soon

        _exit_soon()
    except Exception as e:  # noqa: BLE001 — every failure ends as a message on the page
        shutil.rmtree(folder, ignore_errors=True)
        _set(state="error", error=str(e) or e.__class__.__name__)


@router.post("/install")
def install(request: Request):
    """Download the latest release and restart into it. Packaged Windows app only."""
    if cloud.enabled():
        raise HTTPException(404, "服务器版由服务器的主人更新")
    if request.headers.get(UPDATE_HEADER) != "1":  # same idea as /api/shutdown: no other site can trigger it
        raise HTTPException(403, "缺少确认头")
    host = request.client.host if request.client else ""
    if host not in ("127.0.0.1", "::1", "localhost", "testclient"):
        raise HTTPException(403, "只能从本机更新")
    if not can_install():
        raise HTTPException(400, "只有 Windows 的 exe 版能自动更新；源码版请下载新版本或 git pull")
    with _LOCK:
        if STATE["state"] in ("downloading", "unpacking", "restarting"):
            return dict(STATE)
    local = bool(os.environ.get("PDFTR_UPDATE_ZIP"))
    info = {"latest": "local", "asset": {"size": 0}} if local else _fetch_latest()
    if not local:
        if not info["asset"]:
            raise HTTPException(404, "这个版本还没有 Windows 安装包，过几分钟再试")
        if not is_newer(info["latest"], release_version()):
            raise HTTPException(400, "已经是最新版本")
    _set(state="downloading", done=0, total=info["asset"]["size"], error="", version=info["latest"])
    threading.Thread(target=_install, args=(info["asset"], info["latest"]), daemon=True).start()
    return dict(STATE)


def last_update_failed() -> bool:
    """A swap that could not finish leaves a note; shown once, then cleared."""
    note = _update_dir() / "failed.txt"
    if note.exists():
        shutil.rmtree(_update_dir(), ignore_errors=True)
        return True
    return False
