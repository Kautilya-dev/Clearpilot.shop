import json
from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from db.base import get_db
from db.models import HistoryEntry, Interview, User
from routers.auth import get_current_user
from routers.interviews import get_owned_interview

router = APIRouter(tags=["history"])


class SourceItem(BaseModel):
    title: str
    breadcrumb: str


class HistoryEntryResponse(BaseModel):
    id: str
    question: str
    answer: str
    sources: list[SourceItem]
    created_at: str


def _to_response(e: HistoryEntry) -> HistoryEntryResponse:
    try:
        sources = [SourceItem(**s) for s in json.loads(e.sources)]
    except (json.JSONDecodeError, TypeError):
        sources = []
    return HistoryEntryResponse(id=str(e.id), question=e.question, answer=e.answer, sources=sources, created_at=e.created_at.isoformat())


@router.get("/interviews/{interview_id}/history", response_model=list[HistoryEntryResponse])
async def list_history(
    limit: int = 50, interview: Interview = Depends(get_owned_interview), db: AsyncSession = Depends(get_db)
):
    # Most recent N, newest first - the workspace reverses this client-side to render
    # as a chronological transcript when resuming an interview.
    result = await db.scalars(
        select(HistoryEntry)
        .where(HistoryEntry.interview_id == interview.id)
        .order_by(HistoryEntry.created_at.desc())
        .limit(min(limit, 200))
    )
    return [_to_response(e) for e in result]


class SavePracticeRoundRequest(BaseModel):
    partner_answer: str
    your_response: str
    coach_feedback: str


# Job Mode rounds (AI-suggested or practice-partner) aren't persisted anywhere else - unlike
# Copilot chat, which /chat/ask writes to HistoryEntry itself server-side, nothing calls this
# for the normal AI-vs-candidate flow. This is deliberately scoped to practice-partner rounds
# only, called by the Desktop app once a round with a real partner (not the AI) completes.
@router.post("/interviews/{interview_id}/history", response_model=HistoryEntryResponse)
async def save_practice_round(
    body: SavePracticeRoundRequest,
    interview: Interview = Depends(get_owned_interview),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    question = f"Practice session with partner — {datetime.now(timezone.utc).isoformat()}"
    answer = (
        f"**Partner's spoken answer:**\n{body.partner_answer}\n\n"
        f"**Your response:**\n{body.your_response}\n\n"
        f"**Coach feedback:**\n{body.coach_feedback}"
    )
    entry = HistoryEntry(user_id=current_user.id, interview_id=interview.id, question=question, answer=answer, sources="[]")
    db.add(entry)
    await db.commit()
    await db.refresh(entry)
    return _to_response(entry)


@router.delete("/interviews/{interview_id}/history/{entry_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_history_entry(
    entry_id: UUID, interview: Interview = Depends(get_owned_interview), db: AsyncSession = Depends(get_db)
):
    entry = await db.get(HistoryEntry, entry_id)
    if not entry or entry.interview_id != interview.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="History entry not found")
    await db.delete(entry)
    await db.commit()


@router.delete("/interviews/{interview_id}/history", status_code=status.HTTP_204_NO_CONTENT)
async def clear_history(interview: Interview = Depends(get_owned_interview), db: AsyncSession = Depends(get_db)):
    result = await db.scalars(select(HistoryEntry).where(HistoryEntry.interview_id == interview.id))
    for entry in result:
        await db.delete(entry)
    await db.commit()
