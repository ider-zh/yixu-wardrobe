"""Single durable worker; inference is only performed through the configured adapter."""

import fcntl
import os

from .files import atomic_write, sync_dir
from .images import labelled_webp
from .settings import RuntimeFile

PROMPT_VERSION = "yixu-tryon-v2-anatomy"
PROMPT = (
    "Create one photorealistic virtual try-on with coherent human anatomy. "
    "Image 1 is the only source of person identity: preserve their facial features and "
    "geometry, skin tone, hair, expression and recognizable appearance. Image 2 is an "
    "outfit reference only; never copy its person identity or paste its body underneath "
    "the first person's head. Re-render the outfit completely with its garment details, "
    "realistic fabric, fit, folds, occlusion and consistent lighting. "
    "Reconstruct the neck, shoulders, torso and visible limbs as one coherent body, "
    "keeping the person's body build and a natural head-to-shoulder and head-to-body scale. "
    "Do not mechanically preserve a close-up crop as the body layout: adjust camera distance "
    "and framing when needed to leave enough room for proportionate shoulders and torso. "
    "For an existing full-body view, preserve its body shape and pose rather than "
    "inventing a different physique. Keep the face structurally faithful; never stretch or squash "
    "the face, head or body to fill the output canvas. Avoid an oversized head, undersized "
    "shoulders, a pasted-on face, malformed hands, or duplicate limbs. "
    "Produce one person in one natural portrait photograph, no collage, montage, extra "
    "people or text. This is a consented AI clothing try-on, not a real photograph."
)


