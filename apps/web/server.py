from pathlib import Path

import asyncpg
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from config import settings
from routers import auth, pages

_STATIC_DIR = Path(__file__).resolve().parent / "static"

app = FastAPI(title="ClearPilot API")
app.include_router(auth.router)
app.include_router(pages.router)
app.mount("/assets", StaticFiles(directory=_STATIC_DIR), name="assets")


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
