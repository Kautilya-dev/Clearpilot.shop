import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, Computed, DateTime, ForeignKey, Index, Integer, String, Text
from sqlalchemy.dialects.postgresql import TSVECTOR, UUID
from sqlalchemy.orm import Mapped, mapped_column

from db.base import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String, unique=True, index=True, nullable=False)
    hashed_password: Mapped[str] = mapped_column(String, nullable=False)
    display_name: Mapped[str] = mapped_column(String, nullable=False)
    # Shapes every AI-generated interview answer (web Copilot chat + desktop text/voice
    # Copilot + Job Mode's suggested answer) - not applied to Job Mode's coach/judge feedback.
    answer_format_mode: Mapped[str] = mapped_column(String, nullable=False, default="bullets")
    answer_length: Mapped[str] = mapped_column(String, nullable=False, default="medium")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


class Subject(Base):
    """Catalog of preloaded grounding topics. 'available' ones have a real Document
    corpus ingested; 'coming_soon' ones are catalog-only placeholders for the UI."""
    __tablename__ = "subjects"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    slug: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String, nullable=False)
    status: Mapped[str] = mapped_column(String, nullable=False, default="coming_soon")  # 'available' | 'coming_soon'
    description: Mapped[str] = mapped_column(String, nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


class Interview(Base):
    __tablename__ = "interviews"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False)
    title: Mapped[str] = mapped_column(String, nullable=False)
    state: Mapped[str] = mapped_column(String, nullable=False, default="active")  # 'active' | 'completed' | 'archived'
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


class InterviewSubject(Base):
    """Many-to-many: an interview can combine multiple subjects (e.g. a future
    'Python + React' interview)."""
    __tablename__ = "interview_subjects"

    interview_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("interviews.id", ondelete="CASCADE"), primary_key=True)
    subject_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("subjects.id", ondelete="CASCADE"), primary_key=True)


class Material(Base):
    __tablename__ = "materials"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False)
    interview_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("interviews.id", ondelete="CASCADE"), index=True, nullable=False)
    # 'resume' | 'job_description' | 'real_time_scenario' - validated at the API layer,
    # plain string here so adding a new type later doesn't need a migration.
    type: Mapped[str] = mapped_column(String, nullable=False)
    name: Mapped[str] = mapped_column(String, nullable=False)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


class QAEntry(Base):
    """Curated Q&A ('Q&A section' in the UI) - category/tags are AI-generated, not
    user-typed; see services/qa_classify_service.py."""
    __tablename__ = "qa_entries"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False)
    interview_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("interviews.id", ondelete="CASCADE"), index=True, nullable=False)
    question: Mapped[str] = mapped_column(Text, nullable=False)
    answer: Mapped[str] = mapped_column(Text, nullable=False)
    category: Mapped[str] = mapped_column(String, nullable=False, default="")
    tags: Mapped[str] = mapped_column(String, nullable=False, default="")  # comma-separated - simple, no separate table needed yet
    use_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


class HistoryEntry(Base):
    __tablename__ = "history_entries"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False)
    interview_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("interviews.id", ondelete="CASCADE"), index=True, nullable=False)
    question: Mapped[str] = mapped_column(Text, nullable=False)
    answer: Mapped[str] = mapped_column(Text, nullable=False)
    sources: Mapped[str] = mapped_column(Text, nullable=False, default="[]")  # JSON-encoded list of {title, breadcrumb}
    # Admin response-timing log (see routers/admin.py's /history endpoint) - nullable since
    # rows saved before this was added have no timing data. created_at doubles as "ended at":
    # it's set at INSERT time, which happens right after the stream finishes.
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=True)
    first_chunk_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=True)
    # Null means the default (unset) reasoning effort ran - only ever non-null for an
    # admin/tester's A/B test request (see routers/chat.py's reasoning_effort gating).
    reasoning_effort: Mapped[str] = mapped_column(String, nullable=True)
    # Populated on-demand by POST /admin/history/evaluate (services/answer_quality_service.py)
    # - null until an admin triggers evaluation, not computed automatically on every answer.
    grounding_score: Mapped[int] = mapped_column(Integer, nullable=True)
    logic_score: Mapped[int] = mapped_column(Integer, nullable=True)
    eval_notes: Mapped[str] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


class Document(Base):
    """Shared, system-wide grounding corpus (official docs per Subject) - not scoped
    to a user. Ingested once via scripts/ingest_sap_docs.py, read-only at request time.
    """
    __tablename__ = "documents"
    __table_args__ = (
        Index("ix_documents_search_vector", "search_vector", postgresql_using="gin"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    subject_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("subjects.id", ondelete="CASCADE"), index=True, nullable=False)
    source: Mapped[str] = mapped_column(String, nullable=False)  # 'sap-integration-suite-docs' | 'sap-learning-courses'
    title: Mapped[str] = mapped_column(String, nullable=False)
    breadcrumb: Mapped[str] = mapped_column(String, nullable=False, default="")
    url: Mapped[str] = mapped_column(String, nullable=False, default="")
    chunk_index: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    search_vector: Mapped[str] = mapped_column(
        TSVECTOR, Computed("to_tsvector('english', text)", persisted=True)
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
