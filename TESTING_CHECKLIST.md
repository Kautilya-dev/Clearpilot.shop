# ClearPilot Testing Checklist

Run through this after any change to `build_index.py`, `server.py`, `auth.py`, or the frontend, before pushing.

## 1. Indexing (`python build_index.py`)
- **Test:** Run the script fresh.
- **Success:** Prints a non-zero chunk count, a question count, and either pre-generates answers (with a real key) or prints the "no API key" message without crashing.
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
- **Success:** Deploy logs show no missing-dependency or missing-env-var tracebacks; login + ask + practice all work against the live URL.
- **Failure:** 502 → check Build Logs for missing packages (`requirements.txt`); "Internal Server Error" after login → check Variables tab has all four secrets set and saved.
