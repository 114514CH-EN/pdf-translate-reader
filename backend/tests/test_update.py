"""In-app update: version check, the download guard rails, the swap script. No network."""
from __future__ import annotations

import hashlib
import io
import sys
import zipfile
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.main import app  # noqa: E402
from app.routers import update  # noqa: E402

BASE = "https://github.com/114514CH-EN/pdf-translate-reader/releases/download/v9.9.9/"


def _zip(extra: dict[str, bytes] | None = None) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("PDFTranslate/PDFTranslate.exe", b"new exe")
        z.writestr("PDFTranslate/_internal/base_library.zip", b"lib")
        z.writestr("PDFTranslate/data/pdf_translate.db", b"must never be unpacked")
        for name, data in (extra or {}).items():
            z.writestr(name, data)
    return buf.getvalue()


class _Resp:
    def __init__(self, body: dict, status: int = 200):
        self.status_code, self._body = status, body

    def json(self):
        return self._body


def _release(tag="v9.9.9", url=BASE + "PDFTranslate-v9.9.9-windows.zip", data=b""):
    return {"tag_name": tag, "body": "notes", "html_url": "https://github.com/x/releases/tag/" + tag,
            "assets": [{"name": "pdf-translate-reader-v9.9.9.zip", "browser_download_url": BASE + "src.zip", "size": 1},
                       {"name": "PDFTranslate-v9.9.9-windows.zip", "browser_download_url": url, "size": len(data),
                        "digest": "sha256:" + hashlib.sha256(data).hexdigest()}]}


@pytest.fixture()
def fresh(monkeypatch, tmp_path):
    update._CHECK.update(at=0.0, data=None)
    update.STATE.update(state="idle", done=0, total=0, error="", version="")
    monkeypatch.setattr(update, "BASE_DIR", tmp_path)
    monkeypatch.setattr(update, "release_version", lambda: "1.3.0")
    return tmp_path


def test_version_order():
    assert update.is_newer("1.10.0", "1.9.9") and update.is_newer("2.0", "1.9.9")
    assert not update.is_newer("1.3.0", "1.3.0") and not update.is_newer("1.2.9", "1.3.0")
    assert not update.is_newer("", "1.3.0")


def test_check_reports_a_newer_release(fresh, monkeypatch):
    monkeypatch.setattr(httpx, "get", lambda *a, **k: _Resp(_release()))
    with TestClient(app) as c:
        r = c.get("/api/update/check").json()
    assert r["current"] == "1.3.0" and r["latest"] == "9.9.9" and r["newer"] is True
    assert r["can_install"] is False  # the tests run from source, not from the exe


def test_asset_from_another_site_is_ignored(fresh, monkeypatch):
    monkeypatch.setattr(httpx, "get", lambda *a, **k: _Resp(_release(url="https://evil.test/PDFTranslate-v9.9.9-windows.zip")))
    assert update._fetch_latest()["asset"] is None


def test_github_down_is_a_clear_message(fresh, monkeypatch):
    def boom(*a, **k):
        raise httpx.ConnectError("no network")
    monkeypatch.setattr(httpx, "get", boom)
    with TestClient(app) as c:
        r = c.get("/api/update/check")
    assert r.status_code == 502 and "GitHub" in r.json()["detail"]


def test_install_needs_the_header_and_the_exe(fresh):
    with TestClient(app) as c:
        assert c.post("/api/update/install").status_code == 403  # another web page cannot trigger it
        assert c.post("/api/update/install", headers={"X-PDFTR-Update": "1"}).status_code == 400  # source run


def test_unpack_skips_data_and_refuses_escapes(fresh):
    folder = fresh / "_update"
    folder.mkdir()
    (folder / "ok.zip").write_bytes(_zip())
    new = update._unpack(folder / "ok.zip", folder)
    assert (new / "PDFTranslate.exe").read_bytes() == b"new exe"
    assert not (new / "data").exists()
    (folder / "bad.zip").write_bytes(_zip({"../escaped.txt": b"x"}))
    with pytest.raises(RuntimeError):
        update._unpack(folder / "bad.zip", folder)
    assert not (fresh / "escaped.txt").exists()


def test_download_checks_size_and_hash(fresh, monkeypatch):
    data = _zip()

    class _Stream:
        status_code = 200

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def iter_bytes(self, n):
            yield data

    monkeypatch.setattr(httpx, "stream", lambda *a, **k: _Stream())
    good = {"url": BASE + "a.zip", "size": len(data), "digest": "sha256:" + hashlib.sha256(data).hexdigest()}
    update._download(good, fresh / "a.zip")
    assert (fresh / "a.zip").read_bytes() == data
    with pytest.raises(RuntimeError):
        update._download({**good, "digest": "sha256:" + "0" * 64}, fresh / "b.zip")
    with pytest.raises(RuntimeError):
        update._download({**good, "size": len(data) + 1}, fresh / "c.zip")


def test_full_install_ends_in_the_swap_script(fresh, monkeypatch):
    data = _zip()
    started = []
    monkeypatch.setattr(update, "_download", lambda asset, target: target.write_bytes(data))
    monkeypatch.setattr(update, "_start_swap", lambda folder: started.append(folder))
    monkeypatch.setattr(update.time, "sleep", lambda s: None)
    import app.main as main

    monkeypatch.setattr(main, "_exit_soon", lambda: started.append("exit"))
    update._install({"url": BASE + "a.zip", "size": len(data), "digest": ""}, "9.9.9")
    assert started == [fresh / "_update", "exit"] and update.STATE["state"] == "restarting"
    assert (fresh / "_update" / "PDFTranslate" / "_internal" / "base_library.zip").exists()
    assert not (fresh / "_update" / "update.zip").exists()


def test_failed_install_cleans_up(fresh, monkeypatch):
    def broken(asset, target):
        raise RuntimeError("下载不完整，请再试一次")
    monkeypatch.setattr(update, "_download", broken)
    update._install({"url": BASE + "a.zip", "size": 1, "digest": ""}, "9.9.9")
    assert update.STATE["state"] == "error" and "下载不完整" in update.STATE["error"]
    assert not (fresh / "_update").exists()


def test_swap_script_is_plain_ascii_and_never_touches_data():
    update.APPLY_BAT.encode("ascii")
    assert "data" not in update.APPLY_BAT.lower().replace("_update", "")
