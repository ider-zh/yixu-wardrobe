from conftest import consent, picture, submit
from fastapi.testclient import TestClient


def test_accepted_queue_is_persistent_idempotent_owned_and_has_no_three_job_limit(setup):
    app, c, h, b, provider, _detector, _clock = setup
    assert submit(c, h, b).status_code == 403
    consent(c, h, b)
    assert submit(c, h, b, look_id="101").status_code == 422
    first = submit(c, h, b)
    assert first.status_code == 202, first.text
    job = first.json()
    assert job["status"] == "queued"
    assert job["queue_position"] == 0
    assert job["image_url"] is None and job["download_url"] is None
    assert submit(c, h, b).json()["id"] == job["id"]
    assert submit(c, h, b, image=picture("green")).status_code == 409
    for n in range(1, 5):
        result = submit(c, h, b, key=f"next-request-{n:03}")
        assert result.status_code == 202
        assert result.json()["queue_position"] == n
    assert len(c.get("/api/tryons").json()["items"]) == 5
    assert c.get("/api/tryons/" + job["id"]).json()["id"] == job["id"]
    with TestClient(app, base_url="https://localhost") as other:
        other.get("/api/bootstrap")
        assert other.get("/api/tryons/" + job["id"]).status_code == 404
        assert other.get("/api/tryons/" + job["id"] + "/image").status_code == 404
    assert not provider.calls
    assert not list(app.state.settings.data_dir.rglob("*selfie*"))


def test_missing_provider_does_not_receive_photo(tmp_path):
    from backend.app import create_app
    from backend.settings import Settings

    with TestClient(create_app(Settings(data_dir=tmp_path)), base_url="https://localhost") as c:
        b = c.get("/api/bootstrap").json()
        h = {"Origin": "https://localhost", "X-CSRF-Token": b["csrf_token"]}
        consent(c, h, b)
        result = submit(c, h, b)
        assert result.status_code == 503
        assert result.json()["error"]["code"] == "unavailable"
        assert not list((tmp_path / "inputs").glob("*"))


def test_failed_input_persistence_cleans_all_copies_and_redacts_filesystem_error(
    setup, monkeypatch
):
    import backend.jobs as module

    app, c, h, b, _provider, _detector, _clock = setup
    consent(c, h, b)
    original = module.atomic_write

    def fail_reference(path, data):
        if path.name.endswith(".reference.png"):
            raise OSError("private-disk-path-do-not-leak")
        original(path, data)

    monkeypatch.setattr(module, "atomic_write", fail_reference)
    response = submit(c, h, b)
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "storage_unavailable"
    assert "private-disk" not in response.text
    assert not list(app.state.jobs.inputs.iterdir())
    assert c.get("/api/tryons").json()["items"][0]["status"] == "failed"


def test_receipt_deadline_is_checked_during_upload_and_validation(setup):
    app, c, h, b, _provider, detector, clock = setup
    consent(c, h, b)

    def slow_detection(image):
        clock.now += 3601
        return [(30, 30, 120, 120)]

    detector.detect = slow_detection
    response = submit(c, h, b)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "photo_expired"
    assert not list(app.state.jobs.inputs.iterdir())


def test_cancel_during_input_persistence_never_requeues_or_dispatches(setup, monkeypatch):
    import backend.jobs as module
    from backend.worker import Worker

    app, c, h, b, provider, _detector, _clock = setup
    consent(c, h, b)
    original = module.atomic_write

    def cancel_before_reference(path, data):
        if path.name.endswith(".reference.png"):
            job_id = path.name.split(".")[0]
            assert c.delete("/api/tryons/" + job_id, headers=h).status_code == 200
        original(path, data)

    monkeypatch.setattr(module, "atomic_write", cancel_before_reference)
    response = submit(c, h, b)
    assert response.status_code == 202
    assert response.json()["status"] == "canceled"
    with Worker(app) as worker:
        assert not worker.run_once()
    assert not provider.calls
    assert not list(app.state.jobs.inputs.iterdir())
