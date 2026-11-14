"""术语库全选: several terms changed or deleted in one request."""
from __future__ import annotations

import sys
from pathlib import Path

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.main import app  # noqa: E402


def test_batch_status_scope_and_delete():
    with TestClient(app) as c:
        doc_id = c.post("/api/documents/blank", json={"title": "terms"}).json()["doc_id"]
        ids = [
            c.post("/api/glossary", json={"doc_id": doc_id, "src_term": f"term {i}", "tgt_term": f"术语{i}", "status": "proposed"}).json()["id"]
            for i in range(4)
        ]
        mine = lambda: {t["id"]: t for t in c.get(f"/api/glossary?doc_id={doc_id}").json() if t["id"] in ids}  # noqa: E731

        assert c.post("/api/glossary/batch", json={"ids": ids[:3], "status": "approved"}).json() == {"changed": 3}
        assert [mine()[i]["status"] for i in ids] == ["approved", "approved", "approved", "proposed"]

        assert c.post("/api/glossary/batch", json={"ids": ids[:2], "scope": "global"}).json() == {"changed": 2}
        assert [mine()[i]["scope"] for i in ids] == ["global", "global", "doc", "doc"]
        assert c.post("/api/glossary/batch", json={"ids": ids[:2], "scope": "doc", "doc_id": doc_id}).json() == {"changed": 2}
        assert {mine()[i]["scope"] for i in ids} == {"doc"}

        # nothing chosen, an unknown status, nothing to change, a doc scope without a document
        assert c.post("/api/glossary/batch", json={"ids": []}).status_code == 400
        assert c.post("/api/glossary/batch", json={"ids": ids, "status": "maybe"}).status_code == 400
        assert c.post("/api/glossary/batch", json={"ids": ids}).status_code == 400
        assert c.post("/api/glossary/batch", json={"ids": ids, "scope": "doc"}).status_code == 400
        assert mine()[ids[3]]["status"] == "proposed"

        assert c.post("/api/glossary/batch", json={"ids": ids[1:], "delete": True}).json() == {"changed": 3}
        assert list(mine()) == [ids[0]]
