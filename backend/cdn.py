"""Public-asset CDN queue; private inputs are never discovered or uploaded.

Generic HTTP contract: PUT an unchanged image/webp body to upload_url, with
Authorization: Bearer <token> and X-Asset-ID / X-Content-SHA256. Return JSON
{"id": "opaque-object-id", "url": "https://allowed-host/object.webp"}.
Capabilities: exact WebP only; no assumed idempotence, lookup or delete.
A platform-specific adapter may implement upload(record, payload) and
read(url, max_bytes), returning UploadResult and (MIME, bytes) respectively.
All delivery uncertainty is held for manual review, never blindly replayed.
"""

import fcntl
import hashlib
import http.client
import io
import ipaddress
import json
import os
import re
import socket
import sqlite3
import ssl
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import ClassVar
from urllib.parse import urlsplit

from PIL import Image

from .files import atomic_write

STATUSES = ("queued", "uploading", "verified", "failed", "unknown", "unconfigured")
MAX_IMAGE_BYTES = 32 * 1024 * 1024


class CdnFailure(Exception):
    """Definitive failure before upload, or explicit upload rejection."""


class DeliveryUnknown(Exception):
    """The provider may have accepted the upload; automatic replay is unsafe."""


@dataclass(frozen=True)
class UploadResult:
    remote_id: str
    url: str


def checked_url(url, hosts):
    """Validate configuration/response URL without making a network call."""
    p = urlsplit(url)
    if (
        p.scheme != "https"
        or not p.hostname
        or p.username
        or p.password
        or p.port not in (None, 443)
        or p.fragment
        or p.query
        or p.hostname.lower() not in hosts
    ):
        raise ValueError("CDN URL must use HTTPS and an explicitly allowed host")
    host = p.hostname.lower()
    if host == "localhost" or host.endswith((".localhost", ".local", ".internal")):
        raise ValueError("CDN host must be public")
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        address = None
    if address and not address.is_global:
        raise ValueError("CDN host must be public")
    return p


class PinnedHTTPS(http.client.HTTPSConnection):
    """Connect to the inspected public IP while retaining hostname TLS checks."""

    def __init__(self, host, timeout=20, context=None):
        self.tls_context = context or ssl.create_default_context()
        self.transport_socket = None
        super().__init__(host, timeout=timeout, context=self.tls_context)

    def connect(self):
        addresses = socket.getaddrinfo(self.host, 443, type=socket.SOCK_STREAM)
        if not addresses or any(not ipaddress.ip_address(a[4][0]).is_global for a in addresses):
            raise CdnFailure("CDN DNS does not resolve exclusively to public addresses")
        family, socktype, proto, _, sockaddr = addresses[0]
        raw = socket.socket(family, socktype, proto)
        raw.settimeout(self.timeout)
        try:
            raw.connect(sockaddr)
            self.sock = self.transport_socket = self.tls_context.wrap_socket(
                raw, server_hostname=self.host
            )
        except BaseException:
            raw.close()
            raise


