"""Assistant endpoints: summary, questions, chat (SSE), selection lookup."""
from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from ..db import get_db
from ..services import assistant
from ..services.assistant import AssistantNotConfigured

router = APIRouter(prefix="/api/documents/{doc_id}", tags=["assistant"])


def _require_assistant(doc_id: int) -> None:
    try:
        assistant.assistant_settings(doc_id)
    except AssistantNotConfigured as e:
        raise HTTPException(400, str(e)) from e


def _int_or_none(v) -> int | None:
    return int(v) if isinstance(v, (int, float, str)) and str(v).isdigit() else None


@router.get("/summary")
async def get_summary(doc_id: int, refresh: bool = False):
    _require_assistant(doc_id)
    if refresh:
        with get_db() as db:
            db.execute("UPDATE documents SET summary_md=NULL, questions_json=NULL WHERE id=?", (doc_id,))
    try:
        return await assistant.ensure_summary(doc_id)
    except Exception as e:
        raise HTTPException(502, f"总结生成失败: {type(e).__name__}: {str(e)[:300]}") from e


@router.get("/chat")
def chat_history(doc_id: int):
    with get_db() as db:
        rows = db.execute(
            "SELECT id, role, content, meta_json, created_at FROM chat_messages WHERE doc_id=? ORDER BY id", (doc_id,)
        ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        meta = json.loads(d.pop("meta_json") or "{}")
        if meta.get("sources"):
            d["sources"] = meta["sources"]
        out.append(d)
    return out


@router.delete("/chat")
def clear_chat(doc_id: int):
    with get_db() as db:
        db.execute("DELETE FROM chat_messages WHERE doc_id=?", (doc_id,))
    return {"ok": True}


@router.delete("/chat/last")
def drop_last_exchange(doc_id: int):
    """Remove the last question + answer (used by 重新生成). Returns the question."""
    with get_db() as db:
        rows = db.execute(
            "SELECT id, role, content FROM chat_messages WHERE doc_id=? ORDER BY id DESC LIMIT 2", (doc_id,)
        ).fetchall()
        if len(rows) < 2 or rows[0]["role"] != "assistant" or rows[1]["role"] != "user":
            raise HTTPException(400, "没有可以重新生成的回答")
        db.execute("DELETE FROM chat_messages WHERE id IN (?, ?)", (rows[0]["id"], rows[1]["id"]))
    return {"question": rows[1]["content"]}


@router.post("/chat")
async def chat(doc_id: int, payload: dict):
    message = (payload.get("message") or "").strip()
    quote = (payload.get("quote") or "").strip() or None
    mode = payload.get("mode") or "ask"
    if mode not in assistant.MODES:
        mode = "ask"
    if not message and not quote and mode == "ask":
        raise HTTPException(400, "message 必填")
    message = message or {"explain": "解释这段内容", "formula": "解释这个公式", "translate": "翻译这段",
                          "page": "总结当前页", "quiz": "根据当前页出几道自测题"}.get(mode, "请解释")
    page_no = _int_or_none(payload.get("page_no"))
    _require_assistant(doc_id)
    with get_db() as db:
        doc = db.execute("SELECT id FROM documents WHERE id=?", (doc_id,)).fetchone()
    if doc is None:
        raise HTTPException(404, "文档不存在")

    async def gen():
        try:
            async for chunk in assistant.stream_chat(doc_id, message, page_no, mode=mode, quote=quote):
                if isinstance(chunk, dict) and "reasoning" in chunk:
                    yield "event: reasoning\ndata: " + json.dumps({"text": chunk["reasoning"]}, ensure_ascii=False) + "\n\n"
                elif isinstance(chunk, dict):
                    yield "event: sources\ndata: " + json.dumps(chunk, ensure_ascii=False) + "\n\n"
                else:
                    yield "event: token\ndata: " + json.dumps({"text": chunk}, ensure_ascii=False) + "\n\n"
            yield "event: done\ndata: {}\n\n"
        except Exception as e:
            yield "event: error\ndata: " + json.dumps(
                {"error": f"阅读助手调用失败：{type(e).__name__}: {str(e)[:280]}"}, ensure_ascii=False
            ) + "\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")


@router.post("/lookup")
async def lookup(doc_id: int, payload: dict):
    """划词：单词 → 语境词典释义，句子 → 译文（使用翻译 API）。"""
    text = (payload.get("text") or "").strip()
    if not text:
        raise HTTPException(400, "text 必填")
    try:
        result = await assistant.lookup(doc_id, text, _int_or_none(payload.get("page_no")),
                                        payload.get("mode") or "auto")
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:
        raise HTTPException(502, f"查询失败：{type(e).__name__}: {str(e)[:300]}") from e
    return {"result_md": result}
