import hmac
import sqlite3

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from .settings import Settings
from .store import Store

DISCLOSURE_VERSION = "2026-11-12-v2"
DISCLOSURE = {
    "version": DISCLOSURE_VERSION,
    "title": "照片用途",
    "items": ["照片交由第三方 AI 生成试穿图，结果可供后台评估。"],
}


def error(code: str, message: str, status: int):
    return JSONResponse(
        {"error": {"code": code, "message": message}},
        status_code=status,
        headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
    )


class JsonBodyLimit:
    """Bound non-upload mutation bodies before any framework body accumulation.

    This is a technical JSON parsing bound, not a request or inference quota.
    Multipart /api/tryons retains its separate authenticated streaming limit.
    """

    max_bytes = 64 * 1024

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if (
            scope["type"] != "http"
            or scope["method"] not in ("POST", "PUT", "PATCH")
            or scope["path"].rstrip("/") == "/api/tryons"
        ):
            return await self.app(scope, receive, send)
        body = bytearray()
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            chunk = message.get("body", b"")
            if len(body) + len(chunk) > self.max_bytes:
                response = error("json_too_large", "JSON body exceeds technical limit", 413)
                return await response(scope, receive, send)
            body.extend(chunk)
            if not message.get("more_body", False):
                break
        delivered = False

        async def bounded_receive():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": bytes(body), "more_body": False}
            return await receive()

        return await self.app(scope, bounded_receive, send)


