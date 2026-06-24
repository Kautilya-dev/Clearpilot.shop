import os

import asyncpg
from fastapi import FastAPI

app = FastAPI(title="ClearPilot API")


@app.get("/")
async def root():
    return {"service": "clearpilot-web", "status": "ok"}


@app.get("/health")
async def health():
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        return {"status": "ok", "database": "not configured"}

    try:
        conn = await asyncpg.connect(database_url)
        await conn.execute("SELECT 1")
        await conn.close()
        return {"status": "ok", "database": "connected"}
    except Exception as e:
        return {"status": "degraded", "database": f"error: {e}"}
