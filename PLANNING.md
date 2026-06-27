# ClearPilot — Planning

SAP CPI interview-prep tool. Web app (`apps/web`, FastAPI + Postgres + Redis, deployed on
Railway at clearpilot.shop) is live and in active use. Desktop app (`apps/desktop`,
Electron + React, npm workspace sibling to `apps/web`) is in active development — auth,
stealth screen-share-hiding, the interview picker, and Copilot streaming are built; not yet
packaged/distributed, and has no Materials/Q&A tabs (Copilot-only so far). Rebuilt from
scratch this cycle — nothing carried over from the prior HireGhost Electron app or the
earlier single-password interview-assistant prototype.

Last updated: 2026-06-27.

## Architecture, current state

- **Auth**: JWT (`pyjwt`) + `bcrypt` directly (no passlib). Admin gating via an
  `ADMIN_EMAILS` allowlist env var.
- **Data model**: `users` → `interviews` (title/state) ←many-to-many→ `subjects` (catalog:
  `sap-integration-suite` available; `salesforce`/`servicenow` coming-soon placeholders)
  via `interview_subjects`. `materials` (resume/job_description/real_time_scenario),
  `qa_entries`, `history_entries` all scope to `interview_id` — nothing is global per-user
  anymore except the account itself and the shared `documents` grounding corpus.
- **Retrieval**: Postgres full-text search (`tsvector`/`websearch_to_tsquery`/`ts_rank`),
  deliberately not embeddings/a vector DB. Document retrieval is filtered by the
  interview's subject(s).
- **Redis**: cache only, in front of Postgres (Postgres is always source of truth) — caches
  the per-interview Q&A list, invalidated on every write. Not used for anything else yet.
- **Frontend**: static HTML/Tailwind-CDN/vanilla JS, no build step, served by FastAPI.
- **Desktop app** (`apps/desktop`): Electron + React (electron-vite). Auth uses a one-shot
  local HTTP callback server (`http://127.0.0.1:<port>/callback`) instead of a custom
  `clearpilot://` URL protocol — the protocol registered fine in the Windows registry but
  the OS silently never invoked it; switched to the same local-server pattern `gh auth
  login --web`/`gcloud auth login` use, for the same reliability reason. Sign-in opens the
  system browser to `clearpilot.shop/login?desktop=1&port=...`, then exchanges the
  resulting one-time code for a JWT via `/api/auth/desktop-exchange`. Copilot streaming
  (`chat:ask`/`chat:event` over IPC) mirrors `apps/web`'s `/chat/ask` SSE handling exactly.
  A native stealth addon (`native/stealth`) can exclude the window from screen capture/share.

## Shipped this cycle

**Interview-centric restructure** (`98e20ba`)
- Materials/Q&A/History/Ask moved from flat per-user lists to scoped inside a
  user-created Interview, grounded in one or more selectable Subjects.
- Knowledge base renamed to Q&A throughout.
- Real file upload (PDF/DOCX/TXT via `pypdf`/`python-docx`) for Materials and Q&A,
  alongside paste. Q&A category/tags are always AI-generated, never typed.
- Dashboard rebuilt as "My Interviews" (multi-subject create flow); History rebuilt as a
  resumable interview log (click to continue exactly where you left off, not a frozen
  transcript); new per-interview workspace with Materials/Q&A/Copilot tabs.

**Q&A-bank shortcut + correctness fixes** (`1b6bd50`, `65ad420`, `ae92f43`, `493073b`)
- `/chat/ask` checks the interview's own saved Q&A first via full-text search; a real
  match skips the OpenAI call entirely.
- Found via real usage: short questions (e.g. "Tell me about Yourself") were reducing to
  a single common word after stopword removal and confidently matching unrelated saved
  answers (and unrelated document chunks, separately, in RAG retrieval). Fixed with a
  minimum-substantive-terms gate (`services/text_relevance_service.py`) plus a calibrated
  rank floor for document retrieval.
- That alone didn't catch generic-but-keyword-matching saved answers (e.g. a bulk-uploaded
  Q&A entry that matches a question's wording exactly but isn't personalized to the
  resume). Added an AI judge step (`services/qa_judge_service.py`) that verifies any
  keyword-matched candidate and either uses it verbatim, personalizes it using the
  resume/JD/scenario, or rejects it and falls through to full generation.
- Net effect: the keyword search is now a cheap pre-filter, not a final decision — the
  speed win is smaller than the original instant/free shortcut (a verified match now costs
  one small AI call, ~1-3s) but it's correct, which the original wasn't.

**Streaming + answer quality** (`1f5e8a1`, `ed89422`)
- Answers stream token-by-token (SSE) instead of arriving as one block; each answer
  reports start time, time-to-first-chunk, and total duration in the UI.
- Markdown rendering (marked.js + DOMPurify) for headings/lists/bold — previously shown as
  literal `**`/`-` characters. Required scoped CSS since Tailwind's preflight strips
  default list/heading styling.
- System prompt flipped from "concise, not an essay" to "thorough, detailed, use markdown"
  per direct request.
