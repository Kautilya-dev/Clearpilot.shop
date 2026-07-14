import json

import httpx

from config import settings

OPENAI_CHAT_MODEL = "gpt-5.4"

# Note: NOT using str.format() here - the literal JSON braces in the instructions below
# would collide with format()'s own {placeholder} syntax. Count is spliced in with a plain
# string replace on this one marker instead.
QUESTION_GEN_SYSTEM_PROMPT = """You generate a realistic list of SAP CPI interview questions an interviewer would ask THIS SPECIFIC candidate, based on the materials below - their resume (roles & responsibilities) and, if given, a sample work project and target job description.

Cover the roles/responsibilities and project details in roughly the same order they're presented in the resume, favoring depth on what's actually listed over generic textbook questions. Mix technical questions (adapters, mappings, security, error handling, Groovy) with experience/behavioral ones ("tell me about a time...", "why did you...") that this candidate's own background would naturally prompt.

Respond with ONLY a JSON object in this exact shape: {"questions": ["question 1", "question 2", ...]} - exactly __COUNT__ questions, no other text."""


async def generate_likely_questions(resume_text: str, jd_text: str, scenario_text: str, count: int = 15) -> list[str]:
    resume_section = f"RESUME (roles & responsibilities):\n{resume_text}\n\n" if resume_text else ""
    jd_section = f"TARGET ROLE (job description):\n{jd_text}\n\n" if jd_text else ""
    scenario_section = f"SAMPLE WORK PROJECT:\n{scenario_text}\n\n" if scenario_text else ""
    user_message = (
        f"{resume_section}{jd_section}{scenario_section}".strip()
        or "No materials were provided - generate general SAP CPI interview questions."
    )

    async with httpx.AsyncClient(timeout=45.0) as client:
        response = await client.post(
            "https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {settings.openai_api_key}", "Content-Type": "application/json"},
            json={
                "model": OPENAI_CHAT_MODEL,
                "messages": [
                    {"role": "system", "content": QUESTION_GEN_SYSTEM_PROMPT.replace("__COUNT__", str(count))},
                    {"role": "user", "content": user_message},
                ],
                "response_format": {"type": "json_object"},
            },
        )
        response.raise_for_status()
        content = response.json()["choices"][0]["message"]["content"]

    try:
        parsed = json.loads(content)
        questions = parsed.get("questions") or []
    except (json.JSONDecodeError, AttributeError):
        return []
    return [str(q).strip() for q in questions if str(q).strip()]
