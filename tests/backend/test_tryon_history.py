import json

from conftest import consent, submit
from fastapi.testclient import TestClient

from backend.store import Store


def insert_jobs(app, owner, records):
    now = app.state.jobs.clock()
    with app.state.store.connect() as db:
        db.executemany(
            """INSERT INTO jobs
               (id, owner, idempotency_key, fingerprint, status, look_id, look_title,
                edition, shot_index, created, expires)
               VALUES (?, ?, ?, 'fixture', ?, ?, ?, 'v2', 1, ?, ?)""",
            [
                (key, owner, key, status, look, title, now, now + 3600)
                for key, status, look, title in records
            ],
        )


def history(client, **params):
    response = client.get("/api/tryons", params=params)
    assert response.status_code == 200, response.text
    return response.json()


def test_tryon_history_filters_owner_and_status_before_pagination(setup):
    app, client, _headers, bootstrap, *_ = setup
    owner = bootstrap["visitor"]["id"]
    states = (
        "queued",
        "validating",
        "generating",
        "postprocessing",
        "succeeded",
        "failed",
        "unknown",
        "needs_photo",
        "expired",
        "canceled",
    )
    insert_jobs(app, owner, [(state, state, 101, "周末通勤") for state in states])
    insert_jobs(app, owner, [("different-look", "queued", 102, "观展")])

    with TestClient(app, base_url="https://localhost") as stranger:
        other_owner = stranger.get("/api/bootstrap").json()["visitor"]["id"]
        insert_jobs(app, other_owner, [("private-other", "queued", 101, "周末通勤")])

        active = {"look": " #000101 ", "status": "active", "limit": 2}
        first = history(client, **active)
        assert [job["id"] for job in first["items"]] == ["postprocessing", "generating"]
        assert first["has_more"] is True
        last = history(client, **active, offset=2)
        assert [job["id"] for job in last["items"]] == ["validating", "queued"]
        assert last["has_more"] is False
        assert history(client, **active, offset=4) == {"items": [], "has_more": False}
        assert [job["id"] for job in history(stranger, **active)["items"]] == ["private-other"]

        assert [
            job["status"] for job in history(client, look="通勤", status="success")["items"]
        ] == ["succeeded"]
        assert [
            job["status"] for job in history(client, look="通勤", status="failed")["items"]
        ] == ["canceled", "expired", "needs_photo", "unknown", "failed"]
        assert len(history(client)["items"]) == 11
        assert history(client, look="9" * 100)["items"] == []
        assert client.get("/api/tryons", params={"status": "bogus"}).status_code == 422


def test_tryon_history_prefers_saved_title_and_falls_back_for_legacy_jobs(setup):
    app, client, headers, bootstrap, *_ = setup
    catalog_file = app.state.settings.catalog_path
    catalog = json.loads(catalog_file.read_text())
    look = catalog["looks"][0]
    look.update(title="Résumé % 秋日", model_only=True)
    catalog_file.write_text(json.dumps(catalog), encoding="utf-8")

    consent(client, headers, bootstrap)
    result = submit(client, headers, bootstrap)
    assert result.status_code == 202, result.text
    saved = result.json()
    assert saved["look_title"] == "Résumé % 秋日"

    look["title"] = "当前目录标题"
    catalog_file.write_text(json.dumps(catalog), encoding="utf-8")
    insert_jobs(app, bootstrap["visitor"]["id"], [("legacy", "expired", 1, None)])
    assert [job["id"] for job in history(client, look="rÉSUMÉ %")["items"]] == [saved["id"]]
    assert [job["id"] for job in history(client, look="%")["items"]] == [saved["id"]]
    assert [job["id"] for job in history(client, look="当前目录")["items"]] == ["legacy"]

    catalog_file.write_text('{"looks": []}', encoding="utf-8")
    assert [job["id"] for job in history(client, look="秋日")["items"]] == [saved["id"]]
    assert history(client, look="当前目录")["items"] == []
    assert [job["id"] for job in history(client, look="#0001")["items"]] == ["legacy", saved["id"]]


def test_opening_a_legacy_queue_keeps_rows_and_adds_title_column(setup):
    app, _client, _headers, bootstrap, *_ = setup
    insert_jobs(app, bootstrap["visitor"]["id"], [("legacy", "succeeded", 12, None)])
    with app.state.store.connect() as db:
        db.execute("ALTER TABLE jobs DROP COLUMN look_title")

    reopened = Store(app.state.store.root)
    with reopened.connect() as db:
        row = db.execute("SELECT id, look_id, look_title FROM jobs WHERE id='legacy'").fetchone()
    assert tuple(row) == ("legacy", 12, None)
