import io

from docx import Document as DocxDocument
from fastapi import HTTPException, status
from pypdf import PdfReader

MAX_UPLOAD_BYTES = 10 * 1024 * 1024


def extract_text(filename: str, content: bytes) -> str:
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="File too large (max 10MB)")

    suffix = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""

    if suffix == "pdf":
        reader = PdfReader(io.BytesIO(content))
        text = "\n\n".join(page.extract_text() or "" for page in reader.pages).strip()
    elif suffix == "docx":
        doc = DocxDocument(io.BytesIO(content))
        text = "\n".join(p.text for p in doc.paragraphs).strip()
    elif suffix in ("txt", "md"):
        text = content.decode("utf-8", errors="replace").strip()
    else:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported file type '.{suffix}' - upload a PDF, DOCX, or TXT file.",
        )

    if not text:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No text could be extracted from this file")
    return text
