"""add timing columns to history_entries

Revision ID: a1b2c3d4e5f6
Revises: c3e7b6594630
Create Date: 2026-07-13 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = 'a1b2c3d4e5f6'
down_revision: Union[str, None] = 'c3e7b6594630'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Nullable, no backfill - existing rows predate this tracking and simply show blank
    # in the admin timing log rather than a misleading fabricated value.
    op.add_column('history_entries', sa.Column('started_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('history_entries', sa.Column('first_chunk_at', sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column('history_entries', 'first_chunk_at')
    op.drop_column('history_entries', 'started_at')
