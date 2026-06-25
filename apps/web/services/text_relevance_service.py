from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

MIN_SUBSTANTIVE_TERMS = 2


async def has_enough_substantive_terms(db: AsyncSession, query: str, minimum: int = MIN_SUBSTANTIVE_TERMS) -> bool:
    """True if `query` reduces to at least `minimum` non-stopword lexemes under Postgres's
    english text-search config. Guards every full-text @@ match in this app against short,
    mostly-stopword input (e.g. "Tell me about yourself" -> just "tell" survives) silently
    matching an unrelated row that happens to share that one common word - confirmed live
    against both the Q&A-bank shortcut and document retrieval."""
    term_count = await db.scalar(
        text("SELECT coalesce(array_length(tsvector_to_array(to_tsvector('english', :q)), 1), 0)"),
        {"q": query},
    )
    return term_count >= minimum
