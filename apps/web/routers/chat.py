import json

import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from db.base import get_db
from db.models import HistoryEntry, Interview, QAEntry, User
from routers.auth import get_current_user
from routers.interviews import get_interview_subject_ids, get_owned_interview
from services.qa_match_service import find_matching_qa
from services.rag_service import build_system_prompt, generate_answer, get_active_material, retrieve_relevant_docs

router = APIRouter(tags=["chat"])


class AskRequest(BaseModel):
    question: str


class SourceResponse(BaseModel):
    title: str
    breadcrumb: str


class AskResponse(BaseModel):
    answer: str
    sources: list[SourceResponse]
    from_qa_bank: bool = False


@router.post("/interviews/{interview_id}/chat/ask", response_model=AskResponse)
async def ask(
    body: AskRequest,
    interview: Interview = Depends(get_owned_interview),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if not body.question.strip():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Question is empty")

    # Check this interview's own Q&A bank first - if the user already saved an answer to
    # this question, skip the OpenAI round-trip entirely: instant, free, and it's their
    # own vetted answer rather than a fresh AI generation.
    qa_match = await find_matching_qa(db, interview.id, body.question)
    if qa_match:
        await db.execute(
            update(QAEntry).where(QAEntry.id == qa_match.id).values(use_count=QAEntry.use_count + 1)
        )
        db.add(HistoryEntry(
            user_id=current_user.id,
            interview_id=interview.id,
            question=body.question,
            answer=qa_match.answer,
            sources="[]",
        ))
        await db.commit()
        return AskResponse(answer=qa_match.answer, sources=[], from_qa_bank=True)

    resume = await get_active_material(db, interview.id, "resume")
    jd = await get_active_material(db, interview.id, "job_description")
    scenario = await get_active_material(db, interview.id, "real_time_scenario")
    subject_ids = await get_interview_subject_ids(db, interview.id)
    doc_chunks = await retrieve_relevant_docs(db, body.question, subject_ids)

    system_prompt = build_system_prompt(resume, jd, scenario, doc_chunks)

    try:
        answer = await generate_answer(system_prompt, body.question)
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"AI provider error: {e.response.text}")
    except httpx.HTTPError as e:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"AI provider unreachable: {e}")

    sources = [SourceResponse(title=c.title, breadcrumb=c.breadcrumb) for c in doc_chunks]

    db.add(HistoryEntry(
        user_id=current_user.id,
        interview_id=interview.id,
        question=body.question,
        answer=answer,
        sources=json.dumps([s.model_dump() for s in sources]),
    ))
    await db.commit()

    return AskResponse(answer=answer, sources=sources, from_qa_bank=False)