class Worker:
    def __init__(self, app):
        self.app = app
        self.jobs = app.state.jobs
        self.store = app.state.store
        self.settings = app.state.settings
        self.clock = self.jobs.clock
        self.lock = None

    def __enter__(self):
        self.lock = open(self.store.root / "worker.lock", "a+b")
        os.chmod(self.store.root / "worker.lock", 0o600)
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self.lock.close()
            self.lock = None
            raise RuntimeError("One worker is already active") from None
        self.recover()
        return self

    def recover(self):
        with self.store.connect() as db:
            db.execute(
                "UPDATE jobs SET status=CASE WHEN cancel_requested=1 THEN 'canceled' ELSE 'unknown' END,error_code='delivery_unknown',error_message='Worker stopped after a possible send; this request will not be replayed' WHERE status IN ('generating','postprocessing')"
            )
        self.jobs.purge_inputs()
        self.drain_gc()
        for path in self.jobs.outputs.glob(".*"):
            path.unlink(missing_ok=True)
        with self.store.connect() as db:
            for path in self.jobs.outputs.glob("*.webp"):
                row = db.execute(
                    "SELECT status,output_bytes FROM jobs WHERE id=?", (path.stem,)
                ).fetchone()
                if not row or row["status"] != "succeeded" or row["output_bytes"] <= 0:
                    path.unlink(missing_ok=True)
            for row in db.execute("SELECT id FROM jobs WHERE output_bytes>0").fetchall():
                if not (self.jobs.outputs / f"{row['id']}.webp").is_file():
                    db.execute(
                        "UPDATE jobs SET status='expired',output_bytes=0,error_code='result_missing',error_message='Generated result is no longer available' WHERE id=?",
                        (row["id"],),
                    )
        sync_dir(self.jobs.outputs)

    def __exit__(self, *args):
        if self.lock:
            self.lock.close()
            self.lock = None

    def drain_gc(self):
        with self.store.connect() as db:
            rows = db.execute("SELECT job_id FROM gc").fetchall()
        for row in rows:
            (self.jobs.outputs / f"{row['job_id']}.webp").unlink(missing_ok=True)
        sync_dir(self.jobs.outputs)
        with self.store.connect() as db:
            db.executemany("DELETE FROM gc WHERE job_id=?", [(r["job_id"],) for r in rows])

    def publish(self, row, data):
        job_id = row["id"]
        stage = self.jobs.outputs / f".stage-{job_id}.webp"
        atomic_write(stage, data)
        # Commit GC intent before touching retained results. Recover after any crash.
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            canceled = db.execute(
                "SELECT cancel_requested FROM jobs WHERE id=?", (job_id,)
            ).fetchone()[0]
            if canceled:
                stage.unlink(missing_ok=True)
                db.execute("UPDATE jobs SET status='canceled' WHERE id=?", (job_id,))
                return
            count = db.execute("SELECT count(*) FROM jobs WHERE output_bytes>0").fetchone()[0]
            old = db.execute(
                "SELECT id FROM jobs WHERE output_bytes>0 ORDER BY published,seq LIMIT ?",
                (max(0, count - 999),),
            ).fetchall()
            for item in old:
                db.execute("INSERT OR IGNORE INTO gc VALUES (?)", (item["id"],))
                db.execute(
                    "UPDATE jobs SET status='expired',output_bytes=0,error_code='result_evicted',error_message='Result removed by latest-1000 FIFO retention' WHERE id=?",
                    (item["id"],),
                )
        self.drain_gc()
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            current = db.execute(
                "SELECT cancel_requested FROM jobs WHERE id=?", (job_id,)
            ).fetchone()
            if current["cancel_requested"]:
                stage.unlink(missing_ok=True)
                db.execute("UPDATE jobs SET status='canceled' WHERE id=?", (job_id,))
                return
            os.replace(stage, self.jobs.outputs / f"{job_id}.webp")
            sync_dir(self.jobs.outputs)
            db.execute(
                "UPDATE jobs SET status='succeeded',output_bytes=?,published=? WHERE id=?",
                (len(data), self.clock(), job_id),
            )

    def finish(self, job_id, status, code, message):
        with self.store.connect() as db:
            db.execute(
                "UPDATE jobs SET status=CASE WHEN cancel_requested=1 THEN 'canceled' ELSE ? END,error_code=?,error_message=? WHERE id=?",
                (status, code, message, job_id),
            )
        self.jobs.drop_inputs(job_id)

    def run_once(self):
        if self.lock is None:
            raise RuntimeError("Use Worker as a context manager")
        self.jobs.purge_inputs()
        provider = self.app.state.provider
        if not self.jobs.available():
            return False
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT * FROM jobs WHERE status='queued' ORDER BY seq LIMIT 1"
            ).fetchone()
            if not row:
                return False
            row = dict(row)
            if row["expires"] <= self.clock():
                return True
            # Persist possible-send BEFORE entering external adapter; never replay this state.
            db.execute("UPDATE jobs SET status='generating' WHERE id=?", (row["id"],))
        try:
            photo = (self.jobs.inputs / f"{row['id']}.photo.png").read_bytes()
            reference = (self.jobs.inputs / f"{row['id']}.reference.png").read_bytes()
        except FileNotFoundError:
            self.finish(row["id"], "needs_photo", "photo_missing", "Original input is unavailable")
            return True
        self.jobs.drop_inputs(row["id"])
        runtime = RuntimeFile(self.store.root).load()
        from .provider import InvalidOutput, ProviderRejected

        # Final cooperative dispatch decision, serialized with DELETE after input
        # loading/removal and runtime loading. Commit is the linearization point:
        # cancellation committed before it wins; after it, delivery is possible.
        # No DB lock spans the provider call. This cannot promise a physical
        # zero-gap between commit and Python scheduling/adapter entry.
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            current = db.execute(
                "SELECT cancel_requested,expires FROM jobs WHERE id=?", (row["id"],)
            ).fetchone()
            if current["cancel_requested"]:
                db.execute("UPDATE jobs SET status='canceled' WHERE id=?", (row["id"],))
                return True
            timeout = min(runtime.provider_timeout_seconds, current["expires"] - self.clock() - 1)
            if timeout <= 0:
                db.execute(
                    "UPDATE jobs SET status='needs_photo',error_code='photo_expired',"
                    "error_message='Original input expired before dispatch' WHERE id=?",
                    (row["id"],),
                )
                return True
            # Keep possible-send durable even if the process dies before entry.
            db.execute("UPDATE jobs SET status='generating' WHERE id=?", (row["id"],))

        try:
            result = provider.generate(
                photo=photo,
                reference=reference,
                prompt=PROMPT,
                runtime=runtime,
                timeout=timeout,
            )
        except ProviderRejected:
            self.finish(
                row["id"],
                "failed",
                "provider_rejected",
                "Provider rejected this generation request",
            )
            return True
        except InvalidOutput:
            self.finish(row["id"], "failed", "invalid_output", "Provider returned an invalid image")
            return True
        except Exception:  # noqa: BLE001 - fail closed; never expose native/provider exceptions
            self.finish(
                row["id"],
                "unknown",
                "delivery_unknown",
                "Provider delivery is uncertain; this request will not be replayed",
            )
            return True
        finally:
            del photo, reference
        with self.store.connect() as db:
            db.execute("UPDATE jobs SET status='postprocessing' WHERE id=?", (row["id"],))
        try:
            output = labelled_webp(
                result,
                self.settings,
                {
                    "job_id": row["id"],
                    "prompt_version": PROMPT_VERSION,
                    "model": runtime.model,
                    "look_id": row["look_id"],
                    "edition": row["edition"],
                    "shot_index": row["shot_index"],
                },
            )
        except Exception:  # noqa: BLE001 - fail closed; never expose native/provider exceptions
            self.finish(row["id"], "failed", "invalid_output", "Provider returned an invalid image")
            return True
        self.publish(row, output)
        return True


def main():
    import argparse
    import signal
    import threading

    from .app import create_app

    parser = argparse.ArgumentParser(description="Yixu single durable worker (no automatic replay)")
    parser.add_argument("--once", action="store_true", help="Reconcile and process at most one job")
    args = parser.parse_args()
    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())
    app = create_app()
    with Worker(app) as worker:
        # Input expiry runs independently even during an external request.
        def cleanup():
            while not stop.wait(0.2):
                worker.jobs.purge_inputs()

        sweeper = threading.Thread(target=cleanup, daemon=True)
        sweeper.start()
        try:
            while not stop.is_set():
                did_work = worker.run_once()
                if args.once:
                    break
                if not did_work:
                    stop.wait(0.2)
        finally:
            stop.set()
            sweeper.join()


if __name__ == "__main__":
    main()
