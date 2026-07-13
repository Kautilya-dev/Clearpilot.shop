import jwt
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, EmailStr
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from db.base import get_db
from db.models import User
from services.auth_service import create_access_token, decode_access_token, hash_password, verify_password
from services.desktop_auth_service import consume_desktop_code, create_desktop_code

router = APIRouter(prefix="/auth", tags=["auth"])
_bearer = HTTPBearer()


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str
    display_name: str


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


class UserResponse(BaseModel):
    id: str
    email: str
    display_name: str
    answer_format_mode: str
    answer_length: str


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(_bearer),
    db: AsyncSession = Depends(get_db),
) -> User:
    try:
        user_id = decode_access_token(credentials.credentials)
    except jwt.PyJWTError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired token")

    user = await db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    return user


@router.post("/register", response_model=TokenResponse)
async def register(body: RegisterRequest, db: AsyncSession = Depends(get_db)):
    existing = await db.scalar(select(User).where(User.email == body.email))
    if existing:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Email already registered")

    try:
        hashed_password = hash_password(body.password)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))

    user = User(email=body.email, hashed_password=hashed_password, display_name=body.display_name)
    db.add(user)
    await db.commit()
    await db.refresh(user)

    return TokenResponse(access_token=create_access_token(user.id))


@router.post("/login", response_model=TokenResponse)
async def login(body: LoginRequest, db: AsyncSession = Depends(get_db)):
    user = await db.scalar(select(User).where(User.email == body.email))
    if not user or not verify_password(body.password, user.hashed_password):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Incorrect email or password")

    return TokenResponse(access_token=create_access_token(user.id))


class DesktopCodeResponse(BaseModel):
    code: str


@router.post("/desktop-code", response_model=DesktopCodeResponse)
async def get_desktop_code(current_user: User = Depends(get_current_user)):
    """Called from the browser, right after a normal password login, when that login
    was opened by the desktop app's "Sign in with Browser" flow. Mints a short-lived,
    single-use code the browser then hands to the desktop app via a clearpilot:// redirect."""
    try:
        code = await create_desktop_code(current_user.id)
    except RuntimeError as e:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(e))
    return DesktopCodeResponse(code=code)


class DesktopExchangeRequest(BaseModel):
    code: str


@router.post("/desktop-exchange", response_model=TokenResponse)
async def desktop_exchange(body: DesktopExchangeRequest, db: AsyncSession = Depends(get_db)):
    """Called by the desktop app itself with the code it received via the clearpilot://
    redirect, to get a real JWT. Deliberately unauthenticated (there's no token yet) -
    the code itself, valid for 5 minutes and single-use, is the credential here."""
    user_id = await consume_desktop_code(body.code)
    if user_id is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid or expired code")
    user = await db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid or expired code")
    return TokenResponse(access_token=create_access_token(user.id))


@router.get("/me", response_model=UserResponse)
async def me(current_user: User = Depends(get_current_user)):
    return UserResponse(
        id=str(current_user.id), email=current_user.email, display_name=current_user.display_name,
        answer_format_mode=current_user.answer_format_mode, answer_length=current_user.answer_length,
    )


class UpdateProfileRequest(BaseModel):
    display_name: str


@router.patch("/me", response_model=UserResponse)
async def update_profile(
    body: UpdateProfileRequest, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    current_user.display_name = body.display_name
    await db.commit()
    await db.refresh(current_user)
    return UserResponse(
        id=str(current_user.id), email=current_user.email, display_name=current_user.display_name,
        answer_format_mode=current_user.answer_format_mode, answer_length=current_user.answer_length,
    )


class UpdatePreferencesRequest(BaseModel):
    answer_format_mode: str
    answer_length: str


@router.patch("/me/preferences", response_model=UserResponse)
async def update_preferences(
    body: UpdatePreferencesRequest, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    valid_modes = {"bullets", "star", "concise", "detailed"}
    valid_lengths = {"short", "medium", "one_minute", "long"}
    if body.answer_format_mode not in valid_modes:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid answer_format_mode")
    if body.answer_length not in valid_lengths:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid answer_length")
    # 1 Minute only makes sense paired with a format that actually fills 130-160 words with
    # real substance - Bullets/Concise are built to be terse. Mirrors the UI-side gating in
    # settings.html / AnswerTemplateTab.jsx; enforced here too so the API can't be used to
    # save the combination directly.
    if body.answer_length == "one_minute" and body.answer_format_mode not in {"detailed", "star"}:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="1 Minute length requires Detailed or STAR format",
        )
    current_user.answer_format_mode = body.answer_format_mode
    current_user.answer_length = body.answer_length
    await db.commit()
    await db.refresh(current_user)
    return UserResponse(
        id=str(current_user.id), email=current_user.email, display_name=current_user.display_name,
        answer_format_mode=current_user.answer_format_mode, answer_length=current_user.answer_length,
    )


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


@router.post("/change-password", status_code=status.HTTP_204_NO_CONTENT)
async def change_password(
    body: ChangePasswordRequest, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    if not verify_password(body.current_password, current_user.hashed_password):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Current password is incorrect")
    try:
        current_user.hashed_password = hash_password(body.new_password)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    await db.commit()


@router.delete("/me", status_code=status.HTTP_204_NO_CONTENT)
async def delete_account(current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    # Materials/KB/history rows cascade-delete via their FK's ondelete="CASCADE"
    await db.delete(current_user)
    await db.commit()
