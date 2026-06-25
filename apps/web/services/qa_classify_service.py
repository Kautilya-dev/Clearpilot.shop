import json

import httpx

from config import settings

OPENAI_CHAT_MODEL = "gpt-5.4"

CLASSIFY_SYSTEM_PROMPT = """You categorize and tag interview Q&A pairs for an SAP CPI interview prep tool.
Given a question and answer, respond with ONLY a JSON object in this exact shape:
{"category": "...", "tags": ["...", "..."]}
- category: a short, specific topic label (e.g. "Adapters", "Security", "Error Handling", "Groovy Scripting")
- tags: 2-5 short lowercase keywords relevant to the content
No other text, just the JSON object."""


class Classification:
    def __init__(self, category: str, tags: str):
        self.category = category
        self.tags = tags  # comma-separated, matching QAEntry.tags storage format


async def classify_qa(question: str, answer: str) -> Classification:
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(
            "https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {settings.openai_api_key}", "Content-Type": "application/json"},
            json={
                "model": OPENAI_CHAT_MODEL,
                "messages": [
                    {"role": "system", "content": CLASSIFY_SYSTEM_PROMPT},
                    {"role": "user", "content": f"Question: {question}\nAnswer: {answer}"},
                ],
                "response_format": {"type": "json_object"},
            },
        )
        response.raise_for_status()
        content = response.json()["choices"][0]["message"]["content"]
        parsed = json.loads(content)

    category = str(parsed.get("category") or "").strip()
    raw_tags = parsed.get("tags") or []
    if not isinstance(raw_tags, list):
        raw_tags = []
    tags = ", ".join(str(t).strip() for t in raw_tags if str(t).strip())
    return Classification(category=category, tags=tags)
