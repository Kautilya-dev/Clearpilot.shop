# ClearPilot Testing Checklist

Run through this after any change to `build_index.py`, `server.py`, `auth.py`, or the frontend, before pushing.

## 1. Indexing (`python build_index.py`)
- **Test:** Run the script fresh.
- **Success:** Prints a non-zero chunk count, a question count, and either pre-generates answers (with a real key) or prints the "no API key" message without crashing. Chunks land in Chroma (`DATA_DIR/index`) and a row per document appears in SQLite (`DATA_DIR/db/clearpilot.db`).
- **Failure:** Any traceback during parsing → check the specific file named in the error; a 0 chunk count means `Notes/` or the Handbook PDF path is wrong.

## 2. Question bank quality
- **Test:** Open `questions_bank.json`, sample ~20 entries.
- **Success:** Every entry ends in (or clearly contains) a real question mark and reads like a genuine technical CPI question.
- **Failure:** Entries that are personal narrative ("I have X years...") or chit-chat → tighten `is_technical_question()` / `NARRATIVE_PATTERNS` in `build_index.py` and rebuild.

## 3. Auth gate
- **Test:** Visit `/` while logged out.
- **Success:** Redirects to `/login`; wrong password shows the error state; correct password redirects to `/` and the app loads.
- **Failure:** "Internal Server Error" on login → `APP_PASSWORD` or `SESSION_SECRET` missing from the environment.

## 4. Ask mode — cache hit
- **Test:** Ask a question that's already in `answer_cache.json` (no conversation history).
- **Success:** `X-Answer-Source: cache` header, answer appears near-instantly (no visible streaming delay).
- **Failure:** Falls through to a live call every time → check `find_cached_answer()` normalization/matching logic.

## 5. Ask mode — live fallback
- **Test:** Ask a question that is *not* in the cache.
- **Success:** `X-Answer-Source: live`, `X-Sources` lists plausible source filenames for the topic, answer streams in over ~1-2s, technical/solution-style (not personal narrative unless your real profile supports it), and gets added to `answer_cache.json` afterward.
- **Failure:** Empty/cut-off response → check server logs for an `anthropic.AuthenticationError` (bad/missing key) or other exception.

## 6. Conversational memory
- **Test:** Ask a question, then ask a follow-up that only makes sense with context (e.g. "what about for inbound IDocs specifically?").
- **Success:** The follow-up answer correctly references the prior topic; cache is skipped whenever history is sent (always `X-Answer-Source: live` for follow-ups).
- **Failure:** Follow-up answer is generic/unrelated → confirm the frontend is sending `chatMemory` in the request body and `server.py` is building the multi-turn `messages` list.

## 7. Practice mode
- **Test:** Click "Next Question" several times, then "Reveal Answer".
- **Success:** Each click gives a different real technical question; reveal streams a grounded answer once and disables itself (no duplicate history entries on repeated clicks).
- **Failure:** Same question repeating immediately, or duplicate history rows → check `random.choice` pool size and the `revealBtn.disabled` guard in `app.js`.

## 8. Debug panel
- **Test:** Toggle through a cached answer and a live answer in both Ask and Practice mode.
- **Success:** Debug line shows correct source (`instant cache hit` / `live Claude call`) and a plausible source file list.
- **Failure:** Debug line missing or stuck on `d-none` → check headers are being read before the stream body is consumed in `streamAnswer()`.

## 9. Persona / depth calibration
- **Test:** Fill `profile.txt` with real experience info, ask a basic question you'd already know, and an advanced one slightly beyond your stated experience.
- **Success:** Answers calibrate depth/assumptions to the profile without inventing specific employers/projects not stated in it.
- **Failure:** Answer fabricates a specific company/project not in `profile.txt` → tighten the candidate-profile clause in `build_system_prompt()`.

## 10. Mic input
- **Test:** Click the mic button in Chrome, speak a question, let it auto-stop.
- **Success:** Transcribed text appears in the input box and auto-submits.
- **Failure:** Mic button disabled → unsupported browser (use Chrome); no transcription → check mic permissions; works on `localhost` but not the deployed domain → confirm HTTPS is active (required for `SpeechRecognition` off localhost).

## 11. Deployment (Railway)
- **Test:** Push to `main`, wait for auto-deploy, hit `https://clearpilot.shop`.
- **Success:** Deploy logs show no missing-dependency or missing-env-var tracebacks; the startup log line says `Loaded N chunks` with N matching what `python build_index.py` reported locally (not 0 - see Failure); login + ask + practice all work against the live URL.
- **Failure:** 502 → check Build Logs for missing packages (`requirements.txt`); "Internal Server Error" after login → check Variables tab has all four secrets set and saved; `Loaded 0 chunks` → `index/`/`db/` weren't committed/pushed, or were re-added to `.gitignore` - see README's "Deploying" section.

## 12. Document upload (happy path)
- **Test:** Upload a `.txt`, a `.md` with a couple of `#`/`##` headings, and a `.pdf` or `.docx` via the "Add a document" control.
- **Success:** Status line reports a chunk count added; a follow-up question whose answer only exists in the new file returns a grounded answer citing the uploaded filename in `X-Sources`; the file appears under `DATA_DIR/files` and a row for it exists in SQLite.
- **Failure:** Upload succeeds but the content never surfaces in answers → check `reload_index()` ran (rebuilt BM25 + refreshed `state["chunks"]`) and that `store.add_chunks()` didn't silently no-op.

## 13. Upload validation / rejection paths
- **Test:** Try uploading an unsupported type (e.g. `.exe`/`.zip`), an empty file, an oversized file (>20MB), and a file whose name contains `../` path-traversal segments.
- **Success:** Each is rejected with a 400 and a clear `detail` message; no stray file is left in `DATA_DIR/files` for a rejected upload; no crash/500.
- **Failure:** A rejected upload still leaves a file on disk → check the `dest_path.unlink()` cleanup paths in `/api/upload`.

## 14. Restart persistence
- **Test:** Upload a document, restart the server (`uvicorn` reload or a fresh process), ask a question only answerable from that upload.
- **Success:** The content is still searchable - proves Chroma + SQLite persistence under `DATA_DIR` worked, with no manual reindex step needed.
- **Failure:** Content is gone after restart → confirm `DATA_DIR` resolves to the same path across restarts and Chroma's `PersistentClient` is pointed at `DATA_DIR/index`.

## 15. Rebuild doesn't duplicate or wipe uploads
- **Test:** Upload a document, then run `python build_index.py` again (locally - this no longer runs on Railway, see README's "Deploying" section).
- **Success:** The uploaded document is still present and not duplicated; `Notes/`/handbook chunks are refreshed (not doubled) either.
- **Failure:** Chunk counts grow on every rerun → `store.clear_origin("folder")` isn't being called, or uploads are getting swept up in the "folder" clear by mistake.
