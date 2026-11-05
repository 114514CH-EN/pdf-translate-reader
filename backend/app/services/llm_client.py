"""OpenAI-compatible chat client with provider presets."""
from __future__ import annotations

import time
from typing import Any, AsyncIterator

import openai

PRESETS: dict[str, dict[str, Any]] = {
    # DeepSeek V4 (2026-11): deepseek-flash = DeepSeek-V4.1-Flash, deepseek-v4-pro = DeepSeek-V4-Pro.
    # Thinking mode is ON by default there — see thinking_body().
    "deepseek": {"label": "DeepSeek", "base_url": "https://api.deepseek.com", "default_model": "deepseek-flash",
                 "models": ["deepseek-flash", "deepseek-v4-pro"]},
    "openai": {"label": "OpenAI", "base_url": "https://api.openai.com/v1", "default_model": "gpt-4o-mini"},
    "qwen": {
        "label": "通义千问",
        "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "default_model": "qwen-plus",
    },
    "kimi": {"label": "Kimi", "base_url": "https://api.moonshot.cn/v1", "default_model": "moonshot-v1-8k"},
    # local servers (OpenAI-compatible endpoints on this computer; no key needed)
    "ollama": {"label": "Ollama（本地）", "base_url": "http://127.0.0.1:11434/v1", "default_model": "", "local": True},
    "lmstudio": {"label": "LM Studio（本地）", "base_url": "http://127.0.0.1:1234/v1", "default_model": "", "local": True},
    "custom": {"label": "自定义", "base_url": "", "default_model": "", "local": True},
}

THINKING_LEVELS = ("off", "low", "high", "max")


def has_credentials(cfg: dict) -> bool:
    """A key is required — except for a custom endpoint (local Ollama / LM Studio / vLLM
    servers usually accept any key)."""
    local = PRESETS.get(cfg.get("provider") or "", {}).get("local")
    return bool(cfg.get("api_key")) or (bool(local) and bool((cfg.get("base_url") or "").strip()))


def is_deepseek(cfg: dict) -> bool:
    return cfg.get("provider") == "deepseek" or "deepseek.com" in (cfg.get("base_url") or "")


def thinking_body(cfg: dict) -> dict | None:
    """extra_body for the thinking switch. DeepSeek V4 thinks by default (slow, many
    billed output tokens, temperature ignored), so translation-type calls turn it off
    explicitly. Other providers get nothing (unknown fields can be rejected)."""
    if not is_deepseek(cfg):
        return None
    level = cfg.get("_thinking") or cfg.get("thinking") or "off"
    if level not in THINKING_LEVELS or level == "off":
        return {"thinking": {"type": "disabled"}}
    return {"thinking": {"type": "enabled"}, "reasoning_effort": level}


DEFAULT_CONFIG: dict[str, Any] = {
    "provider": "deepseek",
    "base_url": PRESETS["deepseek"]["base_url"],
    "api_key": None,
    "model": "deepseek-flash",
    "target_lang": "zh",
    "style": "academic",
    "glossary_rev": 0,
}


def make_client(cfg: dict) -> openai.AsyncOpenAI:
    key = cfg.get("api_key") or "not-needed"  # local servers ignore it; the SDK refuses an empty key
    base = (cfg.get("base_url") or "").rstrip("/")
    return openai.AsyncOpenAI(api_key=key, base_url=base or None, timeout=120.0, max_retries=0)


def make_sync_client(cfg: dict) -> openai.OpenAI:
    key = cfg.get("api_key") or "not-needed"
    base = (cfg.get("base_url") or "").rstrip("/")
    return openai.OpenAI(api_key=key, base_url=base or None, timeout=120.0, max_retries=0)


