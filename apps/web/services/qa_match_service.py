from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession


class QAMatch:
    def __init__(self, id: UUID, question: str, answer: str):
        self.id = id
        self.question = question
        self.answer = answer


_MIN_SUBSTANTIVE_TERMS = 2


async def find_matching_qa(db: AsyncSession, interview_id: UUID, question: str) -> QAMatch | None:
    """Full-text match against this interview's own saved Q&A bank - same to_tsvector/
    websearch_to_tsquery technique used for document retrieval, just computed on the fly
    (no persisted column/index) since qa_entries is small once scoped to one interview.
    A hit here skips the OpenAI call entirely: instant, free, and zero hallucination risk
    since it's the user's own vetted answer.

    Requires at least 2 substantive (non-stopword) terms in the asked question before
    attempting a match. websearch_to_tsquery ANDs distinct terms together, so without
    this gate a short question like "Tell me about yourself" can reduce to a single
    common surviving word ("tell") and confidently "match" a completely unrelated saved
    entry that happens to share that one word - confirmed live: it matched "Can you tell
    me about the SFTP parameters?" A wrong answer served with full confidence is worse
    than the extra AI call this gate sometimes costs on legitimately short questions.
    """
    term_count = await db.scalar(
        text("SELECT coalesce(array_length(tsvector_to_array(to_tsvector('english', :q)), 1), 0)"),
        {"q": question},
    )
    if term_count < _MIN_SUBSTANTIVE_TERMS:
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
