"""
Auth routes:
  POST /auth/register  – register new user
  POST /auth/login     – login (OAuth2 password form)
  POST /auth/refresh   – refresh access token
  GET  /auth/me        – get current user profile
"""

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordRequestForm

from core.security import (
    create_access_token,
    create_refresh_token,
    decode_token,
    get_current_user,
    hash_password,
    verify_password,
)
from core.config import settings
from db.mongodb import get_users_collection
from models.meeting_model import TokenResponse, UserCreate, UserResponse

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/register", status_code=status.HTTP_201_CREATED, response_model=UserResponse)
async def register(payload: UserCreate):
    col = get_users_collection()

    # Check uniqueness
    if await col.find_one({"$or": [{"username": payload.username}, {"email": payload.email}]}):
        raise HTTPException(status_code=409, detail="Username or email already exists")

    user_doc = {
        "username": payload.username,
        "email": payload.email,
        "display_name": payload.display_name or payload.username,
        "hashed_password": hash_password(payload.password),
        "role": payload.role,
        "created_at": datetime.now(timezone.utc),
        "is_active": True,
    }
    await col.insert_one(user_doc)

    return UserResponse(
        username=payload.username,
        email=payload.email,
        display_name=payload.display_name,
        role=payload.role,
        created_at=user_doc["created_at"],
    )


@router.post("/login", response_model=TokenResponse)
async def login(form_data: OAuth2PasswordRequestForm = Depends()):
    col = get_users_collection()
    user = await col.find_one({"username": form_data.username})

    if not user or not verify_password(form_data.password, user["hashed_password"]):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password",
            headers={"WWW-Authenticate": "Bearer"},
        )

    access = create_access_token(subject=user["username"], role=user.get("role", "participant"))
    refresh = create_refresh_token(subject=user["username"])

    return TokenResponse(
        access_token=access,
        refresh_token=refresh,
        expires_in=settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
    )


@router.post("/refresh", response_model=TokenResponse)
async def refresh_token(refresh_token: str):
    payload = decode_token(refresh_token)
    if payload.get("type") != "refresh":
        raise HTTPException(status_code=401, detail="Invalid refresh token")

    col = get_users_collection()
    user = await col.find_one({"username": payload["sub"]})
    if not user:
        raise HTTPException(status_code=401, detail="User not found")

    access = create_access_token(subject=user["username"], role=user.get("role", "participant"))
    new_refresh = create_refresh_token(subject=user["username"])

    return TokenResponse(
        access_token=access,
        refresh_token=new_refresh,
        expires_in=settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
    )


@router.get("/me", response_model=UserResponse)
async def get_me(current_user: dict = Depends(get_current_user)):
    col = get_users_collection()
    user = await col.find_one({"username": current_user["username"]})
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    return UserResponse(
        username=user["username"],
        email=user["email"],
        display_name=user.get("display_name"),
        role=user.get("role", "participant"),
        created_at=user["created_at"],
    )
