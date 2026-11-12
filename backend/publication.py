"""Publication proof is written by the explicit delivery CLI, never inferred from import."""

import json
import re
from datetime import datetime
from pathlib import Path


def publication_status(data_dir: Path, catalog: dict) -> dict:
    home = catalog.get("home") or {}
    featured_id = home.get("featured_look_id")
    result = {
        "status": "not_verified",
        "revision": catalog.get("revision"),
        "featured_look_id": featured_id,
        "verified_at": None,
        "source_verified": False,
        "static_verified": False,
    }
    receipt_path = data_dir / "publication.json"
    try:
        if receipt_path.is_symlink() or receipt_path.stat().st_size > 16_384:
            return result
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        featured = next(item for item in catalog.get("looks", []) if item["id"] == featured_id)
        asset = featured["versions"]["v2"]["asset"]
        verified_at = receipt.get("verified_at", "")
        datetime.fromisoformat(verified_at)
        valid = (
            receipt.get("schema_version") == 1
            and receipt.get("status") == "verified"
            and receipt.get("revision") == catalog.get("revision")
            and receipt.get("featured_look_id") == featured_id
            and receipt.get("source_sha256") == asset.get("sha256")
            and receipt.get("source_bytes") == asset.get("bytes")
            and receipt.get("static_verified") is True
            and receipt.get("source_verified") is True
            and bool(re.fullmatch(r"[a-f0-9]{64}", receipt.get("source_sha256", "")))
            and bool(re.search(r"(?:Z|[+-]\d\d:\d\d)$", verified_at))
        )
        if valid:
            result.update(
                status="verified",
                verified_at=verified_at,
                source_verified=True,
                static_verified=True,
            )
    except (OSError, ValueError, TypeError, KeyError, StopIteration, AttributeError):
        pass
    return result
