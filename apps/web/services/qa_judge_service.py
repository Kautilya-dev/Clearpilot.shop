import httpx

from config import settings
from db.models import Material
from services.qa_match_service import QAMatch

OPENAI_CHAT_MODEL = "gpt-5.4"

NO_MATCH_SENTINEL = "NO_MATCH"

JUDGE_SYSTEM_PROMPT = f"""You decide whether a candidate's saved Q&A answer can be reused for a newly asked interview question, personalizing it with their resume/job description/scenarios if needed.

The saved Q&A pair below matched the question by keyword search - that match may be coincidental, not actually relevant.

1. If the saved answer does NOT actually address what's being asked, respond with exactly: {NO_MATCH_SENTINEL}
2. If it DOES address the question and is already personal/specific (uses "I", concrete details), return it verbatim, unchanged.
3. If it's on-topic but generic (a textbook explanation, or references "your project"/"your experience" without real specifics), rewrite it briefly in first person using the resume/scenario details actually provided below, keeping the same core technical facts as the saved answer.

Respond with ONLY the final answer text, or exactly {NO_MATCH_SENTINEL}. No preamble, no labels, no explanation."""


async def judge_and_maybe_answer(
    question: str, candidate: QAMatch, resume: Material | None, jd: Material | None, scenario: Material | None
) -> str | None:
    """Returns the answer to use (verbatim or personalized), or None if the keyword-matched
    candidate doesn't actually address the question - signaling the caller to fall through
    to full RAG-grounded generation instead."""
    resume_section = f"\nCANDIDATE'S RESUME:\n{resume.text}\n" if resume else ""
    jd_section = f"\nTARGET ROLE (job description):\n{jd.text}\n" if jd else ""
    scenario_section = f"\nREAL-TIME SCENARIOS:\n{scenario.text}\n" if scenario else ""

    user_message = (
        f"Question just asked: {question}\n\n"
        f"Saved Q&A candidate:\nQ: {candidate.question}\nA: {candidate.answer}\n"
        f"{resume_section}{jd_section}{scenario_section}"
    )

    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(
            "https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {settings.openai_api_key}", "Content-Type": "application/json"},
            json={
                "model": OPENAI_CHAT_MODEL,
                "messages": [
                    {"role": "system", "content": JUDGE_SYSTEM_PROMPT},
                    {"role": "user", "content": user_message},
                ],
            },
        )
        response.raise_for_status()
        text_out = response.json()["choices"][0]["message"]["content"].strip()

    if not text_out or text_out == NO_MATCH_SENTINEL:
        return None
    return text_out