async def chat_completion(
    cfg: dict,
    messages: list[dict],
    *,
    json_mode: bool = False,
    temperature: float = 0.2,
    max_tokens: int = 8192,
) -> str:
    client = make_client(cfg)
    kwargs: dict[str, Any] = {
        "model": cfg.get("model") or "deepseek-flash",
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    if json_mode:
        kwargs["response_format"] = {"type": "json_object"}
    extra = thinking_body(cfg)
    if extra:
        kwargs["extra_body"] = extra
    last_err: Exception | None = None
    try:
        for attempt in range(5):
            try:
                resp = await client.chat.completions.create(**kwargs)
                content = resp.choices[0].message.content or ""
                _record(cfg, messages, content, getattr(resp, "usage", None))
                return content
            except openai.RateLimitError as e:
                last_err = e
                retry_after = None
                if e.response is not None:
                    retry_after = e.response.headers.get("retry-after")
                delay = float(retry_after) if retry_after else 2**attempt
            except (openai.APIStatusError, openai.APIConnectionError, openai.APITimeoutError) as e:
                last_err = e
                status = getattr(e, "status_code", None)
                if status is not None and status < 500 and status != 429:
                    raise
                delay = 2**attempt
            await _sleep(delay)
        raise last_err if last_err else RuntimeError("LLM call failed")
    finally:
        await client.close()  # release the HTTP connection pool of this call


async def _sleep(seconds: float) -> None:
    import asyncio

    await asyncio.sleep(min(seconds, 30))


async def chat_completion_stream(
    cfg: dict,
    messages: list[dict],
    *,
    temperature: float = 0.3,
    max_tokens: int = 2048,
) -> AsyncIterator[str | dict]:
    """Yield content chunks as they arrive (usage is recorded when the stream ends)."""
    client = make_client(cfg)
    kwargs: dict[str, Any] = dict(
        model=cfg.get("model") or "deepseek-flash",
        messages=messages,
        temperature=temperature,
        max_tokens=max_tokens,
        stream=True,
    )
    extra = thinking_body(cfg)
    if extra:
        kwargs["extra_body"] = extra
    try:
        try:
            stream = await client.chat.completions.create(**kwargs, stream_options={"include_usage": True})
        except openai.BadRequestError:
            stream = await client.chat.completions.create(**kwargs)  # provider rejects stream_options
    except BaseException:
        await client.close()
        raise
    parts: list[str] = []
    usage = None
    try:
        async for chunk in stream:
            if getattr(chunk, "usage", None):
                usage = chunk.usage
            delta = chunk.choices[0].delta if chunk.choices else None
            if delta is None:
                continue
            reasoning = getattr(delta, "reasoning_content", None)
            if reasoning:  # thinking mode: shown separately, never mixed into the answer
                yield {"reasoning": reasoning}
            if delta.content:
                parts.append(delta.content)
                yield delta.content
    finally:  # also when the reader stops the stream early
        _record(cfg, messages, "".join(parts), usage)
        await client.close()


def _record(cfg: dict, messages: list[dict], content: str, usage: Any) -> None:
    from .usage import estimate_tokens, record

    pt = getattr(usage, "prompt_tokens", None) if usage is not None else None
    ct = getattr(usage, "completion_tokens", None) if usage is not None else None
    if pt is None or ct is None:
        pt = sum(estimate_tokens(str(m.get("content") or "")) for m in messages) + 4 * len(messages)
        ct = estimate_tokens(content)
        record(cfg, pt, ct, estimated=True)
        return
    # cached input is billed far lower: DeepSeek prompt_cache_hit_tokens, OpenAI prompt_tokens_details.cached_tokens
    hit = getattr(usage, "prompt_cache_hit_tokens", None)
    if hit is None:
        details = getattr(usage, "prompt_tokens_details", None)
        hit = getattr(details, "cached_tokens", None) if details is not None else None
    record(cfg, pt, ct, cache_hit=int(hit or 0))


def list_models(cfg: dict) -> dict:
    """GET {base_url}/models → {ok, models, error?}. Sync (FastAPI runs it in a worker thread)."""
    client = None
    try:
        client = openai.OpenAI(api_key=cfg.get("api_key") or "not-needed",
                               base_url=(cfg.get("base_url") or "").rstrip("/") or None, timeout=20.0, max_retries=0)
        ids = sorted({m.id for m in client.models.list().data if getattr(m, "id", None)}, key=str.lower)
        if not ids:
            return {"ok": False, "models": [], "error": "这个服务没有返回任何模型（可能没有开放模型列表接口），请手动填写模型名"}
        return {"ok": True, "models": ids}
    except Exception as e:
        status = getattr(e, "status_code", None)
        hint = {401: "API Key 无效、过期或没有填写", 403: "这个 Key 没有权限查看模型列表",
                404: "这个地址没有模型列表接口（检查 Base URL 是否以 /v1 结尾），可以手动填写模型名"}.get(status, "")
        msg = f"{type(e).__name__}: {str(e)[:200]}"
        return {"ok": False, "models": [], "error": f"{hint}（{msg}）" if hint else msg}
    finally:
        if client is not None:
            client.close()


async def test_connection(cfg: dict) -> dict:
    """Return {ok, latency_ms, models?, error?}."""
    t0 = time.monotonic()
    client = None
    models: list[str] = []
    try:
        client = make_sync_client(cfg)
        try:
            ml = client.models.list()
            models = [m.id for m in ml.data][:80]
        except Exception:
            pass
        # cheap real round-trip
        if not cfg.get("model"):
            raise ValueError("还没有填写模型名" + (f"，可用的模型有：{', '.join(models[:12])}" if models else ""))
        extra = thinking_body({**cfg, "_thinking": "off"})  # a 1-token ping must not start thinking
        resp = client.chat.completions.create(
            model=cfg.get("model") or "deepseek-flash",
            messages=[{"role": "user", "content": "ping"}],
            max_tokens=1,
            **({"extra_body": extra} if extra else {}),
        )
        _ = resp.choices[0].message.content
        from .usage import record

        record({**cfg, "_purpose": "test"}, getattr(resp.usage, "prompt_tokens", 0) if resp.usage else 0,
               getattr(resp.usage, "completion_tokens", 0) if resp.usage else 0)
        return {"ok": True, "latency_ms": int((time.monotonic() - t0) * 1000), "models": models}
    except Exception as e:
        hint = ""
        status = getattr(e, "status_code", None)
        if status == 404:
            hint = "（404 通常是模型名不对，或这个服务商 / 中转服务没有这个模型；可从下面的列表里选）"
        elif status == 401:
            hint = "（401：API Key 无效或已过期）"
        elif status == 402:
            hint = "（402：账户余额不足）"
        return {
            "ok": False,
            "latency_ms": int((time.monotonic() - t0) * 1000),
            "error": f"{type(e).__name__}: {e}{hint}",
            "models": models,  # still useful to pick the right model name
        }
    finally:
        if client is not None:
            client.close()
