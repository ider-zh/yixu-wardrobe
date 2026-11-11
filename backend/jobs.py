"""Public HTTP seams and persistent, owner-scoped request queue."""

import hashlib
import json
import secrets
from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile
from starlette.formparsers import MultiPartParser
from starlette.responses import JSONResponse

from .files import atomic_write
from .images import crop_reference, validate_photo


class Submission(BaseModel):
    model_config = ConfigDict(extra="forbid")
    look_id: int = Field(ge=1, le=100)
    edition: Literal["v1", "v2"]
    shot_index: int = Field(ge=1, le=9)
    idempotency_key: str = Field(min_length=8, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")
    disclosure_version: str


def timestamp(value):
    return datetime.fromtimestamp(value, UTC).isoformat().replace("+00:00", "Z")


class Jobs:
    def __init__(self, store, settings, available, detector, clock):
        self.store, self.settings = store, settings
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

    def shape(self, row):
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
        return {
            "id": row["id"],
            "status": row["status"],
            "look_id": row["look_id"],
            "edition": row["edition"],
            "shot_index": row["shot_index"],
            "created_at": timestamp(row["created"]),
            "original_expires_at": timestamp(row["expires"]),
            "queue_position": position,
            "image_url": f"/api/tryons/{row['id']}/image" if ready else None,
            "download_url": f"/api/tryons/{row['id']}/download" if ready else None,
            "error_code": row["error_code"],
            "error_message": row["error_message"],
        }

    def accept(self, owner, data, raw, received):
        fingerprint = hashlib.sha256(
            raw + json.dumps(data.model_dump(exclude={"idempotency_key"}), sort_keys=True).encode()
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
            return self.shape(dict(old))
        # Existing requests need neither fresh inference readiness nor input writes.
        if not self.available():
            raise HTTPException(503, "unavailable:Provider, detector or catalog is not configured")
        photo = validate_photo(raw, self.settings, self.detector)
        reference = crop_reference(self.settings, data.look_id, data.edition, data.shot_index)
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
                return self.shape(dict(old))
            db.execute(
                """INSERT INTO jobs (id,owner,idempotency_key,fingerprint,status,
                       look_id,edition,shot_index,created,expires) VALUES (?,?,?,?,'validating',?,?,?,?,?)""",
                (
                    job_id,
                    owner,
                    data.idempotency_key,
                    fingerprint,
                    data.look_id,
                    data.edition,
                    data.shot_index,
                    received,
                    received + 3600,
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
        return self.shape(self.get(job_id, owner))

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

    def image_response(self, row, attachment=False):
        from starlette.responses import Response

        if row["status"] != "succeeded" or row["output_bytes"] <= 0:
            raise HTTPException(404, "no_result:No generated result")
        try:
            data = (self.outputs / f"{row['id']}.webp").read_bytes()
        except FileNotFoundError:
            raise HTTPException(404, "no_result:No generated result") from None
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
                max_fields=6,
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
        def listing(request: Request, offset: int = 0, limit: int = 100):
            visitor = require_visitor(request)
            if offset < 0 or not 1 <= limit <= 1000:
                raise HTTPException(422, "pagination:Invalid pagination")
            with self.store.connect() as db:
                rows = db.execute(
                    "SELECT * FROM jobs WHERE owner=? ORDER BY seq DESC LIMIT ? OFFSET ?",
                    (visitor["id"], limit + 1, offset),
                ).fetchall()
            return {
                "items": [self.shape(dict(r)) for r in rows[:limit]],
                "has_more": len(rows) > limit,
            }

        @router.get("/tryons/{job_id}")
        def detail(request: Request, job_id: str):
            visitor = require_visitor(request)
            return self.shape(self.get(job_id, visitor["id"]))

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
