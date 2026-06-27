from typing import Literal

import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from db.models import Interview, User
from routers.auth import get_current_user
from routers.interviews import get_owned_interview
from services.realtime_token_service import (
    MIC_INSTRUCTIONS,
    REALTIME_MODEL,
    SPEAKER_INSTRUCTIONS,
    mint_ephemeral_token,
)

router = APIRouter(tags=["realtime"])


class RealtimeTokenRequest(BaseModel):
    source: Literal["speaker", "mic"]


class RealtimeTokenResponse(BaseModel):
    client_secret: str
    expires_at: str
    model: str


@router.post("/interviews/{interview_id}/realtime-token", response_model=RealtimeTokenResponse)
async def mint_realtime_token(
    body: RealtimeTokenRequest,
    interview: Interview = Depends(get_owned_interview),
    current_user: User = Depends(get_current_user),
):
    instructions = SPEAKER_INSTRUCTIONS if body.source == "speaker" else MIC_INSTRUCTIONS
    try:
        result = await mint_ephemeral_token(instructions)
    except httpx.HTTPError as e:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"Could not start realtime session: {e}")
    return RealtimeTokenResponse(
        client_secret=result["value"], expires_at=result["expires_at"], model=REALTIME_MODEL
    )
