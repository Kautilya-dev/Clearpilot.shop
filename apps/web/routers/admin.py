from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from db.base import get_db
from db.models import HistoryEntry, Interview, User
from routers.auth import get_current_user

router = APIRouter(prefix="/admin", tags=["admin"])


async def require_admin(current_user: User = Depends(get_current_user)) -> User:
    if current_user.email.lower() not in settings.admin_emails_set:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required")
    return current_user


class AdminUserResponse(BaseModel):
    id: str
    email: str
    display_name: str
    created_at: str


@router.get("/users", response_model=list[AdminUserResponse])
async def list_users(_: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    result = await db.scalars(select(User).order_by(User.created_at.desc()))
    return [
        AdminUserResponse(
            id=str(u.id), email=u.email, display_name=u.display_name, created_at=u.created_at.isoformat()
        )
        for u in result
    ]


class AdminHistoryEntryResponse(BaseModel):
    id: str
    user_email: str
    user_display_name: str
    interview_title: str
    question: str
    answer: str
    word_count: int
    reasoning_effort: str | None  # None = default (unset) effort ran
    started_at: str | None  # question asked
    first_chunk_at: str | None  # first letter of the answer appeared
    ended_at: str  # created_at - set at INSERT time, right after the stream finishes
    time_to_first_chunk_ms: int | None
    duration_ms: int | None


@router.get("/history", response_model=list[AdminHistoryEntryResponse])
async def list_history(
    limit: int = 200, _: User = Depends(require_admin), db: AsyncSession = Depends(get_db)
):
    result = await db.execute(
        select(HistoryEntry, User, Interview)
        .join(User, User.id == HistoryEntry.user_id)
        .join(Interview, Interview.id == HistoryEntry.interview_id)
        .order_by(HistoryEntry.created_at.desc())
        .limit(limit)
    )
    entries = []
    for entry, user, interview in result:
        time_to_first_chunk_ms = None
        if entry.started_at and entry.first_chunk_at:
            time_to_first_chunk_ms = round((entry.first_chunk_at - entry.started_at).total_seconds() * 1000)
        duration_ms = None
        if entry.started_at:
            duration_ms = round((entry.created_at - entry.started_at).total_seconds() * 1000)
        entries.append(AdminHistoryEntryResponse(
            id=str(entry.id),
            user_email=user.email,
            user_display_name=user.display_name,
            interview_title=interview.title,
            question=entry.question,
            answer=entry.answer,
            word_count=len(entry.answer.split()),
            reasoning_effort=entry.reasoning_effort,
            started_at=entry.started_at.isoformat() if entry.started_at else None,
            first_chunk_at=entry.first_chunk_at.isoformat() if entry.first_chunk_at else None,
            ended_at=entry.created_at.isoformat(),
            time_to_first_chunk_ms=time_to_first_chunk_ms,
            duration_ms=duration_ms,
        ))
    return entries
