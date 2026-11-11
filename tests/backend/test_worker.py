import io

from conftest import consent, submit
from fastapi.testclient import TestClient
from PIL import Image


def test_worker_publishes_private_labelled_webp_and_frozen_reference(setup):
    from backend.worker import Worker

    app, c, h, b, provider, _detector, _clock = setup
    consent(c, h, b)
    job = submit(c, h, b, shot_index="9", edition="v2").json()
    with Worker(app) as worker:
        assert worker.run_once()
        assert not worker.run_once()
    result = c.get("/api/tryons/" + job["id"]).json()
    assert result["status"] == "succeeded"
    assert result["look_id"] == 1 and result["shot_index"] == 9 and result["edition"] == "v2"
    assert len(provider.calls) == 1
    with Image.open(io.BytesIO(provider.calls[0]["reference"])) as ref:
        assert ref.size == (100, 200)
    assert "Image 1" in provider.calls[0]["prompt"] and "identity" in provider.calls[0]["prompt"]
    assert not list((app.state.settings.data_dir / "inputs").iterdir())
    response = c.get(result["image_url"])
    assert response.headers["content-type"] == "image/webp"
    assert response.headers["cache-control"] == "no-store"
    with Image.open(io.BytesIO(response.content)) as output:
        assert output.format == "WEBP"
        metadata = output.info["xmp"].decode()
        assert "Yixu" in metadata and "AI-generated" in metadata
        assert output.getpixel((15, output.height - 10)) != output.getpixel((15, 10))
    download = c.get(result["download_url"])
    assert "attachment" in download.headers["content-disposition"]
    assert download.content == response.content
    with TestClient(app, base_url="https://localhost") as stranger:
        stranger.get("/api/bootstrap")
        assert stranger.get(result["image_url"]).status_code == 404
        assert stranger.get(result["download_url"]).status_code == 404
    assert c.delete("/api/tryons/" + job["id"], headers=h).json() == {"deleted": True}
    assert c.get("/api/tryons/" + job["id"]).json()["status"] == "canceled"
    assert c.get(result["image_url"]).status_code == 404
    assert not list((app.state.settings.data_dir / "results").iterdir())


def test_original_expiry_all_states_and_restart_never_replays_possible_send(setup):
    from backend.app import create_app
    from backend.worker import Worker

    app, c, h, b, provider, detector, clock = setup
    consent(c, h, b)
    expired = submit(c, h, b).json()
    clock.now += 3600
    assert c.get("/api/tryons/" + expired["id"]).json()["status"] == "needs_photo"
    assert not list(app.state.jobs.inputs.iterdir())
    assert not provider.calls
    queued = submit(c, h, b, key="queued-0001").json()
    possible = submit(c, h, b, key="possible-001").json()
    with app.state.store.connect() as db:
        db.execute("UPDATE jobs SET status='generating' WHERE id=?", (possible["id"],))
    restarted = create_app(app.state.settings, provider=provider, detector=detector, clock=clock)
    with Worker(restarted) as worker:
        assert restarted.state.jobs.get(possible["id"])["status"] == "unknown"
        assert restarted.state.jobs.get(queued["id"])["status"] == "queued"
        assert worker.run_once()
        assert not worker.run_once()
    assert len(provider.calls) == 1
    assert not list(app.state.jobs.inputs.iterdir())


def test_provider_uncertainty_invalid_response_and_cancel_do_not_replay(setup):
    from backend.worker import Worker

    app, c, h, b, provider, _detector, _clock = setup
    consent(c, h, b)

    def uncertain(**kwargs):
        raise TimeoutError("private-provider-body-do-not-leak")

    provider.generate = uncertain
    first = submit(c, h, b).json()
    with Worker(app) as worker:
        assert worker.run_once()
        assert c.get("/api/tryons/" + first["id"]).json()["status"] == "unknown"
        assert not worker.run_once()
    assert "private-provider-body" not in c.get("/api/tryons").text
    provider.generate = lambda **kwargs: b"invalid-image-provider-response"
    invalid = submit(c, h, b, key="invalid-001").json()
    with Worker(app) as worker:
        assert worker.run_once()
    assert c.get("/api/tryons/" + invalid["id"]).json()["status"] == "failed"
    canceled = submit(c, h, b, key="canceled-001").json()

    def cancel_during_call(**kwargs):
        c.delete("/api/tryons/" + canceled["id"], headers=h)
        from conftest import picture

        return picture()

    provider.generate = cancel_during_call
    with Worker(app) as worker:
        assert worker.run_once()
        assert not worker.run_once()
    assert c.get("/api/tryons/" + canceled["id"]).json()["status"] == "canceled"
    assert not list(app.state.jobs.inputs.iterdir())
    assert not list(app.state.jobs.outputs.iterdir())


def test_idle_sweeper_deletes_originals_without_traffic_or_worker(setup):
    import time

    app, c, h, b, _provider, _detector, clock = setup
    consent(c, h, b)
    job = submit(c, h, b).json()
    clock.now += 3600
    deadline = time.monotonic() + 3
    while (
        list(app.state.jobs.inputs.iterdir())
        or app.state.jobs.get(job["id"])["status"] != "needs_photo"
    ) and time.monotonic() < deadline:
        time.sleep(0.05)
    assert not list(app.state.jobs.inputs.iterdir())
    assert app.state.jobs.get(job["id"])["status"] == "needs_photo"


def test_global_latest_thousand_fifo_and_no_output_age_expiry(setup):
    from conftest import picture
    from test_admin import login

    from backend.worker import Worker

    app, c, h, b, _provider, _detector, clock = setup
    consent(c, h, b)
    # Controlled already-published fixture: 1000 genuine decoded test WebP files.
    data = picture("green", format="WEBP")
    owner = b["visitor"]["id"]
    with app.state.store.connect() as db:
        for n in range(1000):
            job_id = f"{n:032x}"
            db.execute(
                "INSERT INTO jobs (id,owner,idempotency_key,fingerprint,status,look_id,edition,shot_index,created,expires,output_bytes,published) VALUES (?,?,?,?,'succeeded',1,'v1',1,?,?,?,?)",
                (job_id, owner, job_id, "fixture", clock(), clock() + 3600, len(data), clock() + n),
            )
            (app.state.jobs.outputs / (job_id + ".webp")).write_bytes(data)
    clock.now += 31_536_000
    first_id = "0" * 32
    assert c.get("/api/tryons/" + first_id + "/image").status_code == 200
    newest = submit(c, h, b, key="newest-1001").json()
    with Worker(app) as worker:
        assert worker.run_once()
    assert len(list(app.state.jobs.outputs.glob("*.webp"))) == 1000
    assert c.get("/api/tryons/" + first_id + "/image").status_code == 404
    assert c.get("/api/tryons/" + first_id).json()["status"] == "expired"
    assert c.get("/api/tryons/" + newest["id"]).json()["status"] == "succeeded"
    with TestClient(app, base_url="https://admin.localhost") as admin:
        login(admin, app.state.settings.data_dir)
        overview = admin.get("/api/admin/overview").json()
        assert overview["result_count"] == 1000
        assert overview["result_bytes"] == sum(
            p.stat().st_size for p in app.state.jobs.outputs.glob("*.webp")
        )
        assert admin.get("/api/admin/results?limit=24").json()["has_more"]
