"""Reading features: separate assistant API, encrypted keys, usage + estimate,
search, progress, highlights (incl. exports), reading position, backups."""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pymupdf as fitz
import pytest
from fastapi.testclient import TestClient


def _pdf(tmp_path: Path) -> Path:
    p = tmp_path / "doc.pdf"
    d = fitz.open()
    pg = d.new_page()
    pg.insert_text((72, 72), "Spectral Leakage", fontsize=18)
    pg.insert_textbox(fitz.Rect(72, 90, 520, 200), "A Hann window reduces spectral leakage. The pulse is short.", fontsize=11)
    d.new_page().insert_textbox(fitz.Rect(72, 72, 520, 200), "Second page talks about the pulse again.", fontsize=11)
    d.save(str(p))
    return p


@pytest.fixture()
def client(tmp_path, monkeypatch):
    from app.main import app
    from app.services import assistant, llm_client

    async def fake(cfg, messages, **kw):
        from app.services.usage import record

        record(cfg, 100, 20)
        if "summary_md" in messages[0]["content"]:
            return json.dumps({"summary_md": "总结", "questions": ["问题一？"]}, ensure_ascii=False)
        return "**频谱泄漏**：释义"

    async def fake_stream(cfg, messages, **kw):
        for t in ("回答", "。"):
            yield t

    monkeypatch.setattr(assistant, "chat_completion", fake)
    monkeypatch.setattr(assistant, "chat_completion_stream", fake_stream)
    monkeypatch.setattr(llm_client, "chat_completion", fake)
    with TestClient(app) as c:
        c.put("/api/settings", json={"api": {"provider": "custom", "base_url": "http://x/v1", "api_key": "sk-translate-123", "model": "m-tr"}})
        doc_id = c.post("/api/documents", files={"file": ("d.pdf", _pdf(tmp_path).read_bytes(), "application/pdf")}).json()["doc_id"]
        yield c, doc_id
        c.delete(f"/api/documents/{doc_id}")


def test_assistant_needs_its_own_api(client):
    c, doc_id = client
    c.put("/api/settings", json={"assistant": {"clear_api_key": True, "provider": "deepseek", "base_url": "", "model": ""}})
    r = c.get(f"/api/documents/{doc_id}/summary")
    assert r.status_code == 400 and "尚未配置" in r.json()["detail"]  # never falls back to the translation API
    a = c.put("/api/settings", json={"assistant": {"copy_from_translation": True, "model": "m-asst"}}).json()["assistant"]
    assert a["configured"] and a["model"] == "m-asst" and a["api_key_masked"]
    assert c.get(f"/api/documents/{doc_id}/summary").json()["questions"] == ["问题一？"]
    with c.stream("POST", f"/api/documents/{doc_id}/chat",
                  json={"message": "", "mode": "explain", "quote": "Hann window", "page_no": 1}) as r:
        body = "".join(r.iter_text())
    assert "event: sources" in body and "回答" in body
    hist = c.get(f"/api/documents/{doc_id}/chat").json()
    assert hist[0]["content"].startswith("> Hann window") and hist[1]["sources"]
    assert c.delete(f"/api/documents/{doc_id}/chat/last").json()["question"].startswith("> Hann")


def test_keys_are_encrypted_at_rest(client):
    from app.config import CONFIG_PATH
    from app.db import get_db
    from app.services.secret_store import decrypt, encrypt

    c, _ = client
    raw = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    assert raw["api_key"].startswith("enc:") and "sk-translate" not in CONFIG_PATH.read_text(encoding="utf-8")
    with get_db() as db:
        stored = db.execute("SELECT value_json FROM settings WHERE key='app_config'").fetchone()[0]
    assert "sk-translate" not in stored
    assert decrypt(encrypt("sk-abc")) == "sk-abc" and decrypt("enc:dpapi:broken") is None
    assert c.get("/api/settings").json()["api"]["api_key_masked"] == "sk-…-123"


