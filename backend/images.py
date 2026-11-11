"""Local input validation; no user paths, metadata or full montages leave the gate."""

import io
import json
import warnings

from fastapi import HTTPException
from PIL import Image, ImageOps, UnidentifiedImageError


class YuNetDetector:
    """CPU-only local YuNet, loaded only on intentional app initialization.

    Model/weights are operator-supplied. Initialization exercises inference on a
    blank image before reporting ready. Detection is serialized; OpenCV's model
    input-size mutation is not safe across concurrent requests.
    """

    def __init__(self, settings):
        import threading

        self.lock = threading.Lock()
        self.model = None
        self.ready = False
        if not settings.face_model or not settings.face_model.is_file():
            return
        try:
            import cv2
            import numpy as np

            cv2.setNumThreads(1)
            self.model = cv2.FaceDetectorYN.create(
                str(settings.face_model),
                "",
                (320, 320),
                settings.detector_score_threshold,
                0.3,
                5000,
            )
            self.model.detect(np.zeros((320, 320, 3), dtype=np.uint8))
            self.ready = True
        except Exception:  # noqa: BLE001 - fail closed; never expose native/provider exceptions
            self.model = None

    def detect(self, image):
        if not self.ready or self.model is None:
            raise HTTPException(503, "detector_unavailable:Local face detector is unavailable")
        import cv2
        import numpy as np

        # Bounded inference dimensions, with boxes returned in original pixels.
        scale = min(1.0, 1280 / max(image.size))
        resized = image.resize((round(image.width * scale), round(image.height * scale)))
        pixels = cv2.cvtColor(np.asarray(resized), cv2.COLOR_RGB2BGR)
        try:
            with self.lock:
                self.model.setInputSize(resized.size)
                _, faces = self.model.detect(pixels)
            return (
                [] if faces is None else [tuple(float(x) / scale for x in row[:4]) for row in faces]
            )
        except Exception:  # noqa: BLE001 - fail closed; never expose native/provider exceptions
            raise HTTPException(503, "detector_unavailable:Local face detector failed") from None


def png(image):
    out = io.BytesIO()
    image.save(out, format="PNG")
    return out.getvalue()


def decode(data: bytes, settings):
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            image = Image.open(io.BytesIO(data))
            if image.format not in ("JPEG", "PNG", "WEBP") or getattr(image, "n_frames", 1) != 1:
                raise ValueError()
            w, h = image.size
            if (
                w * h > settings.max_pixels
                or max(w, h) > settings.max_image_dimension
                or min(w, h) < 32
            ):
                raise ValueError()
            image.load()
            return ImageOps.exif_transpose(image).convert("RGB")
    except (
        UnidentifiedImageError,
        OSError,
        ValueError,
        Image.DecompressionBombWarning,
        Image.DecompressionBombError,
    ):
        raise HTTPException(
            422, "invalid_image:Use a valid, single-frame JPEG, PNG or WebP within image limits"
        ) from None


def validate_photo(data, settings, detector):
    if len(data) > settings.max_upload_bytes:
        raise HTTPException(413, "upload_too_large:Photo exceeds technical upload limit")
    image = decode(data, settings)
    faces = detector.detect(image)
    if len(faces) != 1:
        raise HTTPException(422, "face_count:Use a photo containing exactly one visible face")
    _x, _y, w, h = faces[0]
    if (
        min(w, h) < settings.face_min_pixels
        or w * h / (image.width * image.height) < settings.face_min_fraction
    ):
        raise HTTPException(422, "face_too_small:Move closer with a clearly visible face")
    return png(image)


def labelled_webp(data, settings, provenance):
    from xml.sax.saxutils import escape

    from PIL import ImageDraw, ImageFont

    image = decode(data, settings)
    image.info.clear()
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default(size=max(14, image.width // 45))
    band = max(30, image.height // 28)
    draw.rectangle((0, image.height - band, image.width, image.height), fill=(20, 20, 20))
    draw.text((10, image.height - band + 5), "AI GENERATED | Yixu", fill="white", font=font)
    payload = escape(json.dumps(provenance, ensure_ascii=True, sort_keys=True))
    xmp = (
        '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF '
        'xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
        '<rdf:Description xmlns:yixu="urn:yixu:provenance" '
        'yixu:label="AI-generated | Yixu"><yixu:request>'
        + payload
        + "</yixu:request></rdf:Description></rdf:RDF></x:xmpmeta>"
    )
    out = io.BytesIO()
    image.save(out, format="WEBP", quality=90, xmp=xmp.encode())
    return out.getvalue()


def crop_reference(settings, look_id, edition, shot_index):
    try:
        root = settings.catalog_image_root.resolve()
        catalog = json.loads(settings.catalog_path.read_text())
        look = next(item for item in catalog["looks"] if item["id"] == look_id)
        path = (root / look["versions"][edition]["image"]).resolve()
        if not path.is_relative_to(root):
            raise ValueError()
        image = decode(path.read_bytes(), settings)
        col, row = (shot_index - 1) % 3, (shot_index - 1) // 3
        return png(
            image.crop(
                (
                    image.width * col // 3,
                    image.height * row // 3,
                    image.width * (col + 1) // 3,
                    image.height * (row + 1) // 3,
                )
            )
        )
    except (AttributeError, OSError, KeyError, StopIteration, ValueError, HTTPException):
        raise HTTPException(503, "catalog_unavailable:Selected reference is unavailable") from None
