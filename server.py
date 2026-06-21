import os
import json
import pickle
import random
import re
from contextlib import asynccontextmanager
from pathlib import Path

import anthropic
from dotenv import load_dotenv
from fastapi import FastAPI, Form
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from build_index import SYSTEM_PROMPT, retrieve, tokenize
from auth import AuthMiddleware, login_get, login_post

load_dotenv()

APP_DIR = Path(__file__).resolve().parent
INDEX_CACHE = APP_DIR / "index_cache.pkl"
QUESTIONS_BANK = APP_DIR / "questions_bank.json"
ANSWER_CACHE = APP_DIR / "answer_cache.json"

state = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    if INDEX_CACHE.exists():
        with open(INDEX_CACHE, "rb") as f:
            data = pickle.load(f)
        state["chunks"] = data["chunks"]
        state["bm25"] = data["bm25"]
    else:
        state["chunks"] = []
        state["bm25"] = None

    state["questions"] = (
        json.loads(QUESTIONS_BANK.read_text(encoding="utf-8")) if QUESTIONS_BANK.exists() else []
    )
    state["answers"] = (
        json.loads(ANSWER_CACHE.read_text(encoding="utf-8")) if ANSWER_CACHE.exists() else {}
    )

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    state["client"] = anthropic.Anthropic(api_key=api_key) if api_key and "your-new" not in api_key else None

    print(f"Loaded {len(state['chunks'])} chunks, {len(state['questions'])} questions, "
          f"{len(state['answers'])} cached answers. API key configured: {state['client'] is not None}")
    yield


app = FastAPI(lifespan=lifespan)
app.add_middleware(AuthMiddleware)


@app.get("/login")
def login_route():
    return login_get()


@app.post("/login")
def login_submit(password: str = Form(...)):
    return login_post(password)


class AskRequest(BaseModel):
    question: str


def normalize(q):
    return re.sub(r"[^a-z0-9]", "", q.lower())


def find_cached_answer(question):
    answers = state["answers"]
    if question in answers:
        return answers[question]

    norm_q = normalize(question)
    for cached_q, ans in answers.items():
        if normalize(cached_q) == norm_q:
            return ans

    q_tokens = set(tokenize(question))
    if not q_tokens:
        return None
    best_match, best_score = None, 0.0
    for cached_q, ans in answers.items():
        c_tokens = set(tokenize(cached_q))
        if not c_tokens:
            continue
        overlap = len(q_tokens & c_tokens) / len(q_tokens | c_tokens)
        if overlap > best_score:
            best_score, best_match = overlap, ans
    return best_match if best_score >= 0.6 else None


def build_user_message(question):
    chunks = retrieve(state["bm25"], state["chunks"], question)
    context = "\n\n---\n\n".join(f"[Source: {c['source']}]\n{c['text']}" for c in chunks)
    return f"Reference material:\n{context}\n\nQuestion: {question}"


@app.post("/api/ask")
async def ask(req: AskRequest):
    question = req.question.strip()
    if not question:
        return StreamingResponse(iter([""]), media_type="text/plain")

    cached = find_cached_answer(question)
    if cached:
        return StreamingResponse(iter([cached]), media_type="text/plain")

    client = state["client"]
    if client is None:
        msg = "No ANTHROPIC_API_KEY configured on the server. Add one to .env and restart the server."
        return StreamingResponse(iter([msg]), media_type="text/plain")

    user_msg = build_user_message(question)

    def stream():
        full = []
        with client.messages.stream(
            model="claude-sonnet-4-6",
            max_tokens=500,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_msg}],
        ) as s:
            for text in s.text_stream:
                full.append(text)
                yield text
        state["answers"][question] = "".join(full)
        ANSWER_CACHE.write_text(json.dumps(state["answers"], indent=2), encoding="utf-8")

    return StreamingResponse(stream(), media_type="text/plain")


@app.get("/api/practice-question")
def practice_question():
    questions = state["questions"]
    if not questions:
        return {"question": None}
    return {"question": random.choice(questions)}


app.mount("/", StaticFiles(directory=str(APP_DIR / "static"), html=True), name="static")
