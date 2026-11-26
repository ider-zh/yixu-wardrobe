import os
import subprocess
import sys
from pathlib import Path

from fastapi.testclient import TestClient

from backend.app import create_app


def test_optional_environment_factory_real_model_and_no_import_initialization(
    tmp_path, monkeypatch
):
    root = tmp_path / "private"
    model = os.environ.get("YIXU_TEST_FACE_MODEL")
    monkeypatch.setenv("YIXU_DATA_DIR", str(root))
    # Catalog import has its own tests. Keep this startup check independent of gallery size.
    monkeypatch.setenv("YIXU_CONTENT_ROOT", str(tmp_path / "content"))
    monkeypatch.setenv("YIXU_PUBLIC_HOST", "localhost")
    monkeypatch.setenv("YIXU_ADMIN_HOST", "admin.localhost")
    monkeypatch.setenv("YIXU_SECURE_COOKIES", "false")
    if model:
        monkeypatch.setenv("YIXU_FACE_MODEL", model)
    subprocess.run([sys.executable, "-c", "import backend.app; import backend.worker"], check=True)
    assert not root.exists()
    app = create_app()
    assert app.state.settings.data_dir == root
    with TestClient(app, base_url="http://localhost") as c:
        health = c.get("/api/health").json()
        assert health["provider_configured"] is False
        assert health["detector_ready"] == bool(model)
        b = c.get("/api/bootstrap")
        assert b.status_code == 200 and not b.json()["generation_available"]
        assert "secure" not in b.headers["set-cookie"].lower()
    env = {**os.environ, "YIXU_DATA_DIR": str(root)}
    run = subprocess.run(
        [sys.executable, "-m", "backend.worker", "--once"],
        env=env,
        capture_output=True,
        timeout=20,
        check=False,
    )
    assert run.returncode == 0 and not run.stdout
    assert b"Traceback" not in run.stderr
    assert b"password" not in run.stderr.lower()


def test_real_yunet_inference_blank_and_reference_panel(tmp_path):
    import pytest
    from PIL import Image

    from backend.images import YuNetDetector
    from backend.settings import Settings

    model = os.environ.get("YIXU_TEST_FACE_MODEL")
    if not model:
        pytest.skip("Set YIXU_TEST_FACE_MODEL to an operator-supplied official model")
    detector = YuNetDetector(Settings(data_dir=tmp_path, face_model=Path(model)))
    assert detector.ready
    assert detector.detect(Image.new("RGB", (400, 300), "white")) == []
    path = Path(__file__).resolve().parents[2] / "images-v2" / "look-001.webp"
    with Image.open(path) as montage:
        face = detector.detect(montage.crop((0, 0, montage.width // 3, montage.height // 3)))
    assert len(face) == 1


def test_real_yunet_queues_wide_full_body_and_sends_the_uncropped_frame(setup, tmp_path):
    import io

    import pytest
    from conftest import consent, submit
    from PIL import Image, ImageFilter

    from backend.images import YuNetDetector, png
    from backend.settings import Settings
    from backend.worker import Worker

    model = os.environ.get("YIXU_TEST_FACE_MODEL")
    if not model:
        pytest.skip("Set YIXU_TEST_FACE_MODEL to an operator-supplied official model")
    app, client, headers, bootstrap, provider, _, _clock = setup
    detector = YuNetDetector(Settings(data_dir=tmp_path, face_model=Path(model)))
    assert detector.ready
    app.state.jobs.detector = detector
    consent(client, headers, bootstrap)

    # The public Look 001 seated full-body panel has both shoes in frame.
    source = Path(__file__).resolve().parents[2]
    with Image.open(source / "assets/looks/revisions/look-001-female-01-v2-r2.webp") as montage:
        panel = montage.crop((0, montage.height // 3, montage.width // 3, montage.height * 2 // 3))
    frame = Image.new("RGB", (3000, 4500), "#b5b0a6")
    frame.paste(panel, ((frame.width - panel.width) // 2, frame.height // 5))
    # Any accepted face in this fixture is well below the legacy frame-area cutoff.
    head = detector.detect(panel)
    assert len(head) == 1 and min(head[0][2:]) >= 40
    assert head[0][2] * head[0][3] / (frame.width * frame.height) < 0.025

    blurry = panel.filter(ImageFilter.GaussianBlur(radius=8))
    rejected = submit(client, headers, bootstrap, image=png(blurry), edition="v2")
    assert rejected.status_code == 422
    assert rejected.json()["error"]["code"] == "face_count"
    two_faces = Image.new("RGB", (900, 620), "#b5b0a6")
    two_faces.paste(panel, (40, 55))
    two_faces.paste(panel, (510, 55))
    rejected = submit(client, headers, bootstrap, image=png(two_faces), edition="v2")
    assert rejected.status_code == 422
    assert rejected.json()["error"]["code"] == "face_count"
    assert client.get("/api/tryons").json()["items"] == []

    accepted = submit(client, headers, bootstrap, image=png(frame), edition="v2")
    assert accepted.status_code == 202
    job = accepted.json()
    assert job["status"] == "queued"
    assert len(provider.calls) == 0
    with Worker(app) as worker:
        assert worker.run_once()
    with Image.open(io.BytesIO(provider.calls[0]["photo"])) as delivered:
        assert delivered.size == frame.size
        assert delivered.tobytes() == frame.tobytes()
    assert client.get(f"/api/tryons/{job['id']}").json()["status"] == "succeeded"
