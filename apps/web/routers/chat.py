import json
import time
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from db.base import SessionLocal, get_db
from db.models import HistoryEntry, Interview, QAEntry, User
from routers.auth import get_current_user
from routers.interviews import get_interview_subject_ids, get_owned_interview
from services.qa_match_service import find_matching_qa
from services.rag_service import build_system_prompt, generate_answer_stream, get_active_material, retrieve_relevant_docs

router = APIRouter(tags=["chat"])


class AskRequest(BaseModel):
    question: str


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

    # Check this interview's own Q&A bank first - if the user already saved an answer to
    # this question, skip the OpenAI round-trip entirely: instant, free, and it's their
    # own vetted answer rather than a fresh AI generation.
    qa_match = await find_matching_qa(db, interview_id, question)
    if qa_match:
        await db.execute(update(QAEntry).where(QAEntry.id == qa_match.id).values(use_count=QAEntry.use_count + 1))
        await db.commit()

    async def stream():
        started_monotonic = time.monotonic()
        started_iso = _now_iso()
        first_chunk_monotonic = None
        full_text = ""
        sources_payload = []

        yield _sse({"type": "start", "from_qa_bank": bool(qa_match), "started_at": started_iso})

        # The `db` session injected via Depends is torn down once this route function
        # returns the StreamingResponse - FastAPI closes yield-dependencies before the
        # streamed body finishes sending, not after. Everything from here on needs its
        # own session.
        async with SessionLocal() as stream_db:
            if qa_match:
                full_text = qa_match.answer
                first_chunk_monotonic = time.monotonic()
                yield _sse({"type": "chunk", "text": full_text})
            else:
                resume = await get_active_material(stream_db, interview_id, "resume")
                jd = await get_active_material(stream_db, interview_id, "job_description")
                scenario = await get_active_material(stream_db, interview_id, "real_time_scenario")
                subject_ids = await get_interview_subject_ids(stream_db, interview_id)
                doc_chunks = await retrieve_relevant_docs(stream_db, question, subject_ids)
                system_prompt = build_system_prompt(resume, jd, scenario, doc_chunks)
                sources_payload = [{"title": c.title, "breadcrumb": c.breadcrumb} for c in doc_chunks]

                try:
                    async for delta in generate_answer_stream(system_prompt, question):
                        if first_chunk_monotonic is None:
                            first_chunk_monotonic = time.monotonic()
                        full_text += delta
                        yield _sse({"type": "chunk", "text": delta})
                except httpx.HTTPError as e:
                    yield _sse({"type": "error", "detail": f"AI provider error: {e}"})
                    return

            stream_db.add(HistoryEntry(
                user_id=user_id, interview_id=interview_id, question=question, answer=full_text,
                sources=json.dumps(sources_payload),
            ))
            await stream_db.commit()

        ended_monotonic = time.monotonic()
        yield _sse({
            "type": "done",
            "sources": sources_payload,
            "from_qa_bank": bool(qa_match),
            "started_at": started_iso,
            "ended_at": _now_iso(),
            "time_to_first_chunk_ms": (
                round((first_chunk_monotonic - started_monotonic) * 1000) if first_chunk_monotonic else None
            ),
            "duration_ms": round((ended_monotonic - started_monotonic) * 1000),
        })

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )
