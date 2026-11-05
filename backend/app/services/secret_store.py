"""Encrypt API keys at rest.

Windows: DPAPI (CryptProtectData) bound to the current Windows user — the
stored value is useless on another account or machine. Elsewhere (dev / tests)
the value is only obfuscated, which still keeps it out of plain sight in
data/config.json and the database.

Stored form: "enc:dpapi:<base64>" or "enc:obf:<base64>". Anything without the
"enc:" prefix is a legacy plaintext key and is re-encrypted on the next save.
"""
from __future__ import annotations

import base64
import hashlib
import sys

PREFIX = "enc:"


def _dpapi(data: bytes, encrypt: bool) -> bytes:
    import ctypes
    from ctypes import wintypes

    class BLOB(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]

    crypt32 = ctypes.windll.crypt32
    kernel32 = ctypes.windll.kernel32
    buf = ctypes.create_string_buffer(data, len(data))
    blob_in = BLOB(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
    blob_out = BLOB()
    entropy_raw = b"pdf-translate-reader"
    ebuf = ctypes.create_string_buffer(entropy_raw, len(entropy_raw))
    entropy = BLOB(len(entropy_raw), ctypes.cast(ebuf, ctypes.POINTER(ctypes.c_char)))
    fn = crypt32.CryptProtectData if encrypt else crypt32.CryptUnprotectData
    ok = fn(ctypes.byref(blob_in), None, ctypes.byref(entropy), None, None, 0x01, ctypes.byref(blob_out))
    if not ok:
        raise OSError("DPAPI failed")
    try:
        return ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        kernel32.LocalFree(blob_out.pbData)


def _obf_key() -> bytes:
    import getpass
    import platform

    try:
        user = getpass.getuser()
    except Exception:
        user = "user"
    return hashlib.sha256(f"pdftr|{platform.node()}|{user}".encode()).digest()


def _xor(data: bytes) -> bytes:
    k = _obf_key()
    return bytes(b ^ k[i % len(k)] for i, b in enumerate(data))


def is_encrypted(value: str | None) -> bool:
    return bool(value) and str(value).startswith(PREFIX)


def encrypt(value: str | None) -> str | None:
    if not value or is_encrypted(value):
        return value
    raw = value.encode("utf-8")
    if sys.platform == "win32":
        try:
            blob = _dpapi(raw, True)
            if _dpapi(blob, False) == raw:  # verify the round trip before trusting it
                return PREFIX + "dpapi:" + base64.b64encode(blob).decode()
        except Exception:
            pass
    return PREFIX + "obf:" + base64.b64encode(_xor(raw)).decode()


def decrypt(value: str | None) -> str | None:
    """Plain key, or None when it cannot be decrypted (other user / machine)."""
    if not value or not is_encrypted(value):
        return value
    try:
        _, scheme, payload = value.split(":", 2)
        data = base64.b64decode(payload)
        if scheme == "dpapi":
            return _dpapi(data, False).decode("utf-8")
        if scheme == "obf":
            return _xor(data).decode("utf-8")
    except Exception:
        return None
    return None
