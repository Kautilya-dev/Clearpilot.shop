"""Persistent storage: Chroma holds chunk vectors + metadata, SQLite holds the
document registry (filenames, status, counts - not per-chunk data).

Both live under DATA_DIR (default: this app's directory for local dev; point it at
a mounted Railway Volume in production so uploads/index survive redeploys).
"""
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
