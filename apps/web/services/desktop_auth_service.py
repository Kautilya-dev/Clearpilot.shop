import secrets
from uuid import UUID

from db.redis_client import redis_client

# Short-lived, single-use handoff code: the desktop app opens the browser to log in,
# the browser mints this code and redirects to clearpilot://auth-callback?code=..., and
# the desktop app exchanges it server-side for a real JWT. The JWT itself never transits
# a URL or browser history - only this opaque, 5-minute, one-time code does.
_CODE_TTL_SECONDS = 300
_KEY_PREFIX = "desktop_auth_code:"


async def create_desktop_code(user_id: UUID) -> str:
    if redis_client is None:
        raise RuntimeError("Desktop sign-in requires Redis, which isn't configured")
    code = secrets.token_urlsafe(32)
    await redis_client.set(f"{_KEY_PREFIX}{code}", str(user_id), ex=_CODE_TTL_SECONDS)
    return code


async def consume_desktop_code(code: str) -> UUID | None:
    if redis_client is None:
        return None
    key = f"{_KEY_PREFIX}{code}"
    user_id = await redis_client.get(key)
    if user_id is None:
        return None
    await redis_client.delete(key)  # single-use
    return UUID(user_id)
