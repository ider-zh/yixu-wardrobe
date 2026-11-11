from conftest import consent, picture, submit

from backend.worker import Worker


def test_canceled_output_does_not_evict_a_retained_result(setup):
    app, c, h, b, _provider, _detector, clock = setup
    consent(c, h, b)
    data = picture(format="WEBP")
    with app.state.store.connect() as db:
        for n in range(1000):
            identifier = f"{n:032x}"
            db.execute(
                "INSERT INTO jobs (id,owner,idempotency_key,fingerprint,status,look_id,edition,shot_index,created,expires,output_bytes,published) VALUES (?,?,?,?,'succeeded',1,'v1',1,?,?,?,?)",
                (
                    identifier,
                    b["visitor"]["id"],
                    identifier,
                    "fixture",
                    clock(),
                    clock() + 3600,
                    len(data),
                    clock() + n,
                ),
            )
            (app.state.jobs.outputs / (identifier + ".webp")).write_bytes(data)
    canceled = submit(c, h, b, key="cancel-publish-01").json()
    with app.state.store.connect() as db:
        db.execute(
            "UPDATE jobs SET status='postprocessing',cancel_requested=1 WHERE id=?",
            (canceled["id"],),
        )
    # Exercise publication's cancellation race without recovery changing the row.
    worker = Worker(app)
    worker.publish(app.state.jobs.get(canceled["id"]), data)
    assert len(list(app.state.jobs.outputs.glob("*.webp"))) == 1000
    assert c.get("/api/tryons/" + "0" * 32 + "/image").status_code == 200
    assert app.state.jobs.get(canceled["id"])["status"] == "canceled"
