"""add shopify wordpress python react subjects

Revision ID: d7f733741d7a
Revises: f85e3e6c321f
Create Date: 2026-07-02 00:00:00.000000

"""
import uuid
from datetime import datetime, timezone
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = 'd7f733741d7a'
down_revision: Union[str, None] = 'f85e3e6c321f'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Catalog-only placeholders (status='coming_soon'), same pattern as salesforce/servicenow -
    # no ingested Document corpus. Unlike sap-integration-suite, these are mainstream,
    # heavily-documented technologies the model already answers well without grounding;
    # the plan when these go live is per-interview Q&A banks + materials, not a shared corpus.
    now = datetime.now(timezone.utc)
    subjects_table = sa.table(
        'subjects',
        sa.column('id', sa.UUID()), sa.column('slug', sa.String()), sa.column('name', sa.String()),
        sa.column('status', sa.String()), sa.column('description', sa.String()),
        sa.column('created_at', sa.DateTime(timezone=True)),
    )
    op.bulk_insert(subjects_table, [
        {'id': uuid.uuid4(), 'slug': 'shopify', 'name': 'Shopify',
         'status': 'coming_soon', 'description': '', 'created_at': now},
        {'id': uuid.uuid4(), 'slug': 'wordpress', 'name': 'WordPress',
         'status': 'coming_soon', 'description': '', 'created_at': now},
        {'id': uuid.uuid4(), 'slug': 'python', 'name': 'Python',
         'status': 'coming_soon', 'description': '', 'created_at': now},
        {'id': uuid.uuid4(), 'slug': 'react', 'name': 'React',
         'status': 'coming_soon', 'description': '', 'created_at': now},
    ])


def downgrade() -> None:
    op.execute(sa.text("DELETE FROM subjects WHERE slug IN ('shopify', 'wordpress', 'python', 'react')"))
