"""
Builds the local search index, practice question bank, and pre-generated
answer cache for the SAP CPI interview study assistant.

Run this once after setting ANTHROPIC_API_KEY in .env, and again any time
the source documents change.
"""
import os
import json
import pickle
import re
from pathlib import Path

import docx
import fitz  # PyMuPDF
from rank_bm25 import BM25Okapi
from dotenv import load_dotenv
import anthropic

load_dotenv()

APP_DIR = Path(__file__).resolve().parent
BASE_DIR = APP_DIR.parent
NOTES_DIR = BASE_DIR / "Notes"
HANDBOOK_PDF = BASE_DIR / "SAP Cloud Platform Integration Hand Book.pdf"
INTERVIEWS_DIR = BASE_DIR / "RealTime Interviews"

INDEX_CACHE = APP_DIR / "index_cache.pkl"
QUESTIONS_BANK = APP_DIR / "questions_bank.json"
ANSWER_CACHE = APP_DIR / "answer_cache.json"

CHUNK_WORDS = 250

BASE_SYSTEM_PROMPT = """You are a senior SAP CPI (Cloud Platform Integration) technical consultant helping a colleague prepare for interviews.

Answer like an experienced consultant explaining a solution in an interview: confident, structured, and technically specific - name the actual adapters, steps, configuration, or Groovy/script approach involved. Do not give dry textbook definitions; explain HOW you would implement or solve it.

Stay strictly scoped to SAP CPI itself (iFlows, adapters, Groovy/JavaScript scripting, message mapping, security artifacts, monitoring, JMS, error handling). Do not wander into general BTP platform administration topics unless they are a direct part of a CPI integration step (e.g. Cloud Connector setup is fine; unrelated BTP services are not).

Never claim specific personal employment history, named clients, or first-person project narratives ("I worked on this at Company X") unless that real experience is explicitly given to you below in the candidate profile - don't invent employers, clients, or projects that aren't stated there. Speak in terms of how the implementation would be approached ("you would configure...", "the typical approach is...", "to solve this, you'd..."), not fabricated autobiography.

Ground your answer in the provided reference material when it's relevant, but you may supplement with your own correct CPI knowledge if the material doesn't cover it. Keep answers focused and complete - a few short paragraphs or a tight bullet list, not a wall of text.

For behavioral/scenario questions ("tell me about a time...", "how did you handle...", "describe a situation where..."), structure the answer with STAR (Situation, Task, Action, Result). If the candidate profile below contains real relevant experience, ground the STAR answer in that truthfully. If it doesn't, frame it generically and hypothetically ("a common situation is...", "the task would typically be...") rather than inventing a specific fake personal anecdote. For purely technical how-to questions, skip STAR and just answer directly with clear technical structure.
"""


def build_system_prompt(profile_text=""):
    profile_text = (profile_text or "").strip()
    if not profile_text:
        return BASE_SYSTEM_PROMPT
    return (
        BASE_SYSTEM_PROMPT
        + "\n\nCandidate profile (their real, actual background - use this to calibrate technical "
        + "depth and as the only source of truth for any personal experience claims; don't assume "
        + "skills or projects beyond what's stated here):\n"
        + profile_text
    )

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


def extract_docx(path):
    try:
        d = docx.Document(str(path))
        return "\n".join(p.text for p in d.paragraphs if p.text.strip())
    except Exception as e:
        print(f"  ! failed to read {path.name}: {e}")
        return ""


def extract_pdf(path):
    try:
        doc = fitz.open(str(path))
        text = "\n".join(page.get_text() for page in doc)
        doc.close()
        return text
    except Exception as e:
        print(f"  ! failed to read {path.name}: {e}")
        return ""


def chunk_text(text, source, chunk_words=CHUNK_WORDS):
    words = text.split()
    chunks = []
    for i in range(0, len(words), chunk_words):
        piece = words[i:i + chunk_words]
        if len(piece) < 20:
            continue
        chunks.append({"text": " ".join(piece), "source": source})
    return chunks


def build_chunks():
    chunks = []
    seen_names = set()

    for f in sorted(NOTES_DIR.glob("*.docx")):
        text = extract_docx(f)
        if text:
            chunks.extend(chunk_text(text, f.name))
        seen_names.add(f.name.lower())

    for f in sorted(NOTES_DIR.glob("*.pdf")):
        if f.name.lower() in seen_names:
            continue
        text = extract_pdf(f)
        if text:
            chunks.extend(chunk_text(text, f.name))
        seen_names.add(f.name.lower())

    if HANDBOOK_PDF.exists() and HANDBOOK_PDF.name.lower() not in seen_names:
        text = extract_pdf(HANDBOOK_PDF)
        if text:
            chunks.extend(chunk_text(text, HANDBOOK_PDF.name))

    return chunks


def tokenize(text):
    return re.findall(r"[a-z0-9]+", text.lower())


def build_bm25(chunks):
    corpus = [tokenize(c["text"]) for c in chunks]
    return BM25Okapi(corpus)


def retrieve(bm25, chunks, query, top_k=5):
    if bm25 is None or not chunks:
        return []
    scores = bm25.get_scores(tokenize(query))
    ranked = sorted(range(len(chunks)), key=lambda i: scores[i], reverse=True)[:top_k]
    return [chunks[i] for i in ranked if scores[i] > 0]


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


def generate_answer(client, bm25, chunks, question, profile_text=""):
    context_chunks = retrieve(bm25, chunks, question)
    context = "\n\n---\n\n".join(
        f"[Source: {c['source']}]\n{c['text']}" for c in context_chunks
    )
    user_msg = f"Reference material:\n{context}\n\nQuestion: {question}"
    resp = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=500,
        system=build_system_prompt(profile_text),
        messages=[{"role": "user", "content": user_msg}],
    )
    return resp.content[0].text


def main():
    print("Parsing documents...")
    chunks = build_chunks()
    print(f"  {len(chunks)} chunks built")

    print("Building BM25 index...")
    bm25 = build_bm25(chunks)
    with open(INDEX_CACHE, "wb") as f:
        pickle.dump({"chunks": chunks, "bm25": bm25}, f)
    print(f"  cached to {INDEX_CACHE}")

    print("Extracting interview questions...")
    questions = extract_questions()
    with open(QUESTIONS_BANK, "w", encoding="utf-8") as f:
        json.dump(questions, f, indent=2)
    print(f"  {len(questions)} questions -> {QUESTIONS_BANK}")

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key or "your-new" in api_key:
        print("\nNo real ANTHROPIC_API_KEY set in .env -- skipping answer cache pre-generation.")
        print("Add your key to .env and re-run this script to build the answer cache.")
        return

    client = anthropic.Anthropic(api_key=api_key)
    profile_text = load_profile()
    print(f"Candidate profile loaded: {'yes' if profile_text else 'no (using generic calibration)'}")

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
            answer = generate_answer(client, bm25, chunks, q, profile_text)
            cache[q] = answer
            print(f"  [{i}/{len(all_questions)}] cached: {q[:60]}")
        except Exception as e:
            print(f"  [{i}/{len(all_questions)}] FAILED: {q[:60]} -- {e}")

    with open(ANSWER_CACHE, "w", encoding="utf-8") as f:
        json.dump(cache, f, indent=2)
    print(f"\n{len(cache)} answers cached -> {ANSWER_CACHE}")


if __name__ == "__main__":
    main()
