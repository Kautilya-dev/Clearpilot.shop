import asyncio
import json
import uuid as uuid_lib
from typing import Literal
from uuid import UUID

import jwt
from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect

from db.base import SessionLocal
from db.models import Interview
from db.redis_client import redis_client
from services.auth_service import decode_access_token

router = APIRouter(tags=["practice"])


async def _owns_interview(user_id: UUID, interview_id: UUID) -> bool:
    async with SessionLocal() as db:
        interview = await db.get(Interview, interview_id)
        return interview is not None and interview.user_id == user_id


# Relays live text between two Desktop/web clients practicing the same interview together -
# Person 1 (web app "Prompter" tab) speaks the answer, Person 2 (Desktop Job Mode) judges it.
# Auth can't use the normal Depends(get_current_user)/HTTPBearer path here since a raw WS
# client can't reliably set request headers at connect time - the JWT travels as a query
# param instead and is decoded manually, same token either side already holds.
#
# Uses Redis Pub/Sub rather than an in-memory registry so the relay is correct even if this
# backend ever runs multiple worker processes/replicas (e.g. on Railway) - two sockets on
# different processes would otherwise never see each other.
@router.websocket("/practice-relay/ws")
async def practice_relay(
    websocket: WebSocket,
    interview_id: UUID = Query(...),
    role: Literal["host", "guest"] = Query(...),
    token: str = Query(...),
):
    await websocket.accept()

    try:
        user_id = decode_access_token(token)
    except jwt.PyJWTError:
        await websocket.close(code=4401)
        return
    if not await _owns_interview(user_id, interview_id):
        await websocket.close(code=4403)
        return
    if redis_client is None:
        await websocket.close(code=1013)
        return

    conn_id = uuid_lib.uuid4().hex
    channel = f"practice_relay:{interview_id}"
    pubsub = redis_client.pubsub()
    await pubsub.subscribe(channel)

    async def relay_from_redis():
        async for message in pubsub.listen():
            if message["type"] != "message":
                continue
            payload = json.loads(message["data"])
            if payload.get("conn_id") == conn_id:
                continue  # don't echo a connection's own publishes back to itself
            await websocket.send_text(json.dumps(payload))

    async def relay_from_client():
        try:
            while True:
                raw = await websocket.receive_text()
                incoming = json.loads(raw)
                incoming["from"] = role
                incoming["conn_id"] = conn_id
                await redis_client.publish(channel, json.dumps(incoming))
        except WebSocketDisconnect:
            return

    await redis_client.publish(channel, json.dumps({"type": f"{role}_joined", "from": role, "conn_id": conn_id}))
    reader = asyncio.create_task(relay_from_redis())
    writer = asyncio.create_task(relay_from_client())
    try:
        await asyncio.wait({reader, writer}, return_when=asyncio.FIRST_COMPLETED)
    finally:
        reader.cancel()
        writer.cancel()
        await pubsub.unsubscribe(channel)
        await pubsub.close()
        await redis_client.publish(channel, json.dumps({"type": f"{role}_left", "from": role, "conn_id": conn_id}))
