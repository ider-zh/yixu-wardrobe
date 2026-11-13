"""Verified Git content projection and durable, allowlisted public WebP archive.

Only declared public assets enter this service. Private try-on storage is never scanned.
A bad release leaves the last complete revision active, including across restarts.
"""

import copy
import hashlib
import io
import json
import re
import sqlite3
from datetime import UTC, date, datetime
from pathlib import PurePosixPath
from typing import Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException, Query
from PIL import Image
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from starlette.responses import Response

from .files import atomic_write


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Layout(Strict):
    rows: Literal[3]
    columns: Literal[3]
    preview_panel: int = Field(ge=1, le=9)


class Asset(Strict):
    asset_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,128}$")
    file: str
    mime: Literal["image/webp"]
    width: int = Field(strict=True, ge=32, le=8000)
    height: int = Field(strict=True, ge=32, le=8000)
    bytes: int = Field(strict=True, ge=1, le=50 * 1024 * 1024)
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    visibility: Literal["public", "private"]
    layout: Layout | None = None

    @field_validator("file")
    @classmethod
    def relative_file(cls, value):
        path = PurePosixPath(value)
        if (
            not value
            or path.is_absolute()
            or "\\" in value
            or any(part in ("", ".", "..") for part in value.split("/"))
            or path.suffix != ".webp"
            or path.parts[0] not in ("assets", "images-v2")
        ):
            raise ValueError("Expected a relative public WebP asset path")
        return value


class Model(Strict):
    model_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,128}$")
    name: str = Field(min_length=1, max_length=200)
    reference: Asset
    views: list[str] = Field(min_length=1, max_length=16)
    enabled: bool = True


class Models(Strict):
    schema_version: Literal[1]
    models: list[Model]


class Shot(Strict):
    index: int = Field(strict=True, ge=1, le=9)
    title: str = Field(min_length=1, max_length=200)
    emotion: str = Field(min_length=1, max_length=1000)
    pose: str = Field(min_length=1, max_length=1000)
    framing: str = Field(min_length=1, max_length=1000)


class Piece(Strict):
    role: str = Field(min_length=1, max_length=100)
    name: str = Field(min_length=1, max_length=500)


class ProductAppearance(Strict):
    look_id: int = Field(strict=True, ge=1)
    piece_index: int = Field(strict=True, ge=1)
    reference_asset_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,128}$")
    shot_index: int = Field(strict=True, ge=1, le=9)


class ProductImage(Strict):
    title: str = Field(min_length=1, max_length=200)
    caption: str = Field(min_length=1, max_length=1000)
    role: Literal["view", "detail"] = "detail"
    design_study: bool = Field(default=False, strict=True)
    asset: Asset


class Product(Strict):
    product_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,128}$")
    name: str = Field(min_length=1, max_length=200)
    category: str = Field(min_length=1, max_length=100)
    subtitle: str = Field(min_length=1, max_length=500)
    description: str = Field(min_length=1, max_length=2000)
    color_name: str = Field(min_length=1, max_length=100)
    color_hex: str = Field(pattern=r"^#[a-fA-F0-9]{6}$")
    design_material: str = Field(min_length=1, max_length=500)
    notes: list[str] = Field(min_length=1, max_length=10)
    asset: Asset
    gallery: list[ProductImage] = Field(default_factory=list, max_length=8)
    appearances: list[ProductAppearance] = Field(min_length=1, max_length=200)


class Products(Strict):
    schema_version: Literal[1]
    products: list[Product] = Field(max_length=5000)


class BatchLook(Strict):
    id: int = Field(strict=True, ge=1, le=2_147_483_647)
    model_id: str
    model_reference_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    title: str = Field(min_length=1, max_length=200)
    category: str = Field(min_length=1, max_length=200)
    season: str = Field(min_length=1, max_length=100)
    description: str = Field(min_length=1, max_length=2000)
    pieces: list[Piece] = Field(min_length=1)
    tags: list[str] = Field(min_length=1)
    mood: str = Field(min_length=1, max_length=500)
    scene: str = Field(min_length=1, max_length=1000)
    edition: Literal["v2"]
    asset: Asset
    shots: list[Shot] = Field(min_length=9, max_length=9)
    palette: list[str] = Field(default_factory=lambda: ["#d1c3ac", "#f6f0e4", "#594033"])
    details: list[str] = Field(default_factory=list)


