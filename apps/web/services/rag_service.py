import json
from collections.abc import AsyncIterator
from uuid import UUID

import httpx
from sqlalchemy import bindparam, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from db.models import Material
from services.text_relevance_service import has_enough_substantive_terms

OPENAI_CHAT_MODEL = "gpt-5.4"

SYSTEM_PROMPT_TEMPLATE = """You are helping a candidate prepare for a real SAP CPI (Cloud Integration) job interview by answering practice questions the way they should answer live - in first person, as the candidate themselves.

CRITICAL RULES:
1. Answer in first person, as the candidate ("I configured...", "In my last project, I..."), never describing them in third person.
2. Ground every technical claim in the reference material, resume, and scenarios below. Do not invent technologies, projects, metrics, or experience that aren't supported by them.
3. If neither the resume nor the reference material covers what's being asked, say so honestly (e.g. "I haven't worked directly with that") rather than making something up. Never fabricate.
4. Keep every answer interview-perfect: complete and confident, but paced the way a real spoken interview answer sounds - see the word-count target below (roughly one minute by default). Treat that target as a FLOOR, not just a ceiling - a two-sentence summary is a failure even under "medium," because it doesn't sound like a complete interview answer. Reach the target by actually explaining the reasoning and walking through one concrete example in real detail, not by padding with filler. Pick the 2-3 points that matter most rather than trying to cover everything; a focused one-minute answer beats a long one that loses the interviewer's attention. Exception: if the word-count target below explicitly calls for a comprehensive, multi-angle answer, follow that instead - it overrides "pick 2-3 points" for that specific format+length combination.
5. Use markdown to make the answer easy to scan: **bold** for key terms, numbered or bulleted lists for multi-step processes. Keep the language natural and first-person, not a dry reference doc.
6. Every **bolded** key term must be immediately followed by a short, concrete example, mini-scenario, or plain-language explanation of what it means and how it was used - e.g. "I used **Content Modifier** to enrich the message (for example, stamping a `correlationId` header onto every payload for end-to-end tracing)." Never bold a term and move on without unpacking it. In a tight answer this means bolding only the 1-2 terms that matter most, not every possible one, so the example still fits inside the word-count target.
{resume_section}{jd_section}{scenario_section}
REFERENCE MATERIAL (official documentation for this interview's subjects):
{doc_context}"""


class RetrievedChunk:
    def __init__(self, title: str, breadcrumb: str, text: str, rank: float):
        self.title = title
        self.breadcrumb = breadcrumb
        self.text = text
        self.rank = rank


# Calibrated against the real SAP corpus: clearly-relevant matches scored 0.157-0.994,
# while questions with only coincidental term overlap (e.g. "Can you walk me through your
# experience?" sharing "walk"/"experience" with an unrelated chunk) scored <= 2.7e-07 - a
# 1.5M-to-1 gap. 0.01 sits comfortably in that gap with margin on both sides.
MIN_DOC_RANK = 0.01


async def retrieve_relevant_docs(
    db: AsyncSession, question: str, subject_ids: list[UUID], limit: int = 5
) -> list[RetrievedChunk]:
    if not subject_ids:
        return []
    # Same gate as the Q&A-bank shortcut: a short, mostly-stopword question (e.g. "Tell me
    # about yourself") can reduce to one common surviving word and pull in unrelated doc
    # chunks as "reference material" purely on that coincidental overlap - confirmed live,
    # e.g. that exact question matched OAuth/CORS chunks at near-zero rank. Better to ground
    # on nothing than on noise.
    if not await has_enough_substantive_terms(db, question):
        return []
    stmt = text(
        """
        SELECT title, breadcrumb, text, ts_rank(search_vector, websearch_to_tsquery('english', :q)) AS rank
        FROM documents
        WHERE search_vector @@ websearch_to_tsquery('english', :q)
          AND subject_id IN :subject_ids
          AND ts_rank(search_vector, websearch_to_tsquery('english', :q)) > :min_rank
        ORDER BY rank DESC
        LIMIT :limit
        """
    ).bindparams(bindparam("subject_ids", expanding=True))
    result = await db.execute(
        stmt, {"q": question, "subject_ids": subject_ids, "limit": limit, "min_rank": MIN_DOC_RANK}
    )
    return [RetrievedChunk(row.title, row.breadcrumb, row.text, row.rank) for row in result]


async def get_active_material(db: AsyncSession, interview_id: UUID, material_type: str) -> Material | None:
    return await db.scalar(
        select(Material)
        .where(Material.interview_id == interview_id, Material.type == material_type, Material.active.is_(True))
        .order_by(Material.created_at.desc())
        .limit(1)
    )


