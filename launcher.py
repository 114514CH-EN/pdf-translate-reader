"""PDF 双语翻译阅读器 — desktop launcher (also the PyInstaller entry point).

Starts the local server on 127.0.0.1:8765 (or the next free port) and opens the
browser. If this version is already running it just opens the browser.

An older copy still holding the port is stopped, most gentle first:
  1. ask it over HTTP (POST /api/shutdown) — works wherever it runs, even in a
     sandbox or another session where Windows cannot see its process;
  2. the process id it reports in /api/health;
  3. whatever owns the port (Get-NetTCPConnection / netstat);
  4. python / PDFTranslate processes started from this folder.
If none of that frees the port, the new version starts on the next free port
instead of giving up — a stuck old copy can never block the app again.
"""
from __future__ import annotations

import atexit
import json
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

HOST, DEFAULT_PORT = "127.0.0.1", 8765
SPARE_PORTS = range(DEFAULT_PORT + 1, DEFAULT_PORT + 20)

# --pet opens the desktop-pet build (/pet) instead of the classic reader (/).
# One server, one data folder, two interfaces. The packaged app ships the same
# exe twice; the copy named PDFTranslate-Pet.exe starts the pet build.
FROZEN = bool(getattr(sys, "frozen", False))
PET = "--pet" in sys.argv or (FROZEN and Path(sys.executable).stem.lower().endswith("-pet"))
PATH = "/pet" if PET else ""


def _url(port: int) -> str:
    return f"http://{HOST}:{port}"


def _port_open(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.3)
        return s.connect_ex((HOST, port)) == 0


def _health(port: int) -> dict | None:
    """What our app reports on that port (None: nothing there, or not this app)."""
    try:
        with urllib.request.urlopen(_url(port) + "/api/health", timeout=2) as r:
            data = json.loads(r.read().decode("utf-8"))
            return data if data.get("ok") else None
    except Exception:
        return None


def _wait_closed(port: int, seconds: float) -> bool:
    end = time.time() + seconds
    while time.time() < end:
        if not _port_open(port):
            return True
        time.sleep(0.25)
    return not _port_open(port)


def _ask_to_quit(port: int) -> bool:
    """Versions from 2026.11.05-15 on (v1.1.0) stop themselves when asked."""
    req = urllib.request.Request(_url(port) + "/api/shutdown", data=b"", method="POST",
                                 headers={"X-PDFTR-Shutdown": "1"})
    try:
        with urllib.request.urlopen(req, timeout=3):
            pass
    except Exception:
        return False
    return _wait_closed(port, 8)


def _run(cmd: list[str], timeout: int = 15) -> str:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, errors="ignore").stdout or ""
    except Exception:
        return ""


def _port_pids(port: int) -> set[int]:
    """PIDs listening on the port (Windows): PowerShell, then netstat."""
    out = _run(["powershell", "-NoProfile", "-Command",
                f"(Get-NetTCPConnection -LocalPort {port} -State Listen -ErrorAction SilentlyContinue).OwningProcess"])
    pids = {int(t) for t in out.split() if t.isdigit()}
    if not pids:
        for line in _run(["netstat", "-ano"]).splitlines():
            parts = line.split()
            # Proto  Local  Foreign  State  PID  (the state is localised, e.g. 侦听)
            if len(parts) >= 5 and parts[0].upper() == "TCP" and parts[1].endswith(f":{port}") \
                    and parts[2].endswith(":0") and parts[-1].isdigit():
                pids.add(int(parts[-1]))
    return {p for p in pids if p > 4}  # 0 = idle, 4 = System


def _folder_pids(base: Path) -> set[int]:
    """Python / PDFTranslate processes started from this folder (Windows)."""
    folder = str(base).replace("'", "''")
    script = (
        "Get-CimInstance Win32_Process | Where-Object { "
        "($_.Name -like 'python*' -or $_.Name -like 'PDFTranslate*') -and "
        f"(($_.ExecutablePath -like '{folder}*') -or ($_.CommandLine -like '*{folder}*')) -and "
        "($_.CommandLine -match 'launcher|uvicorn|backend.app.main|PDFTranslate') "
        "} | ForEach-Object { $_.ProcessId }"
    )
    return {int(t) for t in _run(["powershell", "-NoProfile", "-Command", script], timeout=20).split() if t.isdigit()}