class Source(Strict):
    url: str
    published_at: date | datetime
    summary: str = Field(min_length=1, max_length=2000)

    @field_validator("url")
    @classmethod
    def public_url(cls, value):
        from urllib.parse import urlsplit

        parsed = urlsplit(value)
        if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username:
            raise ValueError("Expected a source URL")
        return value


class Weather(Strict):
    url: str
    forecast_date: date
    checked_at: datetime
    summary: str = Field(min_length=1, max_length=2000)
    styling_reason: str = Field(min_length=1, max_length=2000)

    @field_validator("url")
    @classmethod
    def public_url(cls, value):
        return Source.public_url(value)


class Research(Strict):
    checked_at: datetime
    trend_sources: list[Source] = Field(min_length=2)
    weather: Weather


class Region(Strict):
    country: str = Field(min_length=1, max_length=100)
    city: str = Field(min_length=1, max_length=100)


class Batch(Strict):
    schema_version: Literal[1]
    batch_id: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}-[A-Za-z0-9_-]+$")
    publish_date: date
    published_at: datetime | None = Field(
        default=None,
        description="Timezone-aware publication instant on publish_date in Asia/Shanghai; omitted means local midnight.",
    )
    cover_look_id: int | None = Field(
        default=None,
        strict=True,
        ge=1,
        le=2_147_483_647,
        description="Homepage cover ID belonging to this batch; omitted means its first look.",
    )
    timezone: Literal["Asia/Shanghai"]
    title: str = Field(min_length=1, max_length=200)
    region: Region
    research: Research
    looks: list[BatchLook] = Field(min_length=1)

    @field_validator("published_at", mode="before")
    @classmethod
    def publication_timestamp(cls, value):
        if value is not None and (
            not isinstance(value, str)
            or not re.fullmatch(
                r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})",
                value,
            )
        ):
            raise ValueError("Expected a timezone-aware ISO publication timestamp")
        return value

    @model_validator(mode="after")
    def publication_metadata(self):
        if self.published_at is not None and self.published_at.utcoffset() is None:
            raise ValueError("Publication timestamp requires a timezone")
        if self.published_at is not None:
            try:
                local_date = self.published_at.astimezone(ZoneInfo(self.timezone)).date()
            except OverflowError as error:
                raise ValueError("Publication timestamp is outside the supported range") from error
            if local_date != self.publish_date:
                raise ValueError("Publication timestamp must match the Shanghai publication date")
        if self.cover_look_id is not None and self.cover_look_id not in {
            look.id for look in self.looks
        }:
            raise ValueError("Cover must belong to this batch")
        return self

    def publication_time(self):
        value = self.published_at or datetime.combine(
            self.publish_date, datetime.min.time(), ZoneInfo(self.timezone)
        )
        return value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def publication_projection(looks, batches, legacy_order):
    """Deterministic feed selection; source file mtimes never affect publication."""
    ordered_batches = sorted(
        batches, key=lambda batch: (batch["published_at"], batch["batch_id"]), reverse=True
    )
    published_ids = [key for batch in ordered_batches for key in sorted(batch["look_ids"])]
    legacy_ids = sorted(look["id"] for look in looks if look["id"] not in published_ids)
    latest_order = published_ids + legacy_ids
    featured = (
        ordered_batches[0]["cover_look_id"]
        if ordered_batches
        else next(iter(legacy_order), next(iter(latest_order), None))
    )
    home = {
        "featured_look_id": featured,
        "recent_look_ids": [key for key in latest_order if key != featured][:6],
        "latest_batch_id": ordered_batches[0]["batch_id"] if ordered_batches else None,
    }
    return ordered_batches, latest_order, home


