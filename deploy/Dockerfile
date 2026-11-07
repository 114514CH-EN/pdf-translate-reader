# PDF 双语翻译阅读器 — server version (backend only; the page is served by Vercel).
# Build from the repository root:  docker compose -f deploy/docker-compose.yml up -d --build
FROM python:3.12-slim

# a Chinese font for the PDF exports (WenQuanYi Micro Hei, ~5 MB)
RUN apt-get update \
    && apt-get install -y --no-install-recommends fonts-wqy-microhei \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt
COPY backend/app backend/app
COPY VERSION VERSION

# PDFTR_REQUIRE_AUTH: without a login configured in .env the API refuses everything
ENV PDFTR_DATA_DIR=/data \
    PDFTR_REQUIRE_AUTH=1 \
    PYTHONUNBUFFERED=1
VOLUME ["/data"]
EXPOSE 8003

HEALTHCHECK --interval=60s --timeout=5s --start-period=20s \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8003/api/health', timeout=4).status == 200 else 1)"

# one worker: translation jobs and the SQLite database live in this process
CMD ["uvicorn", "backend.app.main:app", "--host", "0.0.0.0", "--port", "8003", \
     "--proxy-headers", "--forwarded-allow-ips", "*", "--log-level", "warning"]
