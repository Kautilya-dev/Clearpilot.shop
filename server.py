import os
import json
import random
import re
import time
from contextlib import asynccontextmanager
from pathlib import Path

import anthropic
from dotenv import load_dotenv
from fastapi import FastAPI, Form, UploadFile, File, HTTPException
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import store
from build_index import (
    build_system_prompt, load_profile, retrieve, tokenize, build_bm25, embed_texts,
    STRUCTURED_TRAILER_SENTINEL, parse_structured_trailer, build_evidence,
)
from parsers import SUPPORTED_EXTENSIONS, extract_sections_by_extension
from chunking import chunk_sections
from auth import AuthMiddleware, login_get, login_post, logout

load_dotenv()

APP_DIR = Path(__file__).resolve().parent
QUESTIONS_BANK = APP_DIR / "questions_bank.json"
ANSWER_CACHE = APP_DIR / "answer_cache.json"

MAX_HISTORY_TURNS = 4
MAX_UPLOAD_BYTES = 20 * 1024 * 1024  # 20MB

state = {}


def reload_index():
    """Refreshes the in-memory chunks/embeddings/BM25 from the Chroma store - called
    at startup and after every successful upload."""
    chunks, embeddings = store.get_all_chunks()
    state["chunks"] = chunks
    state["chunk_embeddings"] = embeddings
    state["bm25"] = build_bm25(chunks) if chunks else None


@asynccontextmanager
async def lifespan(app: FastAPI):
    store.init_db()
    reload_index()

    try:
        t0 = time.perf_counter()
        embed_texts(["warmup"])  # forces the ONNX model to download/load now, not on the first real question
        print(f"Pre-loaded the embedding model in {time.perf_counter() - t0:.2f}s.")
    except Exception as e:
        print(f"Embedding model pre-load failed (non-fatal, first question will just be slower): {e}")

    state["questions"] = (
        json.loads(QUESTIONS_BANK.read_text(encoding="utf-8")) if QUESTIONS_BANK.exists() else []
    )
    state["answers"] = (
        json.loads(ANSWER_CACHE.read_text(encoding="utf-8")) if ANSWER_CACHE.exists() else {}
    )

    profile_text = load_profile()
    state["system_prompt"] = build_system_prompt(profile_text)

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    state["client"] = anthropic.Anthropic(api_key=api_key) if api_key and "your-new" not in api_key else None

    print(f"Loaded {len(state['chunks'])} chunks, {len(state['questions'])} questions, "
          f"{len(state['answers'])} cached answers. Profile set: {bool(profile_text)}. "
          f"API key configured: {state['client'] is not None}")

    if state["client"] is not None:
        try:
            t0 = time.perf_counter()
            state["client"].messages.create(
                model="claude-sonnet-4-6",
                max_tokens=1,
                system=[{"type": "text", "text": state["system_prompt"], "cache_control": {"type": "ephemeral", "ttl": "1h"}}],
                messages=[{"role": "user", "content": "hi"}],
            )
            print(f"Pre-warmed the prompt cache in {time.perf_counter() - t0:.2f}s "
                  "- the first real question should already hit a warm cache.")
        except Exception as e:
            print(f"Cache pre-warm failed (non-fatal, first question will just be slower): {e}")
    yield


app = FastAPI(lifespan=lifespan)
app.add_middleware(AuthMiddleware)


@app.get("/login")
def login_route():
    return login_get()


@app.post("/login")
def login_submit(password: str = Form(...)):
    return login_post(password)


@app.get("/logout")
def logout_route():
    return logout()


class HistoryTurn(BaseModel):
    question: str
    answer: str


class AskRequest(BaseModel):
    question: str
    history: list[HistoryTurn] = []


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


def retrieve_chunks(question):
    if not state["bm25"]:
        return []
    return retrieve(state["bm25"], state["chunks"], question, chunk_embeddings=state["chunk_embeddings"])


def build_user_message(question, chunks):
    context = "\n\n---\n\n".join(f"[Source: {c['source']}]\n{c['text']}" for c in chunks)
    return f"Reference material:\n{context}\n\nQuestion: {question}"


def sources_header_value(chunks):
    seen = []
    for c in chunks:
        if c["source"] not in seen:
            seen.append(c["source"])
    return "; ".join(seen) if seen else "none"


def structured_wire_payload(structured):
    """Wire format for a complete structured answer: prose, then the same sentinel
    + JSON trailer the frontend already parses out of a live stream (see stream()
    below) - so cache hits and live answers render identically on the client."""
    trailer = json.dumps({
        "key_points": structured.get("key_points", []),
        "evidence": structured.get("evidence", []),
        "confidence": structured.get("confidence", "medium"),
    })
    return f"{structured.get('answer', '')}\n{STRUCTURED_TRAILER_SENTINEL}{trailer}"


