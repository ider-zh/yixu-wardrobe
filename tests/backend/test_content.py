import copy
import hashlib
import io
import json

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend.app import create_app
from backend.content import ContentService
from backend.settings import Settings
from tests.backend.conftest import Clock, Detector, Provider, consent, picture, submit


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def metadata(root, file, asset_id, size=(64, 96), grid=True):
    data = picture(size=size, format="WEBP")
    path = root / file
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    asset = {
        "asset_id": asset_id,
        "file": file,
        "mime": "image/webp",
        "width": size[0],
        "height": size[1],
        "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "visibility": "public",
    }
    if grid:
        asset["layout"] = {"rows": 3, "columns": 3, "preview_panel": 1}
    return asset


@pytest.fixture
def content_fixture(tmp_path):
    source = tmp_path / "release"
    content = source / "content"
    content.mkdir(parents=True)
    reference = metadata(
        source, "assets/model-bases/female-01.webp", "model-female-01", (96, 64), False
    )
    reference2 = metadata(
        source, "assets/model-bases/female-02.webp", "model-female-02", (96, 64), False
    )
    models = {
        "schema_version": 1,
        "models": [
            {"model_id": "female-01", "name": "01", "reference": reference, "views": ["front"]},
            {"model_id": "female-02", "name": "02", "reference": reference2, "views": ["front"]},
        ],
    }
    image = metadata(source, "images-v2/legacy.webp", "legacy-1")
    baseline: dict = {
        "schema_version": 1,
        "categoryOrder": ["日常"],
        "displayOrder": list(range(1, 101)),
        "looks": [],
    }
    for i in range(1, 101):
        asset = {**image, "asset_id": f"legacy-{i}"}
        baseline["looks"].append(
            {
                "id": i,
                "model_id": None,
                "category": "日常",
                "title": f"Look {i}",
                "image": image["file"],
                "versions": {
                    "v2": {
                        "image": image["file"],
                        "asset": asset,
                        "shots": [{"title": str(n)} for n in range(1, 10)],
                        "previewPanel": 1,
                    }
                },
            }
        )
    asset = metadata(source, "assets/looks/2026-11-12/look-101.webp", "look-101-v2-r1")
    batch = {
        "schema_version": 1,
        "batch_id": "2026-11-12-01",
        "publish_date": "2026-11-12",
        "timezone": "Asia/Shanghai",
        "title": "秋日散步",
        "region": {"country": "CN", "city": "杭州"},
        "research": {
            "checked_at": "2026-11-12T08:00:00+08:00",
            "trend_sources": [
                {
                    "url": f"https://example.com/{n}",
                    "published_at": "2026-11-11",
                    "summary": "搭配信号",
                }
                for n in (1, 2)
            ],
            "weather": {
                "url": "https://example.com/weather",
                "forecast_date": "2026-11-12",
                "checked_at": "2026-11-12T08:00:00+08:00",
                "summary": "凉爽",
                "styling_reason": "策划推断：外套适合户外",
            },
        },
        "looks": [
            {
                "id": 101,
                "model_id": "female-02",
                "model_reference_sha256": reference2["sha256"],
                "title": "秋日散步",
                "category": "日常",
                "season": "秋",
                "description": "散步穿搭",
                "pieces": [{"role": "主体", "name": "针织衫"}],
                "tags": ["秋日"],
                "mood": "开心",
                "scene": "公园",
                "edition": "v2",
                "asset": asset,
                "shots": [
                    {
                        "index": n,
                        "title": f"镜头{n}",
                        "emotion": "开心",
                        "pose": "自然站立",
                        "framing": "全身",
                    }
                    for n in range(1, 10)
                ],
            }
        ],
    }
    write_json(content / "models.json", models)
    write_json(content / "catalog.json", baseline)
    write_json(content / "batches/2026-11-12-01.json", batch)
    settings = Settings(
        data_dir=tmp_path / "private", content_root=content, catalog_image_root=source
    )
    return settings, batch, models


def test_dynamic_catalog_sources_downloads_and_filtering(content_fixture):
    settings, _, _ = content_fixture
    app = create_app(settings, provider=Provider(), detector=Detector(), clock=Clock())
    with TestClient(app, base_url="https://localhost") as client:
        snapshot = client.get("/api/content/catalog").json()
        assert snapshot["displayOrder"][0] == 101
        assert min(snapshot["looks"], key=lambda item: item["editorialOrder"])["id"] == 101
        assert snapshot["counts"] == {"looks": 101, "models": 2, "batches": 1}
        assert all(set(look["versions"]) == {"v2"} for look in snapshot["looks"])
        assert all(look["model_id"] is None for look in snapshot["looks"][:100])
        filtered = client.get("/api/content/looks?model=female-02&region=杭州&q=秋日").json()
        assert [item["id"] for item in filtered["items"]] == [101]
        look = client.get("/api/content/looks/101").json()
        assert look["source_url"] == look["image_url"] == "/api/content/assets/look-101-v2-r1"
        image = client.get(look["source_url"])
        assert (
            image.content
            == (settings.catalog_image_root / "assets/looks/2026-11-12/look-101.webp").read_bytes()
        )
        assert image.headers["content-type"] == "image/webp"
        assert (
            "attachment"
            in client.get(look["source_url"] + "/download").headers["content-disposition"]
        )
        assert client.get("/api/content/assets/unknown").status_code == 404
        assert client.get("/api/content/looks/1000").status_code == 404
        assert (
            client.get("/api/content/catalog", headers={"host": "admin.localhost"}).status_code
            == 404
        )
        assert str(settings.data_dir) not in json.dumps(snapshot)
        assert "archive_path" not in json.dumps(snapshot)
        assert app.state.content.admin_models()[0]["expressive_count"] == 0
        assert app.state.content.admin_models()[1]["expressive_count"] == 1


