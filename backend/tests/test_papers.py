"""Finding papers and importing their PDFs — the network is replaced by canned answers
(the papers here are made up)."""
from __future__ import annotations

import sys
from pathlib import Path

import httpx
import pymupdf as fitz
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.main import app  # noqa: E402
from app.services import papers  # noqa: E402

ATOM = """<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <entry>
    <id>http://arxiv.org/abs/2401.01234v2</id>
    <published>2024-01-03T18:00:00Z</published>
    <title>Gentle Filters for
      Noisy Lattices</title>
    <summary>  We study filters that are gentle.
    They work on lattices.  </summary>
    <author><name>Ada Example</name></author>
    <author><name>Bo Sample</name></author>
    <arxiv:doi>10.9999/gentle.2024.1</arxiv:doi>
    <link title="pdf" href="http://arxiv.org/pdf/2401.01234v2" rel="related" type="application/pdf"/>
    <arxiv:primary_category term="eess.SP"/>
  </entry>
</feed>"""

WORK = {
    "id": "https://openalex.org/W1",
    "doi": "https://doi.org/10.9999/quiet.2023.7",
    "display_name": "Quiet Amplifiers in Practice",
    "publication_year": 2023,
    "authorships": [{"author": {"display_name": "Cy Person"}}],
    "primary_location": {"source": {"display_name": "Journal of Made-up Circuits"},
                         "landing_page_url": "https://publisher.example/quiet"},
    "best_oa_location": {"pdf_url": "https://repo.example/quiet.pdf", "landing_page_url": "https://repo.example/quiet"},
    "locations": [{"landing_page_url": "https://arxiv.org/abs/2301.00042v1", "pdf_url": None}],
    "abstract_inverted_index": {"Amplifiers": [0], "can": [1], "be": [2], "quiet.": [3]},
    "open_access": {"is_oa": True, "oa_url": "https://repo.example/quiet"},
}
CLOSED = {**WORK, "id": "https://openalex.org/W2", "doi": "https://doi.org/10.9999/closed.1",
          "display_name": "A Closed Paper", "best_oa_location": None, "locations": [],
          "open_access": {"is_oa": False, "oa_url": None},
          "primary_location": {"source": {"display_name": "Paywalled"}, "landing_page_url": "https://pub.example/c"}}


def _pdf_bytes(text: str = "Gentle filters, page one.") -> bytes:
    d = fitz.open()
    d.new_page().insert_text((72, 100), text, fontsize=12)
    return d.tobytes()


def fake_network(monkeypatch, routes):
    """routes: (host + path prefix) → response factory(request)."""
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        for prefix, make in routes.items():
            if (request.url.host + request.url.path).startswith(prefix):
                return make(request)
        return httpx.Response(404)

    def client(url=""):
        return httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=True)

    monkeypatch.setattr(papers, "_client", client)
    return calls


def test_classify():
    c = papers.classify
    assert c("2401.01234") == ("arxiv", "2401.01234")
    assert c("arXiv:2401.01234v2") == ("arxiv", "2401.01234v2")
    assert c("https://arxiv.org/pdf/2401.01234v2.pdf") == ("arxiv", "2401.01234v2")
    assert c("math-ph/0101001") == ("arxiv", "math-ph/0101001")
    assert c("https://doi.org/10.9999/quiet.2023.7") == ("doi", "10.9999/quiet.2023.7")
    assert c("10.48550/arXiv.2401.01234") == ("arxiv", "2401.01234")
    assert c("https://files.example/x/report.pdf") == ("url", "https://files.example/x/report.pdf")
    assert c("gentle filters for noisy lattices") == ("title", "gentle filters for noisy lattices")
    assert c("version 2.0 of the gentle filter")[0] == "title"


def test_parse_arxiv_and_openalex():
    (p,) = papers.parse_arxiv(ATOM)
    assert p["title"] == "Gentle Filters for Noisy Lattices"
    assert p["authors"] == ["Ada Example", "Bo Sample"]
    assert p["year"] == 2024 and p["arxiv"] == "2401.01234" and p["doi"] == "10.9999/gentle.2024.1"
    assert p["pdf_url"] == "https://arxiv.org/pdf/2401.01234v2"
    assert p["abstract"] == "We study filters that are gentle. They work on lattices."
    assert "eess.SP" in p["venue"]

    q = papers.parse_openalex(WORK)
    assert q["title"] == "Quiet Amplifiers in Practice" and q["doi"] == "10.9999/quiet.2023.7"
    assert q["pdf_url"] == "https://repo.example/quiet.pdf" and q["arxiv"] == "2301.00042"
    assert q["abstract"] == "Amplifiers can be quiet." and q["venue"] == "Journal of Made-up Circuits"
    c = papers.parse_openalex(CLOSED)
    assert c["pdf_url"] == "" and c["landing_url"] == "https://pub.example/c"


