import json
import stat

from fastapi.testclient import TestClient

from backend.app import create_app
from backend.settings import Settings


def login(client, root):
    bootstrap = client.get("/api/admin/bootstrap").json()
    creds = json.loads((root / "initial-admin.json").read_text())
    headers = {"Origin": "https://admin.localhost", "X-CSRF-Token": bootstrap["csrf_token"]}
    result = client.post("/api/admin/login", json=creds, headers=headers)
    assert result.status_code == 200
    headers["X-CSRF-Token"] = result.json()["csrf_token"]
    return headers


def test_admin_first_init_persistent_hash_login_password_logout(tmp_path):
    settings = Settings(data_dir=tmp_path)
    app = create_app(settings)
    credentials = (tmp_path / "initial-admin.json").read_bytes()
    assert stat.S_IMODE(tmp_path.stat().st_mode) == 0o700
    assert stat.S_IMODE((tmp_path / "initial-admin.json").stat().st_mode) == 0o600
    assert len(json.loads(credentials)["password"]) >= 32
    with TestClient(app, base_url="https://admin.localhost") as c:
        assert c.get("/api/admin/bootstrap").json()["authenticated"] is False
        assert c.get("/api/admin/overview").status_code == 401
        b = c.get("/api/admin/bootstrap").json()
        assert c.post("/api/admin/login", json=json.loads(credentials)).status_code == 403
        h = {"Origin": "https://admin.localhost", "X-CSRF-Token": b["csrf_token"]}
        assert (
            c.post(
                "/api/admin/login", json={"username": "x", "password": "x"}, headers=h
            ).status_code
            == 401
        )
        h = login(c, tmp_path)
        assert c.get("/api/admin/bootstrap").json()["authenticated"] is True
        old_cookie = c.cookies.get("yixu_admin")
        result = c.post(
            "/api/admin/password",
            json={
                "current_password": json.loads(credentials)["password"],
                "new_password": "test-password-is-not-production-123456",
            },
            headers=h,
        )
        assert result.json() == {"changed": True}
        assert c.get("/api/admin/bootstrap").json()["authenticated"] is False
        c.cookies.set("yixu_admin", old_cookie, domain="admin.localhost", path="/")
        assert c.get("/api/admin/bootstrap").json()["authenticated"] is False
    create_app(settings)
    assert (tmp_path / "initial-admin.json").read_bytes() == credentials
    assert (
        json.loads(credentials)["password"].encode()
        not in (tmp_path / "state.sqlite3").read_bytes()
    )


def test_runtime_settings_redacted_atomic_persistent_and_disabled_without_key(tmp_path):
    with TestClient(
        create_app(Settings(data_dir=tmp_path)), base_url="https://admin.localhost"
    ) as c:
        h = login(c, tmp_path)
        assert c.get("/api/admin/settings").status_code == 200
        r = c.put(
            "/api/admin/settings",
            headers=h,
            json={
                "enabled": True,
                "model": "gpt-image-1.5",
                "api_key": "test-only-key",
                "api_base": "https://api.openai.com/v1",
                "proxy_url": "http://127.0.0.1:7890",
            },
        )
        assert r.status_code == 200
        assert r.json()["api_key_configured"] is True
        assert "test-only-key" not in r.text and "api_key" not in r.json()
        assert c.put("/api/admin/settings", headers=h, json={"api_key": ""}).json()[
            "api_key_configured"
        ]
        assert c.put("/api/admin/settings", headers=h, json={"proxy_url": ""}).status_code == 422
        assert c.put("/api/admin/settings", headers=h, json={"unexpected": 3}).status_code == 422
        assert c.post("/api/admin/logout", headers=h).json() == {"authenticated": False}
        assert c.get("/api/admin/settings").status_code == 401
    assert stat.S_IMODE((tmp_path / "runtime.json").stat().st_mode) == 0o600
    with TestClient(
        create_app(Settings(data_dir=tmp_path)), base_url="https://admin.localhost"
    ) as c:
        h = login(c, tmp_path)
        assert c.get("/api/admin/settings").json()["model"] == "gpt-image-1.5"
        assert (
            c.put("/api/admin/settings", headers=h, json={"clear_api_key": True}).json()[
                "api_key_configured"
            ]
            is False
        )


def test_admin_generated_only_results_optional_review_and_delete(setup):
    from conftest import consent, submit

    from backend.worker import Worker

    app, c, h, b, _provider, _detector, _clock = setup
    consent(c, h, b)
    job = submit(c, h, b).json()
    root = app.state.settings.data_dir
    with TestClient(app, base_url="https://admin.localhost") as admin:
        assert admin.get("/api/admin/results").status_code == 401
        ah = login(admin, root)
        assert admin.get("/api/admin/results").json() == {"items": [], "has_more": False}
        assert admin.get("/api/admin/results/" + job["id"] + "/image").status_code == 404
        assert admin.get("/api/tryons/" + job["id"] + "/image").status_code == 404
        assert admin.get("/api/admin/inputs/" + job["id"]).status_code == 404
        with Worker(app) as worker:
            worker.run_once()
        results = admin.get("/api/admin/results?offset=0&limit=24").json()
        assert len(results["items"]) == 1 and not results["has_more"]
        result = results["items"][0]
        assert result["review"] == {"verdict": "unreviewed", "notes": ""}
        assert "owner" not in result and "original" not in str(result)
        assert (
            admin.get(result["image_url"]).content
            == c.get("/api/tryons/" + job["id"] + "/image").content
        )
        review = {"verdict": "approved", "notes": "good fit"}
        assert (
            admin.post("/api/admin/results/" + job["id"] + "/review", json=review).status_code
            == 403
        )
        assert admin.post(
            "/api/admin/results/" + job["id"] + "/review", headers=ah, json=review
        ).json() == {"saved": True, "review": review}
        assert admin.get("/api/admin/results").json()["items"][0]["review"] == review
        assert admin.get("/api/admin/overview").json()["result_count"] == 1
        assert admin.delete("/api/admin/results/" + job["id"], headers=ah).json() == {
            "deleted": True
        }
        assert admin.get("/api/admin/results").json()["items"] == []
        assert admin.get(result["image_url"]).status_code == 404
