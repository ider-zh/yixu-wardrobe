"""The public home is a deterministic publication feed, independent of filters/CDN."""

import copy
import json
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.content import ContentService, publication_projection
from tests.backend.conftest import Clock, Detector, Provider
from tests.backend.test_content import content_fixture as shared_content_fixture
from tests.backend.test_content import write_json

content_fixture = shared_content_fixture


def add_batch(settings, original, suffix, ids, published_at=None, cover=None, publish_date=None):
    batch = copy.deepcopy(original)
    if publish_date:
        batch["publish_date"] = publish_date
        batch["research"]["weather"]["forecast_date"] = publish_date
    batch["batch_id"] = batch["publish_date"] + "-" + suffix
    batch["looks"] = []
    for key in ids:
        item = copy.deepcopy(original["looks"][0])
        item["id"] = key
        item["asset"]["asset_id"] = f"look-{key}-v2-r1"
        batch["looks"].append(item)
    if published_at is not None:
        batch["published_at"] = published_at
    if cover is not None:
        batch["cover_look_id"] = cover
    write_json(settings.content_root / "batches" / (batch["batch_id"] + ".json"), batch)
    return batch


def node_catalog(settings):
    # The compact Python fixture omits optional legacy editorial fields; fill in
    # valid historical descriptions so both independently implemented validators run.
    file = settings.content_root / "catalog.json"
    baseline = json.loads(file.read_text())
    for look in baseline["looks"]:
        look.update(
            season="秋",
            description="Legacy archive",
            pieces=[{"role": "主体", "name": "Archive garment"}],
        )
    write_json(file, baseline)
    module = Path(__file__).resolve().parents[2] / "scripts/content-lib.mjs"
    script = "import {pathToFileURL} from 'node:url'; const {loadContent}=await import(pathToFileURL(process.argv[2])); console.log(JSON.stringify(loadContent(process.argv[1]).catalog));"
    result = subprocess.run(
        [
            "node",
            "--input-type=module",
            "-e",
            script,
            str(settings.catalog_image_root),
            str(module),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout)


def test_later_batches_multilook_cover_and_node_python_parity(content_fixture):
    settings, original, _ = content_fixture
    # Batch names and IDs deliberately do not encode publication order.
    add_batch(
        settings,
        original,
        "zz-early",
        [105],
        "2026-11-13T09:00:00+08:00",
        publish_date="2026-11-13",
    )
    add_batch(
        settings,
        original,
        "aa-late",
        [104, 102, 103],
        "2026-11-14T02:30:00.123456Z",
        103,
        publish_date="2026-11-14",
    )
    static = node_catalog(settings)
    service = ContentService(settings)
    assert service.ready
    dynamic = service.catalog()
    expected_home = {
        "featured_look_id": 103,
        "recent_look_ids": [102, 104, 105, 101, 1, 2],
        "latest_batch_id": "2026-11-14-aa-late",
    }
    assert static["home"] == dynamic["home"] == expected_home
    assert static["latestOrder"] == dynamic["latestOrder"]
    assert static["displayOrder"] == dynamic["displayOrder"]
    assert static["revision"] == dynamic["revision"]
    for snapshot in (static, dynamic):
        assert snapshot["latestOrder"][:5] == [102, 103, 104, 105, 101]
        assert snapshot["displayOrder"][:5] == [104, 102, 103, 105, 101]
        assert (
            next(look for look in snapshot["looks"] if look["id"] == 103)["published_at"]
            == "2026-11-14T02:30:00.123Z"
        )
        assert (
            next(look for look in snapshot["looks"] if look["id"] == 101)["published_at"]
            == "2026-11-11T16:00:00.000Z"
        )
        assert all(look["published_at"] is None for look in snapshot["looks"] if look["id"] <= 100)
    # Resolved home URLs honor delivery selection, while filter state never changes home.
    app = create_app(settings, provider=Provider(), detector=Detector(), clock=Clock())
    app.state.content.set_delivery_resolver(
        lambda asset_id, source: "https://cdn.example/" + asset_id + ".webp"
    )
    with TestClient(app, base_url="https://localhost") as client:
        home = client.get("/api/content/home").json()
        assert home["featured"]["id"] == 103
        assert len(home["recent"]) == 6
        assert home["featured"]["image_url"].startswith("https://cdn.example/")
        assert home["revision"] == static["revision"]
        assert [
            look["id"] for look in client.get("/api/content/looks?limit=5").json()["items"]
        ] == [102, 103, 104, 105, 101]
        assert [
            look["id"]
            for look in client.get("/api/content/looks?limit=5&order=curated").json()["items"]
        ] == [104, 102, 103, 105, 101]
        assert client.get("/api/content/looks?model=missing").json()["total"] == 0
        assert client.get("/api/content/home").json() == home
        assert client.get("/api/content/looks?order=unknown").status_code == 422


@pytest.mark.parametrize(
    "mutation", ["naive", "calendar", "cover", "type", "unknown", "date_mismatch"]
)
def test_publication_metadata_validation_keeps_active_revision(content_fixture, mutation):
    settings, batch, _ = content_fixture
    service = ContentService(settings)
    before = service.catalog()["revision"]
    if mutation == "naive":
        batch["published_at"] = "2026-11-12T08:00:00"
    elif mutation == "calendar":
        batch["published_at"] = "2026-02-30T08:00:00+08:00"
    elif mutation == "cover":
        batch["cover_look_id"] = 1
    elif mutation == "type":
        batch["published_at"] = 1794441600
    elif mutation == "date_mismatch":
        batch["published_at"] = "2026-11-12T23:30:00Z"
    else:
        batch["pin_to_home"] = True
    write_json(settings.content_root / "batches/2026-11-12-01.json", batch)
    assert not service.import_content()
    assert service.catalog()["revision"] == before
    with pytest.raises(subprocess.CalledProcessError):
        node_catalog(settings)


def test_legacy_home_no_fabricated_dates_and_empty_projection(content_fixture):
    settings, _, _ = content_fixture
    (settings.content_root / "batches/2026-11-12-01.json").unlink()
    baseline_path = settings.content_root / "catalog.json"
    baseline = json.loads(baseline_path.read_text())
    baseline["displayOrder"] = list(reversed(range(1, 101)))
    write_json(baseline_path, baseline)
    static = node_catalog(settings)
    dynamic = ContentService(settings).catalog()
    assert (
        static["home"]
        == dynamic["home"]
        == {
            "featured_look_id": 100,
            "recent_look_ids": [1, 2, 3, 4, 5, 6],
            "latest_batch_id": None,
        }
    )
    assert all(look["published_at"] is None for look in dynamic["looks"])
    assert dynamic["displayOrder"] == list(reversed(range(1, 101)))
    assert dynamic["latestOrder"] == list(range(1, 101))
    assert publication_projection([], [], [])[2] == {
        "featured_look_id": None,
        "recent_look_ids": [],
        "latest_batch_id": None,
    }


def test_future_explicit_time_is_metadata_and_daily_batch_limit_remains(content_fixture):
    settings, original, _ = content_fixture
    add_batch(settings, original, "a", [102], "2027-01-01T00:00:00Z", publish_date="2027-01-01")
    static = node_catalog(settings)
    service = ContentService(settings)
    dynamic = service.catalog()
    assert static["home"] == dynamic["home"]
    assert static["latestOrder"][:2] == dynamic["latestOrder"][:2] == [102, 101]
    assert dynamic["home"]["featured_look_id"] == 102
    add_batch(settings, original, "z", [103], "2027-01-01T01:00:00Z", publish_date="2027-01-01")
    assert not service.import_content()
    assert service.catalog()["revision"] == dynamic["revision"]
    with pytest.raises(subprocess.CalledProcessError):
        node_catalog(settings)


def test_previous_archive_upgrades_publication_fields_without_source_files(content_fixture):
    settings, _, _ = content_fixture
    service = ContentService(settings)
    before = service.catalog()
    with service.connect() as db:
        snapshot = json.loads(db.execute("SELECT snapshot FROM revisions").fetchone()[0])
        snapshot.pop("home")
        snapshot.pop("latestOrder")
        for look in snapshot["looks"]:
            look.pop("published_at")
        for batch in snapshot["batches"]:
            batch.pop("published_at")
            batch.pop("cover_look_id")
        db.execute("UPDATE revisions SET snapshot=?", (json.dumps(snapshot),))
    (settings.content_root / "batches/2026-11-12-01.json").write_text("broken release")
    restarted = ContentService(settings)
    assert restarted.import_error == "content_validation_failed"
    assert restarted.catalog()["revision"] == before["revision"]
    assert restarted.catalog()["home"] == before["home"]
    assert restarted.catalog()["latestOrder"] == before["latestOrder"]
