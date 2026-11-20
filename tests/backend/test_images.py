import io

import pytest
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


def test_full_body_photo_is_queued_with_original_composition(setup):
    app, client, headers, bootstrap, provider, detector, _clock = setup
    consent(client, headers, bootstrap)
    # This face covers 0.56% of the image and passed the original-pixel threshold.
    # The former 2.5% frame-area gate rejected it.
    detections = []

    def detect(image):
        detections.append(image.size)
        return [(490, 160, 90, 110)]

    detector.detect = detect
    raw = picture(size=(1080, 1620))
    response = submit(client, headers, bootstrap, image=raw)
    assert response.status_code == 202
    job = response.json()
    assert job["status"] == "queued"
    assert detections == [(1080, 1620)]
    photo_path = app.state.settings.data_dir / "inputs" / (job["id"] + ".photo.png")
    with Image.open(io.BytesIO(raw)) as original, Image.open(photo_path) as normalized:
        assert normalized.size == original.size
        assert normalized.tobytes() == original.tobytes()
    assert not provider.calls


@pytest.mark.parametrize("whole", [[], [(838, 957, 24, 26)]], ids=["missing", "undersized"])
@pytest.mark.parametrize("second_face", [False, True], ids=["deduplicated", "distinct"])
def test_full_body_fallback_resolves_faces_without_losing_single_face_gate(
    setup, whole, second_face
):
    app, client, headers, bootstrap, provider, detector, _clock = setup
    consent(client, headers, bootstrap)
    calls = []
    # One original face appears in all four overlapping tiles. A second face,
    # if present, is only seen on the lower-right tile during the last pass.
    tile_faces = [
        [(820, 930, 60, 80)],
        [(820, 130, 60, 80)],
        [(100, 930, 60, 80)],
        [(100, 130, 60, 80)] + ([(600, 750, 80, 100)] if second_face else []),
    ]
    detections = iter([whole, *tile_faces])

    def detect(image):
        calls.append(image.size)
        return next(detections)

    detector.detect = detect
    response = submit(client, headers, bootstrap, image=picture(size=(1800, 2000)))
    assert calls == [(1800, 2000), *[(1080, 1200)] * 4]
    with app.state.store.connect() as database:
        assert database.execute("SELECT count(*) FROM jobs").fetchone()[0] == (
            0 if second_face else 1
        )
    if second_face:
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "face_count"
        assert not list((app.state.settings.data_dir / "inputs").iterdir())
    else:
        assert response.status_code == 202
        assert response.json()["status"] == "queued"
    assert not provider.calls


def test_detector_rescales_only_down_and_clips_face_box_to_visible_original_pixels():
    import threading

    from backend.images import YuNetDetector

    class EdgeFaceModel:
        def setInputSize(self, size):
            self.size = size

        def detect(self, _pixels):
            return 0, [[-5, 10, 30, 30]]

    detector = object.__new__(YuNetDetector)
    detector.ready = True
    detector.model = EdgeFaceModel()
    detector.lock = threading.Lock()
    large = Image.new("RGB", (1440, 1920))
    assert detector.detect(large) == [(0, 15, 37.5, 45)]
    assert detector.model.size == (960, 1280)
    small = Image.new("RGB", (480, 640))
    assert detector.detect(small) == [(0, 10, 25, 30)]
    assert detector.model.size == (480, 640)


def test_full_body_fallback_rejects_face_below_original_pixel_minimum(setup):
    app, client, headers, bootstrap, provider, detector, _clock = setup
    consent(client, headers, bootstrap)
    detections = iter([[], [(200, 300, 39, 60)], [], [], []])
    detector.detect = lambda _image: next(detections)
    response = submit(client, headers, bootstrap, image=picture(size=(1400, 1800)))
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "face_too_small"
    with app.state.store.connect() as database:
        assert database.execute("SELECT count(*) FROM jobs").fetchone()[0] == 0
    assert not list((app.state.settings.data_dir / "inputs").iterdir())
    assert not provider.calls


def test_detector_missing_or_invalid_model_never_claims_ready(tmp_path):
    from backend.images import YuNetDetector
    from backend.settings import Settings

    missing = YuNetDetector(Settings(data_dir=tmp_path, face_model=tmp_path / "missing.onnx"))
    assert not missing.ready
    invalid = tmp_path / "invalid.onnx"
    invalid.write_bytes(b"invalid model")
    assert not YuNetDetector(Settings(data_dir=tmp_path, face_model=invalid)).ready
