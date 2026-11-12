"""Authenticated observations for Git-delivered public content; no content CRUD."""

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field


class Migration(BaseModel):
    model_config = ConfigDict(extra="forbid")
    asset_ids: list[str] = Field(min_length=1, max_length=1000)


def create_content_admin_router(service, content, admin):
    router = APIRouter(prefix="/api/admin/content")

    @router.get("/overview")
    def overview(request: Request):
        admin.session(request, required=True)
        catalog = content.catalog() if content.ready else {}
        return {
            "revision": catalog.get("revision"),
            "content_ready": content.ready,
            "import_error": getattr(content, "import_error", None),
            "look_count": len(catalog.get("looks", [])),
            "model_count": len(content.admin_models()) if content.ready else 0,
            "cdn": service.overview(),
        }

    @router.get("/models")
    def models(request: Request):
        admin.session(request, required=True)
        items = content.admin_models() if content.ready else []
        for model in items:
            if model.get("preview_available"):
                source = f"/api/admin/content/models/{model['model_id']}/reference"
                model["source_url"] = model["image_url"] = source
                model["reference"].update(source_url=source, image_url=source)
        return {"models": items}

    @router.get("/models/{model_id}/reference")
    def model_reference(request: Request, model_id: str):
        admin.session(request, required=True)
        items = content.admin_models() if content.ready else []
        model = next((item for item in items if item["model_id"] == model_id), None)
        if not model or not model.get("preview_available"):
            raise HTTPException(404, "not_found:Model preview is unavailable")
        data, _ = content.asset(model["reference"]["asset_id"])
        return Response(data, media_type="image/webp")

    @router.post("/cdn/jobs/{job_id}/retry")
    def retry(request: Request, job_id: int):
        admin.session(request, required=True, mutate=True)
        try:
            return service.retry(job_id)
        except ValueError:
            raise HTTPException(
                409,
                "cdn_retry:Only definitive failures for the current provider can be retried; unknown uploads require manual review",
            ) from None

    @router.post("/cdn/jobs/{job_id}/verify")
    def verify(request: Request, job_id: int):
        admin.session(request, required=True, mutate=True)
        try:
            return service.verify_unknown(job_id)
        except ValueError:
            raise HTTPException(
                409,
                "cdn_verify:No recorded unknown object for the current provider; manual provider review required",
            ) from None

    @router.post("/cdn/migrate")
    def migrate(request: Request, data: Migration):
        admin.session(request, required=True, mutate=True)
        try:
            return service.migrate(data.asset_ids)
        except ValueError:
            raise HTTPException(
                409,
                "cdn_migrate:Select active public assets and configure a provider before migration",
            ) from None

    return router