FORMAT_MODE_INSTRUCTIONS = {
    "bullets": "Structure the answer as bullet points covering the key ideas - the bullet that introduces a **bolded** term should also unpack it with a brief example.",
    "star": "Structure the answer using the STAR method: Situation, Task, Action, Result, labelling each part - keep each part to a sentence or two so the whole thing still fits the word-count target below.",
    "concise": "Give a single, direct sentence with no elaboration - even shorter than the word-count target below.",
    "detailed": "Give a fuller explanation with real reasoning and a fully worked example - reach the word-count target below by going deeper on the 1-2 most important terms, not by trimming to a quick summary.",
}
# Calibrated to actual spoken duration (~130-150 words/minute at a natural, measured interview
# pace) rather than vague sentence counts, so "medium" reliably produces the interview-perfect
# one-minute answer regardless of which format above shapes its structure. Each range's lower
# bound is a floor to explicitly guard against the model's tendency to undershoot a loose
# "roughly N words" target and default to a short summary instead.
ANSWER_LENGTH_INSTRUCTIONS = {
    "short": "Write at least 50 words, up to about 70 (roughly 20-30 seconds spoken aloud) - the fastest version, but still one full, complete sentence or two, not a fragment.",
    "medium": "Write at least 130 words, up to about 160 (roughly one minute spoken aloud) - the interview-perfect default. 130 words is a floor: if your answer is shorter, you stopped too early - go back and actually explain the reasoning and walk through one concrete example, don't just pad it. This should read as 4-6 full sentences of real substance, never a 2-sentence summary.",
    # Fallback only - "one_minute" is only selectable alongside star/detailed (see
    # STAR_DETAILED_LENGTH_INSTRUCTIONS below), but an account that saved this combo before
    # that restriction existed could still have it stored with a different format.
    "one_minute": "Write at least 130 words, up to about 160 (roughly one minute spoken aloud) - the interview-perfect default. 130 words is a floor: if your answer is shorter, you stopped too early - go back and actually explain the reasoning and walk through one concrete example, don't just pad it. This should read as 4-6 full sentences of real substance, never a 2-sentence summary.",
    "long": "Write at least 200 words, up to about 260 (roughly 90 seconds spoken aloud) - use this only when the question genuinely needs more depth (a multi-part scenario, a comparison). 200 words is a floor - go deeper with a second example or edge case rather than repeating the same point to pad it out.",
}

# STAR and Detailed have the structure to support a genuinely comprehensive answer (STAR's
# four required parts, Detailed's "fuller explanation with a fully worked example"), so for
# these two formats "1 Minute" and "Long" mean something different than they do for
# Bullets/Concise: a thorough, multi-angle answer rather than a tight one-minute spoken one.
# This is a deliberate exception to rule 4's "pick 2-3 points, a focused answer beats a long
# one" guidance above - only for this format+length combination.
STAR_DETAILED_LENGTH_INSTRUCTIONS = {
    "one_minute": (
        "Write a genuinely comprehensive answer, at least 500 words, up to about 650 - this is an "
        "intentional exception to rule 4's \"pick 2-3 points\" guidance above. Structure it the way a "
        "thorough technical mentor would: the core answer with a concrete example, the practical "
        "nuance of when this applies versus when it doesn't (if relevant to the question), a "
        "real-world design pattern or approach you follow, and close with a short, tightly-distilled "
        "interview-ready version of the same answer (2-4 sentences) so the candidate has both the "
        "deep understanding and the quick spoken version ready."
    ),
    "long": (
        "Write a thorough answer, at least 300 words, up to about 450 - covering the core answer with "
        "a concrete example plus one layer of practical nuance (when it applies, a real design "
        "consideration), without needing every angle the most comprehensive answer would cover."
    ),
}


def build_answer_template_instruction(answer_format_mode: str, answer_length: str) -> str:
    mode = FORMAT_MODE_INSTRUCTIONS.get(answer_format_mode, FORMAT_MODE_INSTRUCTIONS["bullets"])
    if answer_format_mode in ("star", "detailed") and answer_length in STAR_DETAILED_LENGTH_INSTRUCTIONS:
        length = STAR_DETAILED_LENGTH_INSTRUCTIONS[answer_length]
    else:
        length = ANSWER_LENGTH_INSTRUCTIONS.get(answer_length, ANSWER_LENGTH_INSTRUCTIONS["medium"])
    return f"{mode} {length}"


def build_system_prompt(
    resume: Material | None,
    jd: Material | None,
    scenario: Material | None,
    doc_chunks: list[RetrievedChunk],
    answer_format_mode: str = "bullets",
    answer_length: str = "medium",
) -> str:
    resume_section = f"\nCANDIDATE'S RESUME:\n{resume.text}\n" if resume else ""
    jd_section = f"\nTARGET ROLE (job description):\n{jd.text}\n" if jd else ""
    scenario_section = f"\nREAL-TIME SCENARIOS TO DRAW ON:\n{scenario.text}\n" if scenario else ""

    if doc_chunks:
        doc_context = "\n\n".join(f"[{c.title} - {c.breadcrumb}]\n{c.text}" for c in doc_chunks)
    else:
        doc_context = "(No matching reference material was found for this question.)"

    prompt = SYSTEM_PROMPT_TEMPLATE.format(
        resume_section=resume_section, jd_section=jd_section, scenario_section=scenario_section, doc_context=doc_context
    )
    # This overrides rule 4's general "prefer longer, complete answers" guidance above -
    # without saying so explicitly, a "concise"/"short" preference would conflict with it.
    template_instruction = build_answer_template_instruction(answer_format_mode, answer_length)
    return (
        f"{prompt}\n\nANSWER TEMPLATE (follow this instead of the general length guidance above):\n"
        f"{template_instruction}"
    )


async def generate_answer_stream(system_prompt: str, question: str) -> AsyncIterator[str]:
    """Yields text deltas as OpenAI generates them (Chat Completions SSE stream),
    so the caller can forward each piece to the client as it arrives."""
    async with httpx.AsyncClient(timeout=60.0) as client:
        async with client.stream(
            "POST",
            "https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {settings.openai_api_key}", "Content-Type": "application/json"},
            json={
                "model": OPENAI_CHAT_MODEL,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": question},
                ],
                "stream": True,
                # This task is domain-knowledge recall + structuring, not multi-step logical
                # reasoning - a low reasoning effort keeps quality while cutting the "thinking"
                # time before the first visible token streams out, which was the dominant
                # contributor to time-to-first-chunk, independent of total answer length.
                "reasoning_effort": "low",
            },
        ) as response:
            response.raise_for_status()
            async for line in response.aiter_lines():
                if not line.startswith("data: "):
                    continue
                payload = line[len("data: "):]
                if payload == "[DONE]":
                    break
                delta = json.loads(payload)["choices"][0]["delta"].get("content")
                if delta:
                    yield delta