class HttpUploadAdapter:
    capabilities: ClassVar[dict] = {
        "exact_webp": True,
        "idempotent": False,
        "lookup": False,
        "delete": False,
    }

    def __init__(self, config):
        self.config = config

    def _request(self, method, url, limit, body=None, headers=None):
        p = checked_url(url, self.config["allowed_hosts"])
        connection = PinnedHTTPS(
            p.hostname, timeout=self.config["timeout_seconds"], context=ssl.create_default_context()
        )
        try:
            connection.request(method, p.path or "/", body=body, headers=headers or {})
            response = connection.getresponse()
            deadline = time.monotonic() + self.config["timeout_seconds"]
            chunks = []
            remaining = limit + 1
            while remaining:
                budget = deadline - time.monotonic()
                if budget <= 0:
                    raise TimeoutError("CDN response exceeded its deadline")
                if response.fp is not None and connection.transport_socket is not None:
                    connection.transport_socket.settimeout(budget)
                chunk = response.read1(min(65536, remaining))
                if not chunk:
                    break
                chunks.append(chunk)
                remaining -= len(chunk)
            payload = b"".join(chunks)
            if len(payload) > limit:
                raise DeliveryUnknown("CDN response exceeded the permitted size")
            # Redirects are never followed, including same-host redirects.
            return (
                response.status,
                response.getheader("Content-Type", "").split(";")[0].strip().lower(),
                payload,
            )
        finally:
            connection.close()

    def upload(self, record, payload):
        headers = {
            "Content-Type": "image/webp",
            "X-Asset-ID": record["asset_id"],
            "X-Content-SHA256": record["sha256"],
        }
        if self.config["token"]:
            headers["Authorization"] = "Bearer " + self.config["token"]
        try:
            status, _mime, body = self._request(
                "PUT", self.config["upload_url"], 65536, payload, headers
            )
        except CdnFailure:
            raise
        except Exception:  # noqa: BLE001 - delivery uncertainty must never leak details or replay
            raise DeliveryUnknown(
                "Upload delivery could not be confirmed; manual review required"
            ) from None
        if status in (400, 401, 403, 404, 405, 413, 415, 422, 429):
            raise CdnFailure("Upload rejected by provider (HTTP " + str(status) + ")")
        if not 200 <= status < 300:
            raise DeliveryUnknown("Upload response could not confirm delivery")
        try:
            value = json.loads(body)
            result = UploadResult(str(value["id"]), value["url"])
            if not result.remote_id or len(result.remote_id) > 512:
                raise ValueError()
            checked_url(result.url, self.config["allowed_hosts"])
            return result
        except (KeyError, TypeError, ValueError):
            raise DeliveryUnknown("Upload returned no usable allowed object reference") from None

    def read(self, url, max_bytes):
        status, mime, body = self._request("GET", url, max_bytes)
        if status != 200:
            raise DeliveryUnknown("Remote image is not readable")
        return mime, body


def validate_image(payload, record, mime="image/webp"):
    if (
        not 1 <= record["width"] <= 8000
        or not 1 <= record["height"] <= 8000
        or record["width"] * record["height"] > 24000000
    ):
        raise ValueError("Image dimensions exceed the public asset limit")
    if mime != "image/webp" or not payload.startswith(b"RIFF") or payload[8:12] != b"WEBP":
        raise ValueError("Not an image/webp file")
    if len(payload) != record["bytes"] or hashlib.sha256(payload).hexdigest() != record["sha256"]:
        raise ValueError("Image hash or size mismatch")
    with Image.open(io.BytesIO(payload)) as image:
        if (
            image.format != "WEBP"
            or image.size != (record["width"], record["height"])
            or getattr(image, "n_frames", 1) != 1
        ):
            raise ValueError("Image dimensions or format mismatch")
        image.load()


