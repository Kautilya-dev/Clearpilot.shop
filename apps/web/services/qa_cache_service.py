import json
from uuid import UUID

from db.redis_client import redis_client

_TTL_SECONDS = 60 * 60  # safety net only - explicit invalidation on writes is the primary mechanism


def _key(interview_id: UUID) -> str:
    return f"qa_list:{interview_id}"


async def get_cached_list(interview_id: UUID) -> list[dict] | None:
    if redis_client is None:
        return None
    raw = await redis_client.get(_key(interview_id))
    return json.loads(raw) if raw is not None else None


async def set_cached_list(interview_id: UUID, entries: list[dict]) -> None:
    if redis_client is None:
        return
    await redis_client.set(_key(interview_id), json.dumps(entries), ex=_TTL_SECONDS)


async def invalidate_list(interview_id: UUID) -> None:
    if redis_client is None:
        return
    await redis_client.delete(_key(interview_id))
