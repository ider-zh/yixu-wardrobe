# Yixu private API and single worker

## Run

From the repository root, install the exact locked official dependencies:

```sh
uv sync --locked
# Set these to operator-owned private/runtime locations, outside the public tree:
export YIXU_DATA_DIR=/path/to/private/yixu
export YIXU_CATALOG_PATH=/path/to/runtime/catalog.json
export YIXU_IMAGE_ROOT=/path/to/site
export YIXU_FACE_MODEL=/path/to/models/yunet.onnx
export YIXU_PUBLIC_HOST=www.8882088.xyz
export YIXU_ADMIN_HOST=admin.8882088.xyz
export YIXU_SECURE_COOKIES=true
uv run uvicorn backend.app:create_app --factory --host 127.0.0.1 --port 8010 --workers 1 --no-access-log
# Separate service, same environment and data directory:
uv run python -m backend.worker
# Reconcile and process at most one eligible job, then exit:
uv run python -m backend.worker --once
```

The factory also supports `create_app(settings, provider=None, detector=None, clock=None)`.
Imports never initialize storage or credentials. Deliberate app creation initializes
SQLite/WAL and creates `initial-admin.json` only if no administrator exists. This
private first-initialization file is 0600 beneath a 0700 directory; read it locally
as operator, never print it in deployment logs. Passwords in SQLite are Argon2 hashes.
Restarts do not reset credentials; password changes invalidate all admin sessions.
Login's authoritative hash read, password verification and session creation share
an SQLite write transaction with rotation. A login that commits first is revoked
by rotation; one that verifies after rotation cannot use the old password.
Incorrect `current_password` returns **403 / `current_password`**, preserving the
valid admin session; missing/revoked authentication and invalid login credentials
remain **401 / `admin_auth`**.
The initial file remains unchanged after password rotation (it is a bootstrap
receipt, not an active password store). Operators may remove it after recording
credentials securely; existing admin credentials are not recreated.

Nginx must preserve the configured Host and forward the original scheme only from
a trusted loopback proxy. Roles are bound to the **exact** configured Host header;
for direct development on a non-default port configure the host including that
port, or send an explicit Host header. Secure cookies default true; opt into
`YIXU_SECURE_COOKIES=false` for loopback HTTP development only. No wildcard CORS,
parent-domain cookies, public accounts, or default persistent cookie lifetime.
Visitor/admin cookies differ and every mutation requires exact Origin and CSRF.

`YIXU_CATALOG_PATH` accepts the raw exported WARDROBE JSON: `looks[].id`,
`looks[].versions.v1/v2.image` are used, relative to `YIXU_IMAGE_ROOT`.
Visitors cannot choose a filesystem path, URL, model or prompt. The chosen 3x3
panel is cropped before storage/dispatch; the full montage is never an input.

## Provider and detector

Configure model, HTTPS API base, enabled flag, project API key, and explicit
loopback HTTP proxy through authenticated admin settings. Keys never appear in
settings responses. Empty `api_key` preserves the current key; `clear_api_key:true`
explicitly clears it. Runtime JSON writes are same-filesystem atomic, fsynced and
0600. No assistant/CLI auth or ambient OpenAI/proxy environment is used. There is
no direct-connection fallback. Missing provider key, detector or catalog is
reported as unavailable; production has no placeholder or fake-success image.

The official OpenAI SDK uses image edits with two PNG inputs, `n=1`, default
portrait `1024x1536`, `medium`, explicit transport, no redirects and
`max_retries=0`. Model/size/quality and provider transport timeout are admin
configurable. The Linux worker main thread enforces a total wall-clock timeout,
not merely socket inactivity; it never retries uncertain deliveries. This is a
technical request/input-retention bound, not a queue waiting deadline or quota.

The operator supplies an official YuNet ONNX model and license. Initialization
runs real blank-image inference before claiming readiness. Local validation
rejects malformed/animated/unsupported, oversized/pixel-bomb, no-face, multiple-face
and too-small-face photos; corrects orientation and strips source metadata.
Detection runs locally on CPU with bounded resized dimensions.

## State, privacy and recovery

SQLite is the accepted queue. Request content/selection is frozen, owner-scoped
and idempotent; same key with changed bytes/selection returns 409. There is **no**
application generation-count, money, IP, daily, rate or arbitrary queue-length
gate, CAPTCHA, invitation code, five-minute queue deadline or output age expiry.
A single worker is enforced with a process-held flock, not a short lease that
could accidentally replay an active call. Existing identical retries return their
existing job (202), and conflicting retries return 409 even if inference readiness
has since disappeared. Genuinely new unavailable submissions return 503 before
image validation, input persistence or queue insertion; their multipart bytes are
only received under the normal bounded in-memory upload parser.