def test_idempotent_import_and_release_independent_last_good(content_fixture):
    settings, batch, _ = content_fixture
    service = ContentService(settings)
    revision = service.catalog()["revision"]
    assert service.import_content()
    assert service.catalog()["revision"] == revision
    data, _ = service.asset("look-101-v2-r1")
    # A missing asset in a replacement release must not break the durable previous revision.
    (settings.catalog_image_root / batch["looks"][0]["asset"]["file"]).unlink()
    assert not service.import_content()
    assert service.catalog()["revision"] == revision
    restarted = ContentService(settings)
    assert restarted.import_error == "content_validation_failed"
    assert restarted.catalog()["revision"] == revision
    assert restarted.asset("look-101-v2-r1")[0] == data
    with restarted.connect() as db:
        assert db.execute("SELECT count(*) FROM revisions").fetchone()[0] == 1


@pytest.mark.parametrize(
    "mutation",
    [
        "duplicate_id",
        "unknown_model",
        "bad_model_hash",
        "traversal",
        "symlink",
        "wrong_hash",
        "wrong_size",
        "private",
        "missing_shot",
        "bad_grid",
        "v1",
        "naive_date",
        "duplicate_source",
    ],
)
def test_invalid_batch_never_activates_or_archives(content_fixture, mutation):
    settings, original, _ = content_fixture
    service = ContentService(settings)
    revision = service.catalog()["revision"]
    batch = copy.deepcopy(original)
    item = batch["looks"][0]
    asset = item["asset"]
    if mutation == "duplicate_id":
        item["id"] = 1
    elif mutation == "unknown_model":
        item["model_id"] = "not-approved"
    elif mutation == "bad_model_hash":
        item["model_reference_sha256"] = "0" * 64
    elif mutation == "traversal":
        asset["file"] = "assets/../inputs/private.webp"
    elif mutation == "symlink":
        path = settings.catalog_image_root / asset["file"]
        path.unlink()
        path.symlink_to(settings.catalog_image_root / "images-v2/legacy.webp")
    elif mutation == "wrong_hash":
        asset["sha256"] = "0" * 64
    elif mutation == "wrong_size":
        asset["bytes"] += 1
    elif mutation == "private":
        asset["visibility"] = "private"
    elif mutation == "missing_shot":
        item["shots"].pop()
    elif mutation == "bad_grid":
        asset["layout"]["rows"] = 2
    elif mutation == "v1":
        item["edition"] = "v1"
    elif mutation == "naive_date":
        batch["research"]["checked_at"] = "2026-11-12T08:00:00"
    elif mutation == "duplicate_source":
        batch["research"]["trend_sources"][1] = batch["research"]["trend_sources"][0]
    write_json(settings.content_root / "batches/2026-11-12-01.json", batch)
    assert not service.import_content()
    assert service.catalog()["revision"] == revision
    assert len(service.asset_records()) == 103


def test_dynamic_tryon_freezes_local_reference_and_validates_content(content_fixture):
    settings, batch, _ = content_fixture
    app = create_app(settings, provider=Provider(), detector=Detector(), clock=Clock())
    app.state.content.set_delivery_resolver(
        lambda asset_id, source: "https://cdn.invalid/never-fetched.webp"
    )
    with TestClient(app, base_url="https://localhost") as client:
        bootstrap = client.get("/api/bootstrap").json()
        headers = {"Origin": "https://localhost", "X-CSRF-Token": bootstrap["csrf_token"]}
        consent(client, headers, bootstrap)
        result = submit(client, headers, bootstrap, look_id="101", edition="v2")
        assert result.status_code == 202
        job_id = result.json()["id"]
        reference = (app.state.jobs.inputs / f"{job_id}.reference.png").read_bytes()
        assert Image.open(io.BytesIO(reference)).size == (21, 32)
        (settings.catalog_image_root / batch["looks"][0]["asset"]["file"]).unlink()
        assert (app.state.jobs.inputs / f"{job_id}.reference.png").read_bytes() == reference
        assert (
            submit(
                client, headers, bootstrap, key="reject-v1", look_id="101", edition="v1"
            ).status_code
            == 422
        )
        assert (
            submit(
                client, headers, bootstrap, key="reject-id", look_id="1000", edition="v2"
            ).status_code
            == 422
        )
        assert (
            client.post(
                "/api/events",
                headers=headers,
                json={"event": "look_open", "look_id": 101, "edition": "v2"},
            ).status_code
            == 200
        )
        assert (
            client.post(
                "/api/events",
                headers=headers,
                json={"event": "look_open", "look_id": 101, "edition": "v1"},
            ).status_code
            == 422
        )
        # Neither the allowlist nor CDN records ever include private selfies or results.
        assert all("inputs" not in row["file"] for row in app.state.content.asset_records())
        assert client.get(f"/api/content/assets/{job_id}").status_code == 404


