import json
from collections.abc import AsyncIterator
from uuid import UUID

import httpx
from sqlalchemy import bindparam, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from db.models import Material

OPENAI_CHAT_MODEL = "gpt-5.4"

SYSTEM_PROMPT_TEMPLATE = """You are helping a candidate prepare for a real SAP CPI (Cloud Integration) job interview by answering practice questions exactly the way they should answer live - in first person, as the candidate themselves.

CRITICAL RULES:
1. Answer in first person, as the candidate ("I configured...", "In my last project, I..."), never describing them in third person.
2. Ground every technical claim in the reference material, resume, and scenarios below. Do not invent technologies, projects, metrics, or experience that aren't supported by them.
3. If neither the resume nor the reference material covers what's being asked, say so honestly (e.g. "I haven't worked directly with that") rather than making something up. Never fabricate.
4. Keep the answer concise and natural, like a real spoken interview answer - not an essay.
{resume_section}{jd_section}{scenario_section}
REFERENCE MATERIAL (official documentation for this interview's subjects):
{doc_context}"""


class RetrievedChunk:
    def __init__(self, title: str, breadcrumb: str, text: str, rank: float):
        self.title = title
        self.breadcrumb = breadcrumb
        self.text = text
        self.rank = rank


async def retrieve_relevant_docs(
    db: AsyncSession, question: str, subject_ids: list[UUID], limit: int = 5
) -> list[RetrievedChunk]:
    if not subject_ids:
        return []
    stmt = text(
        """
        SELECT title, breadcrumb, text, ts_rank(search_vector, websearch_to_tsquery('english', :q)) AS rank
        FROM documents
        WHERE search_vector @@ websearch_to_tsquery('english', :q)
          AND subject_id IN :subject_ids
        ORDER BY rank DESC
        LIMIT :limit
        """
    ).bindparams(bindparam("subject_ids", expanding=True))
    result = await db.execute(stmt, {"q": question, "subject_ids": subject_ids, "limit": limit})
    return [RetrievedChunk(row.title, row.breadcrumb, row.text, row.rank) for row in result]


async def get_active_material(db: AsyncSession, interview_id: UUID, material_type: str) -> Material | None:
    return await db.scalar(
        select(Material)
        .where(Material.interview_id == interview_id, Material.type == material_type, Material.active.is_(True))
        .order_by(Material.created_at.desc())
        .limit(1)
    )


def build_system_prompt(
    resume: Material | None, jd: Material | None, scenario: Material | None, doc_chunks: list[RetrievedChunk]
) -> str:
    resume_section = f"\nCANDIDATE'S RESUME:\n{resume.text}\n" if resume else ""
    jd_section = f"\nTARGET ROLE (job description):\n{jd.text}\n" if jd else ""
    scenario_section = f"\nREAL-TIME SCENARIOS TO DRAW ON:\n{scenario.text}\n" if scenario else ""

    if doc_chunks:
        doc_context = "\n\n".join(f"[{c.title} - {c.breadcrumb}]\n{c.text}" for c in doc_chunks)
    else:
        doc_context = "(No matching reference material was found for this question.)"

    return SYSTEM_PROMPT_TEMPLATE.format(
        resume_section=resume_section, jd_section=jd_section, scenario_section=scenario_section, doc_context=doc_context
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
