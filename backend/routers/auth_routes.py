"""
Auth routes:
  POST /auth/register  – register new user
  POST /auth/login     – login (OAuth2 password form)
  POST /auth/refresh   – refresh access token
  GET  /auth/me        – get current user profile
  PUT  /auth/me/language – set the caller's native language
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
from core.languages import DEFAULT_LANGUAGE, normalise
from models.meeting_model import (
    TokenResponse,
    UpdateLanguageRequest,
    UserCreate,
    UserResponse,
)

router = APIRouter(prefix="/auth", tags=["auth"])


def _user_response(user: dict) -> UserResponse:
    """
    One place that turns a users document into the public profile.

    Documents written before a field existed simply lack it, so every optional
    field is read with the same default the model declares; a stored language
    code that has since left the table reads as English rather than a 500.
    """
    return UserResponse(
        username=user["username"],
        email=user["email"],
        display_name=user.get("display_name"),
        role=user.get("role", "participant"),
        created_at=user["created_at"],
        native_language=normalise(user.get("native_language")) or DEFAULT_LANGUAGE,
    )


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
        "native_language": payload.native_language or DEFAULT_LANGUAGE,
        "created_at": datetime.now(timezone.utc),
        "is_active": True,
    }
    await col.insert_one(user_doc)

    # display_name as sent (possibly None), not the username fallback that was
    # stored - the response has always echoed the request here.
    return _user_response({**user_doc, "display_name": payload.display_name})


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

    return _user_response(user)


@router.put("/me/language", response_model=UserResponse)
async def set_my_language(
    payload: UpdateLanguageRequest,
    current_user: dict = Depends(get_current_user),
):
    """
    Change the caller's native language.

    This is the account-level default: the language their speech is decoded in
    and translations are delivered in. A meeting can still override what they
    are *speaking* for the moment ("I'm speaking: English"); that override is
    per meeting and lives with the translation service, not here. Streams that
    are already open keep their language until the speaker rejoins or changes
    it in the room, so a profile edit never cuts someone off mid-sentence.
    """
    col = get_users_collection()
    # update_one + find_one rather than find_one_and_update: the SQLite
    # backend implements the common collection surface, not every Mongo call.
    await col.update_one(
        {"username": current_user["username"]},
        {"$set": {"native_language": payload.native_language}},
    )
    user = await col.find_one({"username": current_user["username"]})
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    # Translation caches each user's native language; without this the new
    # choice would take up to its refresh interval to reach live meetings.
    try:
        from services.translation_service import translation_service
        translation_service.forget_user(current_user["username"])
    except Exception as exc:
        print(f"[translation] cache refresh for {current_user['username']} skipped: {exc}")
    return _user_response(user)
