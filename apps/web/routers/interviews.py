from typing import Literal, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from db.base import get_db
from db.models import Interview, InterviewSubject, Subject, User
from routers.auth import get_current_user
from services.qa_cache_service import invalidate_list

router = APIRouter(tags=["interviews"])

InterviewState = Literal["active", "completed", "archived"]


class SubjectResponse(BaseModel):
    id: str
    slug: str
    name: str
    status: str
    description: str


class CreateInterviewRequest(BaseModel):
    title: str
    subject_ids: list[UUID]

    @field_validator("subject_ids")
    @classmethod
    def _at_least_one(cls, v: list[UUID]) -> list[UUID]:
        if not v:
            raise ValueError("Select at least one subject")
        return v


class UpdateInterviewRequest(BaseModel):
    title: Optional[str] = None
    state: Optional[InterviewState] = None


class InterviewResponse(BaseModel):
    id: str
    title: str
    state: str
    subjects: list[SubjectResponse]
    created_at: str


def _subject_to_response(s: Subject) -> SubjectResponse:
    return SubjectResponse(id=str(s.id), slug=s.slug, name=s.name, status=s.status, description=s.description)


def _to_response(i: Interview, subjects: list[Subject]) -> InterviewResponse:
    return InterviewResponse(
        id=str(i.id), title=i.title, state=i.state,
        subjects=[_subject_to_response(s) for s in subjects],
        created_at=i.created_at.isoformat(),
    )


async def _load_subjects_map(db: AsyncSession, interview_ids: list[UUID]) -> dict[UUID, list[Subject]]:
    if not interview_ids:
        return {}
    rows = await db.execute(
        select(InterviewSubject.interview_id, Subject)
        .join(Subject, Subject.id == InterviewSubject.subject_id)
        .where(InterviewSubject.interview_id.in_(interview_ids))
    )
    out: dict[UUID, list[Subject]] = {}
    for interview_id, subject in rows:
        out.setdefault(interview_id, []).append(subject)
    return out


async def get_owned_interview(
    interview_id: UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Interview:
    interview = await db.get(Interview, interview_id)
    if not interview or interview.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Interview not found")
    return interview


async def get_interview_subject_ids(db: AsyncSession, interview_id: UUID) -> list[UUID]:
    result = await db.scalars(
        select(InterviewSubject.subject_id).where(InterviewSubject.interview_id == interview_id)
    )
    return list(result)


@router.get("/subjects", response_model=list[SubjectResponse])
async def list_subjects(_: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    result = await db.scalars(select(Subject).order_by(Subject.status, Subject.name))
    return [_subject_to_response(s) for s in result]


@router.post("/interviews", response_model=InterviewResponse)
async def create_interview(
    body: CreateInterviewRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    subject_ids = list(set(body.subject_ids))
    subjects = list(await db.scalars(select(Subject).where(Subject.id.in_(subject_ids))))
    if len(subjects) != len(subject_ids):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="One or more subjects don't exist")
    unavailable = [s.name for s in subjects if s.status != "available"]
    if unavailable:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"These subjects aren't available yet: {', '.join(unavailable)}",
        )

    interview = Interview(user_id=current_user.id, title=body.title)
    db.add(interview)
    await db.flush()
    for subject_id in subject_ids:
        db.add(InterviewSubject(interview_id=interview.id, subject_id=subject_id))
    await db.commit()
    await db.refresh(interview)
    return _to_response(interview, subjects)


@router.get("/interviews", response_model=list[InterviewResponse])
async def list_interviews(current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    interviews = list(await db.scalars(
        select(Interview).where(Interview.user_id == current_user.id).order_by(Interview.created_at.desc())
    ))
    subjects_map = await _load_subjects_map(db, [i.id for i in interviews])
    return [_to_response(i, subjects_map.get(i.id, [])) for i in interviews]


@router.get("/interviews/{interview_id}", response_model=InterviewResponse)
async def get_interview(interview: Interview = Depends(get_owned_interview), db: AsyncSession = Depends(get_db)):
    subjects_map = await _load_subjects_map(db, [interview.id])
    return _to_response(interview, subjects_map.get(interview.id, []))


@router.patch("/interviews/{interview_id}", response_model=InterviewResponse)
async def update_interview(
    body: UpdateInterviewRequest,
    interview: Interview = Depends(get_owned_interview),
    db: AsyncSession = Depends(get_db),
):
    if body.title is not None:
        interview.title = body.title
    if body.state is not None:
        interview.state = body.state
    await db.commit()
    await db.refresh(interview)
    subjects_map = await _load_subjects_map(db, [interview.id])
    return _to_response(interview, subjects_map.get(interview.id, []))


@router.delete("/interviews/{interview_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_interview(interview: Interview = Depends(get_owned_interview), db: AsyncSession = Depends(get_db)):
    # Materials/qa_entries/history_entries/interview_subjects cascade-delete via FK ondelete="CASCADE"
    await db.delete(interview)
    await db.commit()
    await invalidate_list(interview.id)
