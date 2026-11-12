"""All provider calls here are deterministic test adapters; no real CDN requests."""

import hashlib
import io
import json
import stat

import pytest
from PIL import Image

from backend.cdn import (
    CdnFailure,
    CdnService,
    DeliveryUnknown,
    HttpUploadAdapter,
    UploadResult,
    checked_url,
)


def record(
    root, asset_id="look-101-v2", color="green", file="assets/looks/2026-11-12/look-101.webp"
):
    stream = io.BytesIO()
    Image.new("RGB", (30, 60), color).save(stream, "WEBP")
    data = stream.getvalue()
    sha = hashlib.sha256(data).hexdigest()
    path = root / "public-content" / "assets" / (sha + ".webp")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return {
        "asset_id": asset_id,
        "sha256": sha,
        "bytes": len(data),
        "width": 30,
        "height": 60,
        "file": file,
        "visibility": "public",
        "archive_path": path,
        "source_url": "/api/content/assets/" + asset_id,
    }


def configure(service, host="cdn.example.com"):
    return service.configure(
        {
            "upload_url": "https://" + host + "/upload",
            "allowed_hosts": [host],
            "token": "test-only-private-token",
        }
    )


class Adapter:
    def __init__(self, behavior="success", url="https://cdn.example.com/image.webp"):
        self.behavior = behavior
        self.url = url
        self.uploads = []

    def upload(self, row, payload):
        self.uploads.append(row["asset_id"])
        self.payload = payload
        if self.behavior == "reject":
            raise CdnFailure("test-only-private-token explicit rejected")
        if self.behavior == "timeout":
            raise DeliveryUnknown("test-only-private-token delivered maybe")
        return UploadResult("test-object", self.url)

    def read(self, url, max_bytes):
        if self.behavior == "changed":
            return "image/webp", b"not unchanged"
        if self.behavior == "mime":
            return "application/octet-stream", self.payload
        return "image/webp", self.payload


def test_unconfigured_durable_public_only_source_fallback(tmp_path):
    service = CdnService(tmp_path)
    public = record(tmp_path)
    private = {**public, "asset_id": "private-photo", "visibility": "private"}
    archived = {**public, "asset_id": "legacy-v1", "file": "images/look-001.webp"}
    service.enqueue([public, private, archived], "revision-1")
    assert service.resolve(public["asset_id"], public["source_url"]) == public["source_url"]
    assert service.run_once(Adapter()) is False
    state = CdnService(tmp_path).overview()
    assert state["total"] == 1 and state["counts"]["unconfigured"] == 1
    assert state["config"]["configured"] is False
    assert "archive_path" not in json.dumps(state)
    assert stat.S_IMODE(service.path.stat().st_mode) == 0o600


def test_exact_verification_persistent_resolution_provider_switch(tmp_path):
    service = CdnService(tmp_path)
    first = record(tmp_path)
    service.enqueue([first], "revision-1")
    a = configure(service)
    adapter = Adapter()
    assert service.run_once(adapter)
    assert service.overview()["counts"]["verified"] == 1
    assert service.resolve(first["asset_id"], first["source_url"]) == adapter.url
    assert CdnService(tmp_path).resolve(first["asset_id"], first["source_url"]) == adapter.url
    b = configure(service, "new.example.com")
    assert a["provider_id"] != b["provider_id"]
    second = record(tmp_path, "look-102-v2", "blue")
    service.enqueue([first, second], "revision-2")
    jobs = {r["asset_id"]: r for r in service.overview()["jobs"]}
    assert jobs[first["asset_id"]]["provider_id"] == a["provider_id"]
    assert jobs[second["asset_id"]]["provider_id"] == b["provider_id"]
    assert service.resolve(first["asset_id"], first["source_url"]) == adapter.url
    assert service.run_once(Adapter(url="https://new.example.com/second.webp"))
    assert service.overview()["counts"]["verified"] == 2
    assert not service.run_once(adapter)
    # Retiring a record means its former CDN URL is no longer selected.
    service.enqueue([second], "revision-3")
    assert service.resolve(first["asset_id"], first["source_url"]) == first["source_url"]


