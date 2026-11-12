from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    public_host: str = "localhost"
    admin_host: str = "admin.localhost"
    secure_cookies: bool = True
    cookie_max_age: int | None = None
    content_root: Path | None = None
    catalog_path: Path | None = None
    catalog_image_root: Path | None = None
    face_model: Path | None = None
    max_upload_bytes: int = 12 * 1024 * 1024
    max_pixels: int = 24_000_000
    max_image_dimension: int = 8000
    face_min_pixels: int = 40
    face_min_fraction: float = 0.025
    detector_score_threshold: float = 0.85
    image_concurrency: int = 1

    @classmethod
    def from_env(cls):
        import os

        def path(name):
            value = os.environ.get(name)
            return Path(value).expanduser() if value else None

        return cls(
            data_dir=path("YIXU_DATA_DIR") or Path.home() / ".local/share/yixu-wardrobe",
            public_host=os.environ.get("YIXU_PUBLIC_HOST", "localhost"),
            admin_host=os.environ.get("YIXU_ADMIN_HOST", "admin.localhost"),
            secure_cookies=os.environ.get("YIXU_SECURE_COOKIES", "true").lower()
            not in ("false", "0"),
            content_root=path("YIXU_CONTENT_ROOT")
            or ((path("YIXU_IMAGE_ROOT") or Path(__file__).resolve().parent.parent) / "content"),
            catalog_path=path("YIXU_CATALOG_PATH"),
            catalog_image_root=path("YIXU_IMAGE_ROOT"),
            face_model=path("YIXU_FACE_MODEL"),
            cookie_max_age=int(os.environ["YIXU_COOKIE_MAX_AGE"])
            if os.environ.get("YIXU_COOKIE_MAX_AGE")
            else None,
            max_upload_bytes=int(os.environ.get("YIXU_MAX_UPLOAD_BYTES", str(12 * 1024 * 1024))),
            max_pixels=int(os.environ.get("YIXU_MAX_PIXELS", "24000000")),
            max_image_dimension=int(os.environ.get("YIXU_MAX_IMAGE_DIMENSION", "8000")),
            face_min_pixels=int(os.environ.get("YIXU_FACE_MIN_PIXELS", "40")),
            face_min_fraction=float(os.environ.get("YIXU_FACE_MIN_FRACTION", "0.025")),
            detector_score_threshold=float(os.environ.get("YIXU_DETECTOR_SCORE_THRESHOLD", "0.85")),
            image_concurrency=int(os.environ.get("YIXU_IMAGE_CONCURRENCY", "1")),
        )


# Never populated from ambient assistant/CLI credentials or system proxy variables.
import json
from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .files import atomic_write


class Runtime(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool = False
    model: str = Field(default="gpt-image-1.5", min_length=1, max_length=128)
    api_base: str = "https://api.openai.com/v1"
    proxy_url: str = "http://127.0.0.1:7890"
    api_key: str = Field(default="", max_length=4096, repr=False)
    size: Literal["1024x1536", "1024x1024", "1536x1024"] = "1024x1536"
    quality: Literal["low", "medium", "high", "auto"] = "high"
    provider_timeout_seconds: int = Field(default=180, ge=1, le=3600)

    @field_validator("api_base")
    @classmethod
    def api_url(cls, value):
        parsed = urlsplit(value)
        if (
            parsed.scheme != "https"
            or not parsed.hostname
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError("HTTPS API base required without credentials or query")
        return value.rstrip("/")

    @field_validator("proxy_url")
    @classmethod
    def proxy(cls, value):
        parsed = urlsplit(value)
        if (
            parsed.scheme != "http"
            or parsed.hostname not in ("127.0.0.1", "localhost", "::1")
            or not parsed.port
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
            or parsed.path not in ("", "/")
        ):
            raise ValueError("Explicit loopback HTTP proxy required; no direct fallback")
        return value

    def redacted(self):
        return {**self.model_dump(exclude={"api_key"}), "api_key_configured": bool(self.api_key)}


class RuntimePatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool | None = None
    model: str | None = None
    api_base: str | None = None
    proxy_url: str | None = None
    api_key: str | None = Field(default=None, repr=False)
    clear_api_key: bool = False
    size: str | None = None
    quality: str | None = None
    provider_timeout_seconds: int | None = None


class RuntimeFile:
    def __init__(self, root):
        self.path = root / "runtime.json"

    def load(self) -> Runtime:
        if not self.path.exists():
            return Runtime()
        return Runtime.model_validate_json(self.path.read_bytes())

    def update(self, patch: RuntimePatch) -> Runtime:
        values = self.load().model_dump()
        changes = patch.model_dump(exclude_none=True, exclude={"clear_api_key"})
        if not changes.get("api_key"):
            changes.pop("api_key", None)
        values.update(changes)
        if patch.clear_api_key:
            values["api_key"] = ""
        updated = Runtime.model_validate(values)
        atomic_write(self.path, json.dumps(updated.model_dump()).encode())
        return updated
