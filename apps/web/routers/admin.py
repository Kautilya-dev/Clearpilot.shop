import asyncio
from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from db.base import SessionLocal, get_db
from db.models import HistoryEntry, Interview, User
from routers.auth import get_current_user
from routers.interviews import get_interview_subject_ids
from services.answer_quality_service import evaluate_answer, evaluate_consistency
from services.rag_service import retrieve_relevant_docs

router = APIRouter(prefix="/admin", tags=["admin"])

# Must match apps/web/routers/history.py's savePracticeHistoryEntry prefix - practice-round
# feedback entries aren't topic Q&A, so they're excluded from grounding/logic/consistency
# evaluation (there's no "reference material" question to ground them against).
_PRACTICE_QUESTION_PREFIX = "Practice session with partner"


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
    grounding_score: int | None  # 0-10, null until POST /admin/history/evaluate runs
    logic_score: int | None
    eval_notes: str | None


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
            grounding_score=entry.grounding_score,
            logic_score=entry.logic_score,
            eval_notes=entry.eval_notes,
        ))
    return entries


class ConsistencyGroup(BaseModel):
    question: str
    answer_count: int
    consistency_score: int | None
    notes: str | None


class EvaluateResponse(BaseModel):
    evaluated_count: int
    consistency_groups: list[ConsistencyGroup]


@router.post("/history/evaluate", response_model=EvaluateResponse)
async def evaluate_history(_: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    """Scores every not-yet-scored, non-practice-round history entry for grounding + logic,
    then groups entries by identical question text and scores cross-run consistency for any
    question with 2+ independently-generated answers (e.g. the same question asked at
    different reasoning_effort settings)."""
    unscored = (
        await db.scalars(
            select(HistoryEntry).where(
                HistoryEntry.grounding_score.is_(None),
                ~HistoryEntry.question.startswith(_PRACTICE_QUESTION_PREFIX),
            )
        )
    ).all()

    async def score_one(entry: HistoryEntry):
        # A single AsyncSession can't run concurrent operations - each concurrent task gets
        # its own session for the read-only retrieval, then sets plain attributes on `entry`
        # (no DB I/O, safe from any coroutine) for the original session to commit afterward.
        async with SessionLocal() as task_db:
            subject_ids = await get_interview_subject_ids(task_db, entry.interview_id)
            doc_chunks = await retrieve_relevant_docs(task_db, entry.question, subject_ids)
        reference_text = "\n\n".join(c.text for c in doc_chunks)
        result = await evaluate_answer(entry.question, entry.answer, reference_text)
        entry.grounding_score = result["grounding_score"]
        entry.logic_score = result["logic_score"]
        entry.eval_notes = result["eval_notes"]

    await asyncio.gather(*(score_one(e) for e in unscored))
    await db.commit()

    # Consistency: group ALL non-practice entries (not just newly-scored ones) by question text.
    all_entries = (
        await db.scalars(
            select(HistoryEntry).where(~HistoryEntry.question.startswith(_PRACTICE_QUESTION_PREFIX))
        )
    ).all()
    by_question = defaultdict(list)
    for e in all_entries:
        by_question[e.question].append(e.answer)

    groups_to_check = {q: answers for q, answers in by_question.items() if len(answers) >= 2}
    consistency_results = await asyncio.gather(
        *(evaluate_consistency(q, answers) for q, answers in groups_to_check.items())
    )
    consistency_groups = [
        ConsistencyGroup(
            question=q,
            answer_count=len(answers),
            consistency_score=result["consistency_score"],
            notes=result["notes"],
        )
        for (q, answers), result in zip(groups_to_check.items(), consistency_results)
    ]

    return EvaluateResponse(evaluated_count=len(unscored), consistency_groups=consistency_groups)
