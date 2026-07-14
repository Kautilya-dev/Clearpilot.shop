"""add quality scores to history_entries

Revision ID: c3d4e5f6a7b8
Revises: b2c3d4e5f6a7
Create Date: 2026-07-14 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = 'c3d4e5f6a7b8'
down_revision: Union[str, None] = 'b2c3d4e5f6a7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('history_entries', sa.Column('grounding_score', sa.Integer(), nullable=True))
    op.add_column('history_entries', sa.Column('logic_score', sa.Integer(), nullable=True))
    op.add_column('history_entries', sa.Column('eval_notes', sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column('history_entries', 'eval_notes')
    op.drop_column('history_entries', 'logic_score')
    op.drop_column('history_entries', 'grounding_score')
