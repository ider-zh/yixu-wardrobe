from conftest import consent, submit
from fastapi.testclient import TestClient
from test_admin import login


def test_first_party_events_are_whitelisted_minimal_deduplicated_and_counts_authoritative(setup):
    app, c, h, b, _provider, _detector, _clock = setup
    assert c.post(
        "/api/events", headers=h, json={"event": "page_view", "event_id": "event-00001"}
    ).json() == {"accepted": True}
    assert (
        c.post(
            "/api/events", headers=h, json={"event": "page_view", "event_id": "event-00001"}
        ).status_code
        == 200
    )
    assert (
        c.post(
            "/api/events", headers=h, json={"event": "look_open", "look_id": 1, "edition": "v2"}
        ).status_code
        == 200
    )
    for invalid in (
        {"event": "arbitrary"},
        {"event": "page_view", "raw_ip": "1.2.3.4"},
        {"event": "page_view", "filename": "selfie"},
        {"event": "tryon_success"},
    ):
        assert c.post("/api/events", headers=h, json=invalid).status_code == 422
    assert c.post("/api/events", json={"event": "page_view"}).status_code == 403
    consent(c, h, b)
    submit(c, h, b)
    with TestClient(app, base_url="https://admin.localhost") as admin:
        login(admin, app.state.settings.data_dir)
        data = admin.get("/api/admin/overview").json()
        assert data["visits"] == 1 and data["look_opens"] == 1
        assert data["tryons_total"] == 1 and data["queued"] == 1
        assert data["succeeded"] == 0 and data["result_count"] == 0 and data["result_bytes"] == 0
        assert data["popular_looks"] == [{"look_id": 1, "count": 1}]
        assert len(data["recent_jobs"]) == 1
        assert "token" not in str(data) and "private-selfie" not in str(data)
    with app.state.store.connect() as db:
        columns = [r[1] for r in db.execute("PRAGMA table_info(events)")]
        assert set(columns) == {
            "id",
            "owner",
            "event_id",
            "event",
            "look_id",
            "edition",
            "shot_index",
            "created",
        }
