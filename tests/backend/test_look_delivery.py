import json
from pathlib import Path

from fastapi.testclient import TestClient

from backend.app import create_app
from backend.settings import Settings


def test_admin_can_observe_exact_public_outfit_delivery_without_changes(tmp_path):
    root = Path(__file__).resolve().parents[2]
    settings = Settings(data_dir=tmp_path, content_root=root / "content", catalog_image_root=root)
    app = create_app(settings)
    path = "/api/admin/content/looks/001/delivery"
    with TestClient(app, base_url="https://admin.localhost") as admin:
        assert admin.get(path).status_code == 401
        headers = {
            "Origin": "https://admin.localhost",
            "X-CSRF-Token": admin.get("/api/admin/bootstrap").json()["csrf_token"],
        }
        credentials = json.loads((tmp_path / "initial-admin.json").read_text())
        assert admin.post("/api/admin/login", headers=headers, json=credentials).status_code == 200

        response = admin.get(path)
        assert response.status_code == 200
        assert "archive_path" not in response.text
        assert response.json()["public_origin"] == "https://localhost"
        data = response.json()
        current, previous, *_ = data["assets"]
        assert data["look"]["id"] == 1
        assert current["role"] == "current_photo"
        assert previous["role"] == "previous_photo"
        assert previous["asset_id"] == "look-001-v2-r1"
        assert current["sha256"] != previous["sha256"]
        assert all(asset["delivery"] == "source" for asset in data["assets"])
        assert any(
            asset["role"] == "product_main" and asset["cdn"]["status"] == "source_only"
            for asset in data["assets"]
        )
        boots = admin.get("/api/admin/content/looks/102/delivery").json()["assets"]
        assert any(
            asset["role"] == "product_gallery" and asset["product_id"] == "brown-boots-102"
            for asset in boots
        )
        assert all(
            asset["role"] != "previous_photo"
            for asset in admin.get("/api/admin/content/looks/089/delivery").json()["assets"]
        )
        assert admin.get("/api/admin/content/looks/109/delivery").status_code == 404
        assert admin.get("/api/admin/content/looks/9999/delivery").status_code == 404

        # The site can keep an earlier verified CDN image selected after a failed migration.
        # Neither the most recent 100 jobs nor a matching ID with the wrong hash can hide it.
        cdn = app.state.cdn
        previous_id, previous_hash = previous["asset_id"], previous["sha256"]
        verified_url = "https://static.example.invalid/verified.webp"
        with cdn.connect() as db:
            db.execute("UPDATE jobs SET updated=5000")
            db.execute(
                "UPDATE jobs SET status='verified', remote_url=?, verified=1200, updated=1200 "
                "WHERE asset_id=? AND sha256=?",
                (verified_url, previous_id, previous_hash),
            )
            for provider, sha in (("migration", previous_hash), ("wrong-hash", "0" * 64)):
                db.execute(
                    """INSERT INTO jobs (provider_id,asset_id,sha256,bytes,width,height,file,
                       archive_path,source_url,revision,status,created,updated)
                       SELECT ?,asset_id,?,bytes,width,height,file,archive_path,source_url,
                              revision,'failed',1400,1400 FROM jobs
                       WHERE asset_id=? AND sha256=? AND status='verified'""",
                    (provider, sha, previous_id, previous_hash),
                )
            latest = db.execute(
                "SELECT id FROM jobs WHERE asset_id=? AND sha256=? AND provider_id='migration'",
                (previous_id, previous_hash),
            ).fetchone()[0]

        assert all(job["asset_id"] != previous_id for job in cdn.overview()["jobs"])
        updated = admin.get(path).json()["assets"][1]
        assert updated["delivery"] == "cdn"
        assert updated["image_url"] == verified_url
        assert updated["cdn"] == {
            "status": "failed",
            "job_id": latest,
            "updated_at": 1400,
            "selected_verified_at": 1200,
        }
    with TestClient(app, base_url="https://localhost") as public:
        assert public.get(path).status_code == 404
        assert public.get(previous["source_url"]).status_code == 200