Raw reception stays in bounded memory (no multipart disk spool). Only normalized
photo and cropped reference inputs are privately staged. Input expiry is measured
from server request receipt, including parsing/validation and queued/failed paths.
API lifespan and worker sweeps run independently of traffic. A one-second early
cleanup margin accommodates the 200ms sweep interval; no raw retention extension
is granted. Both services must be supervised: no stopped process can physically
delete disk data while the machine/services remain down; startup sweeps immediately.
Inputs are removed **before** the external request, and the in-memory request is
bounded by remaining input lifetime. Expired unsent work becomes `needs_photo`,
not an automatic paid retry. A new explicit submission is required; in-place
photo replacement is intentionally not implemented (the contract makes it optional).

Possible-send states are persisted before entering the adapter. On worker restart,
`generating`/`postprocessing` become `unknown` and are never replayed. Definitive
provider rejections and invalid output are `failed`; uncertain delivery is
`unknown`. Canceling an executing call records cancellation and discards its
result without another request. Valid unsent queued work resumes.

After loading/removing inputs and loading runtime settings, the worker makes a
final cancellation/expiry decision in a short SQLite write transaction shared
with DELETE. Its commit is the cooperative dispatch linearization point: a
cancellation committed before this decision prevents adapter entry. After that
commit delivery is possible, even before Python schedules adapter entry. There
is no promise of a physical zero-gap, and no database lock is held during network
generation; DELETE remains available and canceled results are not published.
Possible-send recovery stays conservative even for a crash before adapter entry.

Results are fully decoded and privately re-encoded WebP with a visible AI label
and XMP provenance (job/selection/prompt version/model only). Same-filesystem
staging, fsync, durable SQLite GC intent and startup reconciliation recover
publication/eviction crashes. Global publication evicts oldest before publishing
the 1001st result; output retention is FIFO latest 1000, without a time TTL.
Public image/download APIs require the owner; admin result APIs expose generated
outputs only, never originals. Reviews are optional metadata, not a generation gate.

First-party analytics accept only `page_view`, `look_open`, `tryon_open` and a
small typed selection/event-id schema; no raw IP, UA, query, filename, photo or
credential fields. Event IDs deduplicate per visitor. Overview generation/queue,
status, bytes and retained-result counts come from server SQLite state, not
client claims. Unreviewed results are available normally.

## Technical environment controls

- Required production paths/hosts: `YIXU_DATA_DIR`, `YIXU_CATALOG_PATH`,
  `YIXU_IMAGE_ROOT`, `YIXU_FACE_MODEL`, `YIXU_PUBLIC_HOST`, `YIXU_ADMIN_HOST`.
- `YIXU_SECURE_COOKIES` defaults true.
- `YIXU_COOKIE_MAX_AGE` is optional; unset means session cookies (no one-year default).
- Non-upload POST/PUT/PATCH bodies have a fixed 65536-byte technical JSON parsing
  bound enforced at ASGI receive before authentication/body parsing, independent
  of Content-Length (including unknown-length/chunked streams). Oversize bodies
  return 413 / `json_too_large`; bounded buffering stops at the first excess chunk.
  `/api/tryons` instead retains its authenticated multipart upload-byte bound.
- `YIXU_MAX_UPLOAD_BYTES` defaults 12582912; `YIXU_MAX_PIXELS` 24000000;
  `YIXU_MAX_IMAGE_DIMENSION` 8000.
- `YIXU_IMAGE_CONCURRENCY` defaults 1: local reception/validation backpressure,
  not a per-user or accepted-generation quota. Run one API worker on the small host.
- `YIXU_FACE_MIN_PIXELS` 40; `YIXU_FACE_MIN_FRACTION` 0.025;
  `YIXU_DETECTOR_SCORE_THRESHOLD` 0.85.

## Verify, without paid calls

```sh
uv run pytest tests/backend -q
# Also exercise real YuNet with an operator-supplied official model and public reference panel:
YIXU_TEST_FACE_MODEL=/path/to/models/yunet.onnx uv run pytest tests/backend -q
uv run ruff check backend tests/backend
uv run ruff format --check backend tests/backend
uv run mypy backend
uv run python -m compileall -q backend tests/backend
```

Tests inject fake generation only at the documented provider seam. The real SDK is
also exercised via controlled HTTP transport and a real local CONNECT proxy; no
paid provider call is made. Recovery includes a real SIGKILL after possible-send,
real TCP uvicorn factory startup/shutdown, FIFO 1001 boundary, session/host/CSRF
separation, metadata/face gates, idle TTL, cancellation races and settings redaction.
`provider.generate` receives keyword `photo:bytes`, `reference:bytes`, `prompt:str`,
`runtime:Runtime`, `timeout:float` and returns encoded image bytes; detector has
`ready:bool` and `detect(PIL.Image)` returning face `(x,y,width,height)` tuples;
clock is a zero-argument timestamp callable. There are no production fake classes.
