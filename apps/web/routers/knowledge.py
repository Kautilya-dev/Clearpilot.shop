from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from db.base import get_db
from db.models import KnowledgeBaseEntry, User
from routers.auth import get_current_user

router = APIRouter(prefix="/knowledge", tags=["knowledge"])


class CreateKBEntryRequest(BaseModel):
    question: str
    answer: str
    category: str = ""
    tags: str = ""


class UpdateKBEntryRequest(BaseModel):
    question: Optional[str] = None
    answer: Optional[str] = None
    category: Optional[str] = None
    tags: Optional[str] = None


class KBEntryResponse(BaseModel):
    id: str
    question: str
    answer: str
    category: str
    tags: str
    use_count: int
    created_at: str


def _to_response(e: KnowledgeBaseEntry) -> KBEntryResponse:
    return KBEntryResponse(
        id=str(e.id), question=e.question, answer=e.answer, category=e.category,
        tags=e.tags, use_count=e.use_count, created_at=e.created_at.isoformat(),
    )


async def _get_owned_entry(entry_id: UUID, current_user: User, db: AsyncSession) -> KnowledgeBaseEntry:
    entry = await db.get(KnowledgeBaseEntry, entry_id)
    if not entry or entry.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Knowledge base entry not found")
    return entry


@router.post("", response_model=KBEntryResponse)
async def create_entry(
    body: CreateKBEntryRequest, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    entry = KnowledgeBaseEntry(
        user_id=current_user.id, question=body.question, answer=body.answer, category=body.category, tags=body.tags
    )
    db.add(entry)
    await db.commit()
    await db.refresh(entry)
    return _to_response(entry)


@router.get("", response_model=list[KBEntryResponse])
async def list_entries(
    category: Optional[str] = None,
    search: Optional[str] = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    query = select(KnowledgeBaseEntry).where(KnowledgeBaseEntry.user_id == current_user.id)
    if category:
        query = query.where(KnowledgeBaseEntry.category == category)
    if search:
        query = query.where(KnowledgeBaseEntry.question.ilike(f"%{search}%"))
    query = query.order_by(KnowledgeBaseEntry.created_at.desc())
    result = await db.scalars(query)
    return [_to_response(e) for e in result]


@router.patch("/{entry_id}", response_model=KBEntryResponse)
async def update_entry(
    entry_id: UUID,
    body: UpdateKBEntryRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    entry = await _get_owned_entry(entry_id, current_user, db)
    if body.question is not None:
        entry.question = body.question
    if body.answer is not None:
        entry.answer = body.answer
    if body.category is not None:
        entry.category = body.category
    if body.tags is not None:
        entry.tags = body.tags
    await db.commit()
    await db.refresh(entry)
    return _to_response(entry)


@router.delete("/{entry_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_entry(
    entry_id: UUID, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    entry = await _get_owned_entry(entry_id, current_user, db)
    await db.delete(entry)
    await db.commit()
