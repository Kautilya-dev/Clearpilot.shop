from typing import Literal, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from db.base import get_db
from db.models import Interview, Material, User
from routers.auth import get_current_user
from routers.interviews import get_owned_interview
from services.file_extract_service import extract_text

router = APIRouter(tags=["materials"])

MaterialType = Literal["resume", "job_description", "real_time_scenario"]


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


async def _get_owned_material(material_id: UUID, interview: Interview, db: AsyncSession) -> Material:
    material = await db.get(Material, material_id)
    if not material or material.interview_id != interview.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Material not found")
    return material


@router.post("/interviews/{interview_id}/materials", response_model=MaterialResponse)
async def create_material(
    body: CreateMaterialRequest,
    interview: Interview = Depends(get_owned_interview),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    material = Material(
        user_id=current_user.id, interview_id=interview.id, type=body.type, name=body.name, text=body.text
    )
    db.add(material)
    await db.commit()
    await db.refresh(material)
    return _to_response(material)


@router.post("/interviews/{interview_id}/materials/upload", response_model=MaterialResponse)
async def upload_material(
    type: MaterialType = Form(...),
    name: Optional[str] = Form(None),
    file: UploadFile = File(...),
    interview: Interview = Depends(get_owned_interview),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    content = await file.read()
    if not content:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Uploaded file is empty")
    text = extract_text(file.filename or "", content)

    material = Material(
        user_id=current_user.id, interview_id=interview.id, type=type,
        name=name or file.filename or "Untitled", text=text,
    )
    db.add(material)
    await db.commit()
    await db.refresh(material)
    return _to_response(material)


@router.get("/interviews/{interview_id}/materials", response_model=list[MaterialResponse])
async def list_materials(
    type: Optional[MaterialType] = None,
    interview: Interview = Depends(get_owned_interview),
    db: AsyncSession = Depends(get_db),
):
    query = select(Material).where(Material.interview_id == interview.id)
    if type:
        query = query.where(Material.type == type)
    query = query.order_by(Material.created_at.desc())
    result = await db.scalars(query)
    return [_to_response(m) for m in result]


@router.get("/interviews/{interview_id}/materials/{material_id}", response_model=MaterialResponse)
async def get_material(
    material_id: UUID, interview: Interview = Depends(get_owned_interview), db: AsyncSession = Depends(get_db)
):
    material = await _get_owned_material(material_id, interview, db)
    return _to_response(material)


@router.patch("/interviews/{interview_id}/materials/{material_id}", response_model=MaterialResponse)
async def update_material(
    material_id: UUID,
    body: UpdateMaterialRequest,
    interview: Interview = Depends(get_owned_interview),
    db: AsyncSession = Depends(get_db),
):
    material = await _get_owned_material(material_id, interview, db)
    if body.name is not None:
        material.name = body.name
    if body.text is not None:
        material.text = body.text
    if body.active is not None:
        material.active = body.active
    await db.commit()
    await db.refresh(material)
    return _to_response(material)


@router.delete("/interviews/{interview_id}/materials/{material_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_material(
    material_id: UUID, interview: Interview = Depends(get_owned_interview), db: AsyncSession = Depends(get_db)
):
    material = await _get_owned_material(material_id, interview, db)
    await db.delete(material)
    await db.commit()
