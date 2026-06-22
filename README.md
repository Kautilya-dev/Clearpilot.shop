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

Re-running `python build_index.py` does a fresh rebuild of just the `Notes/`/handbook-folder content - anything added live via upload is left untouched.

## Storage layout

Everything lives under `DATA_DIR` (env var; defaults to this app's directory, so local dev needs no setup):

- `DATA_DIR/files` - raw uploaded files
- `DATA_DIR/index` - Chroma's persistent vector store
- `DATA_DIR/db` - SQLite document registry (`clearpilot.db`)
- `DATA_DIR/cache` - cached extracted text per document

On Railway, mount a Volume and point `DATA_DIR` at it so uploads and the index survive redeploys - Railway's default filesystem is ephemeral.
