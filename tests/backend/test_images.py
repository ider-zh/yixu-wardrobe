import io

from conftest import consent, picture, submit
from PIL import Image


def test_local_gate_strips_metadata_and_rejects_invalid_faces_before_enqueue(setup):
    app, c, h, b, provider, detector, _clock = setup
    consent(c, h, b)
    for raw in (b"not-an-image", picture(format="GIF")):
        assert submit(c, h, b, image=raw).status_code == 422
    detector.detect = lambda image: []
    assert submit(c, h, b).json()["error"]["code"] == "face_count"
    detector.detect = lambda image: [(0, 0, 120, 120)] * 2
    assert submit(c, h, b).status_code == 422
    detector.detect = lambda image: [(0, 0, 10, 10)]
    assert submit(c, h, b).json()["error"]["code"] == "face_too_small"
    detector.detect = lambda image: [(30, 30, 120, 120)]
    image = Image.new("RGB", (300, 400), "red")
    exif = Image.Exif()
    exif[0x010E] = "private-camera-description"
    exif[0x0112] = 6
    buf = io.BytesIO()
    image.save(buf, format="JPEG", exif=exif)
    job = submit(c, h, b, image=buf.getvalue()).json()
    photo = (app.state.settings.data_dir / "inputs" / (job["id"] + ".photo.png")).read_bytes()
    with Image.open(io.BytesIO(photo)) as normalized:
        assert normalized.size == (400, 300)
        assert not normalized.getexif()
    assert b"private-camera-description" not in photo
    assert not provider.calls


def test_detector_missing_or_invalid_model_never_claims_ready(tmp_path):
    from backend.images import YuNetDetector
    from backend.settings import Settings

    missing = YuNetDetector(Settings(data_dir=tmp_path, face_model=tmp_path / "missing.onnx"))
    assert not missing.ready
    invalid = tmp_path / "invalid.onnx"
    invalid.write_bytes(b"invalid model")
    assert not YuNetDetector(Settings(data_dir=tmp_path, face_model=invalid)).ready