@pytest.mark.parametrize("behavior", ["timeout", "changed", "mime"])
def test_unknown_delivery_or_verification_is_never_replayed(tmp_path, behavior):
    service = CdnService(tmp_path)
    configure(service)
    asset = record(tmp_path)
    service.enqueue([asset], "rev")
    adapter = Adapter(behavior)
    assert service.run_once(adapter)
    job = service.overview()["jobs"][0]
    assert job["status"] == "unknown"
    assert "test-only-private-token" not in json.dumps(service.overview())
    assert not CdnService(tmp_path).run_once(adapter)
    service.enqueue([asset], "next-revision")
    assert not service.run_once(adapter)
    with pytest.raises(ValueError):
        service.retry(job["id"])
    assert adapter.uploads == [asset["asset_id"]]
    assert service.resolve(asset["asset_id"], asset["source_url"]) == asset["source_url"]


def test_crashed_upload_becomes_unknown_but_queued_is_recoverable(tmp_path):
    service = CdnService(tmp_path)
    configure(service)
    service.enqueue([record(tmp_path)], "rev")
    with service.connect() as db:
        db.execute("UPDATE jobs SET status='uploading'")
    resumed = CdnService(tmp_path)
    assert resumed.overview()["counts"]["unknown"] == 1
    assert not resumed.run_once(Adapter())


def test_explicit_failure_retry_and_archive_integrity(tmp_path):
    service = CdnService(tmp_path)
    configure(service)
    asset = record(tmp_path)
    service.enqueue([asset], "rev")
    assert service.run_once(Adapter("reject"))
    job = service.overview()["jobs"][0]
    assert job["status"] == "failed" and job["attempts"] == 1
    assert service.retry(job["id"]) == {"queued": True}
    asset["archive_path"].write_bytes(b"damaged")
    adapter = Adapter()
    assert service.run_once(adapter)
    assert not adapter.uploads
    assert service.overview()["counts"]["failed"] == 1
    assert service.overview()["jobs"][0]["attempts"] == 2


@pytest.mark.parametrize(
    "change",
    [
        {"archive_path": "/tmp/private-selfie.webp"},
        {"source_url": "/api/admin/results/private/image"},
        {"file": "assets/looks/../../private.webp"},
        {"asset_id": "bad\r\nHeader"},
    ],
)
def test_reject_malformed_public_records(tmp_path, change):
    service = CdnService(tmp_path)
    asset = {**record(tmp_path), **change}
    with pytest.raises(ValueError):
        service.enqueue([asset], "rev")
    assert service.overview()["total"] == 0


def test_config_private_redacted_and_url_boundaries(tmp_path):
    service = CdnService(tmp_path)
    configure(service)
    assert "test-only-private-token" not in json.dumps(service.config_status())
    assert stat.S_IMODE((tmp_path / "cdn-config.json").stat().st_mode) == 0o600
    for url in (
        "http://cdn.example.com/x",
        "https://127.0.0.1/x",
        "https://localhost/x",
        "https://10.0.0.1/x",
        "https://cdn.example.com@localhost/x",
        "https://other.example/x",
        "https://cdn.example.com/x?credential=secret",
    ):
        with pytest.raises(ValueError):
            checked_url(url, ["cdn.example.com", "localhost", "127.0.0.1", "10.0.0.1"])


def test_generic_http_adapter_contract_uses_injected_transport_without_network(tmp_path):
    service = CdnService(tmp_path)
    configure(service)
    adapter = HttpUploadAdapter(service._config())
    asset = record(tmp_path)
    payload = asset["archive_path"].read_bytes()
    calls = []

    def request(method, url, limit, body=None, headers=None):
        calls.append((method, url, headers, body))
        return (
            (
                200,
                "application/json",
                json.dumps(
                    {"id": "test-object", "url": "https://cdn.example.com/public.webp"}
                ).encode(),
            )
            if method == "PUT"
            else (200, "image/webp", payload)
        )

    adapter._request = request
    service.enqueue([asset], "rev")
    assert service.run_once(adapter)
    assert [r[0] for r in calls] == ["PUT", "GET"]
    assert calls[0][2]["Content-Type"] == "image/webp"
    assert calls[0][2]["Authorization"] == "Bearer test-only-private-token"
    assert calls[0][3] == payload
    assert service.overview()["counts"]["verified"] == 1


