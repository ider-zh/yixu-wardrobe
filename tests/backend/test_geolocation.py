import sqlite3
from types import SimpleNamespace

from fastapi.testclient import TestClient
from test_admin import login

from backend.geolocation import GeoLocator
from backend.store import Store


def reader_fixture(tmp_path, monkeypatch, record):
    path = tmp_path / "city.mmdb"
    path.write_bytes(b"database revision one")
    reader = SimpleNamespace(
        get=lambda ip: record, close=lambda: None, metadata=lambda: SimpleNamespace(build_epoch=123)
    )
    monkeypatch.setattr("backend.geolocation.maxminddb.open_database", lambda _: reader)
    return GeoLocator(path)


def test_china_subdivision_only_no_city_inference(tmp_path, monkeypatch):
    record = {
        "country": {"iso_code": "CN", "names": {"en": "China"}},
        "subdivisions": [{"names": {"en": "Zhejiang"}}],
        "city": {"names": {"en": "Hangzhou"}},
        "location": {"latitude": 30},
    }
    geo = reader_fixture(tmp_path, monkeypatch, record)
    assert geo.lookup("223.5.5.5") == {
        "country_code": "CN",
        "country_name": "中国",
        "region_code": None,
        "region_name": "浙江省",
        "source": "DB-IP City Lite",
        "database_build": 123,
        "status": "located",
    }
    record.pop("subdivisions")
    result = geo.lookup("223.5.5.5")
    assert result["country_code"] == "CN" and result["region_name"] is None
    assert "city" not in result and "location" not in result
    geo.close()


def test_ipv6_country_only_and_unsafe_input_never_lookup(tmp_path, monkeypatch):
    record = {
        "country": {"iso_code": "US", "names": {"zh-CN": "美国"}},
        "subdivisions": [{"names": {"en": "California"}}],
    }
    geo = reader_fixture(tmp_path, monkeypatch, record)
    assert geo.lookup("2001:4860:4860::8888")["country_code"] == "US"
    assert geo.lookup("::ffff:8.8.8.8")["country_code"] == "US"
    assert geo.lookup("8.8.8.8")["region_name"] is None
    geo.reader.get = lambda _: (_ for _ in ()).throw(AssertionError("must not lookup"))
    for ip in ("127.0.0.1", "10.0.0.1", "::1", "fe80::1", "::ffff:192.168.1.1", "192.0.2.1"):
        assert geo.lookup(ip)["status"] == "private"
    for ip in ("testclient", "8.8.8.8, 1.1.1.1", None):
        assert geo.lookup(ip)["status"] == "unknown"
    geo.close()


def test_missing_corrupt_database_and_atomic_replacement(tmp_path, monkeypatch):
    path = tmp_path / "city.mmdb"
    geo = GeoLocator(path)
    assert geo.info()["status"] == "unconfigured"
    assert geo.lookup("8.8.8.8")["status"] == "unavailable"
    path.write_bytes(b"not a database")
    assert geo.info()["status"] == "unavailable"
    assert geo.lookup("8.8.8.8")["country_code"] is None
    reader_fixture(tmp_path, monkeypatch, {"country": {"iso_code": "US"}})
    assert geo.info()["status"] == "ready"
    assert geo.lookup("8.8.8.8")["status"] == "located"
    path.unlink()
    assert geo.info()["status"] == "unconfigured" and geo.reader is None


def test_private_geo_admin_only_deduplicated_and_untrusted_headers_ignored(setup, monkeypatch):
    app, client, headers, _b, _p, _d, _clock = setup
    seen = []

    def lookup(host):
        seen.append(host)
        return {
            "country_code": "CN",
            "country_name": "中国",
            "region_code": None,
            "region_name": "浙江省",
            "status": "located",
            "source": "DB-IP City Lite",
            "database_build": 123,
        }

    monkeypatch.setattr(app.state.geolocation, "lookup", lookup)
    spoofed = {
        **headers,
        "X-Forwarded-For": "8.8.8.8",
        "CF-IPCountry": "US",
        "X-Real-IP": "8.8.8.8",
    }
    for _ in range(2):
        response = client.post(
            "/api/events", headers=spoofed, json={"event": "page_view", "event_id": "same-event"}
        )
        assert response.json() == {"accepted": True}
    assert seen == ["testclient"]
    assert client.get("/api/admin/overview").status_code == 404
    assert "visitor_geo" not in client.get("/api/bootstrap").json()
    with app.state.store.connect() as db:
        db.execute(
            "INSERT INTO events(owner,event_id,event,created) VALUES(?,?,?,?)",
            ("old-browser", "historical", "page_view", 100),
        )
        assert db.execute("SELECT count(*) FROM event_geo").fetchone()[0] == 1
        assert not any("ip" in r[1] for r in db.execute("PRAGMA table_info(event_geo)"))
    with TestClient(app, base_url="https://admin.localhost") as admin:
        assert admin.get("/api/admin/overview").status_code == 401
        login(admin, app.state.settings.data_dir)
        geo = admin.get("/api/admin/overview").json()["visitor_geo"]
        assert geo["total_visitors"] == 2 and geo["total_page_views"] == 2
        assert geo["china_provinces"] == [
            {"region_code": None, "region_name": "浙江省", "visits": 1, "visitors": 1}
        ]
        assert sorted(x["visits"] for x in geo["countries"]) == [1, 1]
        assert {x["status"] for x in geo["recent_visitors"]} == {"located", "legacy"}
        assert "8.8.8.8" not in str(geo)


def test_additive_schema_preserves_legacy_events(tmp_path):
    with sqlite3.connect(tmp_path / "state.sqlite3") as db:
        db.execute(
            "CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, "
            "event_id TEXT NOT NULL,event TEXT NOT NULL,look_id INTEGER,edition TEXT,"
            "shot_index INTEGER,created REAL NOT NULL,UNIQUE(owner,event_id))"
        )
        db.execute(
            "INSERT INTO events(owner,event_id,event,created) VALUES('old','old','page_view',1)"
        )
    store = Store(tmp_path)
    Store(tmp_path)
    with store.connect() as db:
        assert db.execute("SELECT count(*) FROM events").fetchone()[0] == 1
        assert db.execute("SELECT count(*) FROM event_geo").fetchone()[0] == 0


def test_same_origin_admin_still_requires_auth_and_csrf(setup):
    import json
    from dataclasses import replace

    from backend.app import create_app

    app, _c, _h, _b, provider, detector, clock = setup
    same = create_app(
        replace(app.state.settings, admin_host="localhost"),
        provider=provider,
        detector=detector,
        clock=clock,
    )
    with TestClient(same, base_url="https://localhost") as client:
        assert client.get("/api/health").status_code == 200
        assert client.get("/api/admin/overview").status_code == 401
        bootstrap = client.get("/api/admin/bootstrap")
        assert "Path=/api/admin" in bootstrap.headers["set-cookie"]
        credentials = json.loads((same.state.settings.data_dir / "initial-admin.json").read_text())
        assert (
            client.post(
                "/api/admin/login",
                json=credentials,
                headers={
                    "Origin": "https://localhost",
                    "X-CSRF-Token": bootstrap.json()["csrf_token"],
                },
            ).status_code
            == 200
        )
        assert client.get("/api/admin/overview").status_code == 200
        assert (
            client.post("/api/admin/logout", headers={"Origin": "https://evil.example"}).status_code
            == 403
        )
        assert client.get("/api/health", headers={"Host": "evil.example"}).status_code == 421
