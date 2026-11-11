import threading
import time
from concurrent.futures import ThreadPoolExecutor

from conftest import consent, picture, submit


def test_local_image_work_is_bounded_without_rejecting_or_quotas(setup):
    _app, c, h, b, _provider, detector, _clock = setup
    consent(c, h, b)
    entered, release = threading.Event(), threading.Event()
    active, maximum = 0, 0
    lock = threading.Lock()

    def blocked_detect(image):
        nonlocal active, maximum
        with lock:
            active += 1
            maximum = max(maximum, active)
        entered.set()
        assert release.wait(5)
        with lock:
            active -= 1
        return [(30, 30, 120, 120)]

    detector.detect = blocked_detect
    with ThreadPoolExecutor(max_workers=2) as pool:
        one = pool.submit(submit, c, h, b, "resource-001", picture())
        assert entered.wait(5)
        two = pool.submit(submit, c, h, b, "resource-002", picture("green"))
        time.sleep(0.2)
        observed = maximum
        release.set()
        assert one.result().status_code == 202 and two.result().status_code == 202
    assert observed == 1
    assert len(c.get("/api/tryons").json()["items"]) == 2
