# PDF Bilingual Translation Reader

[简体中文](README.md) | **English** · [Homepage](https://114514ch-en.github.io/pdf-translate-reader/) · [Download v1.0.0](https://github.com/114514CH-EN/pdf-translate-reader/releases/latest)

A local PDF reader and translator: the original on the left, a translation laid out like the original on the right, with both panes scrolling together. Formulas, tables and images are kept as they are, which makes it suited to English papers, lab handouts and textbooks.

![Page view with the reading assistant](docs/img/reader.png)

Your documents, translations and notes stay on your own computer. Text is sent only to the LLM API you configure, and only when you translate or ask a question.

The interface is in Chinese, and the default translation direction is English → Chinese.

## Features

**Translation**
- Page view: the translation keeps the original's positions, font sizes and colours (headings, numbered-list indents and table cell alignment follow the source). A sentence-by-sentence view lets you edit each sentence
- Formulas are never re-typeset: inline and display math are cropped from the rendered page, so subscripts and superscripts match the original
- Glossary (global and per document) that can be extracted from the document automatically; consistency polishing
- Estimates of tokens, cost and time before translating; a progress strip with one cell per page (click to jump)
- Export: translation-only PDF, side-by-side or alternating-page PDF, bilingual PDF, Markdown (with highlights and notes)

![Sentence-by-sentence view](docs/img/sentences.png)

**Reading**
- Select text to look it up in context, translate it, add it to the glossary, highlight it in five colours or write a note
- Ctrl+F searches the original and the translation at the same time
- Remembers where you stopped in each document
- Tabs, a document library and 8 interface themes (including e-ink and paper)

**Reading assistant**
- Configured with its own model, separately from translation. It answers from the document and cites pages like `[p3]`, which you can click to jump to
- One click to "explain" a selected passage or "walk through" a formula; "summarise this page" and "quiz me on this page"
- Formulas in answers are rendered with KaTeX; supports DeepSeek V4 thinking mode, with the reasoning available to expand

**Desktop pet edition (小页)**
- A second interface for the same app: the reading assistant becomes a small pet that sits on the bottom edge of the window and opens a chat bubble when clicked. It wanders, can be dragged around, and pops up when you ask about selected text
- Change its look with an image URL (GIFs work) or a local file. Backgrounds are removed on import, frame by frame for animations, so the animation is kept. Walking, thinking, talking, listening and sleeping can each have their own picture
- It turns to face the way it walks, dozes off when nothing happens for a while, perks up when you select text, and hops to tell you an answer finished while the bubble was closed
- Right-click menu: summarise the page, quiz, change look, quiet mode, tuck into the corner (comes out only when you ask about selected text)
- After you stay on a page for a few seconds, it offers to explain the formulas, tables or long passages it sees there (can be turned off)
- The default look is 小页, a folded sheet of paper drawn for this project

![Desktop pet edition preview](docs/img/pet.png)

**Other**
- Works with DeepSeek, OpenAI, Qwen, Kimi and any OpenAI-compatible endpoint (Ollama, LM Studio, self-hosted servers). Settings can fetch the model list so you can pick one
- Usage and cost tracking (by purpose and by document), with cache-hit pricing and peak / off-peak rates
- API keys are stored encrypted (Windows DPAPI); the database is backed up automatically on start-up

## Quick start (Windows)

Requires **Python 3.10+**. The repository includes the built frontend, so **Node.js is not needed**.

1. Download the zip from [Releases](https://github.com/114514CH-EN/pdf-translate-reader/releases/latest) and extract it (or clone this repository)
2. Double-click `run.bat`. The first run creates a virtual environment, installs the dependencies and opens `http://127.0.0.1:8765` in your browser
3. Open ⚙ Settings:
   - **翻译 (Translation)**: choose a provider, enter the API key, click "拉取模型列表" (fetch models) to pick a model, then "保存并测试" (save and test)
   - **阅读助手 (Reading assistant)**: configured separately (click "复制翻译 API 的配置" to start from the translation settings)
4. Drop a PDF into the window and click "翻译全文" (translate all). No document at hand? Try the sample [`docs/demo/fourier-guide.pdf`](docs/demo/fourier-guide.pdf)

> With DeepSeek V4, thinking mode is turned off automatically for translation (faster and cheaper). For the reading assistant you can choose in Settings.

### Desktop pet edition

Double-click `run_pet.bat`, which opens `http://127.0.0.1:8765/pet`. Both editions share the same backend and the same `data/` folder, so you can switch between them at any time.

### Build an exe

Run `build_exe.bat` (needs Python and Node.js). It produces `dist\PDFTranslate\PDFTranslate.exe`, and the whole folder can be copied elsewhere. Start it with `--pet` for the desktop pet edition.

## Where data is stored

| Location | Contents |
|---|---|
| `data/pdf_translate.db` | Document structure, translations, glossary, notes, highlights, usage records |
| `data/uploads/` | Uploaded PDFs and page caches |
| `data/backups/` | Automatic backups (latest 10) |
| `data/config.json` | Settings (API keys encrypted) |
| `data/pet/` | The desktop pet's imported image |

`data/` is excluded in `.gitignore` and is never committed.

## Development

```bash
# backend
python -m venv .venv && .venv\Scripts\pip install -r backend\requirements.txt
.venv\Scripts\python -m uvicorn backend.app.main:app --port 8765 --reload

# frontend (in a second terminal; the dev server proxies /api to 8765)
cd frontend && npm install && npm run dev      # http://localhost:5173 (pet edition: /pet.html)
npm run build                                  # writes frontend/dist

# tests (use a temporary data folder and never touch your library)
cd backend && ..\.venv\Scripts\python -m pytest -q tests
```

Stack: FastAPI + SQLite + PyMuPDF + Pillow (backend), React + TypeScript + Vite + Zustand + pdf.js + KaTeX (frontend). Development notes and design decisions are in [PROGRESS.md](PROGRESS.md) (Chinese).

The sample document in the screenshots, `docs/demo/fourier-guide.pdf`, is a demo handout written for this project.