- Conversation now shows newest exchange at the top (live questions are inserted ahead of
  everything; history replay appends in the API's already-newest-first order — these
  needed different insertion logic, a real bug caught by checking the post-reload order,
  not just the live-append path).
- Fixed a self-XSS: typed questions were interpolated into the page unescaped.

**Desktop app v1 + Copilot streaming** (`29abfc9`, `b3c3094`)
- Electron + React app scaffolded: sign-in via system browser, native stealth toggle,
  interview picker reading from the same `/api/interviews` the web app uses.
- Copilot tab ported from `apps/web`'s `submitQuestion()`: streamed, markdown-rendered
  answers over IPC, with the same chunk-render throttle fix described below.
- Not yet packaged as an installer (still `npm run dev` only) and has no Materials/Q&A
  tabs — Copilot is the only thing in the per-interview workspace so far.

**Copilot render-throttle fix** (`b3c3094`)
- Both `apps/desktop`'s `CopilotScreen.jsx` and `apps/web`'s `interview.html` re-parsed and
  re-sanitized the *entire* accumulated markdown answer on every streamed chunk. Cost grows
  with answer length (100+ chunks for a long answer) and visibly lagged behind actual
  chunk-arrival rate by the end of a long response.
- Fix: buffer each chunk's text immediately and cheaply, but only run the expensive
  parse+sanitize once per `requestAnimationFrame`, gated by a pending-flag so multiple
  chunks arriving within one frame collapse into a single re-render. On the stream's `done`
  event, render directly from the buffered text rather than trusting the last throttled
  frame, since one can still be pending when the stream ends.
- Verified by mounting the real `CopilotScreen` component standalone (Vite dev server,
  `window.clearpilot` IPC bridge mocked) and replaying 142 synthetic chunks ~3ms apart:
  throttled version did ~74 re-renders instead of 142, frame-bounded rather than
  chunk-bounded, with the final answer byte-for-byte correct.

## Test credentials

- Admin (also the real account in active use, `Krishna (Admin)`):
  `kkollu99@gmail.com` / `AdminTest!2026`
- Regular user: `testuser@clearpilot.shop` / `UserTest!2026`

Note: `kkollu99@gmail.com` now has real interview data attached (multiple live
interviews with uploaded resume/JD/scenarios and a large personal Q&A bank) — it's no
longer just a disposable test account. Be careful with bulk DB operations against it; use
a fresh interview for throwaway testing instead of touching existing rows.

## Remaining / not started

- **`apps/desktop` packaging**: still runs via `npm run dev` only (electron-vite). No
  installer build verified yet, no icon/branding pass, not installed as a Start Menu app
  on the dev machine — `electron-builder`'s NSIS config exists in `package.json` but is
  untested.
- **`apps/desktop` Materials/Q&A tabs**: the per-interview workspace is Copilot-only;
  the web app's Materials and Q&A tabs have no desktop counterpart yet. Unclear whether
  desktop needs them at all, or stays a Copilot-only "live assist" companion to the web
  app's "study" side (see open question below).
- **AI-generated-answer caching**: discussed but not built. Distinct from the Q&A-bank
  shortcut (which only ever serves the user's *own* saved/judged answers) — this would be
  a Redis cache of fresh AI generations for repeated/similar *novel* questions, to avoid
  re-paying the full OpenAI round-trip. Lower priority than the Q&A-bank shortcut since it
  doesn't have the same "verified correct" guarantee.
- **Timing telemetry is not persisted**: the start/first-chunk/duration figures shown live
  during an Ask are not saved to `history_entries`, so replayed/resumed conversations don't
  show timing on past answers. Deliberate scope cut, not a bug — revisit if historical
  latency tracking turns out to matter.
- **Q&A-bank judge only sees the single top keyword candidate** (`LIMIT 1` in
  `find_matching_qa`). Could expand to top-3 and let the judge pick the best (or none) for
  more robustness against keyword-ranking ties. Not done — judged not worth the added
  complexity unless the single-candidate approach turns out to miss real matches.

## Open questions

- `apps/desktop` does reuse `apps/web`'s design language in practice (same Tailwind purple
  accent, same markdown CSS, Copilot ported line-for-line from `submitQuestion()`) — that
  direction has been set by precedent, not an explicit decision.
- Does `apps/desktop` ever get Materials/Q&A tabs, or does it stay deliberately Copilot-only
  (a "live assist" companion during an actual interview, distinct from the web app's
  "study/prep" role)? Affects how much more desktop work is actually left.
- When does `apps/desktop` need to be packaged/distributed (installer, icon, auto-update),
  versus staying a `npm run dev`-only tool for personal use?
- Is the AI-generated-answer cache worth building, or does the Q&A-bank shortcut +
  judge cover enough of the real latency complaints already? Revisit once there's more
  usage data on how often genuinely novel (non-bank-matched) questions repeat.
- The bulk-uploaded ~185-entry Q&A set on the real account reads like generic SAP CPI
  interview prep material rather than personally-written answers. The AI judge now
  personalizes generic-but-relevant matches on the fly, which seems to resolve the
  practical problem — but worth confirming with continued real use that judged/personalized
  answers actually feel right, not just "technically correct."
