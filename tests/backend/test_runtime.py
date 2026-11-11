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
    path = Path(__file__).resolve().parents[2] / "images" / "look-001.webp"
    with Image.open(path) as montage:
        face = detector.detect(montage.crop((0, 0, montage.width // 3, montage.height // 3)))
    assert len(face) == 1
