import base64
import socketserver
import threading

import httpx2
import pytest
from conftest import picture
from openai import DefaultHttpxClient, OpenAI

from backend.settings import Runtime


def test_actual_sdk_edit_wire_uses_two_images_n1_and_zero_retries():
    from backend.provider import OpenAIProvider

    seen = []
    image = picture()

    def handler(request):
        seen.append(request)
        return httpx2.Response(
            200, json={"created": 1, "data": [{"b64_json": base64.b64encode(image).decode()}]}
        )

    def client_factory(runtime, timeout):
        return OpenAI(
            api_key=runtime.api_key,
            base_url=runtime.api_base,
            max_retries=0,
            timeout=timeout,
            http_client=DefaultHttpxClient(
                transport=httpx2.MockTransport(handler), trust_env=False, follow_redirects=False
            ),
        )

    provider = OpenAIProvider(client_factory=client_factory)
    runtime = Runtime(enabled=True, api_key="test-only-project-key")
    output = provider.generate(
        photo=image,
        reference=picture("blue"),
        prompt="Image 1 identity",
        runtime=runtime,
        timeout=30,
    )
    assert output == image and len(seen) == 1
    req = seen[0]
    assert str(req.url) == "https://api.openai.com/v1/images/edits"
    body = req.content
    assert body.count(b'name="image[]"') == 2
    for name, value in [
        ("model", "gpt-image-1.5"),
        ("n", "1"),
        ("size", "1024x1536"),
        ("quality", "medium"),
    ]:
        assert f'name="{name}"\r\n\r\n{value}'.encode() in body
    assert b"private-selfie" not in body
    assert provider.configured(runtime)
    assert not provider.configured(Runtime())


def test_sdk_failure_not_retried_and_real_transport_has_proxy_only():
    from backend.provider import OpenAIProvider, ProviderUncertain

    connects = []

    class Proxy(socketserver.StreamRequestHandler):
        def handle(self):
            connects.append(self.rfile.readline().decode().strip())
            while self.rfile.readline().strip():
                pass
            self.wfile.write(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")

    with socketserver.TCPServer(("127.0.0.1", 0), Proxy) as proxy:
        thread = threading.Thread(target=proxy.serve_forever, daemon=True)
        thread.start()
        runtime = Runtime(
            enabled=True,
            api_key="test-only-project-key",
            proxy_url=f"http://127.0.0.1:{proxy.server_address[1]}",
        )
        with pytest.raises(ProviderUncertain):
            OpenAIProvider().generate(
                photo=picture(), reference=picture(), prompt="identity", runtime=runtime, timeout=2
            )
        proxy.shutdown()
        thread.join()
    assert connects == ["CONNECT api.openai.com:443 HTTP/1.1"]


def test_definitive_provider_rejection_and_invalid_output_are_failed_not_unknown(setup):
    from conftest import consent, submit

    from backend.provider import InvalidOutput, ProviderRejected
    from backend.worker import Worker

    app, c, h, b, provider, _detector, _clock = setup
    consent(c, h, b)

    def reject(**kwargs):
        raise ProviderRejected("private-upstream-policy-body")

    provider.generate = reject
    job = submit(c, h, b).json()
    with Worker(app) as worker:
        assert worker.run_once()
    assert c.get("/api/tryons/" + job["id"]).json()["status"] == "failed"
    assert c.get("/api/tryons/" + job["id"]).json()["error_code"] == "provider_rejected"

    def invalid(**kwargs):
        raise InvalidOutput()

    provider.generate = invalid
    job = submit(c, h, b, key="bad-output-01").json()
    with Worker(app) as worker:
        assert worker.run_once()
    assert c.get("/api/tryons/" + job["id"]).json()["error_code"] == "invalid_output"
    assert not list(app.state.jobs.inputs.iterdir())


def test_adapter_enforces_total_wall_deadline_not_only_socket_timeout():
    import time

    from backend.provider import OpenAIProvider, ProviderUncertain

    class SlowClient:
        def __enter__(self):
            time.sleep(2)
            raise AssertionError("deadline did not interrupt transport construction")

        def __exit__(self, *args):
            pass

    provider = OpenAIProvider(client_factory=lambda *args: SlowClient())
    start = time.monotonic()
    with pytest.raises(ProviderUncertain):
        provider.generate(
            photo=picture(),
            reference=picture(),
            prompt="identity",
            runtime=Runtime(enabled=True, api_key="test-only"),
            timeout=0.05,
        )
    assert time.monotonic() - start < 1
