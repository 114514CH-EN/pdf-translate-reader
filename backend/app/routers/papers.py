"""Find a paper (arXiv id, DOI, link or title) and import its PDF as a document."""
from __future__ import annotations

import json
import re

from fastapi import APIRouter, HTTPException
from fastapi.concurrency import run_in_threadpool

from .. import cloud
from ..db import get_db
from ..services import papers
from . import documents

router = APIRouter(prefix="/api/papers", tags=["papers"])

_KEEP = ("title", "authors", "year", "venue", "abstract", "doi", "arxiv", "pdf_url", "landing_url", "source")


@router.get("/search")
async def search(q: str = "", limit: int = 10):
    q = q.strip()[:500]
    if not q:
        return {"kind": "title", "results": []}
    try:
        return await run_in_threadpool(papers.search, q, max(1, min(limit, 20)))
    except papers.PaperError as e:
        raise HTTPException(502, str(e)) from e


@router.post("/import")
async def import_paper(payload: dict):
    paper = {k: payload.get("paper", {}).get(k) for k in _KEEP} if isinstance(payload.get("paper"), dict) else {}
    paper = {k: v for k, v in paper.items() if v not in (None, "", [])}
    url = str(paper.get("pdf_url") or "")
    if not url and paper.get("arxiv"):
        url = f"https://arxiv.org/pdf/{paper['arxiv']}"
    if not url:
        raise HTTPException(400, "没有找到这篇论文可以免费下载的 PDF。可以在出版社网站或学校图书馆下载后拖进来")
    # the same paper imported before: open that one instead of a second copy
    key = paper.get("doi") or paper.get("arxiv")
    if key and not payload.get("again"):
        with get_db() as db:
            for row in db.execute("SELECT id, paper_json FROM documents WHERE paper_json IS NOT NULL").fetchall():
                try:
                    old = json.loads(row["paper_json"])
                except ValueError:
                    continue
                if key in (old.get("doi"), old.get("arxiv")):
                    return {"doc_id": row["id"], "existing": True, "warning": None}
    try:
        data = await run_in_threadpool(papers.fetch_pdf, url, cloud.enabled())
    except papers.PaperError as e:
        raise HTTPException(502, str(e)) from e
    title = re.sub(r'[\\/:*?"<>|\s]+', " ", str(paper.get("title") or "paper")).strip()[:150] or "paper"
    result = await documents.ingest_pdf(data, title, paper=paper or None)
    return {**result, "existing": False}
