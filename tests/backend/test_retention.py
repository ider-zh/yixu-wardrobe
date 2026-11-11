from conftest import consent, submit


def test_retained_input_copies_are_removed_before_the_maximum_deadline(setup):
    app, c, h, b, _provider, _detector, clock = setup
    consent(c, h, b)
    job = submit(c, h, b).json()
    # Cleanup scheduling gets a small early margin, never a TTL extension.
    clock.now += 3599.5
    app.state.jobs.purge_inputs()
    assert not list(app.state.jobs.inputs.iterdir())
    assert app.state.jobs.get(job["id"])["status"] == "needs_photo"
