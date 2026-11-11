"""SQLite state. All opaque browser credentials are stored hashed."""

import hashlib
import secrets
import sqlite3
from contextlib import contextmanager
from pathlib import Path


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


class Store:
    def __init__(self, root: Path):
        self.root = root
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        root.chmod(0o700)
        self.db_path = root / "state.sqlite3"
        with self.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS visitors (
                    id TEXT PRIMARY KEY, token_hash TEXT UNIQUE, csrf TEXT, accepted TEXT);
                CREATE TABLE IF NOT EXISTS administrator (
                    id INTEGER PRIMARY KEY CHECK(id=1), username TEXT, password_hash TEXT);
                CREATE TABLE IF NOT EXISTS gc (job_id TEXT PRIMARY KEY);
                CREATE TABLE IF NOT EXISTS events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL,
                    event_id TEXT NOT NULL, event TEXT NOT NULL,
                    look_id INTEGER, edition TEXT, shot_index INTEGER, created REAL NOT NULL,
                    UNIQUE(owner,event_id));
                CREATE TABLE IF NOT EXISTS jobs (
                    seq INTEGER PRIMARY KEY AUTOINCREMENT,
                    id TEXT UNIQUE NOT NULL, owner TEXT NOT NULL,
                    idempotency_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
                    status TEXT NOT NULL, look_id INTEGER, edition TEXT, shot_index INTEGER,
                    created REAL NOT NULL, expires REAL NOT NULL,
                    cancel_requested INTEGER DEFAULT 0,
                    error_code TEXT, error_message TEXT,
                    output_bytes INTEGER DEFAULT 0, published REAL,
                    verdict TEXT DEFAULT 'unreviewed', notes TEXT DEFAULT '',
                    UNIQUE(owner,idempotency_key));
                CREATE INDEX IF NOT EXISTS queue_order ON jobs(status, seq);
                CREATE TABLE IF NOT EXISTS admin_sessions (
                    token_hash TEXT PRIMARY KEY, csrf TEXT, authenticated INTEGER DEFAULT 0);
            """)
        self.db_path.chmod(0o600)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.db_path, timeout=30)
        db.row_factory = sqlite3.Row
        try:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("PRAGMA foreign_keys=ON")
            with db:
                yield db
        finally:
            db.close()

    def visitor(self, token: str | None):
        with self.connect() as db:
            if token:
                row = db.execute(
                    "SELECT * FROM visitors WHERE token_hash=?", (digest(token),)
                ).fetchone()
                if row:
                    return dict(row), None
            token = secrets.token_urlsafe(32)
            row = {
                "id": secrets.token_hex(16),
                "token_hash": digest(token),
                "csrf": secrets.token_urlsafe(32),
                "accepted": None,
            }
            db.execute("INSERT INTO visitors VALUES (:id,:token_hash,:csrf,:accepted)", row)
            return row, token
