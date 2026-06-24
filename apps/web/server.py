import asyncpg
from fastapi import FastAPI

from config import settings
from routers import auth

app = FastAPI(title="ClearPilot API")
app.include_router(auth.router)


@app.get("/")
async def root():
    return {"service": "clearpilot-web", "status": "ok"}


@app.get("/health")
async def health():
    if not settings.database_url:
        return {"status": "ok", "database": "not configured"}

    try:
        conn = await asyncpg.connect(settings.database_url)
        await conn.execute("SELECT 1")
        await conn.close()
        return {"status": "ok", "database": "connected"}
    except Exception as e:
        return {"status": "degraded", "database": f"error: {e}"}
