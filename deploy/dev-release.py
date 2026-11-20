#!/usr/bin/env python3
"""Owned-host dev delivery. Repo commands run as yixu-dev, never root.

Installed copy is root-owned outside releases. No production paths or credentials.
"""

import argparse
import datetime
import fcntl
import hashlib
import json
import os
import pwd
import re
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path("/srv/yixu-wardrobe-dev")
STATE = Path("/var/lib/yixu-dev-deploy")
DATA = Path("/var/lib/yixu-wardrobe-dev")
USER = "yixu-dev"
UNIT = "yixu-dev-api.service"
DOMAIN = "dev-yixu.8882088.xyz"
REPO = "https://github.com/ider-zh/yixu-wardrobe.git"
NODE = "/opt/yixu-dev-node/bin/node"
DOWNLOAD_PROXY = None
ENV = {
    "PATH": "/opt/yixu-dev-node/bin:/usr/local/bin:/usr/bin:/bin",
    "HOME": "/var/lib/yixu-wardrobe-dev",
    "LANG": "C.UTF-8",
    "UV_CACHE_DIR": "/var/cache/yixu-dev",
    "UV_PYTHON_DOWNLOADS": "never",
    "PYTHONDONTWRITEBYTECODE": "1",
    "OMP_NUM_THREADS": "1",
    "OPENBLAS_NUM_THREADS": "1",
}