def create_app(
    settings: Settings | None = None, provider=None, detector=None, clock=None
) -> FastAPI:
    from .images import YuNetDetector
    from .provider import OpenAIProvider
    from .settings import RuntimeFile

    settings = settings or Settings.from_env()
    provider = provider if provider is not None else OpenAIProvider()
    detector = detector if detector is not None else YuNetDetector(settings)
    runtime_file = RuntimeFile(settings.data_dir)

    def provider_ready():
        configured = getattr(provider, "configured", None)
        return bool(configured(runtime_file.load())) if configured else True

    def detector_ready():
        return bool(getattr(detector, "ready", False))

    def available():
        return bool(
            provider_ready()
            and detector_ready()
            and (
                content.ready
                if content.enabled
                else bool(
                    settings.catalog_path
                    and settings.catalog_path.is_file()
                    and settings.catalog_image_root
                    and settings.catalog_image_root.is_dir()
                )
            )
        )

    from contextlib import asynccontextmanager

    import anyio

    @asynccontextmanager
    async def lifespan(app):
        async def cleanup():
            while True:
                await anyio.to_thread.run_sync(app.state.jobs.purge_inputs)
                await anyio.sleep(0.2)

        async with anyio.create_task_group() as tasks:
            tasks.start_soon(cleanup)
            if app.state.content.ready:
                app.state.cdn_worker.start()
            try:
                yield
            finally:
                app.state.cdn_worker.stop()
                tasks.cancel_scope.cancel()

    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    app.add_middleware(JsonBodyLimit)
    app.state.settings = settings
    app.state.provider = provider
    app.state.store = store = Store(settings.data_dir)
    from .content import ContentService

    app.state.content = content = ContentService(settings)
    app.include_router(content.router())

    @app.get("/api/content/publication")
    def publication():
        from .publication import publication_status

        catalog = content.catalog() if content.ready else {}
        return {
            **publication_status(settings.data_dir, catalog),
            "home": catalog.get("home"),
            "look_count": len(catalog.get("looks", [])),
        }

    from .cdn import CdnService
    from .cdn_worker import CdnWorker

    app.state.cdn = cdn = CdnService(settings.data_dir)
    app.state.cdn_worker = CdnWorker(cdn)
    if content.ready:
        cdn.enqueue(content.asset_records(), content.catalog()["revision"])
        content.set_delivery_resolver(cdn.resolve)

    @app.middleware("http")
    async def boundary(request: Request, call_next):
        host = request.headers.get("host", "")
        if host not in (settings.public_host, settings.admin_host):
            return error("host", "Unknown host", 421)
        admin = request.url.path.startswith("/api/admin")
        if admin != (host == settings.admin_host):
            return error("not_found", "Not found", 404)
        try:
            if hasattr(app.state, "jobs"):
                from starlette.concurrency import run_in_threadpool

                await run_in_threadpool(app.state.jobs.purge_inputs)
            response = await call_next(request)
        except (OSError, sqlite3.Error):
            response = error("storage_unavailable", "Private service storage is unavailable", 503)
        except Exception:  # noqa: BLE001 - prevent paths/credentials/native bodies in API errors
            response = error("internal_error", "Request could not be completed", 500)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @app.get("/api/health")
    def health():
        return {
            "ok": True,
            "provider_configured": provider_ready(),
            "detector_ready": detector_ready(),
        }

    @app.get("/api/bootstrap")
    def bootstrap(request: Request):
        visitor, token = store.visitor(request.cookies.get("yixu_visitor"))
        response = JSONResponse(
            {
                "csrf_token": visitor["csrf"],
                "visitor": {"id": visitor["id"]},
                "generation_available": available(),
                "unavailable_reason": None
                if available()
                else "provider_or_detector_or_catalog_unavailable",
                "disclosure": {**DISCLOSURE, "accepted": visitor["accepted"] == DISCLOSURE_VERSION},
                "original_retention_seconds": 3600,
                "result_max_count": 1000,
            }
        )
        if token:
            response.set_cookie(
                "yixu_visitor",
                token,
                httponly=True,
                secure=settings.secure_cookies,
                samesite="strict",
                max_age=settings.cookie_max_age,
            )
        return response

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request, exc):
        code, separator, message = str(exc.detail).partition(":")
        if not separator:
            code, message = (
                ("not_found", "Not found")
                if exc.status_code == 404
                else ("request_rejected", "Request rejected")
            )
        return error(code, message or "Request rejected", exc.status_code)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, exc):
        return error("invalid_request", "Invalid request fields", 422)

    def require_visitor(request: Request, mutate=False):
        token = request.cookies.get("yixu_visitor")
        with store.connect() as db:
            from .store import digest

            row = db.execute(
                "SELECT * FROM visitors WHERE token_hash=?", (digest(token or ""),)
            ).fetchone()
        if not row:
            raise HTTPException(401, "session:Load the page first")
        if mutate:
            check_csrf(request, row["csrf"])
        return dict(row)

    def check_csrf(request: Request, csrf: str):
        if request.headers.get("origin") != str(request.base_url).rstrip(
            "/"
        ) or not hmac.compare_digest(request.headers.get("x-csrf-token", ""), csrf):
            raise HTTPException(403, "csrf:Invalid origin or CSRF token")

    @app.post("/api/disclosure/accept")
    async def accept(request: Request):
        visitor = require_visitor(request, True)
        try:
            data = await request.json()
        except ValueError:
            raise HTTPException(422, "invalid_request:Invalid JSON request") from None
        if not isinstance(data, dict) or set(data) != {"version"}:
            raise HTTPException(422, "invalid_request:Invalid disclosure request")
        if data.get("version") != DISCLOSURE_VERSION:
            raise HTTPException(409, "disclosure_version:Reload the disclosure")
        with store.connect() as db:
            db.execute(
                "UPDATE visitors SET accepted=? WHERE id=?", (DISCLOSURE_VERSION, visitor["id"])
            )
        return {"accepted": True, "version": DISCLOSURE_VERSION}

    import time

    from .jobs import Jobs

    jobs = Jobs(store, settings, available, detector, clock or time.time, content=content)
    app.state.jobs = jobs
    app.include_router(jobs.router(require_visitor, DISCLOSURE_VERSION))
    from .analytics import router as analytics_router

    app.include_router(analytics_router(store, require_visitor, jobs.clock, content=content))
    from .admin import Admin

    admin = Admin(store, settings, check_csrf)
    app.include_router(admin.router())
    app.state.admin = admin
    from .content_admin import create_content_admin_router

    app.include_router(create_content_admin_router(cdn, content, admin))
    return app
