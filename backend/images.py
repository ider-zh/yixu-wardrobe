"""Local input validation; no user paths, metadata or full montages leave the gate."""

import io
import json
import math
import warnings

from fastapi import HTTPException
from PIL import Image, ImageOps, UnidentifiedImageError

FACE_INFERENCE_EDGE = 1280
FaceBox = tuple[float, float, float, float]


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

    def detect(self, image) -> list[FaceBox]:
        if not self.ready or self.model is None:
            raise HTTPException(503, "detector_unavailable:Local face detector is unavailable")
        import cv2
        import numpy as np

        # Bounded inference dimensions. Never invent face pixels by upscaling.
        scale = min(1.0, FACE_INFERENCE_EDGE / max(image.size))
        resized = (
            image
            if scale == 1
            else image.resize((round(image.width * scale), round(image.height * scale)))
        )
        pixels = cv2.cvtColor(np.asarray(resized), cv2.COLOR_RGB2BGR)
        try:
            with self.lock:
                self.model.setInputSize(resized.size)
                _, faces = self.model.detect(pixels)
        except Exception:  # noqa: BLE001 - fail closed; never expose native/provider exceptions
            raise HTTPException(503, "detector_unavailable:Local face detector failed") from None
        if faces is None:
            return []
        x_factor, y_factor = image.width / resized.width, image.height / resized.height
        boxes = []
        for row in faces:
            x, y, w, h = (float(value) for value in row[:4])
            if not all(math.isfinite(value) for value in (x, y, w, h)):
                continue
            left, top = max(0.0, x * x_factor), max(0.0, y * y_factor)
            right = min(image.width, (x + w) * x_factor)
            bottom = min(image.height, (y + h) * y_factor)
            if right > left and bottom > top:
                boxes.append((left, top, right - left, bottom - top))
        return boxes


def _same_face(first: FaceBox, second: FaceBox) -> bool:
    x1, y1, w1, h1 = first
    x2, y2, w2, h2 = second
    overlap_width = max(0.0, min(x1 + w1, x2 + w2) - max(x1, x2))
    overlap_height = max(0.0, min(y1 + h1, y2 + h2) - max(y1, y2))
    overlap = overlap_width * overlap_height
    area1, area2 = w1 * h1, w2 * h2
    if overlap >= 0.4 * (area1 + area2 - overlap):
        return True
    # A first pass at lower resolution can return a smaller box for the same face.
    # Match contained boxes only when their centers are also close.
    return (
        overlap >= 0.8 * min(area1, area2)
        and abs((x1 + w1 / 2) - (x2 + w2 / 2)) <= 0.25 * max(w1, w2)
        and abs((y1 + h1 / 2) - (y2 + h2 / 2)) <= 0.25 * max(h1, h2)
    )


def _visible_faces(image, detector, minimum: int) -> list[FaceBox]:
    whole = detector.detect(image)
    if (
        len(whole) > 1
        or (whole and min(whole[0][2:]) >= minimum)
        or max(image.size) <= FACE_INFERENCE_EDGE
    ):
        return whole

    # Four overlapping crops cover the original image, including lower corners
    # where a second face could be present. Each detector call is still bounded.
    tile_width, tile_height = ((dimension * 3 + 4) // 5 for dimension in image.size)
    candidates = list(whole)
    for left in (0, image.width - tile_width):
        for top in (0, image.height - tile_height):
            tile = image.crop((left, top, left + tile_width, top + tile_height))
            candidates.extend((left + x, top + y, w, h) for x, y, w, h in detector.detect(tile))

    distinct: list[FaceBox] = []
    # Prefer the better resolved box, using the smallest side as the size measure.
    # Every smaller detection is matched against a kept box, avoiding chained merges.
    for face in sorted(candidates, key=lambda box: min(box[2:]), reverse=True):
        if not any(_same_face(face, existing) for existing in distinct):
            distinct.append(face)
            if len(distinct) > 1:
                break
    return distinct


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
    faces = _visible_faces(image, detector, settings.face_min_pixels)
    if len(faces) != 1:
        raise HTTPException(422, "face_count:Use a photo containing exactly one visible face")
    _x, _y, w, h = faces[0]
    if min(w, h) < settings.face_min_pixels:
        raise HTTPException(
            422, "face_too_small:Use a clearer original photo while keeping your full body in frame"
        )
    return png(image)


def labelled_webp(data, settings, provenance, *, append_label=False):
    from xml.sax.saxutils import escape

    from PIL import ImageDraw, ImageFont

    image = decode(data, settings)
    image.info.clear()
    font = ImageFont.load_default(size=max(14, image.width // 45))
    band = max(30, image.height // 28)
    if append_label:
        band = max(30, image.width // 45 + 14)
        w, h = image.size
        canvas = Image.new("RGB", (w, h + band), (20, 20, 20))
        canvas.paste(image, (0, 0))
        image = canvas
    draw = ImageDraw.Draw(image)
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


def hide_grid_original(data, settings):
    from PIL import ImageDraw

    image = decode(data, settings)
    w, h = image.size
    h -= max(30, w // 45 + 14)
    if h < 32:
        raise HTTPException(404, "no_result:No generated result")
    ImageDraw.Draw(image).rectangle(
        (w // 3, h // 3, 2 * w // 3 - 1, 2 * h // 3 - 1), fill=(240, 238, 232)
    )
    out = io.BytesIO()
    image.save(out, format="WEBP", quality=90)
    return out.getvalue()


def crop_reference(settings, look_id, shot_index):
    try:
        root = settings.catalog_image_root.resolve()
        catalog = json.loads(settings.catalog_path.read_text())
        look = next(item for item in catalog["looks"] if item["id"] == look_id)
        path = (root / look["versions"]["v2"]["image"]).resolve()
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
    except StopIteration:
        raise HTTPException(422, "invalid_selection:Selected look is unavailable") from None
    except (AttributeError, OSError, KeyError, ValueError, HTTPException):
        raise HTTPException(503, "catalog_unavailable:Selected reference is unavailable") from None