def test_search_merges_and_puts_free_copies_first(monkeypatch):
    dup = {**WORK, "display_name": "Gentle filters for noisy lattices", "doi": "https://doi.org/10.9999/gentle.2024.1",
           "best_oa_location": None, "locations": [], "open_access": {}}
    fake_network(monkeypatch, {
        "api.openalex.org/works": lambda r: httpx.Response(200, json={"results": [CLOSED, dup]}),
        "export.arxiv.org/api/query": lambda r: httpx.Response(200, text=ATOM),
    })
    out = papers.search("gentle filters for noisy lattices")
    titles = [p["title"] for p in out["results"]]
    assert out["kind"] == "title"
    assert titles.count("Gentle filters for noisy lattices") + titles.count("Gentle Filters for Noisy Lattices") == 1
    first = out["results"][0]
    assert first["doi"] == "10.9999/gentle.2024.1" and first["pdf_url"].startswith("https://arxiv.org/pdf/")
    assert out["results"][-1]["title"] == "A Closed Paper"


def test_doi_lookup_and_unknown_doi(monkeypatch):
    fake_network(monkeypatch, {"api.openalex.org/works/doi:10.9999/quiet": lambda r: httpx.Response(200, json=WORK)})
    (p,) = papers.search("doi:10.9999/quiet.2023.7")["results"]
    assert p["title"] == "Quiet Amplifiers in Practice"
    (u,) = papers.search("10.9999/nobody.knows")["results"]
    assert u["pdf_url"] == "" and u["landing_url"] == "https://doi.org/10.9999/nobody.knows"


def test_service_down_is_said_plainly(monkeypatch):
    def boom(r):
        raise httpx.ConnectError("no route")

    fake_network(monkeypatch, {"api.openalex.org": boom, "export.arxiv.org": boom})
    with pytest.raises(papers.PaperError, match="网络"):
        papers.search("anything at all")


def test_fetch_pdf_refuses_web_pages(monkeypatch):
    fake_network(monkeypatch, {
        "pub.example/page": lambda r: httpx.Response(200, html="<!DOCTYPE html><html>sign in</html>"),
        "pub.example/locked": lambda r: httpx.Response(403),
        "repo.example/ok.pdf": lambda r: httpx.Response(200, content=_pdf_bytes()),
    })
    with pytest.raises(papers.PaperError, match="网页"):
        papers.fetch_pdf("https://pub.example/page")
    with pytest.raises(papers.PaperError, match="订阅"):
        papers.fetch_pdf("https://pub.example/locked")
    with pytest.raises(papers.PaperError):
        papers.fetch_pdf("file:///etc/passwd")
    assert papers.fetch_pdf("https://repo.example/ok.pdf").startswith(b"%PDF")


def test_public_only_refuses_the_local_network():
    with pytest.raises(papers.PaperError):
        papers.check_public("http://127.0.0.1:8765/api/health")


def test_import_opens_a_document_once(monkeypatch):
    fake_network(monkeypatch, {"arxiv.org/pdf/2401.01234": lambda r: httpx.Response(200, content=_pdf_bytes())})
    client = TestClient(app)
    (paper,) = papers.parse_arxiv(ATOM)
    r = client.post("/api/papers/import", json={"paper": paper})
    assert r.status_code == 200, r.text
    doc_id = r.json()["doc_id"]
    assert r.json()["existing"] is False
    d = client.get(f"/api/documents/{doc_id}").json()
    assert d["title"] == "Gentle Filters for Noisy Lattices"
    assert d["paper"]["doi"] == "10.9999/gentle.2024.1" and d["paper"]["authors"][0] == "Ada Example"
    lib = {x["id"]: x for x in client.get("/api/documents").json()}
    assert lib[doc_id]["is_paper"] == 1
    again = client.post("/api/papers/import", json={"paper": paper}).json()
    assert again == {"doc_id": doc_id, "existing": True, "warning": None}
    client.delete(f"/api/documents/{doc_id}")


def test_import_without_a_free_copy(monkeypatch):
    client = TestClient(app)
    r = client.post("/api/papers/import", json={"paper": papers.parse_openalex(CLOSED)})
    assert r.status_code == 400 and "免费" in r.json()["detail"]


FIXTURE = Path(__file__).parent / "data" / "sample-paper.pdf"


