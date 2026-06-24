from typing import Literal, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from db.base import get_db
from db.models import Material, User
from routers.auth import get_current_user

router = APIRouter(prefix="/materials", tags=["materials"])

MaterialType = Literal["resume", "job_description", "project_spec", "domain_knowledge"]


class CreateMaterialRequest(BaseModel):
    type: MaterialType
    name: str
    text: str


class UpdateMaterialRequest(BaseModel):
    name: Optional[str] = None
    text: Optional[str] = None
    active: Optional[bool] = None


class MaterialResponse(BaseModel):
    id: str
    type: str
    name: str
    text: str
    active: bool
    created_at: str


def _to_response(m: Material) -> MaterialResponse:
    return MaterialResponse(
        id=str(m.id), type=m.type, name=m.name, text=m.text, active=m.active, created_at=m.created_at.isoformat()
    )


async def _get_owned_material(material_id: UUID, current_user: User, db: AsyncSession) -> Material:
    material = await db.get(Material, material_id)
    if not material or material.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Material not found")
    return material


@router.post("", response_model=MaterialResponse)
async def create_material(
    body: CreateMaterialRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    material = Material(user_id=current_user.id, type=body.type, name=body.name, text=body.text)
    db.add(material)
    await db.commit()
    await db.refresh(material)
    return _to_response(material)


@router.get("", response_model=list[MaterialResponse])
async def list_materials(
    type: Optional[MaterialType] = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    query = select(Material).where(Material.user_id == current_user.id)
    if type:
        query = query.where(Material.type == type)
    query = query.order_by(Material.created_at.desc())
    result = await db.scalars(query)
    return [_to_response(m) for m in result]


@router.get("/{material_id}", response_model=MaterialResponse)
async def get_material(
    material_id: UUID, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    material = await _get_owned_material(material_id, current_user, db)
    return _to_response(material)


@router.patch("/{material_id}", response_model=MaterialResponse)
async def update_material(
    material_id: UUID,
    body: UpdateMaterialRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    material = await _get_owned_material(material_id, current_user, db)
    if body.name is not None:
        material.name = body.name
    if body.text is not None:
        material.text = body.text
    if body.active is not None:
        material.active = body.active
    await db.commit()
    await db.refresh(material)
    return _to_response(material)


@router.delete("/{material_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_material(
    material_id: UUID, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    material = await _get_owned_material(material_id, current_user, db)
    await db.delete(material)
    await db.commit()
