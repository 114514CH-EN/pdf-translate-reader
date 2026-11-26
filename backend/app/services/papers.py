"""Finding papers and fetching their PDFs.

What the user types decides where to look:

  * an arXiv id or link   (2101.00001, arXiv:2101.00001v2, arxiv.org/abs/…, old ids like hep-th/9901001)
                          → the arXiv API; the PDF is always there
  * a DOI or doi.org link (10.xxxx/…)  → OpenAlex, which knows the open-access copy if there is one
  * a link to a PDF       → that file
  * anything else         → a title / keyword search on OpenAlex and arXiv, merged

Every paper comes back in one shape (see ``_paper``); ``pdf_url`` is empty when no free copy is
known, and the interface says so instead of offering an import that cannot work.

Both services are free and need no key. Requests go out through the system proxy when there is
one (on Windows that lives in the registry, which httpx alone does not read).
"""
from __future__ import annotations

import ipaddress
import os
import re
import socket
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

import httpx

# overridable so the interface can be tried against a local stand-in
ARXIV_API = os.environ.get("PDFTR_ARXIV_API", "https://export.arxiv.org/api/query")
OPENALEX = os.environ.get("PDFTR_OPENALEX_API", "https://api.openalex.org")
UA = "PDFTranslate (local paper reader; https://github.com/114514CH-EN/pdf-translate-reader)"
MAX_PDF = 120 * 1024 * 1024
TIMEOUT = httpx.Timeout(20.0, read=60.0)

_NEW_ARXIV = re.compile(r"(?<![\d.])(\d{4}\.\d{4,5})(v\d+)?(?![\d])")
_OLD_ARXIV = re.compile(r"\b([a-z][a-z\-]+(?:\.[A-Z]{2})?/\d{7})(v\d+)?\b")
_ARXIV_DOI = re.compile(r"10\.48550/arxiv\.(\S+)", re.I)
_DOI = re.compile(r"\b(10\.\d{4,9}/[^\s\"<>]+)")


class PaperError(Exception):
    """Shown to the user as it is."""


# --------------------------------------------------------------------------- what was typed

def classify(q: str) -> tuple[str, str]:
    """('arxiv', id) | ('doi', doi) | ('url', url) | ('title', text)."""
    q = (q or "").strip()
    if not q:
        return "title", ""
    low = q.lower()
    m = _ARXIV_DOI.search(q)
    if m:
        return "arxiv", m.group(1).rstrip(".")
    m = _NEW_ARXIV.search(q) or _OLD_ARXIV.search(q)
    if m and ("arxiv" in low or m.group(0) == q):  # "arXiv:…", an arxiv.org link, or the bare id
        return "arxiv", m.group(1) + (m.group(2) or "")
    m = _DOI.search(q)
    if m and (low.startswith(("10.", "doi:", "https://doi.org", "http://doi.org", "doi.org", "http://dx.doi.org",
                              "https://dx.doi.org")) or " " not in q):
        return "doi", m.group(1).rstrip(".,;)")
    if low.startswith(("http://", "https://")):
        return "url", q
    return "title", q


# --------------------------------------------------------------------------- network

def _proxy(url: str) -> str | None:
    """The proxy for this address: the environment's, or the Windows / macOS system setting,
    and none for the addresses those settings exempt (the machine itself, the local network)."""
    host = urllib.parse.urlparse(url).hostname or ""
    try:
        if urllib.request.proxy_bypass(host):
            return None
    except Exception:
        pass
    p = urllib.request.getproxies()
    return p.get("https") or p.get("http") or None


def _client(url: str = OPENALEX) -> httpx.Client:
    return httpx.Client(timeout=TIMEOUT, follow_redirects=True, headers={"User-Agent": UA},
                        proxy=_proxy(url), trust_env=False)


def check_public(url: str) -> None:
    """Refuse links into the machine's own network (used when the app serves other people)."""
    host = urllib.parse.urlparse(url).hostname or ""
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError as e:
        raise PaperError("打不开这个链接：找不到这个网站") from e
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            raise PaperError("不能从这个地址下载")


def _get_json(client: httpx.Client, url: str, params: dict | None = None) -> dict:
    try:
        r = client.get(url, params=params)
    except httpx.HTTPError as e:
        raise PaperError("连不上论文检索服务，请检查网络（需要能访问 openalex.org 和 arxiv.org）") from e
    if r.status_code == 404:
        return {}
    if r.status_code >= 400:
        raise PaperError(f"论文检索服务暂时不可用（{r.status_code}），稍后再试")
    try:
        return r.json()
    except ValueError as e:
        raise PaperError("论文检索服务返回了无法识别的内容") from e


