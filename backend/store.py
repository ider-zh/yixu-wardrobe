"""SQLite state. All opaque browser credentials are stored hashed."""

import hashlib
import secrets
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Literal, get_args

ThemeName = Literal[
    "editorial",
    "studio",
    "contact-sheet",
    "salon-album",
    "wardrobe-index",
    "linen-room",
    "indigo-studio",
    "porcelain-case",
    "night-runway",
    "city-billboard",
    "garden-walk",
    "sunset-notes",
]
THEME_CHECK = f"CHECK(theme IN ({', '.join(map(repr, get_args(ThemeName)))}))"


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
                    status TEXT NOT NULL, look_id INTEGER, look_title TEXT, edition TEXT, shot_index INTEGER,
                    created REAL NOT NULL, expires REAL NOT NULL,
                    cancel_requested INTEGER DEFAULT 0,
                    error_code TEXT, error_message TEXT,
                    output_bytes INTEGER DEFAULT 0, published REAL,
                    verdict TEXT DEFAULT 'unreviewed', notes TEXT DEFAULT '',
                    UNIQUE(owner,idempotency_key));
                CREATE INDEX IF NOT EXISTS queue_order ON jobs(status, seq);
                CREATE INDEX IF NOT EXISTS jobs_owner_order ON jobs(owner, seq);
                CREATE TABLE IF NOT EXISTS event_geo (
                    event_id INTEGER PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
                    country_code TEXT, country_name TEXT, region_code TEXT, region_name TEXT,
                    status TEXT NOT NULL, source TEXT NOT NULL, database_build INTEGER);
                CREATE INDEX IF NOT EXISTS page_events ON events(event,owner,created);
                CREATE TABLE IF NOT EXISTS admin_sessions (
                    token_hash TEXT PRIMARY KEY, csrf TEXT, authenticated INTEGER DEFAULT 0);
            """)
            db.execute("BEGIN IMMEDIATE")
            job_columns = {row["name"] for row in db.execute("PRAGMA table_info(jobs)")}
            if "pose_mode" not in job_columns:
                db.execute("ALTER TABLE jobs ADD COLUMN pose_mode TEXT NOT NULL DEFAULT 'original'")
            if "look_title" not in job_columns:
                db.execute("ALTER TABLE jobs ADD COLUMN look_title TEXT")
            self._migrate_site_preferences(db)
        self.db_path.chmod(0o600)

    @staticmethod
    def _migrate_site_preferences(db: sqlite3.Connection) -> None:
        # Lock before inspecting the schema so concurrent starts see the completed migration.
        schema = db.execute(
            "SELECT sql FROM sqlite_schema WHERE type='table' AND name='site_preferences'"
        ).fetchone()
        if schema and THEME_CHECK in schema["sql"]:
            return
        table = "site_preferences_next" if schema else "site_preferences"
        db.execute(
            f"CREATE TABLE {table} (id INTEGER PRIMARY KEY CHECK(id=1), "
            f"theme TEXT NOT NULL {THEME_CHECK})"
        )
        if schema:
            db.execute("INSERT INTO site_preferences_next SELECT id, theme FROM site_preferences")
            db.execute("DROP TABLE site_preferences")
            db.execute("ALTER TABLE site_preferences_next RENAME TO site_preferences")

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

    def site_theme(self) -> ThemeName:
        with self.connect() as db:
            row = db.execute("SELECT theme FROM site_preferences WHERE id=1").fetchone()
        return row["theme"] if row else "editorial"

    def save_site_theme(self, theme: ThemeName) -> None:
        with self.connect() as db:
            db.execute(
                "INSERT INTO site_preferences (id,theme) VALUES (1,?) "
                "ON CONFLICT(id) DO UPDATE SET theme=excluded.theme",
                (theme,),
            )

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