def restore_publication_projection(snapshot):
    """Upgrade a verified archived snapshot without changing its source revision."""
    batches = snapshot.get("batches", [])
    for batch in batches:
        if not batch.get("published_at"):
            batch["published_at"] = (
                datetime.fromisoformat(batch["publish_date"] + "T00:00:00+08:00")
                .astimezone(UTC)
                .isoformat(timespec="milliseconds")
                .replace("+00:00", "Z")
            )
        batch.setdefault("cover_look_id", batch["look_ids"][0])
    by_id = {key: batch for batch in batches for key in batch["look_ids"]}
    for look in snapshot["looks"]:
        look["published_at"] = by_id.get(look["id"], {}).get("published_at")
    batches, latest_order, home = publication_projection(
        snapshot["looks"], batches, snapshot.get("displayOrder", [])
    )
    snapshot.update(batches=batches, latestOrder=latest_order, home=home)
    return snapshot


class ContentService:
    def __init__(self, settings):
        self.settings = settings
        image_root = settings.catalog_image_root
        self.source_root = settings.content_root
        # Explicit fixture/legacy catalogs must not accidentally import the real repository.
        if self.source_root is None and image_root and (image_root / "content").is_dir():
            self.source_root = image_root / "content"
        self.enabled = self.source_root is not None
        self.image_root = image_root or (self.source_root.parent if self.source_root else None)
        self.root = settings.data_dir / "public-content"
        self.resolver = None
        self.import_error = None
        self._snapshot: dict = {}
        self._records: dict = {}
        if not self.enabled:
            return
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        (self.root / "assets").mkdir(mode=0o700, exist_ok=True)
        with self.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS assets (
                    asset_id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, metadata TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS revisions (
                    revision TEXT PRIMARY KEY, snapshot TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS active (
                    id INTEGER PRIMARY KEY CHECK(id=1), revision TEXT NOT NULL
                );
            """)
        self._load_active()
        self.import_content()

    def connect(self):
        return sqlite3.connect(self.root / "content.sqlite3", timeout=30)

    @property
    def ready(self):
        return bool(self._snapshot)

    def _load_active(self):
        with self.connect() as db:
            row = db.execute(
                "SELECT snapshot FROM revisions JOIN active USING(revision) WHERE active.id=1"
            ).fetchone()
            if row:
                snapshot = json.loads(row[0])
                ids = snapshot.pop("_asset_ids")
                records = {
                    key: json.loads(metadata)
                    for key, metadata in db.execute("SELECT asset_id,metadata FROM assets")
                    if key in ids
                }
                if len(records) != len(ids):
                    raise ValueError("Incomplete archived revision")
                self._snapshot, self._records = restore_publication_projection(snapshot), records

    def _read_json(self, path):
        if path.is_symlink() or not path.is_file() or path.stat().st_size > 8 * 1024 * 1024:
            raise ValueError("Invalid content manifest")
        data = path.read_bytes()
        self._source_digests.append(
            [
                "content/" + path.relative_to(self.source_root).as_posix(),
                hashlib.sha256(data).hexdigest(),
            ]
        )
        return json.loads(data)

    def _verify_asset(self, value, *, grid=False, public=True):
        asset = Asset.model_validate(value)
        if public and asset.visibility != "public":
            raise ValueError("Private assets cannot enter the public archive")
        if grid and (asset.layout is None or asset.width * 3 != asset.height * 2):
            raise ValueError("Expected a 2:3 nine-panel image")
        if self.image_root is None:
            raise ValueError("Missing image root")
        root = self.image_root.resolve()
        path = root
        for part in PurePosixPath(asset.file).parts:
            path = path / part
            if path.is_symlink():
                raise ValueError("Symlink assets are forbidden")
        if not path.resolve().is_relative_to(root) or path.stat().st_size != asset.bytes:
            raise ValueError("Asset size/path mismatch")
        data = path.read_bytes()
        if (
            len(data) != asset.bytes
            or data[:4] != b"RIFF"
            or data[8:12] != b"WEBP"
            or data[12:16] != b"VP8 "
            or int.from_bytes(data[4:8], "little") + 8 != len(data)
            or 20
            + int.from_bytes(data[16:20], "little")
            + (int.from_bytes(data[16:20], "little") % 2)
            != len(data)
            or hashlib.sha256(data).hexdigest() != asset.sha256
        ):
            raise ValueError("Asset signature/hash mismatch")
        with Image.open(io.BytesIO(data)) as image:
            if (
                image.format != "WEBP"
                or image.size != (asset.width, asset.height)
                or getattr(image, "n_frames", 1) != 1
                or asset.width * asset.height > 24_000_000
            ):
                raise ValueError("Asset decoded metadata mismatch")
            image.load()
        return asset.model_dump(exclude_none=True), data

    def import_content(self):
        if not self.enabled:
            return False
        try:
            snapshot, records, blobs = self._candidate()
            canonical = json.dumps(sorted(self._source_digests), separators=(",", ":"))
            revision = hashlib.sha256(canonical.encode()).hexdigest()
            snapshot["revision"] = revision
            # Check all identities before touching the active revision.
            with self.connect() as db:
                for asset_id, record in records.items():
                    old = db.execute(
                        "SELECT sha256 FROM assets WHERE asset_id=?", (asset_id,)
                    ).fetchone()
                    if old and old[0] != record["sha256"]:
                        raise ValueError("Published asset identities are immutable")
            for asset_id, data in blobs.items():
                path = self.root / "assets" / f"{records[asset_id]['sha256']}.webp"
                if (
                    not path.exists()
                    or hashlib.sha256(path.read_bytes()).hexdigest() != records[asset_id]["sha256"]
                ):
                    atomic_write(path, data)
            with self.connect() as db:
                db.execute("BEGIN IMMEDIATE")
                for asset_id, record in records.items():
                    current = db.execute(
                        "SELECT sha256 FROM assets WHERE asset_id=?", (asset_id,)
                    ).fetchone()
                    if current and current[0] != record["sha256"]:
                        raise ValueError("Published asset identities are immutable")
                    db.execute(
                        "INSERT OR IGNORE INTO assets VALUES (?,?,?)",
                        (asset_id, record["sha256"], json.dumps(record)),
                    )
                db.execute(
                    "INSERT INTO revisions VALUES (?,?) "
                    "ON CONFLICT(revision) DO UPDATE SET snapshot=excluded.snapshot",
                    (revision, json.dumps({**snapshot, "_asset_ids": list(records)})),
                )
                db.execute("INSERT OR REPLACE INTO active VALUES (1,?)", (revision,))
            self._snapshot, self._records = snapshot, records
            self.import_error = None
            return True
        except (
            ValueError,
            OSError,
            KeyError,
            TypeError,
            sqlite3.Error,
            Image.DecompressionBombError,
        ):
            self.import_error = "content_validation_failed"
            return False

    def _candidate(self):
        self._source_digests: list = []
        if self.source_root.is_symlink():
            raise ValueError("Symlink content directory")
        models = Models.model_validate(self._read_json(self.source_root / "models.json"))
        baseline = self._read_json(self.source_root / "catalog.json")
        if baseline.get("schema_version") != 1 or not isinstance(baseline.get("looks"), list):
            raise ValueError("Invalid baseline")
        categories = baseline["categoryOrder"]
        if not categories or len(set(categories)) != len(categories):
            raise ValueError("Invalid category order")
        records, blobs, model_map = {}, {}, {}

        def register(value, grid=False):
            record, data = self._verify_asset(value, grid=grid)
            key = record["asset_id"]
            if key in records:
                raise ValueError("Duplicate asset identity")
            records[key], blobs[key] = record, data
            return record

        for entry in models.models:
            if entry.model_id in model_map:
                raise ValueError("Duplicate model")
            # Private references are never archived publicly or returned as public model URLs.
            if entry.reference.visibility == "public":
                register(entry.reference.model_dump(exclude_none=True))
            else:
                self._verify_asset(entry.reference.model_dump(exclude_none=True), public=False)
            model_map[entry.model_id] = entry.model_dump(mode="json", exclude_none=True)
        looks, ids = [], set()
        for original in baseline["looks"]:
            look = copy.deepcopy(original)
            key = look["id"]
            if type(key) is not int or key < 1 or key in ids:
                raise ValueError("Invalid legacy identity")
            if look.get("model_id") is not None:
                model = model_map.get(look["model_id"])
                if (
                    not model
                    or not model["enabled"]
                    or look.get("model_reference_sha256") != model["reference"]["sha256"]
                ):
                    raise ValueError(
                        "Legacy model attribution requires an explicit verified reference"
                    )
            if set(look["versions"]) != {"v2"}:
                raise ValueError("Legacy baseline must contain only v2")
            version = look["versions"]["v2"]
            asset = register(version["asset"], grid=True)
            if len(version["shots"]) != 9 or look["category"] not in categories:
                raise ValueError("Invalid baseline grid/category")
            version["image"] = asset["file"]
            look["image"], look["ready"] = asset["file"], True
            # Legacy publication dates are unknown, including after image revisions.
            look["published_at"] = None
            ids.add(key)
            looks.append(look)
        if not set(range(1, 101)).issubset(ids):
            raise ValueError("Historical 1-100 identities must be preserved")
        batches, batch_ids, dates = [], set(), set()
        batch_root = self.source_root / "batches"
        if batch_root.is_symlink():
            raise ValueError("Symlink batch directory")
        for path in sorted(batch_root.glob("*.json")):
            batch = Batch.model_validate(self._read_json(path))
            if (
                batch.batch_id in batch_ids
                or batch.publish_date in dates
                or not batch.batch_id.startswith(batch.publish_date.isoformat() + "-")
                or path.stem != batch.batch_id
                or batch.research.checked_at.tzinfo is None
                or batch.research.weather.checked_at.tzinfo is None
                or batch.research.weather.forecast_date != batch.publish_date
                or len({s.url for s in batch.research.trend_sources}) < 2
            ):
                raise ValueError("Invalid batch metadata")
            for item in batch.looks:
                model = model_map.get(item.model_id)
                if (
                    item.id in ids
                    or not model
                    or not model["enabled"]
                    or model["reference"]["sha256"] != item.model_reference_sha256
                    or item.category not in categories
                    or [s.index for s in item.shots] != list(range(1, 10))
                ):
                    raise ValueError("Invalid look/model identity")
                asset = register(item.asset.model_dump(exclude_none=True), grid=True)
                look = item.model_dump(mode="json", exclude={"edition", "asset", "shots"})
                look.update(
                    image=asset["file"],
                    ready=True,
                    batch_id=batch.batch_id,
                    publish_date=batch.publish_date.isoformat(),
                    published_at=batch.publication_time(),
                    region=batch.region.model_dump(),
                    editorialOrder=item.id,
                    versions={
                        "v2": {
                            "image": asset["file"],
                            "ready": True,
                            "previewPanel": asset["layout"]["preview_panel"],
                            "story": item.title,
                            "summary": item.description,
                            "moods": [item.mood],
                            "shots": [s.model_dump() for s in item.shots],
                            "asset": asset,
                        }
                    },
                )
                ids.add(item.id)
                looks.append(look)
            batches.append(
                batch.model_dump(mode="json", exclude={"looks"})
                | {
                    "look_ids": [item.id for item in batch.looks],
                    "published_at": batch.publication_time(),
                    "cover_look_id": batch.cover_look_id or batch.looks[0].id,
                }
            )
            batch_ids.add(batch.batch_id)
            dates.add(batch.publish_date)
        products = []
        product_path = self.source_root / "products.json"
        if product_path.exists() or product_path.is_symlink():
            manifest = Products.model_validate(self._read_json(product_path))
            product_ids, linked_pieces = set(), set()
            by_id = {look["id"]: look for look in looks}
            for product in manifest.products:
                if product.product_id in product_ids:
                    raise ValueError("Duplicate product identity")
                product_ids.add(product.product_id)
                for appearance in product.appearances:
                    look = by_id.get(appearance.look_id)
                    identity = (appearance.look_id, appearance.piece_index)
                    if (
                        not look
                        or appearance.piece_index > len(look.get("pieces", []))
                        or appearance.reference_asset_id
                        != look["versions"]["v2"]["asset"]["asset_id"]
                        or identity in linked_pieces
                    ):
                        raise ValueError("Invalid or duplicate product appearance")
                    linked_pieces.add(identity)
                image_ids = set()
                for image in [product.asset, *[item.asset for item in product.gallery]]:
                    if image.asset_id in image_ids:
                        raise ValueError("Duplicate product gallery image")
                    image_ids.add(image.asset_id)
                    record = register(image.model_dump(exclude_none=True))
                    if not record["file"].startswith("assets/products/") or record.get("layout"):
                        raise ValueError("Product images must be independent public product assets")
                products.append(product.model_dump(mode="json", exclude_none=True))
        batches, latest_order, home = publication_projection(
            looks, batches, baseline.get("displayOrder", [])
        )
        display = [i for batch in batches for i in batch["look_ids"]]
        display += [i for i in baseline.get("displayOrder", []) if i in ids and i not in display]
        display += [look["id"] for look in looks if look["id"] not in display]
        editorial_order = {key: index + 1 for index, key in enumerate(display)}
        for look in looks:
            look["editorialOrder"] = editorial_order[look["id"]]
        snapshot = {
            "schema_version": 1,
            "categoryOrder": categories,
            "displayOrder": display,
            "latestOrder": latest_order,
            "home": home,
            "looks": looks,
            "products": products,
            "models": list(model_map.values()),
            "batches": batches,
            "target": len(looks),
            "generated": len(looks),
            "expressiveGenerated": len(looks),
            "planned": len(looks),
            "counts": {"looks": len(looks), "models": len(model_map), "batches": len(batches)},
        }
        return snapshot, records, blobs

    def set_delivery_resolver(self, resolver):
        self.resolver = resolver

    def asset_records(self):
        return [
            {
                **copy.deepcopy(record),
                "source_url": f"/api/content/assets/{key}",
                "archive_path": self.root / "assets" / f"{record['sha256']}.webp",
            }
            for key, record in self._records.items()
        ]

    def _public_asset(self, value):
        record = copy.deepcopy(value)
        key = record["asset_id"]
        source = f"/api/content/assets/{key}"
        image = self.resolver(key, source) if self.resolver else source
        record.update(source_url=source, image_url=image)
        return record

    def catalog(self):
        if not self.ready:
            raise HTTPException(503, "content_unavailable:Public content is unavailable")
        snapshot = copy.deepcopy(self._snapshot)
        for product in snapshot.get("products", []):
            product["asset"] = self._public_asset(product["asset"])
            for image in product.get("gallery", []):
                image["asset"] = self._public_asset(image["asset"])
        for look in snapshot["looks"]:
            version = look["versions"]["v2"]
            version["asset"] = asset = self._public_asset(version["asset"])
            version.update(
                image=asset["image_url"],
                image_url=asset["image_url"],
                source_url=asset["source_url"],
                asset_id=asset["asset_id"],
            )
            look.update(
                image=asset["image_url"],
                image_url=asset["image_url"],
                source_url=asset["source_url"],
            )
        public_models = []
        for model in snapshot["models"]:
            if model["reference"]["visibility"] != "public":
                continue
            model["reference"] = self._public_asset(model["reference"])
            model["image_url"] = model["reference"]["image_url"]
            model["source_url"] = model["reference"]["source_url"]
            public_models.append(model)
        snapshot["models"] = public_models
        snapshot["counts"]["models"] = len(public_models)
        return snapshot

    def admin_models(self):
        if not self.ready:
            return []
        models = copy.deepcopy(self._snapshot["models"])
        for model in models:
            count = sum(
                look.get("model_id") == model["model_id"] for look in self._snapshot["looks"]
            )
            model["expressive_count"] = count
            model["look_count"] = count
            if model["reference"]["visibility"] == "public":
                model["reference"] = self._public_asset(model["reference"])
                model["source_url"] = model["reference"]["source_url"]
                model["image_url"] = model["reference"]["image_url"]
                model["preview_available"] = True
            else:
                # Private references are observable as metadata, never original URLs or paths.
                model["reference"].pop("file", None)
                model["source_url"] = None
                model["image_url"] = None
                model["preview_available"] = False
        return models

    def asset(self, asset_id):
        record = self._records.get(asset_id)
        if record is None and self.enabled:
            # Published public URLs outlive a release's current catalog. They
            # never resolve through private inputs or historical styling files.
            with self.connect() as db:
                row = db.execute(
                    "SELECT metadata FROM assets WHERE asset_id=?", (asset_id,)
                ).fetchone()
            if row:
                candidate = json.loads(row[0])
                if candidate.get("visibility") == "public":
                    record = candidate
        if record is None:
            raise HTTPException(404, "not_found:Public resource not found")
        path = self.root / "assets" / f"{record['sha256']}.webp"
        try:
            data = path.read_bytes()
        except OSError:
            raise HTTPException(503, "asset_unavailable:Public resource is unavailable") from None
        if hashlib.sha256(data).hexdigest() != record["sha256"]:
            raise HTTPException(503, "asset_unavailable:Public resource is unavailable")
        return data, record

    def crop_reference(self, look_id, edition, shot_index):
        from .images import png

        if edition != "v2" or not 1 <= shot_index <= 9:
            raise HTTPException(
                422, "invalid_selection:Only public expressive references are available"
            )
        look = next(
            (item for item in self._snapshot.get("looks", []) if item["id"] == look_id), None
        )
        if look is None:
            raise HTTPException(422, "invalid_selection:Selected look is unavailable")
        data, _ = self.asset(look["versions"]["v2"]["asset"]["asset_id"])
        with Image.open(io.BytesIO(data)) as image:
            col, row = (shot_index - 1) % 3, (shot_index - 1) // 3
            return png(
                image.convert("RGB").crop(
                    (
                        image.width * col // 3,
                        image.height * row // 3,
                        image.width * (col + 1) // 3,
                        image.height * (row + 1) // 3,
                    )
                )
            )

    def router(self):
        router = APIRouter(prefix="/api/content")

        @router.get("/catalog")
        def catalog():
            return self.catalog()

        @router.get("/home")
        def home():
            snapshot = self.catalog()
            selection = snapshot["home"]
            by_id = {look["id"]: look for look in snapshot["looks"]}
            return {
                **selection,
                "revision": snapshot["revision"],
                "featured": by_id.get(selection["featured_look_id"]),
                "recent": [by_id[key] for key in selection["recent_look_ids"]],
            }

        @router.get("/looks")
        def looks(
            offset: int = Query(0, ge=0),
            limit: int = Query(24, ge=1, le=200),
            model: str | None = None,
            category: str | None = None,
            region: str | None = None,
            q: str | None = Query(None, max_length=200),
            order: Literal["latest", "curated"] = "latest",
        ):
            snapshot = self.catalog()
            by_id = {look["id"]: look for look in snapshot["looks"]}
            order_key = "latestOrder" if order == "latest" else "displayOrder"
            items = [by_id[key] for key in snapshot[order_key]]
            items = [
                look
                for look in items
                if (not model or look.get("model_id") == model)
                and (not category or look["category"] == category)
                and (not region or region in (look.get("region") or {}).values())
                and (not q or q.casefold() in json.dumps(look, ensure_ascii=False).casefold())
            ]
            return {
                "items": items[offset : offset + limit],
                "total": len(items),
                "offset": offset,
                "limit": limit,
                "has_more": offset + limit < len(items),
                "revision": snapshot["revision"],
            }

        @router.get("/looks/{look_id}")
        def look(look_id: int):
            item = next((item for item in self.catalog()["looks"] if item["id"] == look_id), None)
            if item is None:
                raise HTTPException(404, "not_found:Look not found")
            return item

        @router.get("/models")
        def models():
            return {"items": self.catalog()["models"]}

        @router.get("/products")
        def products(category: str | None = None, look_id: int | None = None):
            snapshot = self.catalog()
            items = [
                product
                for product in snapshot.get("products", [])
                if (not category or product["category"] == category)
                and (
                    look_id is None or any(a["look_id"] == look_id for a in product["appearances"])
                )
            ]
            return {"items": items, "total": len(items), "revision": snapshot["revision"]}

        @router.get("/products/{product_id}")
        def product(product_id: str):
            item = next(
                (p for p in self.catalog().get("products", []) if p["product_id"] == product_id),
                None,
            )
            if item is None:
                raise HTTPException(404, "not_found:Product not found")
            return item

        @router.get("/batches")
        def batches():
            return {"items": self.catalog()["batches"]}

        def response(asset_id, attachment=False):
            data, record = self.asset(asset_id)
            return Response(
                data,
                media_type="image/webp",
                headers={
                    "ETag": f'"{record["sha256"]}"',
                    "Content-Disposition": ("attachment" if attachment else "inline")
                    + f'; filename="{asset_id}.webp"',
                },
            )

        @router.get("/assets/{asset_id}")
        def image(asset_id: str):
            return response(asset_id)

        @router.get("/assets/{asset_id}/download")
        def download(asset_id: str):
            return response(asset_id, True)

        return router
