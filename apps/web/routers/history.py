import json
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from db.base import get_db
from db.models import HistoryEntry, User
from routers.auth import get_current_user

router = APIRouter(prefix="/history", tags=["history"])


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


@router.get("", response_model=list[HistoryEntryResponse])
async def list_history(
    limit: int = 50, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    result = await db.scalars(
        select(HistoryEntry)
        .where(HistoryEntry.user_id == current_user.id)
        .order_by(HistoryEntry.created_at.desc())
        .limit(min(limit, 200))
    )
    return [_to_response(e) for e in result]


@router.delete("/{entry_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_history_entry(
    entry_id: UUID, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    entry = await db.get(HistoryEntry, entry_id)
    if not entry or entry.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="History entry not found")
    await db.delete(entry)
    await db.commit()


@router.delete("", status_code=status.HTTP_204_NO_CONTENT)
async def clear_history(current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    result = await db.scalars(select(HistoryEntry).where(HistoryEntry.user_id == current_user.id))
    for entry in result:
        await db.delete(entry)
    await db.commit()
