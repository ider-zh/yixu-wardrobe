import json

from fastapi.testclient import TestClient

from backend.app import create_app
from backend.settings import Settings


def test_content_admin_routes_exact_host_auth_csrf_and_write_scope(tmp_path):
    app = create_app(Settings(data_dir=tmp_path))
    with TestClient(app, base_url="https://admin.localhost") as client:
        assert client.get("/api/admin/content/overview").status_code == 401
        assert client.get("/api/admin/content/models").status_code == 401
        bootstrap = client.get("/api/admin/bootstrap").json()
        headers = {"Origin": "https://admin.localhost", "X-CSRF-Token": bootstrap["csrf_token"]}
        credentials = json.loads((tmp_path / "initial-admin.json").read_text())
        login = client.post("/api/admin/login", headers=headers, json=credentials)
        assert login.status_code == 200
        headers["X-CSRF-Token"] = login.json()["csrf_token"]
        overview = client.get("/api/admin/content/overview")
        assert overview.status_code == 200
        assert overview.json()["cdn"]["config"]["configured"] is False
        assert "archive_path" not in overview.text
        assert client.get("/api/admin/content/models").json() == {"models": []}
        retry = "/api/admin/content/cdn/jobs/1/retry"
        verify = "/api/admin/content/cdn/jobs/1/verify"
        migrate = "/api/admin/content/cdn/migrate"
        for route in [retry, verify, migrate]:
            body = {"asset_ids": ["private-selfie"]} if route == migrate else None
            assert client.post(route, json=body).status_code == 403
            assert (
                client.post(
                    route, headers={**headers, "Origin": "https://localhost"}, json=body
                ).status_code
                == 403
            )
            assert client.post(route, headers=headers, json=body).status_code == 409
        # Neither content edits nor CDN credentials are available via observation endpoints.
        assert client.post("/api/admin/content/models", headers=headers, json={}).status_code == 405
        assert (
            client.put("/api/admin/content/cdn/config", headers=headers, json={}).status_code == 404
        )
        assert client.post("/api/admin/logout", headers=headers).status_code == 200
        assert client.get("/api/admin/content/overview").status_code == 401
    with TestClient(app, base_url="https://localhost") as client:
        assert client.get("/api/admin/content/overview").status_code == 404
        assert client.get("/api/admin/content/models").status_code == 404
    with TestClient(app, base_url="https://admin.localhost.evil.example") as client:
        assert client.get("/api/admin/content/overview").status_code == 421
