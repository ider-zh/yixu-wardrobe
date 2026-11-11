import os
import socket
import subprocess
import sys
import time

import httpx2


def test_real_uvicorn_factory_on_loopback_separates_hosts(tmp_path):
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    env = {
        **os.environ,
        "YIXU_DATA_DIR": str(tmp_path / "private"),
        "YIXU_PUBLIC_HOST": "localhost",
        "YIXU_ADMIN_HOST": "admin.localhost",
        "YIXU_SECURE_COOKIES": "false",
    }
    with (tmp_path / "server.log").open("wb") as log:
        process = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "uvicorn",
                "backend.app:create_app",
                "--factory",
                "--host",
                "127.0.0.1",
                "--port",
                str(port),
                "--no-access-log",
            ],
            env=env,
            stdout=log,
            stderr=log,
        )
        try:
            with httpx2.Client(
                base_url=f"http://127.0.0.1:{port}", trust_env=False, timeout=2
            ) as client:
                deadline = time.monotonic() + 15
                while True:
                    try:
                        result = client.get("/api/health", headers={"Host": "localhost"})
                        break
                    except httpx2.ConnectError:
                        if time.monotonic() > deadline or process.poll() is not None:
                            raise
                        time.sleep(0.05)
                assert result.json()["ok"]
                assert not result.json()["provider_configured"]
                assert (
                    client.get("/api/admin/overview", headers={"Host": "localhost"}).status_code
                    == 404
                )
                admin = client.get("/api/admin/bootstrap", headers={"Host": "admin.localhost"})
                assert admin.status_code == 200 and not admin.json()["authenticated"]
                boot = client.get("/api/bootstrap", headers={"Host": "localhost"})
                assert boot.status_code == 200
                assert boot.headers["cache-control"] == "no-store"
                assert "Domain=" not in boot.headers["set-cookie"]
                # Real chunked HTTP, not just an ASGI client: response must arrive
                # after crossing the JSON bound without sending the planned 16 MiB.
                from http.client import HTTPResponse

                with socket.create_connection(("127.0.0.1", port), timeout=2) as stream:
                    stream.sendall(
                        b"POST /api/events HTTP/1.1\r\nHost: localhost\r\n"
                        b"Content-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n"
                    )
                    chunk = b" " * (64 * 1024)
                    for _ in range(2):
                        stream.sendall(b"10000\r\n" + chunk + b"\r\n")
                    # No terminating chunk and no remaining body: bounded early reply.
                    with HTTPResponse(stream) as reply:
                        reply.begin()
                        assert reply.status == 413
                        assert b'"code":"json_too_large"' in reply.read()
                assert client.get("/api/health", headers={"Host": "localhost"}).status_code == 200
        finally:
            process.terminate()
            process.wait(timeout=10)
    assert process.returncode in (0, -15)  # Uvicorn re-raises SIGTERM after graceful shutdown.
    assert "Application shutdown complete." in (tmp_path / "server.log").read_text()
    assert "Traceback" not in (tmp_path / "server.log").read_text()
