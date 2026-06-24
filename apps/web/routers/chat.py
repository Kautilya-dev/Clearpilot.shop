import json
from typing import Optional
from uuid import UUID

import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from db.base import get_db
from db.models import HistoryEntry, User
from routers.auth import get_current_user
from services.rag_service import build_system_prompt, generate_answer, get_active_material, retrieve_relevant_docs

router = APIRouter(prefix="/chat", tags=["chat"])


class AskRequest(BaseModel):
    question: str
    resume_id: Optional[UUID] = None
    jd_id: Optional[UUID] = None


class SourceResponse(BaseModel):
    title: str
    breadcrumb: str


class AskResponse(BaseModel):
    answer: str
    sources: list[SourceResponse]


@router.post("/ask", response_model=AskResponse)
async def ask(
    body: AskRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if not body.question.strip():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Question is empty")

    resume = await get_active_material(db, current_user.id, "resume")
    jd = await get_active_material(db, current_user.id, "job_description")
    doc_chunks = await retrieve_relevant_docs(db, body.question)

    system_prompt = build_system_prompt(resume, jd, doc_chunks)

    try:
        answer = await generate_answer(system_prompt, body.question)
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"AI provider error: {e.response.text}")
    except httpx.HTTPError as e:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"AI provider unreachable: {e}")

    sources = [SourceResponse(title=c.title, breadcrumb=c.breadcrumb) for c in doc_chunks]

    db.add(HistoryEntry(
        user_id=current_user.id,
        question=body.question,
        answer=answer,
        sources=json.dumps([s.model_dump() for s in sources]),
    ))
    await db.commit()

    return AskResponse(answer=answer, sources=sources)
