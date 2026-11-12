from pathlib import Path

from fastapi.testclient import TestClient


def test_bootstrap_is_automatic_private_host_bound_session(tmp_path: Path):
    from backend.app import create_app
    from backend.settings import Settings

    app = create_app(Settings(data_dir=tmp_path))
    with TestClient(app, base_url="https://localhost") as c:
        assert c.get("/api/health").json() == {
            "ok": True,
            "provider_configured": False,
            "detector_ready": False,
        }
        first = c.get("/api/bootstrap")
        assert first.status_code == 200
        data = first.json()
        assert data["visitor"]["id"] and data["csrf_token"]
        assert data["original_retention_seconds"] == 3600
        assert data["result_max_count"] == 1000
        assert data["generation_available"] is False
        assert not data["disclosure"]["accepted"]
        assert c.get("/api/bootstrap").json()["visitor"] == data["visitor"]
        cookie = first.headers["set-cookie"].lower()
        assert "httponly" in cookie and "secure" in cookie and "samesite=strict" in cookie
        assert "domain=" not in cookie and "max-age=" not in cookie
        assert first.headers["cache-control"] == "no-store"
        assert c.get("/api/admin/overview").status_code == 404
        assert c.get("/api/bootstrap", headers={"host": "unknown.invalid"}).status_code == 421


def test_disclosure_is_concise_and_legacy_acceptance_does_not_carry_over(tmp_path):
    from backend.app import create_app
    from backend.settings import Settings

    app = create_app(Settings(data_dir=tmp_path))
    with TestClient(app, base_url="https://localhost") as c:
        b = c.get("/api/bootstrap").json()
        disclosure = b["disclosure"]
        assert disclosure["title"] == "照片用途"
        assert disclosure["items"] == ["照片交由第三方 AI 生成试穿图，结果可供后台评估。"]
        assert disclosure["version"] != "2026-11-11-v1"
        assert disclosure["accepted"] is False
        headers = {"Origin": "https://localhost", "X-CSRF-Token": b["csrf_token"]}
        # A receipt for the old wording must never be attached to the new copy.
        with app.state.store.connect() as db:
            db.execute(
                "UPDATE visitors SET accepted=? WHERE id=?",
                ("2026-11-11-v1", b["visitor"]["id"]),
            )
        assert c.get("/api/bootstrap").json()["disclosure"]["accepted"] is False
        assert (
            c.post(
                "/api/disclosure/accept", json={"version": "2026-11-11-v1"}, headers=headers
            ).status_code
            == 409
        )
        assert (
            c.post(
                "/api/disclosure/accept", json={"version": disclosure["version"]}, headers=headers
            ).status_code
            == 200
        )
        assert c.get("/api/bootstrap").json()["disclosure"]["accepted"] is True


def test_consent_requires_session_csrf_and_exact_origin(tmp_path):
    from backend.app import create_app
    from backend.settings import Settings

    with TestClient(create_app(Settings(data_dir=tmp_path)), base_url="https://localhost") as c:
        b = c.get("/api/bootstrap").json()
        data = {"version": b["disclosure"]["version"]}
        assert c.post("/api/disclosure/accept", json=data).status_code == 403
        headers = {"X-CSRF-Token": b["csrf_token"], "Origin": "https://attacker.invalid"}
        assert c.post("/api/disclosure/accept", json=data, headers=headers).status_code == 403
        headers["Origin"] = "https://localhost"
        assert (
            c.post("/api/disclosure/accept", json={"version": "old"}, headers=headers).status_code
            == 409
        )
        assert c.post("/api/disclosure/accept", json=data, headers=headers).json() == {
            "accepted": True,
            **data,
        }
        assert c.get("/api/bootstrap").json()["disclosure"]["accepted"]
