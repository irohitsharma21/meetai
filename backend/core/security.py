"""
Security utilities:
  - JWT token creation & validation
  - Argon2 password hashing (bcrypt kept as deprecated fallback)
  - AES-256-GCM field-level encryption for MongoDB
  - FastAPI dependencies for current user & role enforcement
"""

import base64
import os
from datetime import datetime, timedelta, timezone
from typing import Optional, Literal

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from passlib.context import CryptContext

from core.config import settings

# ── Password hashing (argon2 primary, bcrypt as deprecated fallback) ─────────
# bcrypt on Windows has a 72-byte hard limit that causes crashes — argon2 avoids this.
try:
    pwd_context = CryptContext(schemes=["argon2", "bcrypt"], deprecated=["bcrypt"])
except Exception:
    # argon2-cffi not available — fall back to sha256_crypt which has no length limit
    pwd_context = CryptContext(schemes=["sha256_crypt", "bcrypt"], deprecated=["bcrypt"])

# ── OAuth2 bearer scheme ──────────────────────────────────────────────────────
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login")

# ── Role type ─────────────────────────────────────────────────────────────────
Role = Literal["host", "participant", "admin"]


# ── JWT helpers ───────────────────────────────────────────────────────────────
def create_access_token(
    subject: str, role: Role = "participant", expires_delta: Optional[timedelta] = None
) -> str:
    """Create a signed JWT access token."""
    expire = datetime.now(timezone.utc) + (
        expires_delta or timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    )
    payload = {
        "sub": subject,
        "role": role,
        "exp": expire,
        "iat": datetime.now(timezone.utc),
        "type": "access",
    }
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def create_refresh_token(subject: str) -> str:
    """Create a long-lived refresh token."""
    expire = datetime.now(timezone.utc) + timedelta(
        days=settings.REFRESH_TOKEN_EXPIRE_DAYS
    )
    payload = {
        "sub": subject,
        "exp": expire,
        "iat": datetime.now(timezone.utc),
        "type": "refresh",
    }
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def decode_token(token: str) -> dict:
    """Decode and validate a JWT, raising 401 on failure."""
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(
            token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM]
        )
        return payload
    except JWTError:
        raise credentials_exception


# ── Password helpers ──────────────────────────────────────────────────────────
def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)


# ── AES-256-GCM field encryption (for sensitive MongoDB fields) ───────────────
class FieldEncryptor:
    """
    Encrypt / decrypt individual string fields using AES-256-GCM.
    The ciphertext is stored as base64: nonce(12B) || tag(16B) || ciphertext.
    """

    def __init__(self, key_b64: str):
        if not key_b64:
            self._enabled = False
            return
        raw = base64.b64decode(key_b64)
        if len(raw) != 32:
            raise ValueError("ENCRYPTION_KEY must be 32 bytes (256 bits) base64-encoded")
        self._aesgcm = AESGCM(raw)
        self._enabled = True

    @property
    def enabled(self) -> bool:
        return self._enabled

    def encrypt(self, plaintext: str) -> str:
        if not self._enabled:
            return plaintext
        nonce = os.urandom(12)
        ct = self._aesgcm.encrypt(nonce, plaintext.encode(), None)
        return base64.b64encode(nonce + ct).decode()

    def decrypt(self, ciphertext: str) -> str:
        if not self._enabled:
            return ciphertext
        raw = base64.b64decode(ciphertext)
        nonce, ct = raw[:12], raw[12:]
        return self._aesgcm.decrypt(nonce, ct, None).decode()


# Singleton encryptor
encryptor = FieldEncryptor(settings.ENCRYPTION_KEY)


# ── FastAPI dependency: get current user ──────────────────────────────────────
async def get_current_user(token: str = Depends(oauth2_scheme)) -> dict:
    payload = decode_token(token)
    if payload.get("type") != "access":
        raise HTTPException(status_code=401, detail="Invalid token type")
    return {"username": payload["sub"], "role": payload.get("role", "participant")}


# ── Role enforcement dependencies ─────────────────────────────────────────────
def require_role(*roles: Role):
    """Returns a FastAPI dependency that enforces one of the given roles."""

    async def _check(current_user: dict = Depends(get_current_user)):
        if current_user["role"] not in roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Role '{current_user['role']}' not permitted. Required: {roles}",
            )
        return current_user

    return _check


require_host = require_role("host", "admin")
require_any = get_current_user  # any authenticated user
