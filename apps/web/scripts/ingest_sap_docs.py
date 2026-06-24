"""One-time/operational ingestion of the SAP documentation grounding corpus.

Run locally (not part of the deployed app - the source HTML files aren't in the
repo or on Railway, only the resulting rows are):

    venv/Scripts/python.exe scripts/ingest_sap_docs.py [--docs-root PATH] [--courses-root PATH]

Re-running is safe: each source is fully replaced (delete-then-insert) rather
than appended, so this can be re-run after the source folders change.
"""
import argparse
import asyncio
import os
import re
from pathlib import Path

import asyncpg
from bs4 import BeautifulSoup
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

SOURCE_RE = re.compile(r"<!--\s*source:\s*(.*?)\s*-->")
BREADCRUMB_RE = re.compile(r"<!--\s*breadcrumb:\s*(.*?)\s*-->")
COURSE_RE = re.compile(r"<!--\s*course:\s*(.*?)\s*-->")

CHUNK_SIZE_WORDS = 300
CHUNK_OVERLAP_WORDS = 50


def chunk_text(text: str, chunk_size: int = CHUNK_SIZE_WORDS, overlap: int = CHUNK_OVERLAP_WORDS) -> list[str]:
    words = text.split()
    if len(words) <= chunk_size:
        return [text] if words else []

    chunks = []
    start = 0
    while start < len(words):
        end = start + chunk_size
        chunks.append(" ".join(words[start:end]))
        if end >= len(words):
            break
        start = end - overlap
    return chunks


def parse_html_file(path: Path, fallback_breadcrumb: str) -> dict | None:
    raw = path.read_text(encoding="utf-8", errors="ignore")

    source_match = SOURCE_RE.search(raw)
    breadcrumb_match = BREADCRUMB_RE.search(raw)
    course_match = COURSE_RE.search(raw)

    soup = BeautifulSoup(raw, "html.parser")

    title = ""
    if soup.title and soup.title.string:
        title = soup.title.string.split("|")[0].strip()
    if not title:
        title = path.stem

    body = soup.body or soup
    text = body.get_text(separator=" ", strip=True)
    # Strip leaked icon-font glyphs (Unicode Private Use Area) and other non-printable
    # noise that scraped through from styled UI chrome - not real content.
    text = "".join(ch for ch in text if not (0xE000 <= ord(ch) <= 0xF8FF) and (ch.isprintable() or ch.isspace()))
    text = re.sub(r"\s+", " ", text).strip()

    if len(text.split()) < 5:
        return None  # skip empty/stub pages

    breadcrumb = breadcrumb_match.group(1) if breadcrumb_match else fallback_breadcrumb
    if course_match:
        breadcrumb = course_match.group(1)

    return {
        "title": title,
        "breadcrumb": breadcrumb,
        "url": source_match.group(1) if source_match else "",
        "text": text,
    }


def collect_chunks(root: Path, source_label: str) -> list[dict]:
    rows = []
    for html_path in root.rglob("*.html"):
        rel_parts = html_path.relative_to(root).parent.parts
        fallback_breadcrumb = " > ".join(rel_parts) if rel_parts else ""

        parsed = parse_html_file(html_path, fallback_breadcrumb)
        if not parsed:
            continue

        for i, chunk in enumerate(chunk_text(parsed["text"])):
            rows.append(
                {
                    "source": source_label,
                    "title": parsed["title"],
                    "breadcrumb": parsed["breadcrumb"],
                    "url": parsed["url"],
                    "chunk_index": i,
                    "text": chunk,
                }
            )
    return rows


async def ingest(docs_root: Path, courses_root: Path):
    database_url = os.environ["DATABASE_URL"]
    conn = await asyncpg.connect(database_url)

    try:
        for root, label in [(docs_root, "sap-integration-suite-docs"), (courses_root, "sap-learning-courses")]:
            if not root.exists():
                print(f"Skipping {label}: {root} does not exist")
                continue

            print(f"Parsing {label} from {root} ...")
            rows = collect_chunks(root, label)
            print(f"  {len(rows)} chunks from {label}")

            await conn.execute("DELETE FROM documents WHERE source = $1", label)
            await conn.executemany(
                """
                INSERT INTO documents (id, source, title, breadcrumb, url, chunk_index, text, created_at)
                VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, now())
                """,
                [(label, r["title"], r["breadcrumb"], r["url"], r["chunk_index"], r["text"]) for r in rows],
            )
            print(f"  inserted {len(rows)} rows for {label}")

        total = await conn.fetchval("SELECT count(*) FROM documents")
        print(f"Done. documents table now has {total} rows total.")
    finally:
        await conn.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    script_dir = Path(__file__).resolve().parent
    my_app_root = script_dir.parent.parent.parent.parent  # scripts -> web -> apps -> Clearpilot.shop -> MyApp
    parser.add_argument("--docs-root", type=Path, default=my_app_root / "SAP-Integration-Suite-Docs")
    parser.add_argument("--courses-root", type=Path, default=my_app_root / "SAP-Learning-Courses")
    args = parser.parse_args()

    asyncio.run(ingest(args.docs_root, args.courses_root))