def test_lookup_usage_and_estimate(client):
    c, doc_id = client
    r = c.post(f"/api/documents/{doc_id}/lookup", json={"text": "spectral leakage", "page_no": 1})
    assert r.json()["result_md"].startswith("**频谱泄漏**")
    c.put("/api/settings", json={"pricing": {"currency": "¥", "models": {"m-tr": {"in": 2, "out": 8}}}})
    u = c.get("/api/settings/usage").json()
    lk = next(g for g in u["groups"] if g["purpose"] == "lookup")
    assert lk["prompt_tokens"] == 100 and abs(lk["cost"] - (100 * 2 + 20 * 8) / 1e6) < 1e-9
    est = c.get(f"/api/documents/{doc_id}/translate-estimate").json()
    assert est["blocks"] >= 2 and est["total_tokens"] > 0 and est["cost"] is not None and est["calls"] >= 1


def test_search_progress_position(client):
    c, doc_id = client
    s = c.get(f"/api/documents/{doc_id}/search", params={"q": "PULSE"}).json()
    assert s["total"] == 2 and {h["page_no"] for h in s["results"]} == {1, 2}
    assert s["results"][0]["match"] == "pulse" and 0 <= s["results"][0]["y"] < 1
    prog = c.get(f"/api/documents/{doc_id}/progress").json()["pages"]
    assert [p["page_no"] for p in prog] == [1, 2] and all(p["done"] == 0 and p["total"] > 0 for p in prog)
    c.put(f"/api/documents/{doc_id}/position", json={"page": 2, "frac": 0.25})
    d = c.get(f"/api/documents/{doc_id}").json()
    assert d["last_page"] == 2 and d["last_frac"] == 0.25


def test_highlights_roundtrip_and_exports(client, tmp_path):
    c, doc_id = client
    h = c.post("/api/highlights", json={"doc_id": doc_id, "page_no": 1, "pane": "src", "rects": [[72, 95, 300, 108]],
                                        "text": "A Hann window", "color": "green"}).json()
    c.put(f"/api/highlights/{h['id']}", json={"note": "重点"})
    assert c.get("/api/highlights", params={"doc_id": doc_id}).json()[0]["note"] == "重点"
    md = c.post(f"/api/documents/{doc_id}/export", json={"format": "md"}).text
    assert "## 高亮与笔记" in md and "A Hann window" in md and "重点" in md
    pdf = tmp_path / "side.pdf"
    pdf.write_bytes(c.post(f"/api/documents/{doc_id}/export", json={"format": "pdf_side_by_side"}).content)
    with fitz.open(pdf) as d:
        page = d[0]
        annots = [(a.type[1], a.info["content"]) for a in page.annots()]
        assert annots and annots[0] == ("Highlight", "重点")
    assert c.delete(f"/api/highlights/{h['id']}").json()["ok"]
    assert c.post("/api/highlights", json={"doc_id": doc_id, "page_no": 1, "rects": []}).status_code == 400


def test_backups_are_taken_and_pruned(client):
    from app.services import backup

    c, _ = client
    for _ in range(backup.KEEP + 2):
        backup.make_backup(force=True)
    items = c.get("/api/settings/backups").json()["items"]
    assert 1 <= len(items) <= backup.KEEP


def test_deepseek_thinking_switch():
    from app.services.llm_client import thinking_body

    ds = {"provider": "deepseek", "base_url": "https://api.deepseek.com"}
    assert thinking_body(ds) == {"thinking": {"type": "disabled"}}  # translation: always off unless asked
    assert thinking_body({**ds, "_thinking": "high"}) == {"thinking": {"type": "enabled"}, "reasoning_effort": "high"}
    assert thinking_body({"provider": "custom", "base_url": "https://api.deepseek.com/v1", "thinking": "max"})["reasoning_effort"] == "max"
    assert thinking_body({"provider": "openai", "base_url": "https://api.openai.com/v1"}) is None


