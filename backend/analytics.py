import secrets
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field


class Event(BaseModel):
    model_config = ConfigDict(extra="forbid")
    event: Literal["page_view", "look_open", "tryon_open"]
    look_id: int | None = Field(default=None, ge=1, le=2_147_483_647)
    edition: Literal["v2"] | None = None
    shot_index: int | None = Field(default=None, ge=1, le=9)
    event_id: str | None = Field(
        default=None, min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_-]+$"
    )


def router(store, require_visitor, clock, content=None, geolocation=None):
    routes = APIRouter()

    @routes.post("/api/events")
    def event(request: Request, data: Event):
        visitor = require_visitor(request, True)
        if (
            content is not None
            and content.enabled
            and data.look_id is not None
            and not any(look["id"] == data.look_id for look in content.catalog()["looks"])
        ):
            raise HTTPException(422, "invalid_selection:Public look is unavailable")
        with store.connect() as db:
            inserted = db.execute(
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
            if inserted.rowcount and data.event == "page_view" and geolocation is not None:
                # ASGI client is supplied by the server's trusted-proxy policy. Never
                # accept geographic/IP fields from the payload or arbitrary headers.
                geo = geolocation.lookup(request.client.host if request.client else None)
                db.execute(
                    "INSERT INTO event_geo (event_id,country_code,country_name,region_code,"
                    "region_name,status,source,database_build) VALUES (?,?,?,?,?,?,?,?)",
                    (
                        inserted.lastrowid,
                        geo["country_code"],
                        geo["country_name"],
                        geo["region_code"],
                        geo["region_name"],
                        geo["status"],
                        geo["source"],
                        geo["database_build"],
                    ),
                )
        return {"accepted": True}

    return routes


def geography(store):
    with store.connect() as db:
        totals = db.execute(
            "SELECT count(DISTINCT owner),count(*) FROM events WHERE event='page_view'"
        ).fetchone()
        countries = [
            dict(r)
            for r in db.execute(
                "SELECT g.country_code,max(g.country_name) country_name,count(*) visits,"
                "count(DISTINCT e.owner) visitors FROM events e LEFT JOIN event_geo g "
                "ON g.event_id=e.id WHERE e.event='page_view' GROUP BY g.country_code "
                "ORDER BY visits DESC,g.country_code LIMIT 250"
            )
        ]
        provinces = [
            dict(r)
            for r in db.execute(
                "SELECT g.region_code,g.region_name,count(*) visits,count(DISTINCT e.owner) visitors "
                "FROM events e JOIN event_geo g ON g.event_id=e.id "
                "WHERE e.event='page_view' AND g.country_code='CN' "
                "GROUP BY g.region_code,g.region_name ORDER BY visits DESC,g.region_name LIMIT 100"
            )
        ]
        recent = [
            dict(r)
            for r in db.execute(
                "WITH recent AS (SELECT owner,min(created) first_seen,max(created) last_seen,"
                "count(*) page_views FROM events WHERE event='page_view' GROUP BY owner "
                "ORDER BY last_seen DESC,owner LIMIT 20) "
                "SELECT r.owner visitor_id,r.first_seen,r.last_seen,r.page_views,g.country_code,"
                "g.country_name,g.region_code,g.region_name,coalesce(g.status,'legacy') status "
                "FROM recent r LEFT JOIN event_geo g ON g.event_id=(SELECT id FROM events "
                "WHERE owner=r.owner AND event='page_view' ORDER BY created DESC,id DESC LIMIT 1) "
                "ORDER BY r.last_seen DESC,r.owner"
            )
        ]
    return {
        "total_visitors": totals[0],
        "total_page_views": totals[1],
        "countries": countries,
        "china_provinces": provinces,
        "recent_visitors": recent,
    }


def overview(store, jobs, geolocation=None):
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
        "visitor_geo": {
            **geography(store),
            "database": geolocation.info()
            if geolocation
            else {"status": "unconfigured", "source": "DB-IP City Lite"},
        },
    }
