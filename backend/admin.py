import hmac
import json
import secrets
from typing import Literal

from argon2 import PasswordHasher
from argon2.exceptions import VerificationError
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from .files import atomic_write
from .store import digest


class Review(BaseModel):
    model_config = ConfigDict(extra="forbid")
    verdict: Literal["unreviewed", "approved", "rejected"]
    notes: str = Field(default="", max_length=4000)


class Login(BaseModel):
    model_config = ConfigDict(extra="forbid")
    username: str = Field(max_length=128)
    password: str = Field(max_length=1024)


class PasswordChange(BaseModel):
    model_config = ConfigDict(extra="forbid")
    current_password: str = Field(max_length=1024)
    new_password: str = Field(min_length=16, max_length=1024)


class Admin:
    def __init__(self, store, settings, check_csrf):
        self.store, self.settings, self.check_csrf = store, settings, check_csrf
        self.hasher = PasswordHasher()
        with store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if not db.execute("SELECT 1 FROM administrator").fetchone():
                path = store.root / "initial-admin.json"
                if path.exists():
                    credentials = json.loads(path.read_text())
                else:
                    credentials = {"username": "admin", "password": secrets.token_urlsafe(36)}
                    atomic_write(path, json.dumps(credentials).encode())
                db.execute(
                    "INSERT INTO administrator VALUES (1,?,?)",
                    (credentials["username"], self.hasher.hash(credentials["password"])),
                )

    def session(self, request, required=True, mutate=False):
        token = request.cookies.get("yixu_admin", "")
        with self.store.connect() as db:
            row = db.execute(
                "SELECT * FROM admin_sessions WHERE token_hash=?", (digest(token),)
            ).fetchone()
        if not row or (required and not row["authenticated"]):
            raise HTTPException(401, "admin_auth:Administrator login required")
        if mutate:
            self.check_csrf(request, row["csrf"])
        return dict(row)

    def cookie(self, response, token):
        response.set_cookie(
            "yixu_admin",
            token,
            httponly=True,
            secure=self.settings.secure_cookies,
            samesite="strict",
            max_age=self.settings.cookie_max_age,
        )

    def verify(self, db, username, password):
        row = db.execute("SELECT * FROM administrator WHERE id=1").fetchone()
        try:
            valid: bool = self.hasher.verify(row["password_hash"], password)
        except VerificationError:
            valid = False
        if not valid or not hmac.compare_digest(username, row["username"]):
            raise HTTPException(401, "admin_auth:Invalid administrator credentials")

    def router(self):
        router = APIRouter(prefix="/api/admin")

        @router.get("/bootstrap")
        def bootstrap(request: Request):
            try:
                session = self.session(request, required=False)
                token = None
            except HTTPException:
                token = secrets.token_urlsafe(32)
                session = {"csrf": secrets.token_urlsafe(32), "authenticated": 0}
                with self.store.connect() as db:
                    db.execute(
                        "INSERT INTO admin_sessions VALUES (?,?,0)",
                        (digest(token), session["csrf"]),
                    )
            response = JSONResponse(
                {"authenticated": bool(session["authenticated"]), "csrf_token": session["csrf"]}
            )
            if token:
                self.cookie(response, token)
            return response

        @router.post("/login")
        def login(request: Request, data: Login):
            old = self.session(request, required=False, mutate=True)
            token, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
            with self.store.connect() as db:
                # Authoritative credential read, verify and session creation serialize
                # with rotation; an old-password login cannot commit after revocation.
                db.execute("BEGIN IMMEDIATE")
                self.verify(db, data.username, data.password)
                db.execute("DELETE FROM admin_sessions WHERE token_hash=?", (old["token_hash"],))
                db.execute("INSERT INTO admin_sessions VALUES (?,?,1)", (digest(token), csrf))
            response = JSONResponse({"authenticated": True, "csrf_token": csrf})
            self.cookie(response, token)
            return response

        @router.post("/logout")
        def logout(request: Request):
            session = self.session(request, mutate=True)
            with self.store.connect() as db:
                db.execute(
                    "DELETE FROM admin_sessions WHERE token_hash=?", (session["token_hash"],)
                )
            response = JSONResponse({"authenticated": False})
            response.delete_cookie(
                "yixu_admin", secure=self.settings.secure_cookies, httponly=True, samesite="strict"
            )
            return response

        @router.post("/password")
        def password(request: Request, data: PasswordChange):
            self.session(request, mutate=True)
            with self.store.connect() as db:
                db.execute("BEGIN IMMEDIATE")
                username = db.execute("SELECT username FROM administrator").fetchone()[0]
                try:
                    self.verify(db, username, data.current_password)
                except HTTPException:
                    raise HTTPException(
                        403, "current_password:Current password is incorrect"
                    ) from None
                db.execute(
                    "UPDATE administrator SET password_hash=? WHERE id=1",
                    (self.hasher.hash(data.new_password),),
                )
                db.execute("DELETE FROM admin_sessions")
            return {"changed": True}

        @router.get("/overview")
        def overview(request: Request):
            self.session(request)
            from .analytics import overview

            return overview(self.store, request.app.state.jobs)

        @router.get("/settings")
        def get_settings(request: Request):
            self.session(request)
            from .settings import RuntimeFile

            return RuntimeFile(self.store.root).load().redacted()

        from pydantic import ValidationError

        from .settings import RuntimePatch

        @router.put("/settings")
        def put_settings(request: Request, data: RuntimePatch):
            self.session(request, mutate=True)
            from .settings import RuntimeFile

            try:
                return RuntimeFile(self.store.root).update(data).redacted()
            except (ValidationError, ValueError):
                raise HTTPException(422, "invalid_settings:Invalid runtime settings") from None

        @router.get("/results")
        def results(request: Request, offset: int = 0, limit: int = 24):
            self.session(request)
            if offset < 0 or not 1 <= limit <= 1000:
                raise HTTPException(422, "pagination:Invalid pagination")
            with self.store.connect() as db:
                rows = db.execute(
                    "SELECT * FROM jobs WHERE status='succeeded' AND output_bytes>0 ORDER BY published DESC,seq DESC LIMIT ? OFFSET ?",
                    (limit + 1, offset),
                ).fetchall()
            from .jobs import timestamp

            return {
                "items": [
                    {
                        "id": r["id"],
                        "look_id": r["look_id"],
                        "edition": r["edition"],
                        "shot_index": r["shot_index"],
                        "created_at": timestamp(r["created"]),
                        "image_url": f"/api/admin/results/{r['id']}/image",
                        "review": {"verdict": r["verdict"], "notes": r["notes"]},
                    }
                    for r in rows[:limit]
                ],
                "has_more": len(rows) > limit,
            }

        def require_result(request, job_id):
            jobs = request.app.state.jobs
            row = jobs.get(job_id)
            if row["status"] != "succeeded" or row["output_bytes"] <= 0:
                raise HTTPException(404, "not_found:Generated result not found")
            return row

        @router.get("/results/{job_id}/image")
        def image(request: Request, job_id: str):
            self.session(request)
            return request.app.state.jobs.image_response(require_result(request, job_id))

        @router.post("/results/{job_id}/review")
        def review(request: Request, job_id: str, data: Review):
            self.session(request, mutate=True)
            require_result(request, job_id)
            with self.store.connect() as db:
                db.execute(
                    "UPDATE jobs SET verdict=?,notes=? WHERE id=?",
                    (data.verdict, data.notes, job_id),
                )
            return {"saved": True, "review": data.model_dump()}

        @router.delete("/results/{job_id}")
        def delete_result(request: Request, job_id: str):
            self.session(request, mutate=True)
            require_result(request, job_id)
            request.app.state.jobs.remove(job_id)
            return {"deleted": True}

        return router