# --------------------------------------------------------------------------- one shape for all

def _paper(**kw) -> dict:
    p = {
        "title": "", "authors": [], "year": None, "venue": "", "abstract": "",
        "doi": "", "arxiv": "", "pdf_url": "", "landing_url": "", "source": "",
    }
    p.update({k: v for k, v in kw.items() if v not in (None, "")})
    p["title"] = re.sub(r"\s+", " ", p["title"]).strip()
    p["abstract"] = re.sub(r"\s+", " ", p["abstract"]).strip()
    return p


def _norm_title(t: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", (t or "").lower())


# --------------------------------------------------------------------------- arXiv

_ATOM = {"a": "http://www.w3.org/2005/Atom", "arxiv": "http://arxiv.org/schemas/atom"}


def parse_arxiv(xml_text: str) -> list[dict]:
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as e:
        raise PaperError("arXiv 返回了无法识别的内容") from e
    out = []
    for e in root.findall("a:entry", _ATOM):
        abs_url = (e.findtext("a:id", "", _ATOM) or "").strip()
        m = re.search(r"arxiv\.org/abs/(.+)$", abs_url)
        if not m:
            continue  # the API reports a bad id as an entry without one
        aid = m.group(1)
        title = e.findtext("a:title", "", _ATOM)
        if not title.strip() or title.strip().lower() == "error":
            continue
        pdf = ""
        for link in e.findall("a:link", _ATOM):
            if link.get("title") == "pdf" or link.get("type") == "application/pdf":
                pdf = link.get("href", "")
        pdf = (pdf or f"https://arxiv.org/pdf/{aid}").replace("http://", "https://", 1)
        published = e.findtext("a:published", "", _ATOM) or ""
        cat = e.find("arxiv:primary_category", _ATOM)
        out.append(_paper(
            title=title,
            authors=[(a.findtext("a:name", "", _ATOM) or "").strip() for a in e.findall("a:author", _ATOM)],
            year=int(published[:4]) if published[:4].isdigit() else None,
            venue="arXiv" + (f" · {cat.get('term')}" if cat is not None and cat.get("term") else ""),
            abstract=e.findtext("a:summary", "", _ATOM),
            doi=(e.findtext("arxiv:doi", "", _ATOM) or "").strip(),
            arxiv=re.sub(r"v\d+$", "", aid),
            pdf_url=pdf,
            landing_url=f"https://arxiv.org/abs/{aid}",
            source="arXiv",
        ))
    return out


def _arxiv(client: httpx.Client, **params) -> list[dict]:
    try:
        r = client.get(ARXIV_API, params=params)
    except httpx.HTTPError as e:
        raise PaperError("连不上 arXiv，请检查网络") from e
    if r.status_code >= 400:
        raise PaperError(f"arXiv 暂时不可用（{r.status_code}），稍后再试")
    return parse_arxiv(r.text)


# --------------------------------------------------------------------------- OpenAlex

def _abstract(inv: dict | None) -> str:
    """OpenAlex keeps abstracts as word → positions."""
    if not inv:
        return ""
    words: dict[int, str] = {}
    for w, pos in inv.items():
        for i in pos:
            words[i] = w
    return " ".join(words[i] for i in sorted(words))


def parse_openalex(work: dict) -> dict:
    ids = work.get("ids") or {}
    doi = (work.get("doi") or ids.get("doi") or "").replace("https://doi.org/", "")
    arxiv = ""
    pdf = ""
    landing = ""
    locs = [work.get("best_oa_location") or {}, work.get("primary_location") or {}] + list(work.get("locations") or [])
    for loc in locs:
        url = (loc.get("pdf_url") or "") if loc else ""
        land = (loc.get("landing_page_url") or "") if loc else ""
        m = re.search(r"arxiv\.org/(?:abs|pdf)/([^\s?#]+?)(?:\.pdf)?$", url or land)
        if m and not arxiv:
            arxiv = re.sub(r"v\d+$", "", m.group(1))
        if url and not pdf:
            pdf = url
        if land and not landing:
            landing = land
    if arxiv and not pdf:
        pdf = f"https://arxiv.org/pdf/{arxiv}"
    oa = work.get("open_access") or {}
    if not pdf and (oa.get("oa_url") or "").lower().endswith(".pdf"):
        pdf = oa["oa_url"]
    src = ((work.get("primary_location") or {}).get("source") or {})
    return _paper(
        title=work.get("display_name") or work.get("title") or "",
        authors=[(a.get("author") or {}).get("display_name", "") for a in (work.get("authorships") or [])][:30],
        year=work.get("publication_year"),
        venue=src.get("display_name") or "",
        abstract=_abstract(work.get("abstract_inverted_index")),
        doi=doi,
        arxiv=arxiv,
        pdf_url=pdf,
        landing_url=landing or (f"https://doi.org/{doi}" if doi else ""),
        source="OpenAlex",
    )


# --------------------------------------------------------------------------- search

_STOP = {"a", "an", "the", "of", "for", "and", "or", "in", "on", "to", "with", "by", "via", "from", "at", "is",
         "are", "its", "using", "towards", "toward"}

def search(q: str, limit: int = 10) -> dict:
    kind, value = classify(q)
    if not value:
        return {"kind": kind, "results": []}
    with _client() as client:
        if kind == "arxiv":
            return {"kind": kind, "results": _arxiv(client, id_list=value)}
        if kind == "doi":
            work = _get_json(client, f"{OPENALEX}/works/doi:{value}")
            res = [parse_openalex(work)] if work.get("id") else []
            if not res:
                res = [_paper(title=value, doi=value, landing_url=f"https://doi.org/{value}", source="DOI")]
            return {"kind": kind, "results": res}
        if kind == "url":
            name = urllib.parse.unquote(urllib.parse.urlparse(value).path.rsplit("/", 1)[-1]) or value
            return {"kind": kind, "results": [_paper(title=re.sub(r"\.pdf$", "", name, flags=re.I), pdf_url=value,
                                                     landing_url=value, source="链接")]}
        # a title or keywords: both services, the free copies first
        found: list[dict] = []
        errors: list[str] = []
        try:
            data = _get_json(client, f"{OPENALEX}/works", {"search": value, "per-page": limit})
            found += [parse_openalex(w) for w in data.get("results") or []]
        except PaperError as e:
            errors.append(str(e))
        try:
            terms = [w for w in re.findall(r"[\w\-]+", value) if w.lower() not in _STOP][:10]
            if terms:
                found += _arxiv(client, search_query=" AND ".join(f"all:{w}" for w in terms),
                                sortBy="relevance", start=0, max_results=min(limit, 6))
        except PaperError as e:
            errors.append(str(e))
        if not found and errors:
            raise PaperError(errors[0])
    merged: list[dict] = []
    seen: dict[str, dict] = {}
    for p in found:
        key = p["doi"].lower() or p["arxiv"] or _norm_title(p["title"])
        tkey = _norm_title(p["title"])
        prev = seen.get(key) or seen.get(tkey)
        if prev:
            for k in ("pdf_url", "arxiv", "doi", "abstract", "venue", "landing_url"):
                if not prev[k] and p[k]:
                    prev[k] = p[k]
            continue
        seen[key] = seen[tkey] = p
        merged.append(p)
    want = _norm_title(value)
    merged.sort(key=lambda p: (_norm_title(p["title"]) != want, not p["pdf_url"]))
    return {"kind": kind, "results": merged[:limit]}


# --------------------------------------------------------------------------- the PDF

def fetch_pdf(url: str, public_only: bool = False) -> bytes:
    if not url.lower().startswith(("http://", "https://")):
        raise PaperError("只能下载 http / https 链接")
    if public_only:
        check_public(url)
    try:
        with _client(url) as client, client.stream("GET", url, headers={"Accept": "application/pdf,*/*"}) as r:
            if r.status_code in (401, 403):
                raise PaperError("这篇论文需要登录或订阅才能下载。可以在浏览器里下载 PDF 后拖进来")
            if r.status_code >= 400:
                raise PaperError(f"下载失败（{r.status_code}）")
            if public_only:
                check_public(str(r.url))  # where the redirects ended
            buf = bytearray()
            for chunk in r.iter_bytes():
                buf += chunk
                if len(buf) > MAX_PDF:
                    raise PaperError("这个文件太大了（超过 120 MB）")
    except httpx.HTTPError as e:
        raise PaperError("下载失败：连不上这个网站，请检查网络") from e
    data = bytes(buf)
    head = data[:1024].lstrip()
    if not head.startswith(b"%PDF"):
        if b"<html" in head.lower() or b"<!doctype" in head.lower():
            raise PaperError("这个链接打开的是网页而不是 PDF：论文可能需要订阅，或要在网页上点下载。"
                             "可以在浏览器里下载 PDF 后拖进来")
        raise PaperError("下载到的不是 PDF 文件")
    return data
