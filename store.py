"""Persistent storage: Chroma holds chunk vectors + metadata, SQLite holds the
document registry (filenames, status, counts - not per-chunk data).

Both live under DATA_DIR (default: this app's directory for local dev; point it at
a mounted Railway Volume in production so uploads/index survive redeploys).
"""
import json
import os
import sqlite3
import uuid
from contextlib import contextmanager
from pathlib import Path

import chromadb
import numpy as np

APP_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("DATA_DIR", str(APP_DIR)))

FILES_DIR = DATA_DIR / "files"
INDEX_DIR = DATA_DIR / "index"
DB_DIR = DATA_DIR / "db"
CACHE_DIR = DATA_DIR / "cache"

for _d in (FILES_DIR, INDEX_DIR, DB_DIR, CACHE_DIR):
    _d.mkdir(parents=True, exist_ok=True)

DB_PATH = DB_DIR / "clearpilot.db"
COLLECTION_NAME = "clearpilot_chunks"

_chroma_client = None
_collection = None


def get_collection():
    global _chroma_client, _collection
    if _collection is None:
        _chroma_client = chromadb.PersistentClient(path=str(INDEX_DIR))
        _collection = _chroma_client.get_or_create_collection(COLLECTION_NAME)
    return _collection


def add_chunks(chunks, embeddings, origin="upload"):
    """chunks: list of {"text", "source", "section"}; embeddings: np.ndarray (n, dim).
    origin is "folder" (from build_index.py's source folders) or "upload" (live
    /api/upload) - lets a rebuild clear just the folder-sourced content, see clear_origin()."""
    if not chunks:
        return
    collection = get_collection()
    ids = [str(uuid.uuid4()) for _ in chunks]
    collection.add(
        ids=ids,
        embeddings=embeddings.tolist(),
        documents=[c["text"] for c in chunks],
        metadatas=[
            {"source": c["source"], "section": c.get("section", ""), "origin": origin}
            for c in chunks
        ],
    )


def clear_origin(origin):
    """Removes all chunks/documents tagged with the given origin - used by
    build_index.py before a fresh rebuild, so reruns don't duplicate folder content."""
    collection = get_collection()
    if collection.count() > 0:
        collection.delete(where={"origin": origin})
    with _connect() as conn:
        conn.execute("DELETE FROM documents WHERE origin = ?", (origin,))


def get_all_chunks():
    """Returns (chunks, embeddings) for the whole collection - used to rebuild the
    in-memory BM25 index and embedding matrix at startup / after an upload."""
    collection = get_collection()
    total = collection.count()
    if total == 0:
        return [], None

    result = collection.get(include=["documents", "metadatas", "embeddings"], limit=total)
    chunks = [
        {"text": doc, "source": meta.get("source", ""), "section": meta.get("section", "")}
        for doc, meta in zip(result["documents"], result["metadatas"])
    ]
    embeddings = np.array(result["embeddings"]) if result["embeddings"] is not None else None
    return chunks, embeddings


def count():
    return get_collection().count()