def test_unknown_remote_object_can_be_verified_without_reupload(tmp_path):
    service = CdnService(tmp_path)
    configure(service)
    asset = record(tmp_path)
    service.enqueue([asset], "rev")
    adapter = Adapter("mime")
    service.run_once(adapter)
    job = service.overview()["jobs"][0]
    assert service.verify_unknown(job["id"], adapter) == {"verified": False, "status": "unknown"}
    adapter.behavior = "success"
    assert service.verify_unknown(job["id"], adapter) == {"verified": True, "status": "verified"}
    assert adapter.uploads == [asset["asset_id"]]
    assert service.resolve(asset["asset_id"], asset["source_url"]) == adapter.url


def test_dns_private_resolution_blocked_before_connect(monkeypatch):
    import socket

    from backend.cdn import PinnedHTTPS

    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda *args, **kwargs: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443))],
    )
    monkeypatch.setattr(
        socket, "socket", lambda *args, **kwargs: pytest.fail("must not connect to private address")
    )
    with pytest.raises(CdnFailure):
        PinnedHTTPS("cdn.example.com", timeout=1).connect()


def test_generic_http_timeout_unknown_but_explicit_rejection_failed(tmp_path):
    service = CdnService(tmp_path)
    configure(service)
    adapter = HttpUploadAdapter(service._config())
    asset = record(tmp_path)

    def timeout(*args, **kwargs):
        raise TimeoutError("test-only-private-token")

    adapter._request = timeout
    with pytest.raises(DeliveryUnknown):
        adapter.upload(asset, asset["archive_path"].read_bytes())
    adapter._request = lambda *args, **kwargs: (429, "application/json", b"{}")
    with pytest.raises(CdnFailure):
        adapter.upload(asset, asset["archive_path"].read_bytes())
    adapter._request = lambda *args, **kwargs: (302, "text/html", b"redirect")
    with pytest.raises(DeliveryUnknown):
        adapter.upload(asset, asset["archive_path"].read_bytes())


def test_live_upload_is_not_recovered_or_replayed_by_second_process_instance(tmp_path):
    import threading

    service = CdnService(tmp_path)
    configure(service)
    service.enqueue([record(tmp_path)], "revision")
    entered, release = threading.Event(), threading.Event()

    class Blocked(Adapter):
        def upload(self, row, payload):
            entered.set()
            assert release.wait(timeout=5)
            return super().upload(row, payload)

    adapter = Blocked()
    worker = threading.Thread(target=lambda: service.run_once(adapter))
    worker.start()
    try:
        assert entered.wait(timeout=5)
        other = CdnService(tmp_path)
        assert other.overview()["counts"]["uploading"] == 1
        assert not other.run_once(Adapter())
        assert other.overview()["counts"]["unknown"] == 0
    finally:
        release.set()
        worker.join(timeout=5)
    assert not worker.is_alive()
    assert other.overview()["counts"]["verified"] == 1
    assert adapter.uploads == ["look-101-v2"]


def test_explicit_migration_preserves_old_replica_until_new_verifies(tmp_path):
    service = CdnService(tmp_path)
    configure(service)
    asset = record(tmp_path)
    service.enqueue([asset], "revision")
    old = Adapter()
    service.run_once(old)
    configure(service, "new.example.com")
    assert service.migrate([asset["asset_id"]]) == {"queued": 1}
    assert service.migrate([asset["asset_id"]]) == {"queued": 0}
    assert service.resolve(asset["asset_id"], asset["source_url"]) == old.url
    new = Adapter(url="https://new.example.com/new.webp")
    service.run_once(new)
    assert service.resolve(asset["asset_id"], asset["source_url"]) == new.url
    with pytest.raises(ValueError):
        service.migrate(["private-selfie"])


def test_public_archive_symlink_escape_never_uploads_private_data(tmp_path):
    service = CdnService(tmp_path)
    configure(service)
    asset = record(tmp_path)
    private = tmp_path / "private-photo.webp"
    private.write_bytes(asset["archive_path"].read_bytes())
    asset["archive_path"].unlink()
    asset["archive_path"].symlink_to(private)
    with pytest.raises(ValueError):
        service.enqueue([asset], "revision")
    assert service.overview()["total"] == 0
