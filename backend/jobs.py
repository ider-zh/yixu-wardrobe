"""Public HTTP seams and persistent, owner-scoped request queue."""

import hashlib
import json
import re
import secrets
from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile
from starlette.formparsers import MultiPartParser
from starlette.responses import JSONResponse

from .files import atomic_write
from .images import crop_reference, hide_grid_original, validate_photo

HistoryStatus = Literal["all", "active", "success", "failed"]
HISTORY_STATUS_GROUPS = {
    "active": ("queued", "validating", "generating", "postprocessing"),
    "success": ("succeeded",),
    "failed": ("failed", "unknown", "needs_photo", "expired", "canceled"),
}


class Submission(BaseModel):
    model_config = ConfigDict(extra="forbid")
    look_id: int = Field(ge=1, le=2_147_483_647)
    edition: Literal["v2"]
    shot_index: int = Field(ge=1, le=9)
    idempotency_key: str = Field(min_length=8, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")
    disclosure_version: str
    pose_mode: Literal["original", "pose_grid"] = "original"


def timestamp(value):
    return datetime.fromtimestamp(value, UTC).isoformat().replace("+00:00", "Z")


def frozen_reference(row):
    asset_id = row.get("reference_asset_id")
    source = row.get("reference_source_url")
    shot = row.get("shot_index")
    if (
        not isinstance(asset_id, str)
        or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", asset_id)
        or source != f"/api/content/assets/{asset_id}"
        or row.get("edition") != "v2"
        or type(shot) is not int
        or not 1 <= shot <= 9
    ):
        return None
    return {"asset_id": asset_id, "source_url": source, "shot_index": shot}


class Jobs:
    def __init__(self, store, settings, available, detector, clock, content=None):
        self.store, self.settings = store, settings
        self.content = content
        self.available, self.detector, self.clock = available, detector, clock
        import asyncio

        self.upload_slots = asyncio.Semaphore(settings.image_concurrency)
        self.inputs = store.root / "inputs"
        self.outputs = store.root / "results"
        self.inputs.mkdir(mode=0o700, exist_ok=True)
        self.outputs.mkdir(mode=0o700, exist_ok=True)

    def get(self, job_id, owner=None):
        with self.store.connect() as db:
            row = db.execute(
                "SELECT * FROM jobs WHERE id=?" + (" AND owner=?" if owner else ""),
                (job_id, owner) if owner else (job_id,),
            ).fetchone()
        if not row:
            raise HTTPException(404, "not_found:Job not found")
        return dict(row)

    def shape(self, row, *, include_reference=False):
        with self.store.connect() as db:
            position = (
                db.execute(
                    "SELECT count(*) FROM jobs WHERE seq<? AND status IN ('queued','validating','generating','postprocessing')",
                    (row["seq"],),
                ).fetchone()[0]
                if row["status"] == "queued"
                else 0
            )
        ready = row["output_bytes"] > 0 and row["status"] == "succeeded"
        job = {
            "id": row["id"],
            "status": row["status"],
            "look_id": row["look_id"],
            "look_title": row.get("look_title"),
            "edition": row["edition"],
            "shot_index": row["shot_index"],
            "pose_mode": row["pose_mode"],
            "created_at": timestamp(row["created"]),
            "original_expires_at": timestamp(row["expires"]),
            "queue_position": position,
            "image_url": f"/api/tryons/{row['id']}/image" if ready else None,
            "download_url": f"/api/tryons/{row['id']}/download" if ready else None,
            "error_code": row["error_code"],
            "error_message": row["error_message"],
        }
        if include_reference:
            job["reference"] = frozen_reference(row)
        return job

    def look_titles(self):
        if self.content is not None and self.content.enabled:
            return self.content.look_titles()
        if self.settings.catalog_path is None:
            return {}
        try:
            catalog = json.loads(self.settings.catalog_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        looks = catalog.get("looks") if isinstance(catalog, dict) else None
        if not isinstance(looks, list):
            return {}
        return {
            look["id"]: look["title"]
            for look in looks
            if isinstance(look, dict)
            and type(look.get("id")) is int
            and isinstance(look.get("title"), str)
        }

    def history(self, owner, offset, limit, look, status):
        conditions = ["owner=?"]
        params: list[str | int] = [owner]
        statuses = HISTORY_STATUS_GROUPS.get(status)
        if statuses:
            conditions.append("status IN (" + ",".join("?" for _ in statuses) + ")")
            params.extend(statuses)

        needle = look.strip().casefold()
        number = needle.removeprefix("#")
        if number.isascii() and number.isdecimal():
            look_id = int(number)
            if not 1 <= look_id <= 2_147_483_647:
                return {"items": [], "has_more": False}
            conditions.append("look_id=?")
            params.append(look_id)
            needle = ""
        current_titles = self.look_titles() if needle else {}
        with self.store.connect() as db:
            if needle:

                def title_matches(title, look_id):
                    text = (
                        title
                        if isinstance(title, str) and title
                        else current_titles.get(look_id, "")
                    )
                    return needle in text.casefold()

                db.create_function("tryon_title_matches", 2, title_matches, deterministic=True)
                conditions.append("tryon_title_matches(look_title, look_id)")
            rows = db.execute(
                "SELECT * FROM jobs WHERE "
                + " AND ".join(conditions)
                + " ORDER BY seq DESC LIMIT ? OFFSET ?",
                (*params, limit + 1, offset),
            ).fetchall()
        return {
            "items": [self.shape(dict(row), include_reference=True) for row in rows[:limit]],
            "has_more": len(rows) > limit,
        }

    def accept(self, owner, data, raw, received):
        selection = data.model_dump(exclude={"idempotency_key"})
        if data.pose_mode == "original":
            selection.pop("pose_mode")  # Keep existing single-image request keys compatible.
        fingerprint = hashlib.sha256(
            raw + json.dumps(selection, sort_keys=True).encode()
        ).hexdigest()
        with self.store.connect() as db:
            old = db.execute(
                "SELECT * FROM jobs WHERE owner=? AND idempotency_key=?",
                (owner, data.idempotency_key),
            ).fetchone()
        if old:
            if old["fingerprint"] != fingerprint:
                raise HTTPException(
                    409, "idempotency_conflict:This request key has different content"
                )
            return self.shape(dict(old), include_reference=True)
        # Existing requests need neither fresh inference readiness nor input writes.
        if not self.available():
            raise HTTPException(503, "unavailable:Provider, detector or catalog is not configured")
        photo = validate_photo(raw, self.settings, self.detector)
        reference_asset_id = reference_source_url = None
        if self.content is not None and self.content.enabled:
            reference, reference_asset_id, look_title = self.content.capture_reference(
                data.look_id, data.shot_index
            )
            reference_source_url = f"/api/content/assets/{reference_asset_id}"
        else:
            look_title = self.look_titles().get(data.look_id)
            reference = crop_reference(self.settings, data.look_id, data.shot_index)
        job_id = secrets.token_hex(16)
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            old = db.execute(
                "SELECT * FROM jobs WHERE owner=? AND idempotency_key=?",
                (owner, data.idempotency_key),
            ).fetchone()
            if old:
                if old["fingerprint"] != fingerprint:
                    raise HTTPException(
                        409, "idempotency_conflict:This request key has different content"
                    )
                return self.shape(dict(old), include_reference=True)
            db.execute(
                """INSERT INTO jobs (id,owner,idempotency_key,fingerprint,status,
                       look_id,look_title,edition,shot_index,reference_asset_id,reference_source_url,
                       created,expires,pose_mode)
                       VALUES (?,?,?,?,'validating',?,?,?,?,?,?,?,?,?)""",
                (
                    job_id,
                    owner,
                    data.idempotency_key,
                    fingerprint,
                    data.look_id,
                    look_title,
                    data.edition,
                    data.shot_index,
                    reference_asset_id,
                    reference_source_url,
                    received,
                    received + 3600,
                    data.pose_mode,
                ),
            )
        if self.clock() >= received + 3599:
            raise HTTPException(422, "photo_expired:Photo input expired during validation")
        try:
            atomic_write(self.inputs / f"{job_id}.photo.png", photo)
            atomic_write(self.inputs / f"{job_id}.reference.png", reference)
        except OSError:
            with self.store.connect() as db:
                db.execute(
                    "UPDATE jobs SET status='failed',error_code='storage_unavailable',error_message='Input storage is unavailable' WHERE id=?",
                    (job_id,),
                )
            self.drop_inputs(job_id)
            raise HTTPException(
                503, "storage_unavailable:Private image storage is unavailable"
            ) from None
        with self.store.connect() as db:
            updated = db.execute(
                "UPDATE jobs SET status='queued' WHERE id=? AND status='validating' AND cancel_requested=0 AND expires>?",
                (job_id, self.clock()),
            ).rowcount
        if not updated:
            self.drop_inputs(job_id)
        return self.shape(self.get(job_id, owner), include_reference=True)

    def purge_inputs(self):
        # One-second early margin covers the 200ms cleanup tick, never extending raw TTL.
        now = self.clock() + 1
        changed = False
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute(
                "UPDATE jobs SET status='needs_photo',error_code='photo_expired',error_message='Original input expired; submit a new photo explicitly' WHERE status IN ('queued','validating') AND expires<=?",
                (now,),
            )
            # Iterate retained files, never every historical terminal job.
            for path in self.inputs.iterdir():
                job_id = path.name.lstrip(".")[:32]
                row = db.execute("SELECT expires,status FROM jobs WHERE id=?", (job_id,)).fetchone()
                if row and (
                    row["expires"] <= now
                    or row["status"] not in ("queued", "validating", "generating", "postprocessing")
                ):
                    path.unlink(missing_ok=True)
                    changed = True
        if changed:
            from .files import sync_dir

            sync_dir(self.inputs)

    def drop_inputs(self, job_id):
        for kind in ("photo", "reference"):
            (self.inputs / f"{job_id}.{kind}.png").unlink(missing_ok=True)
        from .files import sync_dir

        sync_dir(self.inputs)

    def remove(self, job_id):
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT status FROM jobs WHERE id=?", (job_id,)).fetchone()
            active = row["status"] in ("generating", "postprocessing")
            db.execute(
                "UPDATE jobs SET status=CASE WHEN ? THEN status ELSE ? END, "
                "cancel_requested=1,output_bytes=0 WHERE id=?",
                (active, "canceled", job_id),
            )
            (self.outputs / f"{job_id}.webp").unlink(missing_ok=True)
        self.drop_inputs(job_id)

    def image_response(self, row, attachment=False, *, for_admin=False):
        from starlette.responses import Response

        if row["status"] != "succeeded" or row["output_bytes"] <= 0:
            raise HTTPException(404, "no_result:No generated result")
        try:
            data = (self.outputs / f"{row['id']}.webp").read_bytes()
        except FileNotFoundError:
            raise HTTPException(404, "no_result:No generated result") from None
        if for_admin and row["pose_mode"] == "pose_grid" and not row["generated_grid"]:
            data = hide_grid_original(data, self.settings)
        headers = {
            "Content-Disposition": ("attachment" if attachment else "inline")
            + f'; filename="yixu-{row["id"]}.webp"'
        }
        return Response(data, media_type="image/webp", headers=headers)

    def router(self, require_visitor, disclosure_version):
        router = APIRouter(prefix="/api")

        @router.post("/tryons")
        async def submit(request: Request):
            visitor = require_visitor(request, True)
            # Authorization and consent happen before multipart parsing / receiving photo bytes.
            if visitor["accepted"] != disclosure_version:
                raise HTTPException(403, "consent_required:Accept the current disclosure first")
            received = self.clock()
            async with self.upload_slots:
                return await receive_submission(request, visitor, received)

        async def receive_submission(request, visitor, received):
            max_body = self.settings.max_upload_bytes + 64 * 1024
            size = 0

            async def limited_stream():
                nonlocal size
                async for chunk in request.stream():
                    if self.clock() >= received + 3599:
                        raise HTTPException(
                            422, "photo_expired:Photo input expired during reception"
                        )
                    size += len(chunk)
                    if size > max_body:
                        raise HTTPException(413, "upload_too_large:Upload exceeds technical limit")
                    yield chunk

            parser = MultiPartParser(
                request.headers,
                limited_stream(),
                max_files=1,
                max_fields=7,
                max_part_size=16 * 1024,
            )
            # No temporary raw-photo spool: bound the entire stream and keep parsing in memory.
            parser.spool_max_size = max_body + 1
            form = None
            try:
                import anyio

                with anyio.fail_after(max(0.001, received + 3599 - self.clock())):
                    form = await parser.parse()
            except HTTPException:
                raise
            except TimeoutError:
                raise HTTPException(
                    422, "photo_expired:Photo input expired during reception"
                ) from None
            except Exception:  # noqa: BLE001 - fail closed; never expose native/provider exceptions
                raise HTTPException(422, "invalid_multipart:Invalid multipart upload") from None
            finally:
                # Close partial in-memory spools on parser failure/deadline as well.
                if form is None:
                    for spool in parser._files_to_close_on_error:
                        spool.close()
            try:
                photo = form.get("photo")
                if not isinstance(photo, UploadFile) or len(form.getlist("photo")) != 1:
                    raise HTTPException(422, "invalid_photo:One photo is required")
                fields = {k: v for k, v in form.multi_items() if k != "photo"}
                if len(fields) != len(list(form.multi_items())) - 1:
                    raise HTTPException(422, "invalid_request:Duplicate fields")
                try:
                    data = Submission.model_validate(fields)
                except ValidationError:
                    raise HTTPException(
                        422, "invalid_request:Invalid selection or request key"
                    ) from None
                if data.disclosure_version != disclosure_version:
                    raise HTTPException(409, "disclosure_version:Reload the disclosure")
                raw = await photo.read(self.settings.max_upload_bytes + 1)
                job = await run_in_threadpool(self.accept, visitor["id"], data, raw, received)
                return JSONResponse(job, status_code=202)
            finally:
                await form.close()

        @router.get("/tryons")
        def listing(
            request: Request,
            offset: int = 0,
            limit: int = 100,
            look: str = Query("", max_length=200),
            status: HistoryStatus = "all",
        ):
            visitor = require_visitor(request)
            if not 0 <= offset <= 2**63 - 1 or not 1 <= limit <= 1000:
                raise HTTPException(422, "pagination:Invalid pagination")
            return self.history(visitor["id"], offset, limit, look, status)

        @router.get("/tryons/{job_id}")
        def detail(request: Request, job_id: str):
            visitor = require_visitor(request)
            return self.shape(self.get(job_id, visitor["id"]), include_reference=True)

        @router.get("/tryons/{job_id}/image")
        def image(request: Request, job_id: str):
            visitor = require_visitor(request)
            return self.image_response(self.get(job_id, visitor["id"]))

        @router.get("/tryons/{job_id}/download")
        def download(request: Request, job_id: str):
            visitor = require_visitor(request)
            return self.image_response(self.get(job_id, visitor["id"]), attachment=True)

        @router.delete("/tryons/{job_id}")
        def delete(request: Request, job_id: str):
            visitor = require_visitor(request, True)
            self.get(job_id, visitor["id"])
            self.remove(job_id)
            return {"deleted": True}

        return router