class CdnService:
    def __init__(self, data_dir):
        self.root = Path(data_dir)
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.root.chmod(0o700)
        self.path = self.root / "cdn.sqlite3"
        self.lock = threading.RLock()
        with self.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS jobs (
                    id INTEGER PRIMARY KEY, provider_id TEXT NOT NULL, asset_id TEXT NOT NULL,
                    sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
                    file TEXT NOT NULL, archive_path TEXT NOT NULL, source_url TEXT NOT NULL,
                    revision TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
                    error TEXT NOT NULL DEFAULT '', remote_id TEXT, remote_url TEXT,
                    created REAL NOT NULL, updated REAL NOT NULL, verified REAL,
                    UNIQUE(provider_id,asset_id,sha256));
                CREATE TABLE IF NOT EXISTS active_assets (asset_id TEXT PRIMARY KEY, sha256 TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            """)
        os.chmod(self.path, 0o600)
        # Only recover when no live process owns an upload. A second API process
        # may construct this service while the first is actively sending a file.
        with self._runner_slot() as acquired:
            if acquired:
                self._recover_inflight()

    @contextmanager
    def _runner_slot(self):
        with self.lock:
            descriptor = os.open(
                self.root / "cdn-runner.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600
            )
            acquired = False
            try:
                try:
                    fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    acquired = True
                except BlockingIOError:
                    pass
                yield acquired
            finally:
                if acquired:
                    fcntl.flock(descriptor, fcntl.LOCK_UN)
                os.close(descriptor)

    def _recover_inflight(self):
        with self.connect() as db:
            db.execute(
                "UPDATE jobs SET status='unknown',error='Previous upload did not finish locally; manual review required',updated=? WHERE status='uploading'",
                (time.time(),),
            )

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def _config(self):
        path = self.root / "cdn-config.json"
        return json.loads(path.read_text()) if path.exists() else None

    def configure(self, config):
        """Write-only private configuration; no connectivity request is made here."""
        if config is None:
            (self.root / "cdn-config.json").unlink(missing_ok=True)
            return self.config_status()
        allowed = {"upload_url", "allowed_hosts", "token", "timeout_seconds"}
        if set(config) - allowed:
            raise ValueError("Unsupported CDN configuration field")
        hosts = sorted({str(host).lower() for host in config.get("allowed_hosts", [])})
        if (
            not hosts
            or len(hosts) > 20
            or any(not host or "/" in host or ":" in host for host in hosts)
        ):
            raise ValueError("Explicit public host allowlist required")
        timeout = int(config.get("timeout_seconds", 20))
        if not 1 <= timeout <= 60:
            raise ValueError("Timeout must be between 1 and 60 seconds")
        normalized: dict = {
            "upload_url": str(config.get("upload_url", "")),
            "allowed_hosts": hosts,
            "token": str(config.get("token", "")),
            "timeout_seconds": timeout,
        }
        if len(normalized["token"]) > 4096 or any(c in normalized["token"] for c in "\r\n"):
            raise ValueError("Invalid credential")
        checked_url(normalized["upload_url"], hosts)
        identity = hashlib.sha256(json.dumps(normalized, sort_keys=True).encode()).hexdigest()[:24]
        normalized["provider_id"] = identity
        atomic_write(self.root / "cdn-config.json", json.dumps(normalized).encode())
        with self.connect() as db:
            db.execute(
                "UPDATE jobs SET provider_id=?,status='queued',updated=? WHERE provider_id='unconfigured'",
                (identity, time.time()),
            )
        return self.config_status()

    def config_status(self):
        config = self._config()
        return {
            "configured": bool(config),
            "provider_id": config["provider_id"] if config else None,
            "adapter": "generic-http-put" if config else None,
            "credential_configured": bool(config and config["token"]),
            "capabilities": HttpUploadAdapter.capabilities,
            "message": "Configured; remote availability is verified per image"
            if config
            else "CDN not configured; project image URLs remain active",
        }

    def enqueue(self, records, revision):
        config = self._config()
        provider_id = config["provider_id"] if config else "unconfigured"
        now = time.time()
        # Only verified manifest records passed explicitly by the content service enter the queue.
        eligible = []
        for record in records:
            file = PurePosixPath(str(record.get("file", "")))
            if record.get("visibility") != "public":
                continue
            if not any(
                file.is_relative_to(prefix)
                for prefix in ("images-v2", "assets/looks", "assets/model-bases")
            ):
                continue
            if file.suffix != ".webp" or file.is_absolute() or ".." in file.parts:
                raise ValueError("Unsafe public asset path")
            if not re.fullmatch(r"[A-Za-z0-9_-]{1,160}", str(record.get("asset_id", ""))):
                raise ValueError("Invalid public asset identity")
            if not re.fullmatch(r"[a-f0-9]{64}", str(record.get("sha256", ""))):
                raise ValueError("Invalid public asset hash")
            expected = (
                self.root.resolve() / "public-content" / "assets" / f"{record['sha256']}.webp"
            )
            if Path(record.get("archive_path", "")).resolve() != expected:
                raise ValueError("Public asset must come from the content-addressed public archive")
            if record.get("source_url") != "/api/content/assets/" + record["asset_id"]:
                raise ValueError("Invalid public source URL")
            eligible.append(record)
        with self.lock, self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("DELETE FROM active_assets")
            for record in eligible:
                required = (
                    "asset_id",
                    "sha256",
                    "bytes",
                    "width",
                    "height",
                    "file",
                    "archive_path",
                    "source_url",
                )
                if any(key not in record for key in required):
                    raise ValueError("Incomplete validated public asset record")
                if not str(record["source_url"]).startswith("/api/content/assets/"):
                    raise ValueError("Only controlled project public URLs are supported")
                db.execute(
                    "INSERT INTO active_assets VALUES (?,?)", (record["asset_id"], record["sha256"])
                )
                # Preserve previous provider selection on repeat content import/config changes.
                exists = db.execute(
                    "SELECT 1 FROM jobs WHERE asset_id=? AND sha256=?",
                    (record["asset_id"], record["sha256"]),
                ).fetchone()
                if exists:
                    continue
                db.execute(
                    "INSERT INTO jobs (provider_id,asset_id,sha256,bytes,width,height,file,archive_path,source_url,revision,status,created,updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        provider_id,
                        *(record[key] for key in required[:6]),
                        str(record["archive_path"]),
                        record["source_url"],
                        revision,
                        "queued" if config else "unconfigured",
                        now,
                        now,
                    ),
                )
            db.execute("INSERT OR REPLACE INTO metadata VALUES ('revision',?)", (revision,))
        return self.overview()

    def resolve(self, asset_id, source_url):
        with self.connect() as db:
            row = db.execute(
                "SELECT j.remote_url FROM jobs j JOIN active_assets a ON a.asset_id=j.asset_id AND a.sha256=j.sha256 WHERE j.asset_id=? AND j.status='verified' ORDER BY j.verified DESC,j.id DESC LIMIT 1",
                (asset_id,),
            ).fetchone()
        return row["remote_url"] if row else source_url

    def overview(self):
        with self.connect() as db:
            jobs = db.execute(
                "SELECT j.* FROM jobs j JOIN active_assets a ON a.asset_id=j.asset_id AND a.sha256=j.sha256 ORDER BY j.updated DESC,j.id DESC"
            ).fetchall()
            revision = db.execute("SELECT value FROM metadata WHERE key='revision'").fetchone()
        counts = {status: sum(r["status"] == status for r in jobs) for status in STATUSES}
        return {
            "config": self.config_status(),
            "revision": revision[0] if revision else None,
            "counts": counts,
            "total": len(jobs),
            "bytes": sum(r["bytes"] for r in jobs),
            "verified_bytes": sum(r["bytes"] for r in jobs if r["status"] == "verified"),
            "progress": counts["verified"] / len(jobs) if jobs else None,
            "last_success": max((r["verified"] for r in jobs if r["verified"]), default=None),
            "jobs": [
                {
                    key: r[key]
                    for key in (
                        "id",
                        "provider_id",
                        "asset_id",
                        "sha256",
                        "bytes",
                        "revision",
                        "status",
                        "attempts",
                        "error",
                        "updated",
                        "remote_id",
                    )
                }
                for r in jobs[:100]
            ],
        }

    def retry(self, job_id):
        config = self._config()
        with self.connect() as db:
            row = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
            if (
                not row
                or row["status"] != "failed"
                or not config
                or row["provider_id"] != config["provider_id"]
            ):
                raise ValueError(
                    "Only definitive failures for the current provider can be retried; unknown uploads require manual review"
                )
            db.execute(
                "UPDATE jobs SET status='queued',error='',updated=? WHERE id=?",
                (time.time(), job_id),
            )
        return {"queued": True}

    def migrate(self, asset_ids):
        """Explicitly enqueue active public assets on the current provider.

        Existing verified replicas remain selected until each new copy verifies.
        Repeated migration requests preserve unknown/failed state; they do not
        silently retry existing uploads.
        """
        config = self._config()
        if not config:
            raise ValueError("Configure a provider before requesting migration")
        ids = set(asset_ids)
        if not ids or len(ids) > 1000:
            raise ValueError("Select between 1 and 1000 active public assets")
        now = time.time()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            records = db.execute(
                "SELECT j.* FROM jobs j JOIN active_assets a ON a.asset_id=j.asset_id AND a.sha256=j.sha256 ORDER BY j.id DESC"
            ).fetchall()
            latest: dict[str, sqlite3.Row] = {}
            for row in records:
                latest.setdefault(row["asset_id"], row)
            if not ids.issubset(latest):
                raise ValueError("Only active public assets can be migrated")
            inserted = 0
            for asset_id in ids:
                row = latest[asset_id]
                inserted += db.execute(
                    "INSERT OR IGNORE INTO jobs (provider_id,asset_id,sha256,bytes,width,height,file,archive_path,source_url,revision,status,created,updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        config["provider_id"],
                        *(
                            row[key]
                            for key in (
                                "asset_id",
                                "sha256",
                                "bytes",
                                "width",
                                "height",
                                "file",
                                "archive_path",
                                "source_url",
                                "revision",
                            )
                        ),
                        "queued",
                        now,
                        now,
                    ),
                ).rowcount
        return {"queued": inserted}

    def verify_unknown(self, job_id, adapter=None):
        """Recheck an existing object only; never issue another upload."""
        config = self._config()
        with self.connect() as db:
            row = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        if (
            not row
            or row["status"] != "unknown"
            or not row["remote_url"]
            or not config
            or row["provider_id"] != config["provider_id"]
        ):
            raise ValueError(
                "Only a recorded unknown object for the current provider can be verified"
            )
        adapter = adapter or HttpUploadAdapter(config)
        try:
            checked_url(row["remote_url"], config["allowed_hosts"])
            mime, payload = adapter.read(row["remote_url"], min(row["bytes"], MAX_IMAGE_BYTES))
            validate_image(payload, row, mime)
        except Exception:  # noqa: BLE001 - provider boundary; no secret-bearing details returned
            return {"verified": False, "status": "unknown"}
        now = time.time()
        with self.connect() as db:
            db.execute(
                "UPDATE jobs SET status='verified',error='',verified=?,updated=? WHERE id=? AND status='unknown'",
                (now, now, job_id),
            )
        return {"verified": True, "status": "verified"}

    def run_once(self, adapter=None):
        with self._runner_slot() as acquired:
            if not acquired:
                return False
            # A process may have died since this instance was constructed.
            self._recover_inflight()
            try:
                return self._run_once(adapter)
            finally:
                self._recover_inflight()

    def _run_once(self, adapter=None):
        config = self._config()
        if not config:
            return False
        with self.lock, self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT j.* FROM jobs j JOIN active_assets a ON a.asset_id=j.asset_id AND a.sha256=j.sha256 WHERE j.status='queued' AND provider_id=? ORDER BY j.id LIMIT 1",
                (config["provider_id"],),
            ).fetchone()
            if not row:
                return False
            record = dict(row)
            db.execute(
                "UPDATE jobs SET status='uploading',attempts=attempts+1,updated=? WHERE id=?",
                (time.time(), record["id"]),
            )
        adapter = adapter or HttpUploadAdapter(config)
        uploaded = False
        remote = None
        try:
            try:
                path = Path(record["archive_path"])
                expected = (
                    self.root.resolve() / "public-content" / "assets" / f"{record['sha256']}.webp"
                )
                if path.is_symlink() or path.resolve() != expected:
                    raise ValueError("Archive no longer points to a public content object")
                if path.stat().st_size > MAX_IMAGE_BYTES:
                    raise ValueError("Archive too large")
                payload = path.read_bytes()
                validate_image(payload, record)
            except (OSError, ValueError, Image.DecompressionBombError):
                raise CdnFailure("Local public archive failed integrity validation") from None
            remote = adapter.upload(record, payload)
            uploaded = True
            checked_url(remote.url, config["allowed_hosts"])
            # Persist object identity before the separate verification request.
            with self.connect() as db:
                db.execute(
                    "UPDATE jobs SET remote_id=?,remote_url=? WHERE id=?",
                    (remote.remote_id, remote.url, record["id"]),
                )
            mime, body = adapter.read(remote.url, min(record["bytes"], MAX_IMAGE_BYTES))
            validate_image(body, record, mime)
        except Exception as error:  # noqa: BLE001 - provider boundary: redact all failures and never replay uncertain delivery
            status = "failed" if isinstance(error, CdnFailure) and not uploaded else "unknown"
            # Never persist provider exception text, payload or credential-bearing URLs.
            message = (
                "Local archive validation or explicit provider rejection; safe to retry"
                if status == "failed"
                else "Delivery or remote verification is uncertain; manual review required; upload will not replay"
            )
            with self.connect() as db:
                db.execute(
                    "UPDATE jobs SET status=?,error=?,updated=? WHERE id=?",
                    (status, message, time.time(), record["id"]),
                )
            return True
        now = time.time()
        with self.connect() as db:
            db.execute(
                "UPDATE jobs SET status='verified',error='',verified=?,updated=? WHERE id=?",
                (now, now, record["id"]),
            )
        return True
