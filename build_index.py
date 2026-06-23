"""
Builds/rebuilds the document index (Chroma + SQLite, via store.py), the practice
question bank, and the pre-generated answer cache for the SAP CPI interview study
assistant.

Run this once after setting ANTHROPIC_API_KEY in .env, and again any time the
source documents (Notes/, the handbook PDF) change - it's a fresh rebuild of just
that "folder" content (store.clear_origin("folder")); anything added live via the
running app's /api/upload is left untouched.
"""
import os
import json
import re
import sys
from pathlib import Path

import numpy as np
from rank_bm25 import BM25Okapi
from fastembed import TextEmbedding
from dotenv import load_dotenv
import anthropic

import store
from parsers import SUPPORTED_EXTENSIONS, extract_sections_by_extension
from chunking import chunk_sections

load_dotenv()

APP_DIR = Path(__file__).resolve().parent
BASE_DIR = APP_DIR.parent
NOTES_DIR = BASE_DIR / "Notes"
HANDBOOK_PDF = BASE_DIR / "SAP Cloud Platform Integration Hand Book.pdf"
INTERVIEWS_DIR = BASE_DIR / "RealTime Interviews"

QUESTIONS_BANK = APP_DIR / "questions_bank.json"
ANSWER_CACHE = APP_DIR / "answer_cache.json"

EMBEDDING_MODEL_NAME = "BAAI/bge-small-en-v1.5"

_embed_model = None


def get_embed_model():
    global _embed_model
    if _embed_model is None:
        _embed_model = TextEmbedding(model_name=EMBEDDING_MODEL_NAME)
    return _embed_model


def embed_texts(texts):
    return np.array(list(get_embed_model().embed(texts)))


BASE_SYSTEM_PROMPT = """You are a senior SAP CPI (Cloud Platform Integration) technical consultant helping a colleague prepare for interviews.

Answer like an experienced consultant explaining a solution in an interview: confident, structured, and technically specific - name the actual adapters, steps, configuration, or Groovy/script approach involved. Do not give dry textbook definitions; explain HOW you would implement or solve it.

Stay strictly scoped to SAP CPI itself (iFlows, adapters, Groovy/JavaScript scripting, message mapping, security artifacts, monitoring, JMS, error handling). Do not wander into general BTP platform administration topics unless they are a direct part of a CPI integration step (e.g. Cloud Connector setup is fine; unrelated BTP services are not).

Never claim specific personal employment history, named clients, or first-person project narratives ("I worked on this at Company X") unless that real experience is explicitly given to you below in the candidate profile - don't invent employers, clients, or projects that aren't stated there. Speak in terms of how the implementation would be approached ("you would configure...", "the typical approach is...", "to solve this, you'd..."), not fabricated autobiography.

Ground your answer in the provided reference material when it's relevant, but you may supplement with your own correct CPI knowledge if the material doesn't cover it. Keep answers focused and complete - a few short paragraphs or a tight bullet list, not a wall of text.

For behavioral/scenario questions ("tell me about a time...", "how did you handle...", "describe a situation where..."), structure the answer with STAR (Situation, Task, Action, Result). If the candidate profile below contains real relevant experience, ground the STAR answer in that truthfully. If it doesn't, frame it generically and hypothetically ("a common situation is...", "the task would typically be...") rather than inventing a specific fake personal anecdote. For purely technical how-to questions, skip STAR and just answer directly with clear technical structure.
"""


STRUCTURED_TRAILER_SENTINEL = "<<<CLEARPILOT_STRUCTURED>>>"

STRUCTURED_REPLY_INSTRUCTIONS = f"""

After your prose answer, on a new line output exactly this sentinel: {STRUCTURED_TRAILER_SENTINEL}
On the line after that, output a single-line JSON object with exactly these keys:
- "key_points": an array of 2-5 short strings summarizing the answer's main points
- "confidence": one of "high", "medium", or "low", reflecting how well the reference material actually supports this answer

Output nothing after that JSON object - no extra commentary, no repeating the answer, no source citations (those are added separately). Example ending:
{STRUCTURED_TRAILER_SENTINEL}
{{"key_points": ["Point one", "Point two"], "confidence": "high"}}
"""