def _kill(pids: set[int]) -> None:
    me = {os.getpid(), os.getppid()}
    for pid in sorted(pids - me):
        out = _run(["taskkill", "/PID", str(pid), "/T", "/F"]).strip()
        print(f"  结束进程 {pid}：{out or '已发送'}")


def _stop_old(port: int, info: dict | None, base: Path) -> bool:
    print("  请它自己退出…")
    if _ask_to_quit(port):
        return True
    if os.name != "nt":
        return False
    steps = [
        ("按它报告的进程号结束", lambda: {int(info["pid"])} if info and str(info.get("pid", "")).isdigit() else set()),
        ("按端口查找进程", lambda: _port_pids(port)),
        ("按程序文件夹查找进程", lambda: _folder_pids(base)),
    ]
    for label, find in steps:
        pids = find() - {os.getpid(), os.getppid()}
        if not pids:
            continue
        print(f"  {label}：{', '.join(map(str, sorted(pids)))}")
        _kill(pids)
        if _wait_closed(port, 5):
            return True
    return False


def _spare_port() -> int | None:
    return next((p for p in SPARE_PORTS if not _port_open(p)), None)


def _state_file(data_dir: Path) -> Path:
    return data_dir / "server.json"


def _recorded(data_dir: Path) -> dict:
    try:
        return json.loads(_state_file(data_dir).read_text(encoding="utf-8"))
    except Exception:
        return {}


def _record(data_dir: Path, port: int, version: str) -> None:
    f = _state_file(data_dir)
    try:
        data_dir.mkdir(parents=True, exist_ok=True)
        f.write_text(json.dumps({"pid": os.getpid(), "port": port, "version": version}), encoding="utf-8")
    except Exception:
        return

    def _forget() -> None:
        try:
            if _recorded(data_dir).get("pid") == os.getpid():
                f.unlink()
        except Exception:
            pass

    atexit.register(_forget)


def _open(port: int) -> None:
    webbrowser.open(_url(port) + PATH)


def _open_when_ready(port: int) -> None:
    for _ in range(120):
        if _port_open(port):
            _open(port)
            return
        time.sleep(0.25)


def _ver_key(v: str) -> tuple[int, ...]:
    """'2026.11.13-3' → (2026, 11, 13, 3), so versions compare in release order."""
    import re

    return tuple(int(n) for n in re.findall(r"\d+", v)[:5])


def _hand_over_to_main() -> bool:
    """PDFTranslate-Pet.exe is a copy of PDFTranslate.exe. If an update replaced the original
    and could not refresh the copy, the copy still holds the old program: start the
    original in pet mode instead (it remakes the copy), and step aside."""
    if not FROZEN or os.name != "nt":
        return False
    me = Path(sys.executable)
    if not me.stem.lower().endswith("-pet"):
        return False
    main_exe = me.with_name(me.stem[: -len("-pet")] + ".exe")
    try:
        a, b = main_exe.stat(), me.stat()
        if a.st_size == b.st_size and int(a.st_mtime) == int(b.st_mtime):
            return False
        import subprocess

        args = [x for x in sys.argv[1:] if x != "--pet"]
        subprocess.Popen([str(main_exe), "--pet", *args], cwd=str(me.parent), close_fds=True)
        return True
    except Exception:
        return False


