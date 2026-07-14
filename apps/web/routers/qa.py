import asyncio
from typing import Optional
from uuid import UUID

import httpx
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from db.base import SessionLocal, get_db
from db.models import Interview, QAEntry, User
from routers.auth import get_current_user
from routers.interviews import get_interview_subject_ids, get_owned_interview
from services.file_extract_service import extract_text
from services.qa_cache_service import get_cached_list, invalidate_list, set_cached_list
from services.qa_classify_service import Classification, classify_qa
from services.qa_parse_service import parse_qa_pairs
from services.qa_prepare_service import generate_likely_questions, generate_palette_scenario_questions
from services.rag_service import build_system_prompt, generate_answer, get_active_material, retrieve_relevant_docs

router = APIRouter(tags=["qa"])

_MAX_PAIRS_PER_UPLOAD = 50
_CLASSIFY_CONCURRENCY = 5
_PREPARE_CONCURRENCY = 5
_DEFAULT_PREPARE_COUNT = 15
_MAX_PREPARE_COUNT = 30
# Palette scenarios are pre-generated for later recall, not streamed live under time
# pressure, so they're worth the fuller comprehensive treatment regardless of the
# user's live-chat format preference - it's also the only combination that reliably
# emits the labeled Example/Practical nuance/Design approach/Short answer sections the
# answer-nav UI needs to build a jump nav (see rag_service.py's STAR_DETAILED_LENGTH_INSTRUCTIONS).
_PALETTE_ANSWER_FORMAT = "star"
_PALETTE_ANSWER_LENGTH = "one_minute"


class CreateQAEntryRequest(BaseModel):
    question: str
    answer: str


class UpdateQAEntryRequest(BaseModel):
    question: Optional[str] = None
    answer: Optional[str] = None


class QAEntryResponse(BaseModel):
    id: str
    question: str
    answer: str
    category: str
    tags: str
    use_count: int
    auto_generated: bool
    created_at: str


def _to_response(e: QAEntry) -> QAEntryResponse:
    return QAEntryResponse(
        id=str(e.id), question=e.question, answer=e.answer, category=e.category,
        tags=e.tags, use_count=e.use_count, auto_generated=e.auto_generated, created_at=e.created_at.isoformat(),
    )


async def _classify_or_fallback(question: str, answer: str) -> Classification:
    # Category/tags are a nice-to-have organizational layer, not the point of saving the
    # entry - if the AI call fails, save with empty category/tags rather than blocking it.
    try:
        return await classify_qa(question, answer)
    except (httpx.HTTPError, ValueError, KeyError):
        return Classification(category="", tags="")


async def _classify_many(pairs: list[tuple[str, str]]) -> list[Classification]:
    semaphore = asyncio.Semaphore(_CLASSIFY_CONCURRENCY)

    async def _one(question: str, answer: str) -> Classification:
        async with semaphore:
            return await _classify_or_fallback(question, answer)

    return await asyncio.gather(*(_one(q, a) for q, a in pairs))


async def _get_owned_entry(entry_id: UUID, interview: Interview, db: AsyncSession) -> QAEntry:
    entry = await db.get(QAEntry, entry_id)
    if not entry or entry.interview_id != interview.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Q&A entry not found")
    return entry


@router.post("/interviews/{interview_id}/qa", response_model=QAEntryResponse)
async def create_entry(
    body: CreateQAEntryRequest,
    interview: Interview = Depends(get_owned_interview),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    classification = await _classify_or_fallback(body.question, body.answer)
    entry = QAEntry(
        user_id=current_user.id, interview_id=interview.id, question=body.question, answer=body.answer,
        category=classification.category, tags=classification.tags,
    )
    db.add(entry)
    await db.commit()
    await db.refresh(entry)
    await invalidate_list(interview.id)
    return _to_response(entry)


@router.post("/interviews/{interview_id}/qa/upload", response_model=list[QAEntryResponse])
async def upload_qa(
    file: UploadFile = File(...),
    interview: Interview = Depends(get_owned_interview),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    content = await file.read()
    if not content:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Uploaded file is empty")
    text = extract_text(file.filename or "", content)

    pairs = parse_qa_pairs(text)
    if not pairs:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No Q&A pairs found - format each pair as 'Q: ...' followed by 'A: ...'.",
        )
    if len(pairs) > _MAX_PAIRS_PER_UPLOAD:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Found {len(pairs)} pairs - max {_MAX_PAIRS_PER_UPLOAD} per upload. Split into smaller files.",
        )

    classifications = await _classify_many(pairs)
    entries = [
        QAEntry(
            user_id=current_user.id, interview_id=interview.id, question=question, answer=answer,
            category=classification.category, tags=classification.tags,
        )
        for (question, answer), classification in zip(pairs, classifications)
    ]
    db.add_all(entries)
    await db.commit()
    for entry in entries:
        await db.refresh(entry)
    await invalidate_list(interview.id)
    return [_to_response(e) for e in entries]


class PrepareQARequest(BaseModel):
    count: int = _DEFAULT_PREPARE_COUNT
    # "general": likely questions across the whole resume/JD/scenario. "palette_scenarios":
    # one complex, scenario-grounded question per CPI palette option (Content Modifier,
    # Splitter, Router, ...) - see qa_prepare_service.generate_palette_scenario_questions.
    mode: str = "general"


class PrepareQAResponse(BaseModel):
    prepared_count: int
    entries: list[QAEntryResponse]