def build_system_prompt(profile_text=""):
    profile_text = (profile_text or "").strip()
    base = BASE_SYSTEM_PROMPT
    if profile_text:
        base = (
            base
            + "\n\nCandidate profile (their real, actual background - use this to calibrate technical "
            + "depth and as the only source of truth for any personal experience claims; don't assume "
            + "skills or projects beyond what's stated here):\n"
            + profile_text
        )
    return base + STRUCTURED_REPLY_INSTRUCTIONS


def parse_structured_trailer(raw_text):
    """Parses the {"key_points": [...], "confidence": "..."} JSON the model emits after
    STRUCTURED_TRAILER_SENTINEL. Falls back to safe defaults if it doesn't parse cleanly
    (e.g. truncated by max_tokens before the model reached the trailer)."""
    try:
        data = json.loads(raw_text.strip())
    except Exception:
        return [], "medium"
    key_points = data.get("key_points")
    if not isinstance(key_points, list):
        key_points = []
    confidence = data.get("confidence")
    if confidence not in ("high", "medium", "low"):
        confidence = "medium"
    return [str(p) for p in key_points][:5], confidence


def build_evidence(chunks, max_items=3, snippet_len=160):
    evidence = []
    for c in chunks[:max_items]:
        text = c["text"].strip()
        snippet = text[:snippet_len] + ("..." if len(text) > snippet_len else "")
        evidence.append({"source": c["source"], "section": c.get("section", ""), "snippet": snippet})
    return evidence


def split_structured_response(raw_text, chunks):
    """Splits a full (non-streamed) model response into the structured answer shape
    {answer, key_points, evidence, confidence}. server.py's /api/ask does the streaming
    equivalent of this incrementally while tokens arrive."""
    idx = raw_text.find(STRUCTURED_TRAILER_SENTINEL)
    if idx == -1:
        answer_text, key_points, confidence = raw_text.strip(), [], "medium"
    else:
        answer_text = raw_text[:idx].strip()
        key_points, confidence = parse_structured_trailer(raw_text[idx + len(STRUCTURED_TRAILER_SENTINEL):])
    return {
        "answer": answer_text,
        "key_points": key_points,
        "evidence": build_evidence(chunks),
        "confidence": confidence,
    }


COMMON_CPI_QUESTIONS = [
    "What is the difference between XSLT mapping and Groovy script in CPI?",
    "How do you handle errors in an iFlow using exception subprocesses?",
    "How does the Aggregator step work and when would you use it?",
    "How do you configure certificate-based authentication for an SFTP adapter?",
    "How do you implement OAuth 2.0 client credentials in a CPI iFlow?",
    "How do you set up a Cloud Connector and virtual host for on-premise connectivity?",
    "How would you design a content-based router in an iFlow?",
    "How do you use JMS queues for asynchronous processing in CPI?",
    "How do you debug a failed message in CPI message monitoring?",
    "What's your approach to performance-optimizing a slow iFlow?",
    "How do you implement PGP encryption/decryption in CPI?",
    "How do you handle dynamic configuration using externalized parameters?",
    "How would you process a large file using the Splitter pattern?",
    "How do you implement idempotency or duplicate message handling in CPI?",
    "How do you configure an IDoc adapter for inbound and outbound scenarios?",
]


def tokenize(text):
    return re.findall(r"[a-z0-9]+", text.lower())


def build_bm25(chunks):
    corpus = [tokenize(c["text"]) for c in chunks]
    return BM25Okapi(corpus)


def reciprocal_rank_fusion(rank_lists, k=60):
    scores = {}
    for ranked_ids in rank_lists:
        for rank, doc_id in enumerate(ranked_ids):
            scores[doc_id] = scores.get(doc_id, 0.0) + 1.0 / (k + rank + 1)
    return sorted(scores.items(), key=lambda x: x[1], reverse=True)


