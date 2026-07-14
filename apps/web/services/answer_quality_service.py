import re

import httpx

from config import settings

OPENAI_CHAT_MODEL = "gpt-5.4"

_SCORE_RE = re.compile(r"GROUNDING:\s*(\d+).*?LOGIC:\s*(\d+).*?NOTES:\s*(.*)", re.DOTALL | re.IGNORECASE)

EVAL_SYSTEM_PROMPT = """You are a strict technical reviewer grading an AI-generated SAP CPI interview answer.

Score two dimensions, each 0-10:
1. GROUNDING - do the answer's technical claims (property names, adapter names, Groovy APIs, config steps) align with the reference material below, or with well-established SAP CPI knowledge if no reference material was retrieved? Penalize fabricated specifics, invented method/class names, or claims that contradict the reference material. 10 = fully accurate and grounded, 0 = fabricated or wrong.
2. LOGIC - is the answer internally coherent and well-structured as a technical explanation, free of contradictions or non-sequiturs? 10 = perfectly logical, 0 = incoherent.

Respond with EXACTLY this format, nothing else:
GROUNDING: <0-10>
LOGIC: <0-10>
NOTES: <one sentence explaining the scores>"""

CONSISTENCY_SYSTEM_PROMPT = """You are comparing multiple AI-generated answers to the SAME interview question (each generated independently) for consistency.

Score 0-10: do the answers agree on the core technical facts and approach, or do they contradict each other / give substantively different guidance? 10 = fully consistent, 0 = contradictory.

Respond with EXACTLY this format, nothing else:
CONSISTENCY: <0-10>
NOTES: <one sentence explaining any disagreement found, or confirming agreement>"""


async def evaluate_answer(question: str, answer: str, reference_text: str) -> dict:
    """Scores a single saved answer for grounding + logical coherence against freshly
    retrieved reference material (the original retrieval isn't persisted, so this
    re-retrieves at evaluation time rather than comparing against the exact original context).
    """
    user_message = (
        f"QUESTION: {question}\n\nANSWER TO EVALUATE:\n{answer}\n\n"
        f"REFERENCE MATERIAL:\n{reference_text or '(no reference material retrieved for this question)'}"
    )
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(
            "https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {settings.openai_api_key}", "Content-Type": "application/json"},
            json={
                "model": OPENAI_CHAT_MODEL,
                "messages": [
                    {"role": "system", "content": EVAL_SYSTEM_PROMPT},
                    {"role": "user", "content": user_message},
                ],
            },
        )
        response.raise_for_status()
        text_out = response.json()["choices"][0]["message"]["content"].strip()

    match = _SCORE_RE.search(text_out)
    if not match:
        return {"grounding_score": None, "logic_score": None, "eval_notes": f"Could not parse judge output: {text_out[:200]}"}
    grounding, logic, notes = match.groups()
    return {"grounding_score": int(grounding), "logic_score": int(logic), "eval_notes": notes.strip()}


async def evaluate_consistency(question: str, answers: list[str]) -> dict:
    """Scores how consistent a GROUP of independently-generated answers to the same
    question are with each other - a group-level metric, not per-answer."""
    answers_block = "\n\n".join(f"ANSWER {i + 1}:\n{a}" for i, a in enumerate(answers))
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(
            "https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {settings.openai_api_key}", "Content-Type": "application/json"},
            json={
                "model": OPENAI_CHAT_MODEL,
                "messages": [
                    {"role": "system", "content": CONSISTENCY_SYSTEM_PROMPT},
                    {"role": "user", "content": f"QUESTION: {question}\n\n{answers_block}"},
                ],
            },
        )
        response.raise_for_status()
        text_out = response.json()["choices"][0]["message"]["content"].strip()

    match = re.search(r"CONSISTENCY:\s*(\d+).*?NOTES:\s*(.*)", text_out, re.DOTALL | re.IGNORECASE)
    if not match:
        return {"consistency_score": None, "notes": f"Could not parse judge output: {text_out[:200]}"}
    score, notes = match.groups()
    return {"consistency_score": int(score), "notes": notes.strip()}