@contextmanager
def _connect():
    conn = sqlite3.connect(str(DB_PATH))
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    with _connect() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS documents (
                id TEXT PRIMARY KEY,
                filename TEXT NOT NULL,
                file_type TEXT NOT NULL,
                origin TEXT NOT NULL,
                uploaded_at TEXT NOT NULL,
                status TEXT NOT NULL,
                chunk_count INTEGER NOT NULL DEFAULT 0
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS conversations (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                question TEXT NOT NULL,
                answer TEXT NOT NULL,
                key_points TEXT NOT NULL DEFAULT '[]',
                evidence TEXT NOT NULL DEFAULT '[]',
                confidence TEXT NOT NULL DEFAULT 'medium',
                created_at TEXT NOT NULL
            )
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_messages_conversation_id
            ON messages (conversation_id, created_at)
        """)


def register_document(filename, file_type, origin="upload", status="ready", chunk_count=0):
    doc_id = str(uuid.uuid4())
    with _connect() as conn:
        conn.execute(
            "INSERT INTO documents (id, filename, file_type, origin, uploaded_at, status, chunk_count) "
            "VALUES (?, ?, ?, ?, datetime('now'), ?, ?)",
            (doc_id, filename, file_type, origin, status, chunk_count),
        )
    return doc_id


def list_documents():
    with _connect() as conn:
        rows = conn.execute(
            "SELECT id, filename, file_type, origin, uploaded_at, status, chunk_count "
            "FROM documents ORDER BY uploaded_at DESC"
        ).fetchall()
    return [
        {
            "id": r[0], "filename": r[1], "file_type": r[2], "origin": r[3],
            "uploaded_at": r[4], "status": r[5], "chunk_count": r[6],
        }
        for r in rows
    ]


def unique_filename(original_name):
    stem, suffix = Path(original_name).stem, Path(original_name).suffix
    candidate = original_name
    i = 1
    while (FILES_DIR / candidate).exists():
        candidate = f"{stem}_{i}{suffix}"
        i += 1
    return candidate


def save_uploaded_file(filename, content_bytes):
    dest = FILES_DIR / filename
    dest.write_bytes(content_bytes)
    return dest


def cache_extracted_text(doc_id, text):
    (CACHE_DIR / f"{doc_id}.txt").write_text(text, encoding="utf-8")


# --- Conversations (Ask mode only - Practice mode stays ephemeral/client-side) ---

DEFAULT_CONVERSATION_TITLE = "New conversation"


def create_conversation(title=None):
    conv_id = str(uuid.uuid4())
    with _connect() as conn:
        conn.execute(
            "INSERT INTO conversations (id, title, created_at, updated_at) "
            "VALUES (?, ?, datetime('now'), datetime('now'))",
            (conv_id, title or DEFAULT_CONVERSATION_TITLE),
        )
    return conv_id


def list_conversations():
    with _connect() as conn:
        rows = conn.execute("""
            SELECT c.id, c.title, c.created_at, c.updated_at, COUNT(m.id)
            FROM conversations c
            LEFT JOIN messages m ON m.conversation_id = c.id
            GROUP BY c.id
            ORDER BY c.updated_at DESC
        """).fetchall()
    return [
        {"id": r[0], "title": r[1], "created_at": r[2], "updated_at": r[3], "message_count": r[4]}
        for r in rows
    ]


def _row_to_message(r):
    return {
        "id": r[0],
        "question": r[2],
        "answer": r[3],
        "key_points": json.loads(r[4]),
        "evidence": json.loads(r[5]),
        "confidence": r[6],
        "created_at": r[7],
    }


def get_conversation(conversation_id):
    with _connect() as conn:
        conv = conn.execute(
            "SELECT id, title, created_at, updated_at FROM conversations WHERE id = ?",
            (conversation_id,),
        ).fetchone()
        if conv is None:
            return None
        rows = conn.execute(
            "SELECT id, conversation_id, question, answer, key_points, evidence, confidence, created_at "
            "FROM messages WHERE conversation_id = ? ORDER BY created_at ASC",
            (conversation_id,),
        ).fetchall()
    return {
        "id": conv[0], "title": conv[1], "created_at": conv[2], "updated_at": conv[3],
        "messages": [_row_to_message(r) for r in rows],
    }


def rename_conversation(conversation_id, title):
    with _connect() as conn:
        cur = conn.execute(
            "UPDATE conversations SET title = ? WHERE id = ?", (title, conversation_id)
        )
    return cur.rowcount > 0


def delete_conversation(conversation_id):
    with _connect() as conn:
        conn.execute("DELETE FROM messages WHERE conversation_id = ?", (conversation_id,))
        cur = conn.execute("DELETE FROM conversations WHERE id = ?", (conversation_id,))
    return cur.rowcount > 0


def has_messages(conversation_id):
    with _connect() as conn:
        row = conn.execute(
            "SELECT 1 FROM messages WHERE conversation_id = ? LIMIT 1", (conversation_id,)
        ).fetchone()
    return row is not None


def get_recent_messages(conversation_id, limit=4):
    with _connect() as conn:
        rows = conn.execute(
            "SELECT id, conversation_id, question, answer, key_points, evidence, confidence, created_at "
            "FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?",
            (conversation_id, limit),
        ).fetchall()
    return [_row_to_message(r) for r in reversed(rows)]


def add_message(conversation_id, question, answer, key_points, evidence, confidence):
    msg_id = str(uuid.uuid4())
    with _connect() as conn:
        conn.execute(
            "INSERT INTO messages (id, conversation_id, question, answer, key_points, evidence, confidence, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))",
            (msg_id, conversation_id, question, answer, json.dumps(key_points), json.dumps(evidence), confidence),
        )
        conn.execute(
            "UPDATE conversations SET updated_at = datetime('now') WHERE id = ?", (conversation_id,)
        )
    return msg_id