def retrieve(bm25, chunks, query, top_k=3, chunk_embeddings=None):
    """Hybrid retrieval: BM25 (keyword) + semantic embeddings, combined via
    Reciprocal Rank Fusion. Falls back to pure BM25 if no embeddings are available."""
    if bm25 is None or not chunks:
        return []

    candidate_k = min(len(chunks), max(top_k * 4, 20))

    bm25_scores = bm25.get_scores(tokenize(query))
    bm25_ranked = [
        i for i in sorted(range(len(chunks)), key=lambda i: bm25_scores[i], reverse=True)
        if bm25_scores[i] > 0
    ][:candidate_k]

    if chunk_embeddings is None:
        return [chunks[i] for i in bm25_ranked[:top_k]]

    query_vec = embed_texts([query])[0]
    sims = chunk_embeddings @ query_vec
    semantic_ranked = sorted(range(len(chunks)), key=lambda i: sims[i], reverse=True)[:candidate_k]

    fused = reciprocal_rank_fusion([bm25_ranked, semantic_ranked])
    top_ids = [doc_id for doc_id, _ in fused[:top_k]]
    return [chunks[i] for i in top_ids]


TECH_KEYWORDS = [
    "cpi", "btp", "iflow", "i-flow", "integration flow", "adapter", "groovy", "javascript",
    "script", "mapping", "xslt", "udf", "idoc", "sftp", "ftp", "http", "soap", "odata",
    "jms", "queue", "exception", "security material", "certificate", "encryption", "decryption",
    "pgp", "monitoring", "message processing", "payload", "node", "cloud connector",
    "value mapping", "content modifier", "router", "splitter", "aggregator", "gather",
    "process direct", "oauth", "api management", "transport", "package", "artifact",
    "channel", "sender", "receiver", "polling", "scheduler", "variable", "header",
    "property", "multicast", "filter", "content enricher", "data store", "trace",
    "log level", "mpl", "correlation id", "message id", "wsdl", "json", "xml", "rfc",
    "bapi", "proxy", "successfactors", "sfsf", "s/4hana", "ecc", "keystore", "tenant",
    "runtime node", "neo", "cloud foundry", "architecture",
]

EXCLUDE_PATTERNS = re.compile(
    r"government id|camera|can you hear|notice period|current ctc|expected ctc|"
    r"current organization|current company|available to join|share your screen|"
    r"video|network issue|background noise|connection|are you there|"
    r"can you see|can you hear|mute|unmute|recording this|introduce yourself",
    re.IGNORECASE,
)


NARRATIVE_PATTERNS = re.compile(
    r"\byears? of experience\b|\bI have (overall|around|about)\b|\bI am [A-Z][a-z]+\b|"
    r"^(yeah,? )*(yeah|yes|okay,? )*i (am|have|worked|got)\b",
    re.IGNORECASE,
)


def is_technical_question(q):
    if "?" not in q:
        return False
    if EXCLUDE_PATTERNS.search(q) or NARRATIVE_PATTERNS.search(q):
        return False
    q_lower = q.lower()
    return any(kw in q_lower for kw in TECH_KEYWORDS)


def extract_questions():
    questions = []
    seen = set()
    if not INTERVIEWS_DIR.exists():
        return questions
    for f in sorted(INTERVIEWS_DIR.glob("*.txt")):
        try:
            text = f.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue
        for line in text.splitlines():
            line = line.strip()
            if not line.lower().startswith("interviewer:"):
                continue
            q = line.split(":", 1)[1].strip()
            if len(q) < 15 or not is_technical_question(q):
                continue
            key = re.sub(r"[^a-z0-9]", "", q.lower())[:80]
            if key in seen:
                continue
            seen.add(key)
            questions.append(q)
    return questions


def load_profile():
    # Prefer an env var so real background info never has to be committed to git.
    env_profile = os.environ.get("CANDIDATE_PROFILE", "").strip()
    if env_profile:
        return env_profile

    profile_path = APP_DIR / "profile.txt"
    if not profile_path.exists():
        return ""
    text = profile_path.read_text(encoding="utf-8", errors="ignore").strip()
    if text.startswith("Fill this in with your real"):
        return ""  # still the placeholder, treat as unset
    return text


def generate_answer(client, bm25, chunks, question, profile_text="", chunk_embeddings=None):
    """Returns the structured {answer, key_points, evidence, confidence} shape."""
    context_chunks = retrieve(bm25, chunks, question, chunk_embeddings=chunk_embeddings)
    context = "\n\n---\n\n".join(
        f"[Source: {c['source']}]\n{c['text']}" for c in context_chunks
    )
    user_msg = f"Reference material:\n{context}\n\nQuestion: {question}"
    resp = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=2000,
        system=[{"type": "text", "text": build_system_prompt(profile_text), "cache_control": {"type": "ephemeral"}}],
        messages=[{"role": "user", "content": user_msg}],
    )
    return split_structured_response(resp.content[0].text, context_chunks)