def write_json(path, value, owner=None):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix=".receipt-", dir=path.parent)
    try:
        if owner is not None:
            os.fchown(fd, *owner)
        with os.fdopen(fd, "w") as out:
            json.dump(value, out, indent=2)
            out.write("\n")
            out.flush()
            os.fsync(out.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def configure_transport():
    global DOWNLOAD_PROXY
    config = Path("/etc/yixu-wardrobe-dev/deploy.json")
    if not config.exists():
        return
    value = json.loads(config.read_text()).get("download_proxy")
    if not value:
        return
    parsed = urllib.parse.urlsplit(value)
    if (
        parsed.scheme != "http"
        or parsed.hostname != "127.0.0.1"
        or not parsed.port
        or parsed.username
        or parsed.password
        or parsed.path not in ("", "/")
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("Development download proxy must be an explicit loopback HTTP URL")
    DOWNLOAD_PROXY = value
    ENV.update(HTTPS_PROXY=value, HTTP_PROXY=value, NO_PROXY="127.0.0.1,localhost,::1")


def run(args, *, cwd=None):
    args = list(map(str, args))
    if DOWNLOAD_PROXY and args[0] == "/usr/bin/git":
        args[1:1] = ["-c", "http.proxy=" + DOWNLOAD_PROXY]
    completed = subprocess.run(
        ["/usr/sbin/runuser", "-u", USER, "--", *map(str, args)],
        cwd=cwd,
        env=ENV,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=900,
        check=False,
    )
    with (STATE / "build.log").open("ab") as log:
        log.write(completed.stdout)
    if completed.returncode:
        raise RuntimeError("Development build command failed; inspect private build.log")
    return completed.stdout.decode().strip()


def get(url, host=None):
    headers = {"User-Agent": "yixu-dev-deployment", "Cache-Control": "no-cache"}
    if host:
        headers["Host"] = host
    proxy = (
        DOWNLOAD_PROXY
        if urllib.parse.urlsplit(url).hostname not in ("127.0.0.1", "localhost")
        else None
    )
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({"http": proxy, "https": proxy} if proxy else {})
    )
    with opener.open(urllib.request.Request(url, headers=headers), timeout=20) as response:
        return response.read()


def ci_succeeded(sha):
    query = urllib.parse.urlencode(
        {"branch": "dev", "event": "push", "head_sha": sha, "per_page": 10}
    )
    runs = json.loads(
        get(
            "https://api.github.com/repos/ider-zh/yixu-wardrobe/"
            "actions/workflows/check.yml/runs?" + query
        )
    )["workflow_runs"]
    matches = [
        r
        for r in runs
        if r.get("head_sha") == sha and r.get("head_branch") == "dev" and r.get("event") == "push"
    ]
    if not matches:
        return False
    latest = max(matches, key=lambda r: r["id"])
    return latest.get("status") == "completed" and latest.get("conclusion") == "success"


def snapshot(release):
    text = (release / "public/catalog.js").read_text()
    match = re.fullmatch(r"window\.WARDROBE = ([\s\S]+);\s*", text)
    if not match:
        raise RuntimeError("Invalid candidate content snapshot")
    return json.loads(match[1])


def verify(release, origin):
    catalog = snapshot(release)
    health = json.loads(get("http://127.0.0.1:8766/api/health", DOMAIN))
    if health.get("ok") is not True or health.get("provider_configured") is not False:
        raise RuntimeError("Development API is unhealthy or unexpected generation is enabled")
    actual = json.loads(get("http://127.0.0.1:8766/api/content/catalog", DOMAIN))
    if actual.get("revision") != catalog["revision"] or actual.get("home") != catalog["home"]:
        raise RuntimeError("API and development snapshot differ")
    # Never select /api/admin from an unauthenticated cookie; its protection is a gate.
    try:
        get("http://127.0.0.1:8766/api/admin/overview", DOMAIN)
        raise RuntimeError("Development administrator endpoint lacks authentication")
    except urllib.error.HTTPError as error:
        if error.code != 401:
            raise
    checks = [
        ("public/" + name, "/" + ("" if name == "index.html" else name))
        for name in [
            "index.html",
            "app.js",
            "catalog.js",
            "style.css",
            "expressive.css",
            "tryon.js",
            "tryon.css",
            "product-themes.js",
            "product-page.js",
            "product-themes.css",
            "favicon.svg",
        ]
    ]
    checks += [
        ("admin/" + name, "/admin/" + name) for name in ["index.html", "app.mjs", "admin.css"]
    ]
    for local, remote in checks:
        data = get(origin.rstrip("/") + remote, DOMAIN)
        if hashlib.sha256(data).digest() != hashlib.sha256((release / local).read_bytes()).digest():
            raise RuntimeError("Development static file is stale: " + remote)
    featured = next(
        look for look in actual["looks"] if look["id"] == actual["home"]["featured_look_id"]
    )
    asset = featured["versions"]["v2"]["asset"]
    source = featured["source_url"]
    if not isinstance(source, str) or not re.fullmatch(
        r"/api/content/assets/[A-Za-z0-9_-]{1,160}", source
    ):
        raise RuntimeError("Development featured source URL is outside the owned API")
    image = get("http://127.0.0.1:8766" + source, DOMAIN)
    if len(image) != asset["bytes"] or hashlib.sha256(image).hexdigest() != asset["sha256"]:
        raise RuntimeError("Development featured resource differs")
    return {
        "revision": catalog["revision"],
        "featured_look_id": catalog["home"]["featured_look_id"],
        "static_files_verified": len(checks),
        "source_verified": True,
        "source_sha256": asset["sha256"],
        "source_bytes": asset["bytes"],
        "static_verified": True,
        "admin_auth_verified": True,
    }


def switch_current(release):
    release = Path(release)
    if (
        release.parent != ROOT / "releases"
        or not re.fullmatch("[a-f0-9]{40}", release.name)
        or release.is_symlink()
        or (ROOT / "releases").is_symlink()
    ):
        raise ValueError("Only an immutable development release may be activated")
    temporary = ROOT / ".current-next"
    temporary.unlink(missing_ok=True)
    temporary.symlink_to(release)
    os.replace(temporary, ROOT / "current")


def restart():
    subprocess.run(["/usr/bin/systemctl", "restart", UNIT], check=True, timeout=60)


def build(sha):
    release = ROOT / "releases" / sha
    if release.exists():
        raise RuntimeError("Candidate already exists; inspect it before removing or retrying")
    release.mkdir(mode=0o755)
    account = pwd.getpwnam(USER)
    os.chown(release, account.pw_uid, account.pw_gid)
    archive = subprocess.Popen(
        [
            "/usr/sbin/runuser",
            "-u",
            USER,
            "--",
            "/usr/bin/git",
            "--git-dir=" + str(ROOT / "repository.git"),
            "archive",
            sha,
        ],
        env=ENV,
        stdout=subprocess.PIPE,
    )
    try:
        subprocess.run(
            ["/usr/sbin/runuser", "-u", USER, "--", "/usr/bin/tar", "-xf", "-", "-C", str(release)],
            stdin=archive.stdout,
            env=ENV,
            check=True,
            timeout=120,
        )
    finally:
        archive.stdout.close()
    if archive.wait(timeout=30):
        raise RuntimeError("Candidate export failed")
    run(["/usr/local/bin/uv", "sync", "--locked", "--python", "/usr/bin/python3"], cwd=release)
    run([NODE, "scripts/check.mjs"], cwd=release)
    run([NODE, "qa/regression-expressive.mjs"], cwd=release)
    run([NODE, "scripts/build.mjs"], cwd=release)
    run([release / ".venv/bin/python", "-m", "pytest", "tests/backend", "-q"], cwd=release)
    # Fail on unsafe coarse-geography or same-origin boundaries through the normal suite.
    snapshot(release)
    return release


def deliver(origin, retry=False):
    repo = ROOT / "repository.git"
    if not (repo / "HEAD").exists():
        repo.mkdir(mode=0o755, exist_ok=True)
        account = pwd.getpwnam(USER)
        os.chown(repo, account.pw_uid, account.pw_gid)
        run(["/usr/bin/git", "init", "--bare", repo])
        run(["/usr/bin/git", "--git-dir=" + str(repo), "remote", "add", "origin", REPO])
    run(
        [
            "/usr/bin/git",
            "--git-dir=" + str(repo),
            "fetch",
            "--depth=1",
            "--no-tags",
            "origin",
            "refs/heads/dev",
        ]
    )
    sha = run(["/usr/bin/git", "--git-dir=" + str(repo), "rev-parse", "FETCH_HEAD"])
    if not re.fullmatch("[a-f0-9]{40}", sha):
        raise RuntimeError("Invalid development Git identity")
    receipt_path = STATE / "deployment.json"
    previous = json.loads(receipt_path.read_text()) if receipt_path.exists() else {}
    if previous.get("git_head") == sha and previous.get("status") == "verified":
        print("Development release is already verified: " + sha)
        return
    if previous.get("git_head") == sha and previous.get("status") == "failed" and not retry:
        print("Development release needs manual review; unchanged failed SHA is not retried")
        return
    if not ci_succeeded(sha):
        print("Waiting for successful dev push CI: " + sha)
        return
    old = (ROOT / "current").resolve() if (ROOT / "current").exists() else None
    switched = False
    try:
        release = build(sha)
        switch_current(release)
        switched = True
        restart()
        result = None
        for attempt in range(15):
            try:
                result = verify(release, origin)
                break
            except (OSError, ValueError, RuntimeError):
                if attempt == 14:
                    raise
                time.sleep(1)
        receipt = {
            "status": "verified",
            "git_head": sha,
            "verified_at": datetime.datetime.now(datetime.UTC).isoformat(),
            **result,
        }
        account = pwd.getpwnam(USER)
        publication = {
            key: receipt[key]
            for key in (
                "status",
                "git_head",
                "verified_at",
                "revision",
                "featured_look_id",
                "source_sha256",
                "source_bytes",
                "source_verified",
                "static_verified",
            )
        }
        publication["schema_version"] = 1
        write_json(DATA / "publication.json", publication, owner=(account.pw_uid, account.pw_gid))
        write_json(receipt_path, receipt)
        print(json.dumps(receipt))
    except Exception:
        if switched and old:
            switch_current(old)
            restart()
        elif switched:
            subprocess.run(["/usr/bin/systemctl", "stop", UNIT], check=False, timeout=60)
        write_json(
            receipt_path,
            {
                "status": "failed",
                "git_head": sha,
                "previous_release_restored": bool(switched and old),
                "private_database_rolled_back": False,
                "checked_at": datetime.datetime.now(datetime.UTC).isoformat(),
            },
        )
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--origin", default="https://" + DOMAIN, choices=["https://" + DOMAIN, "http://127.0.0.1"]
    )
    parser.add_argument(
        "--retry",
        action="store_true",
        help="Retry a reviewed failure after removing its failed candidate",
    )
    options = parser.parse_args()
    configure_transport()
    if os.geteuid() != 0:
        parser.error("Installed controller requires root; repository commands run only as yixu-dev")
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(STATE, 0o700)
    with (STATE / "release.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        deliver(options.origin, options.retry)


if __name__ == "__main__":
    main()
