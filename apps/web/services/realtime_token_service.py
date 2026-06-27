import httpx

from config import settings

REALTIME_MODEL = "gpt-realtime-2"
_CLIENT_SECRET_TTL_SECONDS = 10 * 60  # default is 1 minute - too short for a full WS handshake under load

SPEAKER_INSTRUCTIONS = (
    "You are a silent transcription assistant listening to an interviewer's spoken questions. "
    "Your ONLY job is to transcribe the audio you hear into English text. Do NOT respond, do NOT generate answers."
)
MIC_INSTRUCTIONS = (
    "You are a silent transcription assistant listening to a candidate's spoken voice. "
    "Your ONLY job is to transcribe the audio you hear into English text. Do NOT respond, do NOT generate answers."
)


async def mint_ephemeral_token(instructions: str) -> dict:
    """Mints a short-lived client secret the desktop app can use to connect directly to
    OpenAI's Realtime API without ever holding the real server-side API key. See
    https://platform.openai.com/docs/api-reference/realtime-sessions/create-realtime-client-secret.
    """
    print(f"[realtime] minting client secret, key configured: {bool(settings.openai_api_key)}")
    async with httpx.AsyncClient(timeout=10.0) as client:
        try:
            response = await client.post(
                "https://api.openai.com/v1/realtime/client_secrets",
                headers={"Authorization": f"Bearer {settings.openai_api_key}", "Content-Type": "application/json"},
                json={
                    "expires_after": {"anchor": "created_at", "seconds": _CLIENT_SECRET_TTL_SECONDS},
                    "session": {
                        "type": "realtime",
                        "model": REALTIME_MODEL,
                        "instructions": instructions,
                        "output_modalities": ["text"],
                    },
                },
            )
        except httpx.HTTPError as e:
            print(f"[realtime] request to OpenAI failed before a response came back: {e!r}")
            raise
        print(f"[realtime] OpenAI responded {response.status_code}: {response.text[:500]}")
        response.raise_for_status()
        return response.json()
