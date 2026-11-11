# PDF Bilingual Translation Reader

[简体中文](README.md) | **English** · [Homepage](https://114514ch-en.github.io/pdf-translate-reader/) · [Download for Windows](https://github.com/114514CH-EN/pdf-translate-reader/releases/latest)

A local PDF reader and translator: the original on the left, a translation laid out like the original on the right, with both panes scrolling together. Formulas, tables and images are kept as they are, which makes it suited to English papers, lab handouts and textbooks.

![Page view with the reading assistant](docs/img/reader.png)

Your documents, translations and notes stay on your own computer. Text is sent only to the LLM API you configure, and only when you translate or ask a question.

The interface is in Chinese, and the default translation direction is English → Chinese.

## Features

**Translation**
- Page view: the translation keeps the original's positions, font sizes and colours (headings, numbered-list indents and table cell alignment follow the source). A sentence-by-sentence view lets you edit each sentence
- Formulas are never re-typeset: inline and display math are cropped from the rendered page, so subscripts and superscripts match the original
- Text inside pictures can be translated too (Settings → 翻译 → 翻译图片文字, off by default): each picture gets its own button, text is recognised locally and painted back at the same place, size, colour and rotation
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
- Physics (Settings → 界面 → 桌宠, each can be turned off): let go of it up high and it falls and bounces; fling it and it keeps the speed of your hand and bounces off the window edges
- It reacts: rub the pointer back and forth over it to pet it (hearts), a hard landing leaves it seeing stars; it hops when a translation finishes and suggests a break after 45 minutes of reading
- Right-click menu: summarise the page, quiz, change look, quiet mode, tuck into the corner (comes out only when you ask about selected text)
- After you stay on a page for a few seconds, it offers to explain the formulas, tables or long passages it sees there (can be turned off)
- The default look is 小页, a folded sheet of paper drawn for this project

![Desktop pet edition preview](docs/img/pet.png)

**Other**
- Works with DeepSeek, OpenAI, Qwen, Kimi and any OpenAI-compatible endpoint (Ollama, LM Studio, self-hosted servers). Settings can fetch the model list so you can pick one
- Usage and cost tracking (by purpose and by document), with cache-hit pricing and peak / off-peak rates
- API keys are stored encrypted (Windows DPAPI); the database is backed up automatically on start-up

## Quick start (Windows)

### Option 1: download the exe (recommended, nothing to install)

1. From [Releases](https://github.com/114514CH-EN/pdf-translate-reader/releases/latest), download **`PDFTranslate-vX.Y.Z-windows.zip`** and extract it anywhere
2. Double-click **`PDFTranslate.exe`**; your browser opens `http://127.0.0.1:8765`. **`启动桌宠版.bat`** starts the desktop pet edition (after the first run a `PDFTranslate-Pet.exe` appears next to it). Later versions install from ⚙ Settings → Data & security → **Check for updates**
3. Open ⚙ Settings:
   - **翻译 (Translation)**: choose a provider, enter the API key, click "拉取模型列表" (fetch models) to pick a model, then "保存并测试" (save and test)
   - **阅读助手 (Reading assistant)**: configured separately (click "复制翻译 API 的配置" to start from the translation settings)
4. Drop a PDF into the window and click "翻译全文" (translate all). No document at hand? Try the sample [`docs/demo/fourier-guide.pdf`](docs/demo/fourier-guide.pdf)

Documents, translations and settings are stored in the `data\` folder next to the exe. To upgrade, download the new version and copy the old `data\` folder into it.

> With DeepSeek V4, thinking mode is turned off automatically for translation (faster and cheaper). For the reading assistant you can choose in Settings.

### Option 2: run from source

Requires **Python 3.10+**. The repository includes the built frontend, so **Node.js is not needed**. Download the source zip (or clone this repository) and double-click `run.bat`; for the pet edition double-click `run_pet.bat` (opens `http://127.0.0.1:8765/pet`). The first run creates a virtual environment and installs the dependencies. Both editions share the same backend and the same `data/` folder.

### Starting and closing

- To close it: close the console window, press Ctrl+C, or click "退出程序" (quit) in Settings → 数据与安全 (Data & security)
- If an older version is still running when you start it, it is asked to quit first; if it cannot be stopped (for example it runs in another sandbox), the app starts on the next free port from 8766 instead

### Build the exe yourself

Run `build_exe.bat` (needs Python). It produces `dist\PDFTranslate\` with `PDFTranslate.exe` and `启动桌宠版.bat`; the whole folder can be copied elsewhere. Releases are built automatically on Windows by GitHub, see `.github/workflows/release.yml`.

### Server version (Vercel + your own server)

The app can also run as a website: the page on Vercel, the backend in Docker on your own server (reached through a Cloudflare Tunnel), with a login checked by an existing account service and limited to listed users. See [deploy/README.md](deploy/README.md) (Chinese).

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
