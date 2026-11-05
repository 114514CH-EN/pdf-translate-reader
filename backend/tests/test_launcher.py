"""Launcher start/stop: never blocked by an old copy it cannot stop."""
from __future__ import annotations

import json
import socket
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "backend"))

import launcher  # noqa: E402


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _fake_server(port: int, version: str, obeys_shutdown: bool) -> HTTPServer:
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            body = json.dumps({"ok": True, "version": version, "pid": 999999}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            ok = obeys_shutdown and self.headers.get("X-PDFTR-Shutdown") == "1"
            self.send_response(200 if ok else 404)
            self.end_headers()
            if ok:
                threading.Thread(target=srv.shutdown, daemon=True).start()

    srv = HTTPServer(("127.0.0.1", port), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def _setup(monkeypatch, tmp_path):
    port = _free_port()
    monkeypatch.setattr(launcher, "DEFAULT_PORT", port)
    monkeypatch.setattr(launcher, "SPARE_PORTS", range(port + 1, port + 20))
    monkeypatch.setattr(launcher, "_open", lambda p: None)
    monkeypatch.setattr(launcher, "_wait_closed", lambda p, s: not launcher._port_open(p) or _settle(p))
    monkeypatch.setattr(launcher.os, "name", "posix")  # no taskkill in tests
    return port


def _settle(port: int) -> bool:
    import time

    for _ in range(40):
        if not launcher._port_open(port):
            return True
        time.sleep(0.05)
    return False


def test_unstoppable_old_copy_starts_on_a_spare_port(monkeypatch, tmp_path):
    port = _setup(monkeypatch, tmp_path)
    srv = _fake_server(port, "2026.01.01-1", obeys_shutdown=False)  # e.g. running in a sandbox
    try:
        got = launcher._pick_port("NEW", tmp_path, tmp_path)
        assert got is not None and got != port and got in launcher.SPARE_PORTS
    finally:
        srv.server_close()


def test_old_copy_that_obeys_is_replaced_on_the_default_port(monkeypatch, tmp_path):
    port = _setup(monkeypatch, tmp_path)
    srv = _fake_server(port, "2026.01.01-1", obeys_shutdown=True)
    try:
        assert launcher._pick_port("NEW", tmp_path, tmp_path) == port
    finally:
        srv.server_close()


def test_same_version_is_reused_even_on_a_spare_port(monkeypatch, tmp_path):
    port = _setup(monkeypatch, tmp_path)
    spare = port + 3
    srv = _fake_server(spare, "NEW", obeys_shutdown=False)
    (tmp_path / "server.json").write_text(json.dumps({"pid": 1, "port": spare, "version": "NEW"}))
    try:
        assert launcher._pick_port("NEW", tmp_path, tmp_path) is None  # just opens the browser
    finally:
        srv.server_close()


def test_free_default_port_is_used(monkeypatch, tmp_path):
    port = _setup(monkeypatch, tmp_path)
    assert launcher._pick_port("NEW", tmp_path, tmp_path) == port


def test_shutdown_endpoint_needs_the_header(monkeypatch):
    from fastapi.testclient import TestClient

    from app import main

    calls = []
    monkeypatch.setattr(main, "_exit_soon", lambda: calls.append(1))
    with TestClient(main.app) as c:
        h = c.get("/api/health").json()
        assert h["pid"] > 0 and h["base_dir"]
        assert c.post("/api/shutdown").status_code == 403  # a web page cannot close the app
        assert c.post("/api/shutdown", headers={"X-PDFTR-Shutdown": "1"}).json()["ok"] is True
    import time

    time.sleep(0.2)
    assert calls == [1]