@router.post("/interviews/{interview_id}/qa/prepare", response_model=PrepareQAResponse)
async def prepare_qa(
    body: PrepareQARequest,
    interview: Interview = Depends(get_owned_interview),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Pre-generates interview questions and a full, grounded answer for each - saved into
    the Q&A bank as auto_generated=True so a live question that matches gets served
    near-instantly (see routers/chat.py's fast path) instead of waiting on a fresh
    generation. Two modes: "general" covers the whole resume/JD/scenario broadly;
    "palette_scenarios" generates one complex, scenario-based question per CPI palette
    option, grounded in the real-time material, for fast recall on design-under-a-twist
    questions specifically.
    """
    resume = await get_active_material(db, interview.id, "resume")
    jd = await get_active_material(db, interview.id, "job_description")
    scenario = await get_active_material(db, interview.id, "real_time_scenario")

    palette_mode = body.mode == "palette_scenarios"
    if palette_mode:
        if not scenario:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Add a sample work project (real-time material) first - palette scenarios are grounded in it.",
            )
        pairs = await generate_palette_scenario_questions(
            resume.text if resume else "", jd.text if jd else "", scenario.text
        )
        if not pairs:
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Could not generate scenarios - try again.")
    else:
        if not resume and not scenario:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Add a resume or sample work project first - nothing to prepare questions from.",
            )
        count = max(1, min(body.count, _MAX_PREPARE_COUNT))
        questions = await generate_likely_questions(
            resume.text if resume else "", jd.text if jd else "", scenario.text if scenario else "", count=count
        )
        if not questions:
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Could not generate questions - try again.")
        pairs = [("", q) for q in questions]

    semaphore = asyncio.Semaphore(_PREPARE_CONCURRENCY)

    async def _prepare_one(palette: str, question: str) -> QAEntry | None:
        async with semaphore:
            # Own session per concurrent task - a single AsyncSession can't handle concurrent
            # operations (see routers/admin.py's evaluate_history for the same fix).
            async with SessionLocal() as task_db:
                subject_ids = await get_interview_subject_ids(task_db, interview.id)
                doc_chunks = await retrieve_relevant_docs(task_db, question, subject_ids)
            format_mode, answer_length = (
                (_PALETTE_ANSWER_FORMAT, _PALETTE_ANSWER_LENGTH)
                if palette_mode
                else (current_user.answer_format_mode, current_user.answer_length)
            )
            system_prompt = build_system_prompt(resume, jd, scenario, doc_chunks, format_mode, answer_length)
            try:
                answer = await generate_answer(system_prompt, question)
            except httpx.HTTPError:
                return None
            classification = await _classify_or_fallback(question, answer)
            tags = f"{classification.tags},{palette}" if palette and classification.tags else (palette or classification.tags)
            return QAEntry(
                user_id=current_user.id, interview_id=interview.id, question=question, answer=answer,
                category=classification.category, tags=tags, auto_generated=True,
            )

    results = await asyncio.gather(*(_prepare_one(palette, q) for palette, q in pairs))
    entries = [e for e in results if e is not None]
    if not entries:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Could not generate any answers - try again.")

    db.add_all(entries)
    await db.commit()
    for entry in entries:
        await db.refresh(entry)
    await invalidate_list(interview.id)
    return PrepareQAResponse(prepared_count=len(entries), entries=[_to_response(e) for e in entries])


@router.get("/interviews/{interview_id}/qa", response_model=list[QAEntryResponse])
async def list_entries(
    category: Optional[str] = None,
    search: Optional[str] = None,
    interview: Interview = Depends(get_owned_interview),
    db: AsyncSession = Depends(get_db),
):
    # Only the unfiltered "load everything" case is cached - category/search are ad hoc
    # query shapes that aren't worth a cache key each.
    cacheable = not category and not search
    if cacheable:
        cached = await get_cached_list(interview.id)
        if cached is not None:
            return cached

    query = select(QAEntry).where(QAEntry.interview_id == interview.id)
    if category:
        query = query.where(QAEntry.category == category)
    if search:
        query = query.where(QAEntry.question.ilike(f"%{search}%"))
    query = query.order_by(QAEntry.created_at.desc())
    result = await db.scalars(query)
    responses = [_to_response(e) for e in result]

    if cacheable:
        await set_cached_list(interview.id, [r.model_dump() for r in responses])
    return responses


@router.patch("/interviews/{interview_id}/qa/{entry_id}", response_model=QAEntryResponse)
async def update_entry(
    entry_id: UUID,
    body: UpdateQAEntryRequest,
    interview: Interview = Depends(get_owned_interview),
    db: AsyncSession = Depends(get_db),
):
    entry = await _get_owned_entry(entry_id, interview, db)
    if body.question is not None:
        entry.question = body.question
    if body.answer is not None:
        entry.answer = body.answer
    if body.question is not None or body.answer is not None:
        classification = await _classify_or_fallback(entry.question, entry.answer)
        entry.category = classification.category
        entry.tags = classification.tags
    await db.commit()
    await db.refresh(entry)
    await invalidate_list(interview.id)
    return _to_response(entry)


@router.delete("/interviews/{interview_id}/qa/{entry_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_entry(
    entry_id: UUID, interview: Interview = Depends(get_owned_interview), db: AsyncSession = Depends(get_db)
):
    entry = await _get_owned_entry(entry_id, interview, db)
    await db.delete(entry)
    await db.commit()
    await invalidate_list(interview.id)
