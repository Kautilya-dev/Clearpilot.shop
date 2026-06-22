"""Splits heading-tagged sections (from parsers.py) into word-count-capped chunks,
tagging every chunk with its source file and heading path for citation later.
"""
CHUNK_WORDS = 250
MIN_CHUNK_WORDS = 20


def _format_section(heading_path):
    return " > ".join(heading_path) if heading_path else ""


def chunk_sections(sections, source, chunk_words=CHUNK_WORDS, min_words=MIN_CHUNK_WORDS):
    chunks = []
    for section in sections:
        words = section["text"].split()
        if not words:
            continue
        section_label = _format_section(section.get("heading_path", []))
        pieces = [words[i:i + chunk_words] for i in range(0, len(words), chunk_words)]
        for piece in pieces:
            # Drop tiny tail remainders from a long section, but never drop the only
            # piece a short section has - otherwise brief headed sections vanish entirely.
            if len(piece) < min_words and len(pieces) > 1:
                continue
            chunks.append({"text": " ".join(piece), "source": source, "section": section_label})
    return chunks
