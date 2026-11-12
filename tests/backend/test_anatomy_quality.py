"""Try-on rendering policy, using only isolated test state and transports."""

import io

from conftest import consent, submit
from PIL import Image

from backend.settings import Runtime


def test_new_runtime_defaults_to_high_rendering_quality_without_overriding_operator_choice():
    assert Runtime().quality == "high"
    assert Runtime(quality="medium").quality == "medium"


def test_worker_requests_coherent_anatomical_redraw_and_versions_generated_provenance(setup):
    from backend.worker import Worker

    app, client, headers, bootstrap, provider, _detector, _clock = setup
    consent(client, headers, bootstrap)
    job = submit(client, headers, bootstrap).json()
    with Worker(app) as worker:
        assert worker.run_once()
    assert len(provider.calls) == 1
    prompt = provider.calls[0]["prompt"]
    assert "Reconstruct the neck, shoulders, torso and visible limbs" in prompt
    assert "never stretch or squash" in prompt
    assert "camera distance" in prompt
    assert "Image 1 is the only source of person identity" in prompt
    assert "never copy its person identity" in prompt
    result = client.get("/api/tryons/" + job["id"]).json()
    assert result["status"] == "succeeded"
    with Image.open(io.BytesIO(client.get(result["image_url"]).content)) as image:
        assert "yixu-tryon-v2-anatomy" in image.info["xmp"].decode()
    assert not list(app.state.jobs.inputs.iterdir())