def test_peak_hours_and_cache_hit_pricing():
    from datetime import datetime, timezone

    from app.services.usage import DEEPSEEK_PEAK, DEEPSEEK_PRICING, cost, is_peak

    cfg = {"pricing": {"currency": "¥", "models": DEEPSEEK_PRICING, "peak": DEEPSEEK_PEAK}}
    # 2026-11-02 is a Monday; Beijing = UTC+8
    assert is_peak(cfg, datetime(2026, 11, 2, 2, 0, tzinfo=timezone.utc))       # 10:00 Beijing
    assert not is_peak(cfg, datetime(2026, 11, 2, 4, 30, tzinfo=timezone.utc))  # 12:30 lunch
    assert is_peak(cfg, datetime(2026, 11, 2, 9, 59, tzinfo=timezone.utc))      # 17:59
    assert not is_peak(cfg, datetime(2026, 11, 7, 2, 0, tzinfo=timezone.utc))   # Saturday
    assert not is_peak({"pricing": {}}, datetime(2026, 11, 2, 2, 0, tzinfo=timezone.utc))
    # flash: 1M input of which 600k cached, 100k output, off-peak: 0.4·1 + 0.6·0.02 + 0.1·4
    off = cost(cfg, "deepseek-flash", 1_000_000, 100_000, cache_hit=600_000)
    assert abs(off - (0.4 + 0.012 + 0.4)) < 1e-9
    assert abs(cost(cfg, "deepseek-flash", 1_000_000, 100_000, 600_000, peak=True) - 2 * off) < 1e-9
    assert cost(cfg, "unknown-model", 10, 10) is None


def test_usage_records_cache_hits_and_streams_reasoning(monkeypatch):
    import asyncio
    from types import SimpleNamespace as NS

    from app.db import get_db, init_db
    from app.services import llm_client

    init_db()

    class FakeStream:
        def __init__(self):
            self.items = [
                NS(usage=None, choices=[NS(delta=NS(reasoning_content="先想一想", content=None))]),
                NS(usage=None, choices=[NS(delta=NS(reasoning_content=None, content="答案"))]),
                NS(usage=NS(prompt_tokens=50, completion_tokens=7, prompt_cache_hit_tokens=40), choices=[]),
            ]

        def __aiter__(self):
            return self

        async def __anext__(self):
            if not self.items:
                raise StopAsyncIteration
            return self.items.pop(0)

    sent = {}

    class FakeClient:
        def __init__(self, *a, **k):
            self.chat = NS(completions=NS(create=self.create))

        async def create(self, **kw):
            sent.update(kw)
            return FakeStream()

        async def close(self):
            pass

    monkeypatch.setattr(llm_client, "make_client", lambda cfg: FakeClient())
    cfg = {"provider": "deepseek", "base_url": "https://api.deepseek.com", "model": "deepseek-v4-pro",
           "_thinking": "high", "_purpose": "assistant-test"}

    async def run():
        return [c async for c in llm_client.chat_completion_stream(cfg, [{"role": "user", "content": "hi"}])]

    out = asyncio.run(run())
    assert out == [{"reasoning": "先想一想"}, "答案"]
    assert sent["extra_body"] == {"thinking": {"type": "enabled"}, "reasoning_effort": "high"}
    with get_db() as db:
        r = db.execute("SELECT prompt_tokens, completion_tokens, cache_hit_tokens, estimated FROM usage_log"
                       " WHERE purpose='assistant-test' ORDER BY id DESC LIMIT 1").fetchone()
    assert tuple(r) == (50, 7, 40, 0)


def test_fetch_models_uses_form_values(client, monkeypatch):
    from app.routers import settings as settings_router

    seen = {}

    def fake_list(cfg):
        seen.update(cfg)
        return {"ok": True, "models": ["b-model", "a-model"]}

    monkeypatch.setattr(settings_router, "list_models", fake_list)
    c, _ = client
    r = c.post("/api/settings/models", json={"target": "assistant", "provider": "custom",
                                             "base_url": "http://gpu-box:8000/v1", "api_key": "sk-typed"}).json()
    assert r["ok"] and seen["base_url"] == "http://gpu-box:8000/v1" and seen["api_key"] == "sk-typed"
    # a local / custom endpoint works without any key
    c.put("/api/settings", json={"assistant": {"clear_api_key": True}})
    assert c.post("/api/settings/models", json={"target": "assistant", "provider": "custom",
                                                "base_url": "http://gpu-box:8000/v1"}).json()["ok"]
    # a hosted provider without a key is refused before any request
    c.put("/api/settings", json={"assistant": {"clear_api_key": True}})
    r = c.post("/api/settings/models", json={"target": "assistant", "provider": "openai", "base_url": "https://api.openai.com/v1"}).json()
    assert not r["ok"] and "API Key" in r["error"]
