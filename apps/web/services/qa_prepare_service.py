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


# One question per CPI palette option, covering the step types real interviewers actually
# probe on (confirmed against the 18 real transcripts reviewed this session) - broad enough
# to give near-instant Q&A-bank coverage across a live interview's likely scenario questions
# without generating so many that prep takes too long or the list becomes unscannable.
CPI_PALETTE_OPTIONS = [
    "Content Modifier",
    "Splitter (General vs Iterating)",
    "Aggregator",
    "Router",
    "Content Enricher / Poll Enrich",
    "Filter",
    "Message Mapping (Graphical Mapping)",
    "Groovy Script",
    "JMS Adapter / Queue",
    "Data Store Operations",
    "Exception Subprocess",
    "Multicast",
    "Join / Gather",
    "Encoder/Decoder (Base64, PGP)",
    "Converter (XML/JSON/CSV)",
    "SFTP Adapter",
    "OData Adapter",
    "SOAP Adapter",
    "IDoc Adapter",
]

# Note: NOT using str.format() here either, for the same reason as QUESTION_GEN_SYSTEM_PROMPT
# above - the literal JSON braces in the example shape would collide with format()'s
# {placeholder} syntax. The palette list is spliced in with a plain string replace.
PALETTE_SCENARIO_SYSTEM_PROMPT = """You generate realistic, COMPLEX scenario-based SAP CPI interview questions - the kind where an interviewer describes a concrete situation and asks the candidate to design or troubleshoot it, not a textbook "what is X" definition question.

You will be given a list of CPI palette options and this candidate's own SAMPLE WORK PROJECT / resume material below. For EACH palette option in the list, write exactly ONE complex, scenario-based question that:
- Is grounded in the candidate's own real-time material where possible - reuse its actual system names, field names, and flow details so the question feels like it's about THEIR project, not a generic one.
- If the sample material doesn't naturally cover a given palette option, invent a plausible complex scenario consistent with the candidate's stack and domain (same kind of systems/adapters they already work with) rather than skipping that palette option or asking a plain definition question.
- Is the kind of question a real interviewer asks to test design judgment under a twist or edge case (e.g. "what if the payload has X and you need to do Y", "how would you handle it if Z fails mid-processing"), not "what is a Content Modifier used for."

PALETTE OPTIONS (one question each, in this order):
__PALETTES__

Respond with ONLY a JSON object in this exact shape: {"questions": [{"palette": "palette name", "question": "the scenario question"}, ...]} - one entry per palette option listed above, no other text."""


async def generate_palette_scenario_questions(
    resume_text: str, jd_text: str, scenario_text: str, palettes: list[str] = CPI_PALETTE_OPTIONS
) -> list[tuple[str, str]]:
    """Returns (palette, question) pairs - one complex scenario question per CPI palette
    option, grounded in the candidate's own real-time material so the resulting answers
    (once generated and saved as auto_generated Q&A) serve near-instantly if a live
    interviewer asks about that palette option, instead of waiting on fresh generation.
    """
    resume_section = f"RESUME (roles & responsibilities):\n{resume_text}\n\n" if resume_text else ""
    jd_section = f"TARGET ROLE (job description):\n{jd_text}\n\n" if jd_text else ""
    scenario_section = f"SAMPLE WORK PROJECT:\n{scenario_text}\n\n" if scenario_text else ""
    user_message = f"{resume_section}{jd_section}{scenario_section}".strip() or "No materials were provided."

    palette_list = "\n".join(f"- {p}" for p in palettes)
    system_prompt = PALETTE_SCENARIO_SYSTEM_PROMPT.replace("__PALETTES__", palette_list)

    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.post(
            "https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {settings.openai_api_key}", "Content-Type": "application/json"},
            json={
                "model": OPENAI_CHAT_MODEL,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_message},
                ],
                "response_format": {"type": "json_object"},
            },
        )
        response.raise_for_status()
        content = response.json()["choices"][0]["message"]["content"]

    try:
        parsed = json.loads(content)
        items = parsed.get("questions") or []
    except (json.JSONDecodeError, AttributeError):
        return []
    return [
        (str(item.get("palette", "")).strip(), str(item.get("question", "")).strip())
        for item in items
        if isinstance(item, dict) and str(item.get("question", "")).strip()
    ]
