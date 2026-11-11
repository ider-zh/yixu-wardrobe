import asyncio

import httpx2
from conftest import consent, picture


def test_invalid_json_and_unmatched_routes_use_private_stable_errors(setup):
    _app, c, h, _b, _provider, _detector, _clock = setup
    for data in ("{broken", "[]", "null"):
        result = c.post(
            "/api/disclosure/accept",
            headers={**h, "Content-Type": "application/json"},
            content=data,
        )
        assert result.status_code == 422
        assert set(result.json()) == {"error"}
    missing = c.get("/api/missing")
    assert missing.status_code == 404
    assert set(missing.json()) == {"error"}
    invalid_host = c.get("/api/bootstrap", headers={"Host": "attacker.invalid"})
    assert invalid_host.headers["cache-control"] == "no-store"


def test_photo_auth_before_receive_and_strict_receipt_deadline(setup):
    app, c, h, b, _provider, detector, clock = setup
    consent(c, h, b)
    called = []
    detector.detect = lambda image: called.append(1) or [(30, 30, 120, 120)]
    boundary = "testmultipart"
    fields = {
        "look_id": "1",
        "edition": "v1",
        "shot_index": "1",
        "idempotency_key": "slow-upload-01",
        "disclosure_version": b["disclosure"]["version"],
    }
    body = b""
    for name, value in fields.items():
        body += f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
    body += f'--{boundary}\r\nContent-Disposition: form-data; name="photo"; filename="private.png"\r\nContent-Type: image/png\r\n\r\n'.encode()
    raw = body + picture() + f"\r\n--{boundary}--\r\n".encode()
    cookie = "; ".join(f"{k}={v}" for k, v in c.cookies.items())

    async def exercise():
        async with httpx2.AsyncClient(
            transport=httpx2.ASGITransport(app=app), base_url="https://localhost"
        ) as client:

            async def forbidden_stream():
                raise AssertionError("Photo received before authorization")
                yield b""

            rejected = await client.post("/api/tryons", content=forbidden_stream())
            assert rejected.status_code == 401

            async def slow_stream():
                yield raw[:200]
                clock.now += 3601
                yield raw[200:]

            response = await client.post(
                "/api/tryons",
                headers={
                    **h,
                    "Cookie": cookie,
                    "Content-Type": f"multipart/form-data; boundary={boundary}",
                },
                content=slow_stream(),
            )
            assert response.status_code == 422
            assert response.json()["error"]["code"] == "photo_expired"

    asyncio.run(exercise())
    assert not called
    assert not list(app.state.jobs.inputs.iterdir())


def test_unexpected_internal_errors_are_json_private_and_redacted(setup, monkeypatch):
    app, c, h, b, _provider, _detector, _clock = setup
    consent(c, h, b)
    from conftest import submit

    job = submit(c, h, b).json()

    def broken_shape(row):
        raise RuntimeError("private-secret-or-path-never-return")

    monkeypatch.setattr(app.state.jobs, "shape", broken_shape)
    response = c.get("/api/tryons/" + job["id"])
    assert response.status_code == 500
    assert response.json()["error"]["code"] == "internal_error"
    assert "private-secret" not in response.text
    assert response.headers["cache-control"] == "no-store"