@app.post("/api/ask")
async def ask(req: AskRequest):
    question = req.question.strip()
    if not question:
        return StreamingResponse(iter([""]), media_type="text/plain")

    has_history = len(req.history) > 0

    if not has_history:
        cached = find_cached_answer(question)
        if cached:
            structured = cached if isinstance(cached, dict) else {
                "answer": cached, "key_points": [], "evidence": [], "confidence": "medium",
            }
            return StreamingResponse(
                iter([structured_wire_payload(structured)]),
                media_type="text/plain",
                headers={"X-Answer-Source": "cache", "X-Sources": "cached-answer"},
            )

    t_request_start = time.perf_counter()
    client = state["client"]
    chunks = retrieve_chunks(question)
    print(f"[ask] retrieval took {time.perf_counter() - t_request_start:.2f}s for: {question[:60]!r}")

    if client is None:
        msg = "No ANTHROPIC_API_KEY configured on the server. Add one to .env and restart the server."
        return StreamingResponse(
            iter([msg]), media_type="text/plain", headers={"X-Answer-Source": "error", "X-Sources": "none"}
        )

    messages = []
    for turn in req.history[-MAX_HISTORY_TURNS:]:
        messages.append({"role": "user", "content": turn.question})
        messages.append({"role": "assistant", "content": turn.answer})
    messages.append({"role": "user", "content": build_user_message(question, chunks)})

    def stream():
        # Stream prose tokens to the client as they arrive; once the model's sentinel
        # shows up, stop forwarding (it's buffered instead) so the client never sees
        # the raw trailer mid-stream - then send our own sentinel + the final
        # structured JSON (with server-computed evidence) once generation finishes.
        sentinel_len = len(STRUCTURED_TRAILER_SENTINEL)
        pending = ""
        prose_parts = []
        structured_raw = ""
        sentinel_found = False
        t_claude_start = time.perf_counter()
        first_token_seen = False

        with client.messages.stream(
            model="claude-sonnet-4-6",
            max_tokens=2000,
            system=[{"type": "text", "text": state["system_prompt"], "cache_control": {"type": "ephemeral", "ttl": "1h"}}],
            messages=messages,
        ) as s:
            for text in s.text_stream:
                if not first_token_seen:
                    first_token_seen = True
                    print(f"[ask] Claude first token after {time.perf_counter() - t_claude_start:.2f}s "
                          f"({time.perf_counter() - t_request_start:.2f}s total since request start)")
                if sentinel_found:
                    structured_raw += text
                    continue
                pending += text
                idx = pending.find(STRUCTURED_TRAILER_SENTINEL)
                if idx != -1:
                    prose_part = pending[:idx]
                    if prose_part:
                        prose_parts.append(prose_part)
                        yield prose_part
                    structured_raw = pending[idx + sentinel_len:]
                    sentinel_found = True
                    pending = ""
                else:
                    safe_len = max(0, len(pending) - (sentinel_len - 1))
                    if safe_len:
                        emit_part = pending[:safe_len]
                        prose_parts.append(emit_part)
                        yield emit_part
                        pending = pending[safe_len:]

            try:
                usage = s.get_final_message().usage
                print(f"[ask] cache: {usage.cache_read_input_tokens} read, "
                      f"{usage.cache_creation_input_tokens} created (of {usage.input_tokens} input tokens)")
            except Exception as e:
                print(f"[ask] couldn't read cache usage: {e}")

        if not sentinel_found and pending:
            prose_parts.append(pending)
            yield pending

        answer_text = "".join(prose_parts).strip()
        key_points, confidence = parse_structured_trailer(structured_raw)
        evidence = build_evidence(chunks)
        structured = {"answer": answer_text, "key_points": key_points, "evidence": evidence, "confidence": confidence}

        trailer = json.dumps({"key_points": key_points, "evidence": evidence, "confidence": confidence})
        yield f"\n{STRUCTURED_TRAILER_SENTINEL}{trailer}"

        if not has_history:
            state["answers"][question] = structured
            ANSWER_CACHE.write_text(json.dumps(state["answers"], indent=2), encoding="utf-8")

    return StreamingResponse(
        stream(),
        media_type="text/plain",
        headers={"X-Answer-Source": "live", "X-Sources": sources_header_value(chunks)},
    )


@app.get("/api/practice-question")
def practice_question():
    questions = state["questions"]
    if not questions:
        return {"question": None}
    return {"question": random.choice(questions)}


@app.post("/api/upload")
async def upload_document(file: UploadFile = File(...)):
    original_name = Path(file.filename or "").name  # basename only - strips any path components
    ext = Path(original_name).suffix.lower()

    if not original_name or ext not in SUPPORTED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail="Supported file types: " + ", ".join(sorted(SUPPORTED_EXTENSIONS)),
        )

    contents = await file.read()
    if not contents:
        raise HTTPException(status_code=400, detail="File is empty.")
    if len(contents) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=400, detail="File too large (max 20MB).")

    dest_name = store.unique_filename(original_name)
    dest_path = store.save_uploaded_file(dest_name, contents)

    sections = extract_sections_by_extension(dest_path)
    if not sections:
        dest_path.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="Could not extract any text from this file.")

    new_chunks = chunk_sections(sections, dest_name)
    if not new_chunks:
        dest_path.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="File parsed but produced no usable chunks (too short?).")

    embeddings = embed_texts([c["text"] for c in new_chunks])
    store.add_chunks(new_chunks, embeddings, origin="upload")
    doc_id = store.register_document(dest_name, ext.lstrip("."), origin="upload", chunk_count=len(new_chunks))
    store.cache_extracted_text(doc_id, "\n\n".join(s["text"] for s in sections))

    reload_index()

    return {"filename": dest_name, "chunks_added": len(new_chunks), "total_chunks": len(state["chunks"])}


app.mount("/", StaticFiles(directory=str(APP_DIR / "static"), html=True), name="static")
