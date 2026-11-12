import json

import pytest

from backend.publication import publication_status


def catalog():
    return {
        "revision": "a" * 64,
        "home": {"featured_look_id": 101},
        "looks": [
            {
                "id": 101,
                "versions": {"v2": {"asset": {"sha256": "b" * 64, "bytes": 500}}},
            }
        ],
    }


def receipt():
    return {
        "schema_version": 1,
        "status": "verified",
        "revision": "a" * 64,
        "featured_look_id": 101,
        "verified_at": "2026-11-12T08:30:00.000Z",
        "source_sha256": "b" * 64,
        "source_bytes": 500,
        "source_verified": True,
        "static_verified": True,
        "git_head": "c" * 40,
        "private_note": "/private/path/never-export",
    }


def test_receipt_is_not_inferred_from_successful_content_import(tmp_path):
    result = publication_status(tmp_path, catalog())
    assert result["status"] == "not_verified"
    assert not result["source_verified"]
    assert result["featured_look_id"] == 101


def test_verified_receipt_is_sanitized_and_bound_to_current_content(tmp_path):
    (tmp_path / "publication.json").write_text(json.dumps(receipt()))
    result = publication_status(tmp_path, catalog())
    assert result["status"] == "verified"
    assert result["static_verified"] and result["source_verified"]
    assert result["verified_at"] == receipt()["verified_at"]
    assert "private_note" not in result
    assert "git_head" not in result
    assert "private/path" not in json.dumps(result)
    newer = catalog()
    newer["revision"] = "d" * 64
    assert publication_status(tmp_path, newer)["status"] == "not_verified"


@pytest.mark.parametrize(
    "field,value",
    [
        ("featured_look_id", 100),
        ("source_sha256", "d" * 64),
        ("source_bytes", 501),
        ("source_verified", False),
        ("static_verified", False),
        ("verified_at", "not-a-date"),
        ("verified_at", "2026-11-12T08:30:00"),
        ("status", "activation_failed"),
    ],
)
def test_incomplete_or_stale_proof_cannot_claim_publication(tmp_path, field, value):
    record = receipt()
    record[field] = value
    (tmp_path / "publication.json").write_text(json.dumps(record))
    assert publication_status(tmp_path, catalog())["status"] == "not_verified"


def test_malformed_and_symlinked_proof_fail_closed(tmp_path):
    record = tmp_path / "publication.json"
    record.write_text("invalid json")
    assert publication_status(tmp_path, catalog())["status"] == "not_verified"
    record.unlink()
    other = tmp_path / "secret.json"
    other.write_text(json.dumps(receipt()))
    record.symlink_to(other)
    assert publication_status(tmp_path, catalog())["status"] == "not_verified"


def test_public_endpoint_uses_host_boundary_and_returns_no_private_fields(setup):
    app, client, *_ = setup
    response = client.get("/api/content/publication")
    assert response.status_code == 200
    assert response.json()["status"] == "not_verified"
    assert response.headers["cache-control"] == "no-store"
    assert str(app.state.settings.data_dir) not in response.text
    assert (
        client.get("/api/content/publication", headers={"host": "admin.localhost"}).status_code
        == 404
    )
