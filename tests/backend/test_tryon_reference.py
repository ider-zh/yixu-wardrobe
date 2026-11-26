import hashlib
import io

from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

from backend.app import create_app
from backend.worker import Worker
from tests.backend.conftest import Clock, Detector, Provider, consent, submit
from tests.backend.test_content import content_fixture as shared_content_fixture
from tests.backend.test_content import write_json

content_fixture = shared_content_fixture


def grid_asset(settings, template, name, color):
    image = Image.new("RGB", (96, 144), "white")
    ImageDraw.Draw(image).rectangle((0, 96, 31, 143), fill=color)
    stream = io.BytesIO()
    image.save(stream, format="WEBP", quality=95)
    payload = stream.getvalue()
    file = f"assets/looks/2026-11-12/{name}.webp"
    (settings.catalog_image_root / file).write_bytes(payload)
    return {
        **template,
        "asset_id": name,
        "file": file,
        "width": image.width,
        "height": image.height,
        "bytes": len(payload),
        "sha256": hashlib.sha256(payload).hexdigest(),
    }, payload


def bootstrap(client):
    data = client.get("/api/bootstrap").json()
    headers = {"Origin": "https://localhost", "X-CSRF-Token": data["csrf_token"]}
    return data, headers


def test_public_tryon_reference_matches_frozen_crop_after_catalog_switch_and_restart(
    content_fixture, monkeypatch
):
    settings, batch, _models = content_fixture
    look = batch["looks"][0]
    old_title = look["title"]
    original, original_bytes = grid_asset(settings, look["asset"], "look-101-v2-r1", "red")
    replacement, _ = grid_asset(settings, look["asset"], "look-101-v2-r2", "blue")
    look.update(asset=original, model_only=True)
    manifest = settings.content_root / "batches/2026-11-12-01.json"
    write_json(manifest, batch)

    clock = Clock()
    app = create_app(settings, provider=Provider(), detector=Detector(), clock=clock)
    service = app.state.content
    assert service.ready, service.import_error
    read_asset = service.asset
    frozen = {
        "asset_id": original["asset_id"],
        "source_url": f"/api/content/assets/{original['asset_id']}",
        "shot_index": 7,
    }

    def read_during_publication(asset_id):
        if look["asset"] == original:
            look.update(asset=replacement, title="更新后的搭配")
            write_json(manifest, batch)
            assert service.import_content()
        return read_asset(asset_id)

    monkeypatch.setattr(service, "asset", read_during_publication)
    with TestClient(app, base_url="https://localhost") as client:
        boot, headers = bootstrap(client)
        consent(client, headers, boot)
        response = submit(client, headers, boot, look_id="101", shot_index="7")
        assert response.status_code == 202, response.text
        job = response.json()
        assert job["reference"] == frozen
        assert job["look_title"] == old_title
        assert service.look_titles()[101] == "更新后的搭配"
        old_crop = (app.state.jobs.inputs / f"{job['id']}.reference.png").read_bytes()
        with Image.open(io.BytesIO(old_crop)) as image:
            assert image.size == (32, 48)
            red, green, blue = image.getpixel((8, 12))
            assert red > 240 and green < 15 and blue < 15
        assert submit(client, headers, boot, look_id="101", shot_index="7").json() == job
        token = client.cookies.get("yixu_visitor")

    provider = Provider()
    restarted = create_app(settings, provider=provider, detector=Detector(), clock=clock)
    with TestClient(
        restarted, base_url="https://localhost", cookies={"yixu_visitor": token}
    ) as client:
        assert client.get(f"/api/tryons/{job['id']}").json()["reference"] == frozen
        assert (
            client.get("/api/tryons", params={"look": "#101"}).json()["items"][0]["reference"]
            == frozen
        )
        assert client.get(frozen["source_url"]).content == original_bytes
        raw_job = restarted.state.jobs.get(job["id"])
        assert "reference" not in restarted.state.jobs.shape(raw_job)
        assert raw_job["reference_asset_id"] == original["asset_id"]
        assert raw_job["reference_source_url"] == frozen["source_url"]

        with Worker(restarted) as worker:
            assert worker.run_once()
        assert len(provider.calls) == 1
        assert provider.calls[0]["reference"] == old_crop
        result = client.get(f"/api/tryons/{job['id']}").json()
        assert result["status"] == "succeeded"
        assert result["reference"] == frozen
        assert client.get(result["image_url"]).status_code == 200

        boot, headers = bootstrap(client)
        later = submit(client, headers, boot, key="new-reference", look_id="101", shot_index="7")
        assert later.status_code == 202, later.text
        assert later.json()["reference"]["asset_id"] == replacement["asset_id"]

        with TestClient(restarted, base_url="https://localhost") as other:
            bootstrap(other)
            assert other.get(f"/api/tryons/{job['id']}").status_code == 404
            assert other.get(result["image_url"]).status_code == 404
            assert other.get("/api/tryons", params={"look": "101"}).json()["items"] == []
            assert other.get(frozen["source_url"]).status_code == 200


def test_unverified_tryon_references_stay_null_even_if_private_paths_exist(setup):
    app, client, headers, boot, *_ = setup
    consent(client, headers, boot)
    job = submit(client, headers, boot).json()
    assert job["reference"] is None

    with app.state.store.connect() as db:
        db.execute(
            "UPDATE jobs SET reference_asset_id=?, reference_source_url=? WHERE id=?",
            ("verified-format-id", "/private/inputs/record.reference.png", job["id"]),
        )
    response = client.get(f"/api/tryons/{job['id']}")
    assert response.json()["reference"] is None
    assert "/private/" not in response.text
