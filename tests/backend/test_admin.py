import json
import sqlite3
import stat
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.settings import Settings
from backend.store import Store


def login(client, root):
    bootstrap = client.get("/api/admin/bootstrap").json()
    creds = json.loads((root / "initial-admin.json").read_text())
    headers = {"Origin": str(client.base_url).rstrip("/"), "X-CSRF-Token": bootstrap["csrf_token"]}
    result = client.post("/api/admin/login", json=creds, headers=headers)
    assert result.status_code == 200
    headers["X-CSRF-Token"] = result.json()["csrf_token"]
    return headers


@pytest.mark.parametrize("admin_host", ["admin.localhost", "localhost"])
def test_site_theme_is_public_to_read_and_admin_only_to_save(tmp_path, admin_host):
    settings = Settings(data_dir=tmp_path, admin_host=admin_host)
    public = "/api/site-theme"
    admin = "/api/admin/site-theme"
    editorial = {"theme": "editorial"}
    studio = {"theme": "studio"}
    app = create_app(settings)
    with (
        TestClient(app, base_url="https://localhost") as visitor,
        TestClient(app, base_url=f"https://{admin_host}") as controller,
    ):
        response = visitor.get(public)
        assert response.json() == editorial
        assert response.headers["Cache-Control"] == "no-store"
        assert "set-cookie" not in response.headers
        assert visitor.put(public, json=studio).status_code == 405
        assert visitor.put(admin, json=studio).status_code == (
            401 if admin_host == "localhost" else 404
        )
        assert controller.get(admin).status_code == 401
        assert controller.put(admin, json=studio).status_code == 401

        headers = login(controller, tmp_path)
        assert controller.get(admin).json() == editorial
        assert controller.put(admin, json=studio).status_code == 403
        assert (
            controller.put(
                admin, json=studio, headers={**headers, "Origin": "https://elsewhere.test"}
            ).status_code
            == 403
        )
        for invalid in ({"theme": "auto"}, {"theme": True}, {"theme": "studio", "extra": 1}, {}):
            assert controller.put(admin, json=invalid, headers=headers).status_code == 422
        assert visitor.get(public).json() == editorial
        response = controller.put(admin, json=studio, headers=headers)
        assert response.json() == studio
        assert response.headers["Cache-Control"] == "no-store"
        assert visitor.get(public).json() == studio
        assert controller.post("/api/admin/logout", headers=headers).status_code == 200
        assert controller.put(admin, json=editorial, headers=headers).status_code == 401

    with TestClient(create_app(settings), base_url="https://localhost") as restarted:
        assert restarted.get(public).json() == studio
    isolated = Settings(data_dir=tmp_path / "isolated", admin_host=admin_host)
    with TestClient(create_app(isolated), base_url="https://localhost") as separate:
        assert separate.get(public).json() == editorial


def test_site_theme_migrates_legacy_sqlite_and_persists_all_new_options(tmp_path):
    with closing(sqlite3.connect(tmp_path / "state.sqlite3")) as db:
        db.executescript("""
            PRAGMA journal_mode=WAL;
            CREATE TABLE site_preferences (
                id INTEGER PRIMARY KEY CHECK(id=1),
                theme TEXT NOT NULL CHECK(theme IN ('editorial', 'studio')));
            INSERT INTO site_preferences (id, theme) VALUES (1, 'studio');
        """)
    with ThreadPoolExecutor(max_workers=4) as workers:
        futures = [workers.submit(Store, tmp_path) for _ in range(4)]
        assert [future.result().site_theme() for future in futures] == ["studio"] * 4

    settings = Settings(data_dir=tmp_path)
    public = "/api/site-theme"
    admin = "/api/admin/site-theme"
    with TestClient(create_app(settings), base_url="https://admin.localhost") as controller:
        headers = login(controller, tmp_path)
        assert controller.get(admin).json() == {"theme": "studio"}
        for theme in (
            "contact-sheet",
            "salon-album",
            "wardrobe-index",
            "linen-room",
            "indigo-studio",
            "porcelain-case",
            "night-runway",
            "city-billboard",
            "garden-walk",
            "sunset-notes",
        ):
            setting = {"theme": theme}
            assert controller.put(admin, json=setting, headers=headers).json() == setting
            assert controller.get(admin).json() == setting
            with TestClient(create_app(settings), base_url="https://localhost") as restarted:
                assert restarted.get(public).json() == setting

    with pytest.raises(sqlite3.IntegrityError), Store(tmp_path).connect() as db:
        db.execute("UPDATE site_preferences SET theme='unknown' WHERE id=1")
    assert Store(tmp_path).site_theme() == "sunset-notes"


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


@pytest.mark.parametrize("configured_minimum", [None, 8])
def test_admin_password_length_is_enforced_per_deployment(tmp_path, configured_minimum):
    settings = Settings(data_dir=tmp_path)
    if configured_minimum is not None:
        settings = replace(settings, admin_password_min_length=configured_minimum)
    minimum = configured_minimum or 16
    with TestClient(create_app(settings), base_url="https://admin.localhost") as client:
        assert "password_min_length" not in client.get("/api/admin/bootstrap").json()
        credentials = json.loads((tmp_path / "initial-admin.json").read_text())
        headers = login(client, tmp_path)
        assert client.get("/api/admin/bootstrap").json()["password_min_length"] == minimum

        payload = {"current_password": credentials["password"], "new_password": "a" * (minimum - 1)}
        denied = client.post("/api/admin/password", json=payload, headers=headers)
        assert denied.status_code == 422
        assert denied.json()["error"]["code"] == "password_too_short"
        assert client.get("/api/admin/bootstrap").json()["authenticated"] is True

        payload["new_password"] = "a" * minimum
        assert client.post("/api/admin/password", json=payload, headers=headers).json() == {
            "changed": True
        }
        bootstrap = client.get("/api/admin/bootstrap").json()
        assert bootstrap["authenticated"] is False
        headers["X-CSRF-Token"] = bootstrap["csrf_token"]
        assert client.post("/api/admin/login", json=credentials, headers=headers).status_code == 401
        credentials["password"] = payload["new_password"]
        signed_in = client.post("/api/admin/login", json=credentials, headers=headers)
        assert signed_in.status_code == 200
        assert signed_in.json()["password_min_length"] == minimum


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