def test_asset_identity_cannot_be_replaced(content_fixture):
    settings, batch, _ = content_fixture
    service = ContentService(settings)
    revision = service.catalog()["revision"]
    item = batch["looks"][0]
    path = settings.catalog_image_root / item["asset"]["file"]
    data = picture(color="blue", size=(64, 96), format="WEBP")
    path.write_bytes(data)
    item["asset"]["bytes"] = len(data)
    item["asset"]["sha256"] = hashlib.sha256(data).hexdigest()
    write_json(settings.content_root / "batches/2026-11-12-01.json", batch)
    assert not service.import_content()
    assert service.catalog()["revision"] == revision


def test_private_model_reference_is_observable_without_public_exposure(content_fixture):
    settings, _, models = content_fixture
    private = metadata(
        settings.catalog_image_root,
        "assets/model-bases/private.webp",
        "private-reference",
        (96, 64),
        False,
    )
    private["visibility"] = "private"
    models["models"].append(
        {"model_id": "private-model", "name": "私有参考", "reference": private, "views": ["front"]}
    )
    write_json(settings.content_root / "models.json", models)
    service = ContentService(settings)
    assert service.ready
    assert "private-model" not in [model["model_id"] for model in service.catalog()["models"]]
    observed = next(
        model for model in service.admin_models() if model["model_id"] == "private-model"
    )
    assert observed["preview_available"] is False
    assert observed["source_url"] is None
    assert "file" not in observed["reference"]
    assert "private-reference" not in [record["asset_id"] for record in service.asset_records()]
    assert "assets/model-bases/private.webp" not in json.dumps(observed)


def test_legacy_attribution_requires_registered_reference(content_fixture):
    settings, _, models = content_fixture
    service = ContentService(settings)
    revision = service.catalog()["revision"]
    baseline_file = settings.content_root / "catalog.json"
    baseline = json.loads(baseline_file.read_text())
    baseline["looks"][0]["model_id"] = models["models"][0]["model_id"]
    write_json(baseline_file, baseline)
    assert not service.import_content()
    assert service.catalog()["revision"] == revision
    baseline["looks"][0]["model_reference_sha256"] = models["models"][0]["reference"]["sha256"]
    write_json(baseline_file, baseline)
    assert service.import_content()
    assert service.catalog()["looks"][0]["model_id"] == models["models"][0]["model_id"]


def test_admin_model_reference_uses_authenticated_admin_origin(content_fixture):
    settings, _, _ = content_fixture
    app = create_app(settings, provider=Provider(), detector=Detector(), clock=Clock())
    route = "/api/admin/content/models/female-01/reference"
    with TestClient(app, base_url="https://admin.localhost") as client:
        assert client.get(route).status_code == 401
        bootstrap = client.get("/api/admin/bootstrap").json()
        credentials = json.loads((settings.data_dir / "initial-admin.json").read_text())
        headers = {"Origin": "https://admin.localhost", "X-CSRF-Token": bootstrap["csrf_token"]}
        login = client.post("/api/admin/login", json=credentials, headers=headers)
        assert login.status_code == 200
        models = client.get("/api/admin/content/models").json()["models"]
        model = next(item for item in models if item["model_id"] == "female-01")
        assert model["reference"]["source_url"] == route
        image = client.get(route)
        assert image.status_code == 200 and image.headers["content-type"] == "image/webp"
        assert image.content == app.state.content.asset(model["reference"]["asset_id"])[0]
        assert (
            client.get("/api/content/assets/" + model["reference"]["asset_id"]).status_code == 404
        )
        assert client.get("/api/admin/content/models/unknown/reference").status_code == 404
        headers["X-CSRF-Token"] = login.json()["csrf_token"]
        assert client.post("/api/admin/logout", headers=headers).status_code == 200
        assert client.get(route).status_code == 401
    with TestClient(app, base_url="https://localhost") as client:
        assert client.get(route).status_code == 404


def test_previous_public_asset_url_survives_new_revision(content_fixture):
    settings, batch, _ = content_fixture
    service = ContentService(settings)
    old_id = batch["looks"][0]["asset"]["asset_id"]
    old_data, _ = service.asset(old_id)
    batch["looks"][0]["asset"]["asset_id"] = old_id + "-r2"
    write_json(settings.content_root / "batches/2026-11-12-01.json", batch)
    assert service.import_content()
    assert old_id not in {record["asset_id"] for record in service.asset_records()}
    assert service.asset(old_id)[0] == old_data
    restarted = ContentService(settings)
    assert restarted.asset(old_id)[0] == old_data
