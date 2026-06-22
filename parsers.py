"""Heading-aware section extraction for HTML, DOCX, Markdown, PDF, and TXT files.

Each extractor returns a list of sections: [{"heading_path": [...], "text": "..."}].
PDF/TXT carry no reliable structural markup (PDF heading detection from font metrics
is a much harder, lower-value problem for personal notes-style PDFs), so they return
a single section per file with an empty heading_path; chunking still splits those by
word count downstream.
"""
import re
from pathlib import Path

import docx
import fitz  # PyMuPDF
from bs4 import BeautifulSoup

HTML_HEADING_LEVELS = {"h1": 1, "h2": 2, "h3": 3, "h4": 4, "h5": 5, "h6": 6}
TEXT_BEARING_TAGS = {"p", "li", "td", "th", "blockquote", "pre"}
MARKDOWN_HEADING_RE = re.compile(r"^(#{1,6})\s+(.*)$")
DOCX_HEADING_RE = re.compile(r"^Heading\s*(\d)$", re.IGNORECASE)


def _push_heading(stack, level, title):
    return [h for h in stack if h[0] < level] + [(level, title)]


def extract_html_sections(path):
    try:
        html = Path(path).read_text(encoding="utf-8", errors="ignore")
    except Exception as e:
        print(f"  ! failed to read {Path(path).name}: {e}")
        return []

    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "nav", "footer", "header"]):
        tag.decompose()

    sections = []
    heading_stack = []
    current_text = []

    def flush():
        text = "\n".join(t for t in current_text if t.strip())
        if text.strip():
            sections.append({"heading_path": [h[1] for h in heading_stack], "text": text})
        current_text.clear()

    root = soup.body or soup
    for el in root.descendants:
        name = getattr(el, "name", None)
        if name in HTML_HEADING_LEVELS:
            flush()
            level = HTML_HEADING_LEVELS[name]
            title = el.get_text(strip=True)
            heading_stack = _push_heading(heading_stack, level, title)
        elif name in TEXT_BEARING_TAGS:
            text = el.get_text(" ", strip=True)
            if text:
                current_text.append(text)

    flush()

    if not sections:
        # No semantic structure at all (no p/li/td/headings) - fall back to whatever
        # plain text the page has, as one section.
        text = root.get_text("\n", strip=True)
        if text:
            sections.append({"heading_path": [], "text": text})

    return sections


def extract_docx_sections(path):
    try:
        d = docx.Document(str(path))
    except Exception as e:
        print(f"  ! failed to read {Path(path).name}: {e}")
        return []

    sections = []
    heading_stack = []
    current_text = []

    def flush():
        text = "\n".join(current_text)
        if text.strip():
            sections.append({"heading_path": [h[1] for h in heading_stack], "text": text})
        current_text.clear()

    for p in d.paragraphs:
        text = p.text.strip()
        if not text:
            continue
        style_name = p.style.name if p.style else ""
        m = DOCX_HEADING_RE.match(style_name or "")
        if m:
            flush()
            level = int(m.group(1))
            heading_stack = _push_heading(heading_stack, level, text)
        else:
            current_text.append(text)

    flush()
    return sections


def extract_markdown_sections(path):
    try:
        text = Path(path).read_text(encoding="utf-8", errors="ignore")
    except Exception as e:
        print(f"  ! failed to read {Path(path).name}: {e}")
        return []

    sections = []
    heading_stack = []
    current_text = []
    in_code_block = False

    def flush():
        body = "\n".join(current_text).strip()
        if body:
            sections.append({"heading_path": [h[1] for h in heading_stack], "text": body})
        current_text.clear()

    for line in text.splitlines():
        if line.strip().startswith("```"):
            in_code_block = not in_code_block
            current_text.append(line)
            continue
        m = None if in_code_block else MARKDOWN_HEADING_RE.match(line)
        if m:
            flush()
            level = len(m.group(1))
            heading_stack = _push_heading(heading_stack, level, m.group(2).strip())
        else:
            current_text.append(line)

    flush()
    return sections


def extract_pdf_sections(path):
    try:
        doc = fitz.open(str(path))
        text = "\n".join(page.get_text() for page in doc)
        doc.close()
    except Exception as e:
        print(f"  ! failed to read {Path(path).name}: {e}")
        return []
    return [{"heading_path": [], "text": text}] if text.strip() else []


def extract_txt_sections(path):
    try:
        text = Path(path).read_text(encoding="utf-8", errors="ignore")
    except Exception as e:
        print(f"  ! failed to read {Path(path).name}: {e}")
        return []
    return [{"heading_path": [], "text": text}] if text.strip() else []


EXTRACTORS = {
    ".html": extract_html_sections,
    ".htm": extract_html_sections,
    ".docx": extract_docx_sections,
    ".md": extract_markdown_sections,
    ".markdown": extract_markdown_sections,
    ".pdf": extract_pdf_sections,
    ".txt": extract_txt_sections,
}

SUPPORTED_EXTENSIONS = set(EXTRACTORS.keys())


def extract_sections_by_extension(path):
    extractor = EXTRACTORS.get(Path(path).suffix.lower())
    return extractor(path) if extractor else []
