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
    async with httpx.AsyncClient(timeout=10.0) as client:
        response = await client.post(
            "https://api.openai.com/v1/realtime/client_secrets",
            headers={"Authorization": f"Bearer {settings.openai_api_key}", "Content-Type": "application/json"},
            json={
                "modalities": ["text"],
                "instructions": instructions,
                "input_audio_format": "pcm16",
                "input_audio_transcription": {"model": "whisper-1"},
                "expires_after": {"anchor": "created_at", "seconds": _CLIENT_SECRET_TTL_SECONDS},
            },
        )
        response.raise_for_status()
        return response.json()
