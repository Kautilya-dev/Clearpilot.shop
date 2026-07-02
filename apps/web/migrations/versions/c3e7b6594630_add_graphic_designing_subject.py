"""add graphic designing subject

Revision ID: c3e7b6594630
Revises: 02012c07ea8b
Create Date: 2026-07-02 00:00:00.000000

"""
import uuid
from datetime import datetime, timezone
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = 'c3e7b6594630'
down_revision: Union[str, None] = '02012c07ea8b'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    now = datetime.now(timezone.utc)
    subjects_table = sa.table(
        'subjects',
        sa.column('id', sa.UUID()), sa.column('slug', sa.String()), sa.column('name', sa.String()),
        sa.column('status', sa.String()), sa.column('description', sa.String()),
        sa.column('created_at', sa.DateTime(timezone=True)),
    )
    op.bulk_insert(subjects_table, [
        {'id': uuid.uuid4(), 'slug': 'graphic-designing', 'name': 'Graphic Designing',
         'status': 'coming_soon', 'description': '', 'created_at': now},
    ])


def downgrade() -> None:
    op.execute(sa.text("DELETE FROM subjects WHERE slug = 'graphic-designing'"))