def _pick_port(version: str, base: Path, data_dir: Path) -> int | None:
    """Port to start on; None when this version is already running (browser opened); -1: no port."""
    # this version may already run on a spare port (an old copy kept 8765 busy last time)
    rec = _recorded(data_dir)
    rec_port = int(rec.get("port") or 0)
    if rec_port and rec_port != DEFAULT_PORT and _port_open(rec_port):
        info = _health(rec_port)
        if info and info.get("version") == version:
            print(f"已在运行：{_url(rec_port)}{PATH}")
            _open(rec_port)
            return None

    if not _port_open(DEFAULT_PORT):
        return DEFAULT_PORT
    info = _health(DEFAULT_PORT)
    if info and info.get("version") == version:
        print(f"已在运行：{_url(DEFAULT_PORT)}{PATH}")
        _open(DEFAULT_PORT)
        return None
    if info is None:
        print(f"端口 {DEFAULT_PORT} 被其他程序占用。")
    elif _ver_key(version) and _ver_key(str(info.get("version") or "")) > _ver_key(version):
        # this exe is the stale one (a copy left behind by an update): never replace a newer
        # server with older code — the page it serves would not match it
        print(f"已有更新的版本（{info.get('version')}）在运行，直接打开它：{_url(DEFAULT_PORT)}{PATH}")
        _open(DEFAULT_PORT)
        return None
    else:
        print(f"检测到旧版本服务（{info.get('version') or '未知版本'}）仍在运行，正在关闭它…")
        # an old server would serve the new page with old backend code
        if _stop_old(DEFAULT_PORT, info, base):
            print("  旧服务已关闭。")
            return DEFAULT_PORT
        print("  关不掉它：它可能运行在别的窗口或沙箱里（例如另一个 Claude 窗口启动的测试服务），")
        print("  这台电脑上看不到它的进程。它不影响你使用，那边结束时会自动关闭。")
    port = _spare_port()
    if port is None:
        print(f"端口 {DEFAULT_PORT}–{SPARE_PORTS[-1]} 都被占用，无法启动。")
        return -1
    print(f"  改用端口 {port} 启动。")
    return port


def _pet_copy() -> None:
    """PDFTranslate-Pet.exe is this same program under another name. The download ships
    one exe (half the size); the twin is made here, and remade after every update."""
    if not FROZEN or os.name != "nt":
        return
    me = Path(sys.executable)
    if me.stem.lower().endswith("-pet"):
        return
    twin = me.with_name(me.stem + "-Pet.exe")

    def attempt() -> bool:
        try:
            a = me.stat()
            if twin.exists():
                b = twin.stat()
                if b.st_size == a.st_size and int(b.st_mtime) == int(a.st_mtime):
                    return True
                twin.unlink()
            import shutil

            shutil.copy2(me, twin)
            return True
        except Exception:
            return False  # in use, or a read-only folder: 启动桌宠版.bat still works

    if attempt():
        return

    def later() -> None:  # the old twin may be the process that just started us and is still closing
        for _ in range(10):
            time.sleep(1.5)
            if attempt():
                return

    threading.Thread(target=later, daemon=True).start()


def _windowed() -> bool:
    """The packaged app has no console window (since v1.5.0): nothing to print to, nobody to ask."""
    return FROZEN and os.name == "nt" and "--console" not in sys.argv


def _open_console() -> None:
    """PDFTranslate.exe --console: the old black window, for watching what the app does."""
    if not (FROZEN and os.name == "nt" and "--console" in sys.argv):
        return
    try:
        import ctypes

        if ctypes.windll.kernel32.AllocConsole():
            sys.stdout = open("CONOUT$", "w", encoding="utf-8", errors="replace", buffering=1)  # noqa: SIM115
            sys.stderr = sys.stdout
    except Exception:
        pass


def _log_file(data_dir: Path) -> Path:
    return data_dir / "logs" / "app.log"


def _log_to_file(data_dir: Path) -> None:
    """Without a console, everything the app prints goes to data\\logs\\app.log."""
    if not _windowed() and sys.stdout is not None and sys.stderr is not None:
        return
    try:
        log = _log_file(data_dir)
        log.parent.mkdir(parents=True, exist_ok=True)
        if log.exists() and log.stat().st_size > 1_000_000:
            log.replace(log.with_name("app.old.log"))
        f = open(log, "a", encoding="utf-8", errors="replace", buffering=1)  # noqa: SIM115
        f.write(f"\n===== {time.strftime('%Y-%m-%d %H:%M:%S')} =====\n")
        sys.stdout = sys.stderr = f
    except Exception:
        if sys.stdout is None or sys.stderr is None:
            sys.stdout = sys.stderr = open(os.devnull, "w")  # noqa: SIM115


