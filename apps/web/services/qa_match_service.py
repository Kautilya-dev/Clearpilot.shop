from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from services.text_relevance_service import has_enough_substantive_terms


class QAMatch:
    def __init__(self, id: UUID, question: str, answer: str):
        self.id = id
        self.question = question
        self.answer = answer


async def find_matching_qa(db: AsyncSession, interview_id: UUID, question: str) -> QAMatch | None:
    """Full-text match against this interview's own saved Q&A bank - same to_tsvector/
    websearch_to_tsquery technique used for document retrieval, just computed on the fly
    (no persisted column/index) since qa_entries is small once scoped to one interview.
    A hit here skips the OpenAI call entirely: instant, free, and zero hallucination risk
    since it's the user's own vetted answer. See has_enough_substantive_terms for why a
    minimum-term gate is required before attempting this - a wrong answer served with full
    confidence is worse than the extra AI call the gate sometimes costs.
    """
    if not await has_enough_substantive_terms(db, question):
        return None

    result = await db.execute(
        text(
            """
            SELECT id, question, answer,
                   ts_rank(to_tsvector('english', question), websearch_to_tsquery('english', :q)) AS rank
            FROM qa_entries
            WHERE interview_id = :interview_id
              AND to_tsvector('english', question) @@ websearch_to_tsquery('english', :q)
            ORDER BY rank DESC
            LIMIT 1
            """
        ),
        {"q": question, "interview_id": interview_id},
    )
    row = result.first()
    if not row:
        return None
    return QAMatch(id=row.id, question=row.question, answer=row.answer)
