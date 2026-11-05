"""PDF 双语翻译阅读器 — desktop launcher (also the PyInstaller entry point).

Starts the local server on 127.0.0.1:8765 and opens the browser. If the app is
already running, it just opens the browser.
"""
from __future__ import annotations

import socket
import sys
import threading
import time
import webbrowser

HOST, PORT = "127.0.0.1", 8765
URL = f"http://{HOST}:{PORT}"


def _port_open() -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.3)
        return s.connect_ex((HOST, PORT)) == 0


def _open_when_ready() -> None:
    for _ in range(120):
        if _port_open():
            webbrowser.open(URL)
            return
        time.sleep(0.25)


def _running_version() -> str | None:
    """Version reported by whatever is listening on the port (None = not our app / too old)."""
    import json
    import urllib.request

    try:
        with urllib.request.urlopen(URL + "/api/health", timeout=2) as r:
            return json.loads(r.read().decode("utf-8")).get("version")
    except Exception:
        return None


def _port_pids() -> set[str]:
    """PIDs listening on PORT (Windows). Tries PowerShell first, then netstat."""
    import subprocess

    pids: set[str] = set()
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             f"(Get-NetTCPConnection -LocalPort {PORT} -State Listen -ErrorAction SilentlyContinue).OwningProcess"],
            capture_output=True, text=True, timeout=15,
        ).stdout
        pids |= {t.strip() for t in out.split() if t.strip().isdigit() and t.strip() != "0"}
    except Exception:
        pass
    if not pids:
        try:
            out = subprocess.run(["netstat", "-ano"], capture_output=True, text=True, timeout=15, errors="ignore").stdout
            for line in out.splitlines():
                parts = line.split()
                # Proto  Local  Foreign  State  PID  (state may be localised, e.g. 侦听)
                if len(parts) >= 5 and parts[0].upper() == "TCP" and parts[1].endswith(f":{PORT}") and parts[2].endswith(":0"):
                    if parts[-1].isdigit() and parts[-1] != "0":
                        pids.add(parts[-1])
        except Exception:
            pass
    return pids


def _stop_port_owner() -> bool:
    """Stop the process listening on PORT (an older copy of this app)."""
    import os
    import subprocess

    if os.name != "nt":
        return False
    pids = _port_pids()
    for pid in pids:
        r = subprocess.run(["taskkill", "/PID", pid, "/T", "/F"], capture_output=True, text=True, errors="ignore")
        print(f"  结束进程 {pid}: {(r.stdout or r.stderr).strip()}")
    if not pids:
        print("  没找到占用端口的进程号。")
    for _ in range(40):
        if not _port_open():
            return True
        time.sleep(0.25)
    if pids:
        print(f"  仍未关闭，可在任务管理器 →「详细信息」中手动结束 PID {', '.join(sorted(pids))}（python.exe）。")
    return not _port_open()


def main() -> None:
    from backend.app.config import APP_VERSION

    if _port_open():
        running = _running_version()
        if running == APP_VERSION:
            print(f"已在运行：{URL}")
            webbrowser.open(URL)
            return
        # an older server (e.g. started before an update) is still holding the port:
        # reusing it would serve the new page with old backend code
        print(f"检测到旧版本服务（{running or '未知版本'}）仍在运行，正在关闭它…")
        if not _stop_port_owner():
            print("无法自动关闭旧服务，请手动关闭旧的命令行窗口后再运行 run.bat。")
            input("按回车退出")
            return
    import uvicorn

    from backend.app.main import app

    if "--no-browser" not in sys.argv:
        threading.Thread(target=_open_when_ready, daemon=True).start()
    print(f"PDF 双语翻译阅读器已启动：{URL}（关闭此窗口即退出）")
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")


if __name__ == "__main__":
    main()
