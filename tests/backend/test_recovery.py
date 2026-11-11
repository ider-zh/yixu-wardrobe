import os
import subprocess
import sys
import time

from conftest import consent, picture, submit

from backend.worker import Worker


def test_sigkill_after_possible_send_recovers_unknown_without_replay(setup):
    app, c, h, b, provider, _detector, clock = setup
    consent(c, h, b)
    job = submit(c, h, b).json()
    marker = app.state.settings.data_dir / "send-started"
    script = """
import os, time
from pathlib import Path
from backend.app import create_app
from backend.settings import Settings
from backend.worker import Worker
class Detector:
    ready = True
class Blocking:
    def generate(self, **kwargs):
        Path(os.environ['MARKER']).write_text('possible-send')
        time.sleep(120)
settings=Settings(data_dir=Path(os.environ['DATA']), catalog_path=Path(os.environ['CATALOG']), catalog_image_root=Path(os.environ['IMAGE_ROOT']))
app=create_app(settings, provider=Blocking(), detector=Detector(), clock=lambda: float(os.environ['CLOCK']))
with Worker(app) as worker:
    worker.run_once()
"""
    env = {
        **os.environ,
        "DATA": str(app.state.settings.data_dir),
        "CATALOG": str(app.state.settings.catalog_path),
        "IMAGE_ROOT": str(app.state.settings.catalog_image_root),
        "CLOCK": str(clock()),
        "MARKER": str(marker),
    }
    process = subprocess.Popen(
        [sys.executable, "-c", script], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE
    )
    try:
        deadline = time.monotonic() + 15
        while not marker.exists() and process.poll() is None and time.monotonic() < deadline:
            time.sleep(0.02)
        assert marker.exists()
        assert c.get("/api/tryons/" + job["id"]).json()["status"] == "generating"
        process.kill()
        process.communicate(timeout=5)
    finally:
        if process.poll() is None:
            process.kill()
            process.communicate(timeout=5)
    assert process.returncode == -9
    with Worker(app) as worker:
        assert not worker.run_once()
        assert app.state.jobs.get(job["id"])["status"] == "unknown"
    assert not provider.calls
    assert not list(app.state.jobs.inputs.iterdir())


def test_recovery_reconciles_staging_atomic_leftovers_gc_and_missing_results(setup):
    app, c, h, b, _provider, _detector, _clock = setup
    consent(c, h, b)
    job = submit(c, h, b).json()
    root = app.state.jobs.outputs
    output = picture(format="WEBP")
    (root / (".stage-" + job["id"] + ".webp")).write_bytes(output)
    (root / ("..stage-" + job["id"] + ".webp.partial")).write_bytes(output)
    (root / ("a" * 32 + ".webp")).write_bytes(output)
    with app.state.store.connect() as db:
        db.execute("UPDATE jobs SET status='postprocessing' WHERE id=?", (job["id"],))
        db.execute("INSERT INTO gc VALUES (?)", ("a" * 32,))
    with Worker(app) as worker:
        assert not worker.run_once()
    assert not list(root.iterdir())
    assert c.get("/api/tryons/" + job["id"]).json()["status"] == "unknown"
    with app.state.store.connect() as db:
        assert db.execute("SELECT count(*) FROM gc").fetchone()[0] == 0


def test_single_worker_exclusion_preserves_live_generating_state(setup):
    import pytest

    app, c, h, b, _provider, _detector, _clock = setup
    consent(c, h, b)
    job = submit(c, h, b).json()
    with Worker(app):
        with app.state.store.connect() as db:
            db.execute("UPDATE jobs SET status='generating' WHERE id=?", (job["id"],))
        with pytest.raises(RuntimeError, match="already active"), Worker(app):
            pass
        assert app.state.jobs.get(job["id"])["status"] == "generating"
