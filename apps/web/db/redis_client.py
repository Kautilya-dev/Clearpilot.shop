import redis.asyncio as redis

from config import settings

# None when REDIS_URL isn't configured (e.g. some local dev setups) - callers treat a
# None client as "cache disabled," falling back to Postgres-only behavior.
redis_client: redis.Redis | None = redis.from_url(settings.redis_url, decode_responses=True) if settings.redis_url else None
