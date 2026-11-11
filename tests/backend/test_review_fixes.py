"""HTTP/concurrency regressions for the independently reproduced review blockers."""

import asyncio

import httpx2
import pytest


@pytest.mark.parametrize(
    ("host", "path", "method"),
    [
        ("localhost", "/api/events", "POST"),
        ("localhost", "/api/disclosure/accept", "POST"),
        ("admin.localhost", "/api/admin/login", "POST"),
        ("admin.localhost", "/api/admin/password", "POST"),
        ("admin.localhost", "/api/admin/settings", "PUT"),
        ("admin.localhost", "/api/admin/results/missing/review", "POST"),
    ],
)
def test_chunked_json_is_bounded_before_auth_and_framework_parsing(setup, host, path, method):
    app, _client, _headers, _bootstrap, _provider, _detector, _clock = setup

    async def probe():
        consumed = 0

        async def body():
            nonlocal consumed
            # Same 16 MiB causal probe as the review; never allocate the whole body.
            for _ in range(256):
                chunk = b" " * (64 * 1024)
                consumed += len(chunk)
                yield chunk
            yield b'{"event":"page_view"}'

        async with httpx2.AsyncClient(
            transport=httpx2.ASGITransport(app=app), base_url=f"https://{host}"
        ) as client:
            request = client.build_request(
                method, path, headers={"Content-Type": "application/json"}, content=body()
            )
            assert "content-length" not in request.headers
            response = await client.send(request)
            assert response.status_code == 413
            assert response.json()["error"]["code"] == "json_too_large"
            assert consumed <= 128 * 1024
            assert response.headers["cache-control"] == "no-store"
            # Error must not poison subsequent requests.
            health = "/api/admin/bootstrap" if host.startswith("admin") else "/api/health"
            assert (await client.get(health)).status_code == 200

    asyncio.run(probe())


def test_old_password_login_cannot_survive_concurrent_rotation(setup, monkeypatch):
    import json
    import threading
    from concurrent.futures import ThreadPoolExecutor

    from fastapi.testclient import TestClient
    from test_admin import login

    app, _client, _headers, _bootstrap, _provider, _detector, _clock = setup
    root = app.state.store.root
    credentials = json.loads((root / "initial-admin.json").read_text())
    verified, release, rotating = threading.Event(), threading.Event(), threading.Event()
    real_verify = app.state.admin.verify
    first = True
    verification_transaction = []

    def gated_verify(db, username, password):
        nonlocal first
        real_verify(db, username, password)
        if first:
            first = False
            verification_transaction.append(db.in_transaction)
            verified.set()
            assert release.wait(10)

    with (
        TestClient(app, base_url="https://admin.localhost") as owner,
        TestClient(app, base_url="https://admin.localhost") as stale,
        ThreadPoolExecutor(max_workers=2) as pool,
    ):
        headers = login(owner, root)
        boot = stale.get("/api/admin/bootstrap").json()
        stale_headers = {"Origin": "https://admin.localhost", "X-CSRF-Token": boot["csrf_token"]}
        monkeypatch.setattr(app.state.admin, "verify", gated_verify)
        pending_login = pool.submit(
            stale.post, "/api/admin/login", headers=stale_headers, json=credentials
        )
        assert verified.wait(10)

        def rotate():
            rotating.set()
            return owner.post(
                "/api/admin/password",
                headers=headers,
                json={
                    "current_password": credentials["password"],
                    "new_password": "local-test-rotation-password-12345",
                },
            )

        rotation = pool.submit(rotate)
        try:
            assert rotating.wait(5)
            # Reproduce the review's exact ordering if verification is unlocked:
            # complete rotation before releasing the already-verified login.
            # If the DB writer is already owned, release it so rotation can finish.
            # This observed-lock branch avoids a scheduler-speed race or sleeps.
            if not verification_transaction[0]:
                assert rotation.result(timeout=10).status_code == 200
        finally:
            release.set()
        assert pending_login.result(timeout=10).status_code == 200
        assert rotation.result(timeout=10).status_code == 200
        assert stale.get("/api/admin/overview").status_code == 401
        # A genuinely new login with the revoked password still gets login's 401.
        boot = stale.get("/api/admin/bootstrap").json()
        stale_headers["X-CSRF-Token"] = boot["csrf_token"]
        assert (
            stale.post("/api/admin/login", headers=stale_headers, json=credentials).status_code
            == 401
        )


