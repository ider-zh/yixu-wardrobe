"""Product presentation is portable content, with identical API/offline defaults."""

import copy
import json
import subprocess
from pathlib import Path

import pytest

from backend.content import ContentService
from tests.backend.test_content import content_fixture as shared_content_fixture
from tests.backend.test_content import metadata, write_json
from tests.backend.test_home import node_catalog

content_fixture = shared_content_fixture


@pytest.fixture
def themed_product(content_fixture):
    settings, batch, _ = content_fixture
    manifest = json.loads(Path("content/products.json").read_text())
    product = manifest["products"][0]
    product.pop("presentation", None)
    product.pop("copy", None)
    product["gallery"] = []
    product["asset"] = metadata(
        settings.catalog_image_root,
        "assets/products/theme-fixture.webp",
        "product-theme-fixture",
        (80, 100),
        False,
    )
    product["appearances"] = [
        {
            "look_id": 101,
            "piece_index": 1,
            "reference_asset_id": batch["looks"][0]["asset"]["asset_id"],
            "shot_index": 1,
        }
    ]
    manifest["products"] = [product]
    write_json(settings.content_root / "products.json", manifest)
    return settings, manifest


def test_product_theme_defaults_and_forward_compatible_content_match_node(themed_product):
    settings, manifest = themed_product
    service = ContentService(settings)
    for presentation, headings in [
        (None, None),
        ({"theme": "studio", "preset": "neutral-white"}, {"hero_title": "A new silhouette"}),
        (
            {"theme": "future-theme", "preset": "future-paper"},
            {"details_title": '<b>Plain text</b> & "copy"'},
        ),
    ]:
        product = manifest["products"][0]
        if presentation is not None:
            product["presentation"] = presentation
            product["copy"] = headings
        write_json(settings.content_root / "products.json", manifest)
        static = node_catalog(settings)
        assert service.import_content()
        dynamic = service.catalog()
        static_product = copy.deepcopy(static["products"][0])
        dynamic_product = copy.deepcopy(dynamic["products"][0])
        # Transport URLs differ intentionally; the normalized content contract does not.
        for item in (static_product, dynamic_product):
            item.pop("asset")
        assert static_product == dynamic_product
        assert static["revision"] == dynamic["revision"]
        delivered = dynamic["products"][0]
        assert delivered["presentation"] == (presentation or {"theme": "editorial"})
        assert delivered["copy"] == (headings or {})


@pytest.mark.parametrize(
    "field,value",
    [
        ("presentation", None),
        ("presentation", "studio"),
        ("presentation", {"theme": "../studio"}),
        ("presentation", {"theme": "Studio"}),
        ("presentation", {"preset": "https://other.example/theme.css"}),
        ("presentation", {"theme": "studio", "stylesheet": "external.css"}),
        ("copy", None),
        ("copy", {"hero_title": 42}),
        ("copy", {"hero_title": ""}),
        ("copy", {"details_title": "   "}),
        ("copy", {"views_title": "x" * 201}),
        ("copy", {"html": "<script>evil()</script>"}),
    ],
)
def test_invalid_theme_content_retains_usable_publication(themed_product, field, value):
    settings, manifest = themed_product
    service = ContentService(settings)
    before = service.catalog()
    candidate = copy.deepcopy(manifest)
    candidate["products"][0][field] = value
    write_json(settings.content_root / "products.json", candidate)
    assert not service.import_content()
    assert service.catalog() == before
    with pytest.raises(subprocess.CalledProcessError):
        node_catalog(settings)
