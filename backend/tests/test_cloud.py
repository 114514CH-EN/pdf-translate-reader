"""Server version (cloud mode): workspace login, session cookie, locked API.

The workspace auth service is replaced by a stub — no network, no real accounts.
"""
from __future__ import annotations

import sys
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import cloud  # noqa: E402
from app.main import app  # noqa: E402

USERS = {"alice": "right-password", "bob": "bobs-password"}


class _Resp:
    def __init__(self, status: int, body: dict):
        self.status_code = status
        self._body = body

    def json(self):
        return self._body


def _fake_workspace(url, json=None, timeout=None):  # noqa: A002 — httpx.post's own keyword
    assert url == "https://workspace.test/api/auth" and json["action"] == "login"
    if USERS.get(json["username"]) == json["password"]:
        return _Resp(200, {"ok": True, "token": "ws-token", "username": json["username"], "role": "user"})
    return _Resp(401, {"error": "用户名或密码错误"})


@pytest.fixture()
def cloud_env(monkeypatch):
    monkeypatch.setenv("PDFTR_AUTH_URL", "https://workspace.test/api/auth")
    monkeypatch.setenv("PDFTR_ALLOWED_USERS", "Alice")
    monkeypatch.setenv("PDFTR_SESSION_SECRET", "s" * 32)
    monkeypatch.setenv("PDFTR_COOKIE_SECURE", "0")  # the test client speaks plain http
    monkeypatch.setattr(httpx, "post", _fake_workspace)
    cloud._FAILS.clear()
    with TestClient(app) as c:
        yield c


def test_server_without_login_config_refuses(monkeypatch):
    monkeypatch.setenv("PDFTR_REQUIRE_AUTH", "1")
    monkeypatch.delenv("PDFTR_AUTH_URL", raising=False)
    with TestClient(app) as c:
        assert c.get("/api/health").status_code == 200
        assert c.get("/api/documents").status_code == 503


def test_local_mode_needs_no_login():
    with TestClient(app) as c:
        assert c.get("/api/session").json() == {"cloud": False, "user": None}
        assert c.get("/api/documents").status_code == 200


def test_api_is_locked_until_login(cloud_env):
    c = cloud_env
    assert c.get("/api/health").status_code == 200  # the version check works before login
    assert "pid" not in c.get("/api/health").json()  # no process details for the outside
    assert c.get("/api/session").json() == {"cloud": True, "user": None}
    r = c.get("/api/documents")
    assert r.status_code == 401 and r.json()["detail"] == "请先登录"
    assert c.get("/api/settings").status_code == 401


def test_login_with_workspace_account(cloud_env):
    c = cloud_env
    assert c.post("/api/login", json={"username": "alice", "password": "wrong"}).status_code == 401
    r = c.post("/api/login", json={"username": "alice", "password": "right-password"})
    assert r.status_code == 200 and r.json()["user"] == "alice"
    cookie = r.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=lax" in cookie
    assert c.get("/api/session").json() == {"cloud": True, "user": "alice"}
    docs = c.get("/api/documents")
    assert docs.status_code == 200
    assert docs.headers["cache-control"].startswith("private")  # never cached by the CDN
    c.post("/api/logout")
    assert c.get("/api/documents").status_code == 401


def test_only_allowed_users(cloud_env):
    r = cloud_env.post("/api/login", json={"username": "bob", "password": "bobs-password"})
    assert r.status_code == 403  # a valid workspace account, but not on the list


def test_forged_or_expired_cookie(cloud_env, monkeypatch):
    c = cloud_env
    good = cloud.sign("alice")
    payload, sig = good.rsplit(".", 1)
    c.cookies.set(cloud.COOKIE, payload + "." + sig[:-2] + "xx")
    assert c.get("/api/documents").status_code == 401
    c.cookies.set(cloud.COOKIE, cloud.sign("alice", now=0))  # expired decades ago
    assert c.get("/api/documents").status_code == 401
    c.cookies.set(cloud.COOKIE, good)
    assert c.get("/api/documents").status_code == 200
    monkeypatch.setenv("PDFTR_ALLOWED_USERS", "carol")  # removed from the list later
    assert c.get("/api/documents").status_code == 401


def test_shutdown_is_off_on_a_server(cloud_env):
    c = cloud_env
    c.cookies.set(cloud.COOKIE, cloud.sign("alice"))
    assert c.post("/api/shutdown", headers={"X-PDFTR-Shutdown": "1"}).status_code == 404


def test_too_many_wrong_passwords(cloud_env):
    c = cloud_env
    for _ in range(cloud.MAX_FAILS):
        c.post("/api/login", json={"username": "alice", "password": "nope"})
    r = c.post("/api/login", json={"username": "alice", "password": "right-password"})
    assert r.status_code == 429


def test_key_encryption_survives_a_new_container(monkeypatch):
    from app.services import secret_store

    monkeypatch.setenv("PDFTR_SECRET_KEY", "k" * 32)
    sealed = secret_store.encrypt("sk-test-123")
    assert sealed.startswith("enc:key:") and "sk-test" not in sealed
    assert secret_store.decrypt(sealed) == "sk-test-123"
    monkeypatch.setenv("PDFTR_SECRET_KEY", "other" * 8)
    assert secret_store.decrypt(sealed) is None


def test_private_cache_header():
    assert cloud.private_cache("public, max-age=3600") == "private, max-age=3600"
    assert cloud.private_cache(None) == "private, no-cache"
    assert cloud.private_cache("private, max-age=60, s-maxage=600") == "private, max-age=60"