def test_paper_index_of_a_two_column_paper():
    """The made-up paper in tests/data (make_paper_fixture.py): references, figure and table
    captions with their areas, sections in order, two columns read one after the other."""
    client = TestClient(app)
    r = client.post("/api/documents", files={"file": ("sample-paper.pdf", FIXTURE.read_bytes(), "application/pdf")})
    doc_id = r.json()["doc_id"]
    try:
        idx = client.get(f"/api/documents/{doc_id}/paper-index").json()
        assert idx["style"] == "numeric"
        assert sorted(idx["refs"]) == ["1", "2", "3", "4"]
        assert idx["refs"]["2"]["query"] == "Box filters revisited"
        assert idx["refs"]["3"]["query"] == "2001.00001"  # an arXiv id: searched directly
        assert idx["refs"]["1"]["page"] == 2
        fig, tab = idx["figs"]["fig:1"], idx["figs"]["tab:1"]
        assert fig["caption"].startswith("Figure 1: Response across a single step")
        assert "Table 1" not in fig["caption"]  # two captions in one block: each its own
        assert tab["caption"].startswith("Table 1: Mean error")
        assert fig["area"] and fig["area"][3] <= 345 and tab["area"] and tab["area"][1] >= 420
        titles = [o["title"] for o in idx["outline"]]
        assert titles[1:] == ["Abstract", "1 Introduction", "2 The Gentle Filter", "3 Results", "4 Conclusion", "References"]
        assert {o["level"] for o in idx["outline"][1:]} == {1}
        assert idx["page_sizes"]["1"] == [595.0, 842.0] or idx["page_sizes"][1] == [595.0, 842.0]
        # page 2 reads column by column: the left column's results before the right column's conclusion
        p2 = client.get(f"/api/documents/{doc_id}/pages/2/blocks").json()
        texts = [b["text"].split("\n")[0] for b in (p2["blocks"] if isinstance(p2, dict) else p2)]
        order = [texts.index(t) for t in ("3  Results", "We compare the gentle filter with a box filter of the same",
                                          "4  Conclusion", "References")]
        assert order == sorted(order)
    finally:
        client.delete(f"/api/documents/{doc_id}")


@pytest.mark.parametrize("entry,title", [
    ("[2] C. Person and D. Body. Box filters revisited. In Proc. of the Imaginary Conference, 2020.", "Box filters revisited"),
    ("Smith J, Doe A. Gentle smoothing of grids. J Imag Sci. 2020;3:4-9.", "Gentle smoothing of grids"),
    ("Smith, J. and Doe, A. (2020). Gentle smoothing of grids. Journal of Imaginary Science, 3, 4-9.", "Gentle smoothing of grids"),
    ('E. Name, "Smoothing without tears," in Proc. Imag. Conf., 2020.', "Smoothing without tears"),
    ("[7] G. Who. Lattices. Imaginary Letters 1, 2020. doi:10.9999/abc.12.", "10.9999/abc.12"),
])
def test_reference_search_terms(entry, title):
    from app.services.paper_index import guess_title

    assert guess_title(entry) == title


def test_paper_interpretation_and_section_modes(monkeypatch):
    """论文解读 sees every section of the paper (not just the passages nearest the question)
    and the paper's details; 讲解这一节 sees that section in full."""
    from app.services import assistant

    seen: list[list[dict]] = []

    async def fake_stream(cfg, messages, **kw):
        seen.append(messages)
        for t in ("解读", "。"):
            yield t

    monkeypatch.setattr(assistant, "chat_completion_stream", fake_stream)
    client = TestClient(app)
    client.put("/api/settings", json={"assistant": {"provider": "custom", "base_url": "http://x/v1",
                                                     "api_key": "sk-test-asst", "model": "m-asst"}})
    paper = {"title": "Gentle Filters for Noisy Lattices", "authors": ["Ada Example", "Bo Sample"], "year": 2024,
             "abstract": "Smoothing a noisy lattice usually blurs its edges.", "doi": "10.9999/gentle.2024.1x"}
    doc_id = client.post("/api/documents", files={"file": ("p.pdf", FIXTURE.read_bytes(), "application/pdf")}).json()["doc_id"]
    try:
        from app.db import get_db
        import json as _json

        with get_db() as db:
            db.execute("UPDATE documents SET paper_json=? WHERE id=?", (_json.dumps(paper), doc_id))
        with client.stream("POST", f"/api/documents/{doc_id}/chat", json={"message": "", "mode": "paper"}) as r:
            body = "".join(r.iter_text())
        assert "解读" in body and "event: error" not in body, body
        user = seen[-1][-1]["content"]
        for part in ("1 Introduction", "2 The Gentle Filter", "3 Results", "4 Conclusion"):
            assert f"## {part}" in user  # every section
        assert "Box filters revisited" not in user  # not the reference list
        assert "Paper: Gentle Filters for Noisy Lattices — Ada Example, Bo Sample (2024)" in user
        assert "the paper in one sentence" in user
        hist = client.get(f"/api/documents/{doc_id}/chat").json()
        assert hist[-2]["content"] == "解读这篇论文" and hist[-1]["sources"] == [1, 2]

        idx = client.get(f"/api/documents/{doc_id}/paper-index").json()
        method = next(o for o in idx["outline"] if o["title"] == "2 The Gentle Filter")
        with client.stream("POST", f"/api/documents/{doc_id}/chat",
                           json={"message": "讲解这一节：2 The Gentle Filter", "mode": "section",
                                 "section_id": method["block_id"]}) as r:
            "".join(r.iter_text())
        user = seen[-1][-1]["content"]
        assert "The section to explain" in user and "never moves an edge" in user  # the section in full
        assert "We compare the gentle filter" not in user.split("The section to explain")[1]
        r = client.post(f"/api/documents/{doc_id}/chat", json={"message": "x", "mode": "section"})
        assert r.status_code == 400
    finally:
        client.delete(f"/api/documents/{doc_id}")
        client.put("/api/settings", json={"assistant": {"clear_api_key": True}})
