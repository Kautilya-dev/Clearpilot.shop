# ClearPilot

A personal SAP CPI study assistant. Ask a technical CPI question by voice or text and get a fast, grounded answer pulled from your own notes and the CPI handbook - plus a practice mode built from real interview question patterns.

## Setup

```
pip install -r requirements.txt
cp .env.example .env   # fill in ANTHROPIC_API_KEY, APP_PASSWORD, SESSION_SECRET
python build_index.py  # indexes Notes/ + the handbook PDF into Chroma/SQLite, builds questions_bank.json, answer_cache.json
uvicorn server:app --reload
```

Open `http://localhost:8000` in Chrome (required for the microphone feature).

## Adding documents

Drop a `.pdf`, `.docx`, `.txt`, `.md`, or `.html` file in via the "Add a document" upload control in the app itself - no need to rerun `build_index.py` for one-off additions. Uploaded files are saved under `DATA_DIR/files` and indexed immediately (chunked by heading/section where the format supports it, embedded, and stored in Chroma + SQLite), so the next question can draw on it right away.

To add to the `Notes/`/handbook-folder content instead, edit those folders (one level up from this repo) and rerun `python build_index.py` locally, **then commit and push** `index/` and `db/` - see "Deploying" below for why.

## Storage layout

Everything lives under `DATA_DIR` (env var; defaults to this app's directory, so local dev needs no setup):

- `DATA_DIR/files` - raw uploaded files (gitignored)
- `DATA_DIR/index` - Chroma's persistent vector store (**committed** - see below)
- `DATA_DIR/db` - SQLite document registry, `clearpilot.db` (**committed** - see below)
- `DATA_DIR/cache` - cached extracted text per document (gitignored)

## Deploying (Railway)

`Notes/`, the handbook PDF, and `RealTime Interviews/` live one level above this repo on disk - they are **not** part of the `Clearpilot.shop` git repo and never reach Railway. Because of that, `index/` and `db/` are committed straight into git instead of being gitignored like a normal build artifact: Railway can only serve what was indexed locally and pushed, it can't rebuild the index itself from source files it doesn't have.

So the deploy flow is: change source content locally → `python build_index.py` → commit `index/` + `db/` → push. There's no Railway-side rebuild step (an earlier `release:` command that tried this was removed - it just silently produced an empty index every deploy).

Live uploads (`/api/upload`) are unaffected by this - they write to the running container's `DATA_DIR` directly, no git/deploy involved. They just need a mounted Volume (with `DATA_DIR` pointed at it) to survive a redeploy, same as before.