@pytest.mark.parametrize("boundary", ["inputs", "runtime"])
def test_cancel_winning_final_dispatch_boundary_never_enters_provider(setup, monkeypatch, boundary):
    import threading
    from concurrent.futures import ThreadPoolExecutor

    from conftest import consent, submit

    from backend.settings import RuntimeFile
    from backend.worker import Worker

    app, client, headers, bootstrap, provider, _detector, _clock = setup
    consent(client, headers, bootstrap)
    job = submit(client, headers, bootstrap).json()
    loaded, release = threading.Event(), threading.Event()
    old_drop, old_load = app.state.jobs.drop_inputs, RuntimeFile.load

    def pause():
        if threading.current_thread().name.startswith("review-worker"):
            loaded.set()
            assert release.wait(10)

    def gated_drop(job_id):
        old_drop(job_id)
        pause()

    def gated_load(self):
        runtime = old_load(self)
        pause()
        return runtime

    if boundary == "inputs":
        monkeypatch.setattr(app.state.jobs, "drop_inputs", gated_drop)
    else:
        monkeypatch.setattr(RuntimeFile, "load", gated_load)
    with (
        Worker(app) as worker,
        ThreadPoolExecutor(max_workers=1, thread_name_prefix="review-worker") as pool,
    ):
        pending = pool.submit(worker.run_once)
        try:
            assert loaded.wait(10)
            assert not provider.calls
            response = client.delete("/api/tryons/" + job["id"], headers=headers)
            assert response.status_code == 200
            assert not provider.calls
        finally:
            release.set()
        assert pending.result(timeout=10)
        assert not worker.run_once()
    assert not provider.calls
    assert client.get("/api/tryons/" + job["id"]).json()["status"] == "canceled"
    assert not list(app.state.jobs.inputs.iterdir())
    assert not list(app.state.jobs.outputs.iterdir())


@pytest.mark.parametrize("unavailable", ["provider", "detector", "catalog"])
def test_existing_idempotency_is_resolved_before_availability(setup, monkeypatch, unavailable):
    from conftest import consent, submit

    app, client, headers, bootstrap, provider, detector, _clock = setup
    consent(client, headers, bootstrap)
    original = submit(client, headers, bootstrap)
    assert original.status_code == 202
    job = original.json()
    inputs = {p.name: p.read_bytes() for p in app.state.jobs.inputs.iterdir()}
    if unavailable == "provider":
        monkeypatch.setattr(provider, "configured", lambda runtime: False, raising=False)
    elif unavailable == "detector":
        monkeypatch.setattr(detector, "ready", False)
    else:
        app.state.settings.catalog_path.unlink()

    def forbidden_validation(image):
        pytest.fail("Existing requests/new unavailable requests must not run image inference")

    monkeypatch.setattr(detector, "detect", forbidden_validation)
    identical = submit(client, headers, bootstrap)
    assert identical.status_code == 202
    assert identical.json()["id"] == job["id"]
    conflict = submit(client, headers, bootstrap, shot_index="2")
    assert conflict.status_code == 409
    assert conflict.json()["error"]["code"] == "idempotency_conflict"
    new = submit(client, headers, bootstrap, key="genuinely-new-request")
    assert new.status_code == 503
    assert new.json()["error"]["code"] == "unavailable"
    assert {p.name: p.read_bytes() for p in app.state.jobs.inputs.iterdir()} == inputs
    assert len(client.get("/api/tryons").json()["items"]) == 1
    assert not provider.calls


def test_wrong_current_password_is_validation_not_session_revocation(setup):
    from fastapi.testclient import TestClient
    from test_admin import login

    app, _client, _headers, _bootstrap, _provider, _detector, _clock = setup
    with TestClient(app, base_url="https://admin.localhost") as client:
        headers = login(client, app.state.store.root)
        response = client.post(
            "/api/admin/password",
            headers=headers,
            json={
                "current_password": "not-the-current-password",
                "new_password": "new-test-password-12345",
            },
        )
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "current_password"
        assert client.get("/api/admin/bootstrap").json()["authenticated"] is True
        assert client.get("/api/admin/overview").status_code == 200
        assert client.post("/api/admin/logout", headers=headers).status_code == 200
        assert (
            client.post(
                "/api/admin/password",
                headers=headers,
                json={"current_password": "irrelevant", "new_password": "new-test-password-12345"},
            ).status_code
            == 401
        )


def test_json_bound_does_not_replace_multipart_photo_limit(setup):
    import io

    from conftest import consent, submit
    from PIL import Image

    _app, client, headers, bootstrap, _provider, _detector, _clock = setup
    consent(client, headers, bootstrap)
    image = io.BytesIO()
    Image.new("RGB", (300, 400), "blue").save(image, format="PNG", compress_level=0)
    raw = image.getvalue()
    assert len(raw) > 64 * 1024
    assert submit(client, headers, bootstrap, image=raw).status_code == 202


def test_delete_does_not_wait_for_slow_network_generation(setup, monkeypatch):
    import threading
    from concurrent.futures import ThreadPoolExecutor

    from conftest import consent, picture, submit

    from backend.worker import Worker

    app, client, headers, bootstrap, provider, _detector, _clock = setup
    consent(client, headers, bootstrap)
    job = submit(client, headers, bootstrap).json()
    entered, release = threading.Event(), threading.Event()

    def slow_provider(**kwargs):
        entered.set()
        assert release.wait(10)
        return picture()

    monkeypatch.setattr(provider, "generate", slow_provider)
    with Worker(app) as worker, ThreadPoolExecutor(max_workers=2) as pool:
        pending = pool.submit(worker.run_once)
        try:
            assert entered.wait(5)
            deletion = pool.submit(client.delete, "/api/tryons/" + job["id"], headers=headers)
            assert deletion.result(timeout=2).status_code == 200
            assert not pending.done()
        finally:
            release.set()
        assert pending.result(timeout=10)
        assert not worker.run_once()
    assert client.get("/api/tryons/" + job["id"]).json()["status"] == "canceled"
    assert not list(app.state.jobs.outputs.iterdir())
