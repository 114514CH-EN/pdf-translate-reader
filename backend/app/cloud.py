"""Cloud mode: the app on a server, behind a login (see deploy/README.md).

Off unless PDFTR_AUTH_URL is set — the desktop app and run.bat never see any of
this. When on:

  * every /api/* call needs a session cookie, except /api/health and the login
    endpoints below;
  * the login itself is checked by the student workspace: the username and
    password are passed to its /api/auth (``{"action": "login"}``), and only the
    usernames in PDFTR_ALLOWED_USERS get in;
  * the session is an HMAC-signed cookie (HttpOnly, SameSite=Lax), so plain
    <img> and EventSource requests carry it too;
  * /api/shutdown is gone (a server is stopped by its owner, not by a web page).

Environment:
  PDFTR_AUTH_URL         https://www.miku-api.com/api/auth
  PDFTR_ALLOWED_USERS    comma-separated workspace usernames
  PDFTR_SESSION_SECRET   long random string (signs the cookie)
  PDFTR_SESSION_DAYS     how long a login lasts (default 30)
  PDFTR_COOKIE_SECURE    "0" only for testing over plain http
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import threading
import time

import httpx
from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel

COOKIE = "pdftr_session"
OPEN_PATHS = {"/api/health", "/api/session", "/api/login", "/api/logout"}


def auth_url() -> str:
    return os.environ.get("PDFTR_AUTH_URL", "").strip()


def enabled() -> bool:
    return bool(auth_url())


def _allowed() -> set[str]:
    return {u.strip().lower() for u in os.environ.get("PDFTR_ALLOWED_USERS", "").split(",") if u.strip()}


def _secret() -> bytes:
    s = os.environ.get("PDFTR_SESSION_SECRET", "")
    if len(s) < 16:
        # refuse to sign anything with a guessable key
        raise HTTPException(500, "服务器没有配置 PDFTR_SESSION_SECRET（至少 16 个字符）")
    return s.encode()


def _days() -> float:
    try:
        return max(0.01, float(os.environ.get("PDFTR_SESSION_DAYS", "30")))
    except ValueError:
        return 30.0


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def sign(user: str, now: float | None = None) -> str:
    start = time.time() if now is None else now
    payload = _b64(json.dumps({"u": user, "exp": int(start + _days() * 86400)}).encode())
    sig = _b64(hmac.new(_secret(), payload.encode(), hashlib.sha256).digest())
    return f"{payload}.{sig}"


def verify(token: str | None) -> str | None:
    """The user name in a valid, unexpired session that is still allowed; else None."""
    if not token or "." not in token:
        return None
    payload, sig = token.rsplit(".", 1)
    try:
        good = _b64(hmac.new(_secret(), payload.encode(), hashlib.sha256).digest())
    except HTTPException:
        return None
    if not hmac.compare_digest(good, sig):
        return None
    try:
        data = json.loads(_unb64(payload))
    except Exception:
        return None
    user = str(data.get("u") or "")
    if not user or float(data.get("exp") or 0) < time.time():
        return None
    if user.lower() not in _allowed():
        return None  # removed from the list since: the old cookie stops working
    return user


def current_user(request: Request) -> str | None:
    return verify(request.cookies.get(COOKIE))


# --- brute force: a few wrong passwords per address, then a pause -------------------
_FAILS: dict[str, list[float]] = {}
_FAIL_LOCK = threading.Lock()
MAX_FAILS, WINDOW = 8, 300.0


def _client_ip(request: Request) -> str:
    # Vercel sets x-real-ip to the visitor; behind Cloudflare Tunnel the peer is local
    return (request.headers.get("x-real-ip") or request.headers.get("cf-connecting-ip")
            or (request.client.host if request.client else "") or "?")


def _too_many(ip: str) -> bool:
    now = time.time()
    with _FAIL_LOCK:
        recent = [t for t in _FAILS.get(ip, []) if now - t < WINDOW]
        _FAILS[ip] = recent
        return len(recent) >= MAX_FAILS


def _failed(ip: str) -> None:
    with _FAIL_LOCK:
        _FAILS.setdefault(ip, []).append(time.time())


# --- routes -------------------------------------------------------------------------
router = APIRouter(prefix="/api")


class LoginIn(BaseModel):
    username: str
    password: str


def _set_cookie(response: Response, value: str, max_age: int) -> None:
    response.set_cookie(
        COOKIE, value, max_age=max_age, httponly=True, samesite="lax", path="/",
        secure=os.environ.get("PDFTR_COOKIE_SECURE", "1") != "0",
    )


@router.get("/session")
def session(request: Request):
    """What the page needs to know before it shows anything."""
    if not enabled():
        return {"cloud": False, "user": None}
    return {"cloud": True, "user": current_user(request)}


@router.post("/login")
def login(body: LoginIn, request: Request, response: Response):
    if not enabled():
        raise HTTPException(404, "本机版不需要登录")
    ip = _client_ip(request)
    if _too_many(ip):
        raise HTTPException(429, "尝试次数过多，请 5 分钟后再试")
    name = body.username.strip()
    if not name or not body.password:
        raise HTTPException(400, "请输入用户名和密码")
    try:
        r = httpx.post(auth_url(), json={"action": "login", "username": name, "password": body.password},
                       timeout=15)
    except httpx.HTTPError:
        raise HTTPException(502, "连不上 workspace 的登录服务，请稍后再试")
    if r.status_code in (401, 403, 400):
        _failed(ip)
        try:
            msg = r.json().get("error")
        except Exception:
            msg = None
        raise HTTPException(401, msg or "用户名或密码错误")
    if r.status_code == 429:
        raise HTTPException(429, "workspace 那边尝试次数过多，请 5 分钟后再试")
    if r.status_code != 200:
        raise HTTPException(502, f"workspace 登录服务出错（{r.status_code}）")
    try:
        data = r.json()
    except Exception:
        raise HTTPException(502, "workspace 登录服务的回复看不懂")
    user = str(data.get("username") or name)
    if not data.get("ok") or user.lower() not in _allowed():
        _failed(ip)
        raise HTTPException(403, "这个账号没有使用这个阅读器的权限")
    _set_cookie(response, sign(user), int(_days() * 86400))
    return {"ok": True, "user": user}


@router.post("/logout")
def logout(response: Response):
    response.delete_cookie(COOKIE, path="/")
    return {"ok": True}


def must_have_login() -> bool:
    """Set by the Docker image: a server must never run without a login by mistake."""
    return os.environ.get("PDFTR_REQUIRE_AUTH") == "1"


async def guard(request: Request, call_next):
    """Middleware: in cloud mode every API call outside OPEN_PATHS needs a session."""
    if must_have_login() and not enabled() and request.url.path.startswith("/api/") \
            and request.url.path != "/api/health":
        # an empty .env on the server would otherwise open the whole library to the internet
        return JSONResponse({"detail": "服务器没有配置登录（PDFTR_AUTH_URL），已拒绝所有请求"}, status_code=503)
    if enabled():
        path = request.url.path
        if path.startswith("/api/") and path not in OPEN_PATHS and request.method != "OPTIONS":
            if not current_user(request):
                return JSONResponse({"detail": "请先登录"}, status_code=401)
    response = await call_next(request)
    if enabled() and request.url.path.startswith("/api/"):
        # private data: never kept by a CDN or a shared cache in between
        response.headers["Cache-Control"] = private_cache(response.headers.get("Cache-Control"))
    return response


def private_cache(value: str | None) -> str:
    """Same browser caching, but never in a CDN or proxy: drop public / s-maxage, add private."""
    keep = [d.strip() for d in (value or "no-cache").split(",")
            if d.strip() and d.strip().split("=")[0].lower() not in ("public", "private", "s-maxage")]
    return ", ".join(["private"] + keep)
