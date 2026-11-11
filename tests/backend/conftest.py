import io
import json

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend.app import create_app
from backend.settings import Settings


class Clock:
    def __init__(self):
        self.now = 1_800_000_000.0

    def __call__(self):
        return self.now


class Detector:
    ready = True

    def detect(self, image):
        return [(30, 30, 120, 120)]


class Provider:
    def __init__(self):
        self.calls = []

    def generate(self, *, photo, reference, prompt, runtime, timeout):
        self.calls.append(
            {"photo": photo, "reference": reference, "prompt": prompt, "timeout": timeout}
        )
        return picture("purple", (256, 384))


def picture(color="red", size=(300, 400), format="PNG"):
    out = io.BytesIO()
    Image.new("RGB", size, color).save(out, format=format)
    return out.getvalue()


@pytest.fixture
def setup(tmp_path):
    (tmp_path / "catalog").mkdir()
    (tmp_path / "catalog/grid.png").write_bytes(picture("blue", (300, 600)))
    catalog = {
        "looks": [{"id": 1, "versions": {"v1": {"image": "grid.png"}, "v2": {"image": "grid.png"}}}]
    }
    (tmp_path / "catalog.json").write_text(json.dumps(catalog))
    settings = Settings(
        data_dir=tmp_path / "private",
        catalog_path=tmp_path / "catalog.json",
        catalog_image_root=tmp_path / "catalog",
    )
    provider, detector, clock = Provider(), Detector(), Clock()
    app = create_app(settings, provider=provider, detector=detector, clock=clock)
    with TestClient(app, base_url="https://localhost") as client:
        bootstrap = client.get("/api/bootstrap").json()
        headers = {"Origin": "https://localhost", "X-CSRF-Token": bootstrap["csrf_token"]}
        yield app, client, headers, bootstrap, provider, detector, clock


def consent(client, headers, bootstrap):
    assert (
        client.post(
            "/api/disclosure/accept",
            headers=headers,
            json={"version": bootstrap["disclosure"]["version"]},
        ).status_code
        == 200
    )


def submit(client, headers, bootstrap, key="request-001", image=None, **fields):
    data = {
        "look_id": "1",
        "edition": "v1",
        "shot_index": "1",
        "idempotency_key": key,
        "disclosure_version": bootstrap["disclosure"]["version"],
    }
    data.update(fields)
    return client.post(
        "/api/tryons",
        headers=headers,
        data=data,
        files={"photo": ("private-selfie.png", image or picture(), "image/png")},
    )
