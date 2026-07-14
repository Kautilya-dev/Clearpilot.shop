import json
import time
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from db.base import SessionLocal, get_db
from db.models import HistoryEntry, Interview, QAEntry, User
from routers.auth import get_current_user
from routers.interviews import get_interview_subject_ids, get_owned_interview
from services.qa_judge_service import judge_and_maybe_answer
from services.qa_match_service import find_matching_qa
from services.rag_service import build_system_prompt, generate_answer_stream, get_active_material, retrieve_relevant_docs

router = APIRouter(tags=["chat"])

# "minimal" is not a valid reasoning_effort for this model on the Chat Completions endpoint -
# confirmed live, OpenAI rejects it with a 400. Only these three are actually accepted.
_VALID_REASONING_EFFORTS = {"low", "medium", "high"}


class AskRequest(BaseModel):
    question: str
    # Admin/tester-only live experiment (see generate_answer_stream) to test whether a lower
    # reasoning effort cuts time-to-first-chunk without hurting grounding accuracy - ignored
    # for everyone else, so this can't be used to degrade other users' answer quality.
    reasoning_effort: str | None = None


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sse(payload: dict) -> str:
    return f"data: {json.dumps(payload)}\n\n"


@router.post("/interviews/{interview_id}/chat/ask")
async def ask(
    body: AskRequest,
    interview: Interview = Depends(get_owned_interview),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if not body.question.strip():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Question is empty")

    question = body.question
    interview_id = interview.id
    user_id = current_user.id
    # Captured as plain strings now, not read off current_user inside stream() - that ORM
    # object is bound to this request-scoped db session, which FastAPI tears down before
    # the streamed body finishes (same reason stream() opens its own stream_db below).
    answer_format_mode = current_user.answer_format_mode
    answer_length = current_user.answer_length
    user_email = current_user.email.lower()
    can_use_testing_knobs = user_email in settings.admin_emails_set or user_email in settings.tester_emails_set
    reasoning_effort = (
        body.reasoning_effort
        if can_use_testing_knobs and body.reasoning_effort in _VALID_REASONING_EFFORTS
        else None
    )

    # A keyword candidate from the Q&A bank, if any - not a final decision. Whether it's
    # actually used gets judged inside stream() once resume/JD/scenario are loaded, since
    # the judge weighs candidate relevance against them too.
    qa_candidate = await find_matching_qa(db, interview_id, question)

    async def stream():
        started_monotonic = time.monotonic()
        started_dt = datetime.now(timezone.utc)
        started_iso = started_dt.isoformat()
        first_chunk_monotonic = None
        first_chunk_dt = None
        full_text = ""
        sources_payload = []
        used_qa_bank = False

        yield _sse({"type": "start", "started_at": started_iso})

        # The `db` session injected via Depends is torn down once this route function
        # returns the StreamingResponse - FastAPI closes yield-dependencies before the
        # streamed body finishes sending, not after. Everything from here on needs its
        # own session.
        async with SessionLocal() as stream_db:
            resume = await get_active_material(stream_db, interview_id, "resume")
            jd = await get_active_material(stream_db, interview_id, "job_description")
            scenario = await get_active_material(stream_db, interview_id, "real_time_scenario")

            if qa_candidate:
                try:
                    judged = await judge_and_maybe_answer(question, qa_candidate, resume, jd, scenario)
                except httpx.HTTPError:
                    judged = None  # judge call failing shouldn't block answering - fall through
                if judged:
                    full_text = judged
                    used_qa_bank = True
                    first_chunk_monotonic = time.monotonic()
                    first_chunk_dt = datetime.now(timezone.utc)
                    yield _sse({"type": "chunk", "text": full_text})

            if not used_qa_bank:
                subject_ids = await get_interview_subject_ids(stream_db, interview_id)
                doc_chunks = await retrieve_relevant_docs(stream_db, question, subject_ids)
                system_prompt = build_system_prompt(resume, jd, scenario, doc_chunks, answer_format_mode, answer_length)
                sources_payload = [{"title": c.title, "breadcrumb": c.breadcrumb} for c in doc_chunks]

                try:
                    async for delta in generate_answer_stream(system_prompt, question, reasoning_effort):
                        if first_chunk_monotonic is None:
                            first_chunk_monotonic = time.monotonic()
                            first_chunk_dt = datetime.now(timezone.utc)
                        full_text += delta
                        yield _sse({"type": "chunk", "text": delta})
                except httpx.HTTPError as e:
                    yield _sse({"type": "error", "detail": f"AI provider error: {e}"})
                    return

            if used_qa_bank:
                await stream_db.execute(
                    update(QAEntry).where(QAEntry.id == qa_candidate.id).values(use_count=QAEntry.use_count + 1)
                )

            stream_db.add(HistoryEntry(
                user_id=user_id, interview_id=interview_id, question=question, answer=full_text,
                sources=json.dumps(sources_payload),
                started_at=started_dt, first_chunk_at=first_chunk_dt,
                reasoning_effort=reasoning_effort,
            ))
            await stream_db.commit()

        ended_monotonic = time.monotonic()
        yield _sse({
            "type": "done",
            "sources": sources_payload,
            "from_qa_bank": used_qa_bank,
            "started_at": started_iso,
            "ended_at": _now_iso(),
            "time_to_first_chunk_ms": (
                round((first_chunk_monotonic - started_monotonic) * 1000) if first_chunk_monotonic else None
            ),
            "duration_ms": round((ended_monotonic - started_monotonic) * 1000),
            "reasoning_effort": reasoning_effort,  # None means default - lets an admin A/B test confirm what actually ran
        })

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )
