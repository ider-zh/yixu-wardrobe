import secrets
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field


class Event(BaseModel):
    model_config = ConfigDict(extra="forbid")
    event: Literal["page_view", "look_open", "tryon_open"]
    look_id: int | None = Field(default=None, ge=1, le=2_147_483_647)
    edition: Literal["v1", "v2"] | None = None
    shot_index: int | None = Field(default=None, ge=1, le=9)
    event_id: str | None = Field(
        default=None, min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_-]+$"
    )


def router(store, require_visitor, clock, content=None):
    routes = APIRouter()

    @routes.post("/api/events")
    def event(request: Request, data: Event):
        visitor = require_visitor(request, True)
        if (
            content is not None
            and content.enabled
            and (
                data.edition == "v1"
                or (
                    data.look_id is not None
                    and not any(look["id"] == data.look_id for look in content.catalog()["looks"])
                )
            )
        ):
            raise HTTPException(422, "invalid_selection:Public look is unavailable")
        with store.connect() as db:
            db.execute(
                "INSERT OR IGNORE INTO events "
                "(owner,event_id,event,look_id,edition,shot_index,created) VALUES (?,?,?,?,?,?,?)",
                (
                    visitor["id"],
                    data.event_id or secrets.token_hex(16),
                    data.event,
                    data.look_id,
                    data.edition,
                    data.shot_index,
                    clock(),
                ),
            )
        return {"accepted": True}

    return routes


def overview(store, jobs):
    with store.connect() as db:
        counts = {
            r[0]: r[1] for r in db.execute("SELECT status,count(*) FROM jobs GROUP BY status")
        }
        events = {
            r[0]: r[1] for r in db.execute("SELECT event,count(*) FROM events GROUP BY event")
        }
        result_count, result_bytes = db.execute(
            "SELECT count(*),coalesce(sum(output_bytes),0) FROM jobs WHERE output_bytes>0"
        ).fetchone()
        popular = [
            {"look_id": r[0], "count": r[1]}
            for r in db.execute(
                "SELECT look_id,count(*) FROM events WHERE event='look_open' AND look_id IS NOT NULL GROUP BY look_id ORDER BY count(*) DESC,look_id LIMIT 10"
            )
        ]
        recent = [dict(r) for r in db.execute("SELECT * FROM jobs ORDER BY seq DESC LIMIT 20")]
    return {
        "visits": events.get("page_view", 0),
        "look_opens": events.get("look_open", 0),
        "tryons_total": sum(counts.values()),
        "queued": counts.get("queued", 0),
        "running": sum(counts.get(s, 0) for s in ("validating", "generating", "postprocessing")),
        "succeeded": counts.get("succeeded", 0),
        "failed": counts.get("failed", 0),
        "unknown": counts.get("unknown", 0),
        "result_count": result_count,
        "result_bytes": result_bytes,
        "popular_looks": popular,
        "recent_jobs": [jobs.shape(r) for r in recent],
    }