def build_chunks_from_folders():
    """Walks Notes/ (any supported file type) and the handbook PDF, returning chunks
    ready for store.add_chunks(..., origin="folder"). RealTime Interviews/ is mined
    separately by extract_questions() for the practice bank, not indexed as content."""
    all_chunks = []
    seen_names = set()

    if NOTES_DIR.exists():
        for f in sorted(NOTES_DIR.glob("*")):
            if not f.is_file() or f.suffix.lower() not in SUPPORTED_EXTENSIONS:
                continue
            sections = extract_sections_by_extension(f)
            if sections:
                all_chunks.extend(chunk_sections(sections, f.name))
            else:
                print(f"  ! no extractable text in {f.name}")
            seen_names.add(f.name.lower())

    if HANDBOOK_PDF.exists() and HANDBOOK_PDF.name.lower() not in seen_names:
        sections = extract_sections_by_extension(HANDBOOK_PDF)
        if sections:
            all_chunks.extend(chunk_sections(sections, HANDBOOK_PDF.name))

    return all_chunks


def main():
    store.init_db()

    print("Clearing previously-indexed folder content (fresh rebuild; live uploads are untouched)...")
    store.clear_origin("folder")

    print("Parsing documents...")
    chunks = build_chunks_from_folders()
    print(f"  {len(chunks)} chunks built")

    if chunks:
        print(f"Computing semantic embeddings ({EMBEDDING_MODEL_NAME}, downloads the model on first run)...")
        embeddings = embed_texts([c["text"] for c in chunks])
        print(f"  {embeddings.shape[0]} embeddings, dim {embeddings.shape[1]}")
        store.add_chunks(chunks, embeddings, origin="folder")

        chunk_counts = {}
        for c in chunks:
            chunk_counts[c["source"]] = chunk_counts.get(c["source"], 0) + 1
        for source, n in chunk_counts.items():
            store.register_document(source, Path(source).suffix.lstrip("."), origin="folder", chunk_count=n)

    total = store.count()
    print(f"  index now has {total} chunks total (folder + any live uploads)")

    print("Extracting interview questions...")
    questions = extract_questions()
    with open(QUESTIONS_BANK, "w", encoding="utf-8") as f:
        json.dump(questions, f, indent=2)
    print(f"  {len(questions)} questions -> {QUESTIONS_BANK}")

    if "--no-cache" in sys.argv:
        print("\n--no-cache passed - skipping answer cache pre-generation "
              "(used for Railway's release step, to keep deploys fast/predictable).")
        return

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key or "your-new" in api_key:
        print("\nNo real ANTHROPIC_API_KEY set in .env -- skipping answer cache pre-generation.")
        print("Add your key to .env and re-run this script to build the answer cache.")
        return

    client = anthropic.Anthropic(api_key=api_key)
    profile_text = load_profile()
    print(f"Candidate profile loaded: {'yes' if profile_text else 'no (using generic calibration)'}")

    all_chunks, chunk_embeddings = store.get_all_chunks()
    bm25 = build_bm25(all_chunks) if all_chunks else None

    all_questions = list(dict.fromkeys(questions + COMMON_CPI_QUESTIONS))
    print(f"\nPre-generating answers for {len(all_questions)} questions "
          f"(this calls the Claude API once per new question)...")

    cache = {}
    if ANSWER_CACHE.exists():
        try:
            cache = json.loads(ANSWER_CACHE.read_text(encoding="utf-8"))
        except Exception:
            cache = {}

    for i, q in enumerate(all_questions, 1):
        if q in cache:
            continue
        try:
            answer = generate_answer(client, bm25, all_chunks, q, profile_text, chunk_embeddings)
            cache[q] = answer
            print(f"  [{i}/{len(all_questions)}] cached: {q[:60]}")
        except Exception as e:
            print(f"  [{i}/{len(all_questions)}] FAILED: {q[:60]} -- {e}")

    with open(ANSWER_CACHE, "w", encoding="utf-8") as f:
        json.dump(cache, f, indent=2)
    print(f"\n{len(cache)} answers cached -> {ANSWER_CACHE}")


if __name__ == "__main__":
    main()