def _alert(text: str) -> None:
    """Something the user must see: a message box without a console, else the old prompt."""
    if _windowed():
        try:
            import ctypes

            ctypes.windll.user32.MessageBoxW(None, text, "PDF 双语翻译阅读器", 0x30)
        except Exception:
            pass
        return
    try:
        input(text + " 按回车退出")
    except Exception:
        pass


def _start_tray(port: int, data_dir: Path) -> None:
    """The app's presence now that the console is gone: an icon next to the clock."""
    if not _windowed():
        return
    try:
        import tray

        first = data_dir / "logs" / ".tray-hint-shown"
        hint = None
        if not first.exists():
            hint = "程序在后台运行。点这个图标打开阅读器，右键可以退出。"
            try:
                first.parent.mkdir(parents=True, exist_ok=True)
                first.write_text("1", encoding="utf-8")
            except Exception:
                pass

        def quit_app() -> None:
            from backend.app.main import _exit_soon

            _exit_soon()

        tray.start(
            "PDF 双语翻译阅读器",
            on_open=lambda: webbrowser.open(_url(port)),
            on_pet=lambda: webbrowser.open(_url(port) + "/pet"),
            on_quit=quit_app,
            log_path=str(_log_file(data_dir)),
            hint=hint,
        )
        atexit.register(tray.stop)
    except Exception as e:  # noqa: BLE001 — the app works without the icon
        print(f"[tray] unavailable: {e!r}")


def _console_title() -> None:
    if os.name == "nt":
        try:
            import ctypes

            ctypes.windll.kernel32.SetConsoleTitleW(f"PDF 双语翻译阅读器{'（桌宠版）' if PET else ''}")
        except Exception:
            pass


def _pause_on_crash() -> None:
    """The packaged exe has no run.bat around it: keep the window open on an error."""
    if FROZEN:
        import traceback

        try:
            traceback.print_exc()
        except Exception:
            pass
        if _windowed():
            _alert("启动失败。错误信息在程序文件夹的 data\\logs\\app.log 里，请把这个文件发给开发者。")
        else:
            _alert("启动失败，请把上面的错误信息截图发给开发者。")


def _safe_output() -> None:
    """Chinese messages must not crash an English Windows console or a redirected log."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")  # type: ignore[union-attr]
        except Exception:
            pass


def main() -> None:
    _open_console()
    if sys.stdout is None or sys.stderr is None:  # no console: nothing may print before the log is open
        sys.stdout = sys.stderr = open(os.devnull, "w")  # noqa: SIM115
    _safe_output()
    _console_title()
    if _hand_over_to_main():
        return
    _pet_copy()
    from backend.app.config import APP_VERSION, BASE_DIR, DATA_DIR

    _log_to_file(Path(DATA_DIR))

    port = _pick_port(APP_VERSION, Path(BASE_DIR), Path(DATA_DIR))
    if port is None:
        return
    if port < 0:
        _alert(f"端口 {DEFAULT_PORT}–{SPARE_PORTS[-1]} 都被占用，无法启动。")
        sys.exit(1)

    import uvicorn

    from backend.app.main import app

    _record(Path(DATA_DIR), port, APP_VERSION)
    if "--no-browser" not in sys.argv:
        threading.Thread(target=_open_when_ready, args=(port,), daemon=True).start()
    print(f"PDF 双语翻译阅读器{'（桌宠版）' if PET else ''}已启动：{_url(port)}{PATH}")
    if _windowed():
        print("关闭方法：右键任务栏右下角的图标 → 退出，或在程序的 设置 → 数据与安全 里点「退出程序」。")
        _start_tray(port, Path(DATA_DIR))
    else:
        print("关闭方法：关掉这个窗口、按 Ctrl+C，或在程序的 设置 → 数据与安全 里点「退出程序」。")
    try:
        uvicorn.run(app, host=HOST, port=port, log_level="warning")
    except KeyboardInterrupt:
        pass
    print("已退出。")


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except BaseException:
        _pause_on_crash()
        raise
