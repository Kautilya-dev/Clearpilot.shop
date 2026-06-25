# ClearPilot — Planning

SAP CPI interview-prep tool. Web app (`apps/web`, FastAPI + Postgres + Redis, deployed on
Railway at clearpilot.shop) is live and in active use. Desktop app (`apps/desktop`) is
planned but not started. Rebuilt from scratch this cycle — nothing carried over from the
prior HireGhost Electron app or the earlier single-password interview-assistant prototype.

Last updated: 2026-06-25.

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

## Test credentials

- Admin (also the real account in active use, `Krishna (Admin)`):
  `kkollu99@gmail.com` / `AdminTest!2026`
- Regular user: `testuser@clearpilot.shop` / `UserTest!2026`

Note: `kkollu99@gmail.com` now has real interview data attached (multiple live
interviews with uploaded resume/JD/scenarios and a large personal Q&A bank) — it's no
longer just a disposable test account. Be careful with bulk DB operations against it; use
a fresh interview for throwaway testing instead of touching existing rows.

## Remaining / not started

- **`apps/desktop`**: not started at all. No scope, design, or connectivity decisions made
  yet for a desktop "copilot" counterpart to the web "study" app.
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

- Should `apps/desktop` reuse any UI/design language from `apps/web`, or be a from-scratch
  native build? No direction set yet.
- Is the AI-generated-answer cache worth building, or does the Q&A-bank shortcut +
  judge cover enough of the real latency complaints already? Revisit once there's more
  usage data on how often genuinely novel (non-bank-matched) questions repeat.
- The bulk-uploaded ~185-entry Q&A set on the real account reads like generic SAP CPI
  interview prep material rather than personally-written answers. The AI judge now
  personalizes generic-but-relevant matches on the fly, which seems to resolve the
  practical problem — but worth confirming with continued real use that judged/personalized
  answers actually feel right, not just "technically correct."
