"""add answer template preference to users

Revision ID: 02012c07ea8b
Revises: d7f733741d7a
Create Date: 2026-07-02 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '02012c07ea8b'
down_revision: Union[str, None] = 'd7f733741d7a'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # server_default (not just the ORM-side default=) means Postgres backfills every
    # existing row as part of ADD COLUMN itself - no separate UPDATE needed to satisfy
    # NOT NULL, and 'bullets'/'medium' match today's implicit answer behavior so existing
    # users see no change until they actually visit the new setting.
    op.add_column('users', sa.Column('answer_format_mode', sa.String(), nullable=False, server_default='bullets'))
    op.add_column('users', sa.Column('answer_length', sa.String(), nullable=False, server_default='medium'))


def downgrade() -> None:
    op.drop_column('users', 'answer_length')
    op.drop_column('users', 'answer_format_mode')
