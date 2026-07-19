"""ABOUT THIS FILE
Lists, saves, and deletes an interview's HistoryEntry rows (Copilot Q&A + Prompter
sessions). Linked from:
- apps/web/pages/interview.html: GET here to render the Copilot tab's conversation replay
  and the Prompter tab's "Prompter History" view (filtered client-side by the
  PRACTICE_QUESTION_PREFIX-prefixed question text POST'd below).
- apps/web/routers/chat.py: writes Copilot Q&A rows directly via HistoryEntry, doesn't call
  this module's POST endpoint.
- apps/desktop/src/main/api-client.js's savePrompterSession(): the Desktop app's Prompter
  tab POSTs here once a session stops, so a session started from either the web Prompter tab
  or the Desktop app's Prompter tab ends up in the same reviewable history.
"""
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


class SavePrompterSessionRequest(BaseModel):
    web_transcript: str = ""
    ai_response: str = ""


# Prompter sessions (Desktop's Prompter tab, or a partner speaking into the web Prompter tab
# relayed there) aren't persisted anywhere else - unlike Copilot chat, which /chat/ask writes
# to HistoryEntry itself server-side, nothing calls this for that flow. Called by the Desktop
# app once a Prompter session stops (see api-client.js's savePrompterSession). Either field
# can be empty - e.g. the AI Generated Response panel was disabled the whole session, or no
# partner ever connected - only sections with real content are included in the saved answer.
# The "Practice session with partner" question prefix is unchanged from the pre-refactor
# schema so apps/web/pages/interview.html's Prompter History filter still matches these rows.
@router.post("/interviews/{interview_id}/history", response_model=HistoryEntryResponse)
async def save_prompter_session(
    body: SavePrompterSessionRequest,
    interview: Interview = Depends(get_owned_interview),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    question = f"Practice session with partner — {datetime.now(timezone.utc).isoformat()}"
    sections = []
    if body.web_transcript.strip():
        sections.append(f"**Web Prompter transcription:**\n{body.web_transcript.strip()}")
    if body.ai_response.strip():
        sections.append(f"**AI generated response:**\n{body.ai_response.strip()}")
    answer = "\n\n".join(sections) or "(No transcription or AI response was captured for this session.)"
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


# UPDATES LOG
# 2026-07-20 - Renamed SavePracticeRoundRequest -> SavePrompterSessionRequest and
#   save_practice_round -> save_prompter_session; fields changed from {partner_answer,
#   your_response, coach_feedback} to {web_transcript, ai_response} - the AI judge (mic
#   listening + comparison feedback) was removed from the Desktop app's Prompter tab
#   entirely, so there's no more candidate response or coach feedback to save, just the two
#   independent live panels (Web Prompter Transcription relay + AI Generated Response).
