"""Optional process-local background runner for durable public CDN work."""

import logging
import threading


class CdnWorker:
    def __init__(self, service, interval=5):
        self.service = service
        self.interval = interval
        self.stopped = threading.Event()
        self.thread = None

    def start(self):
        if self.thread and self.thread.is_alive():
            return self
        self.stopped.clear()
        self.thread = threading.Thread(target=self.run, name="yixu-public-cdn", daemon=True)
        self.thread.start()
        return self

    def run(self):
        while not self.stopped.is_set():
            try:
                worked = self.service.run_once()
            except Exception:  # noqa: BLE001 - long-lived worker boundary; never log provider credentials
                # Provider exception details may contain private credentials or URLs.
                logging.getLogger(__name__).warning(
                    "Public CDN worker step failed; see protected queue state"
                )
                worked = False
            self.stopped.wait(0.05 if worked else self.interval)

    def stop(self):
        self.stopped.set()
        if self.thread:
            # Transport waits are bounded; don't stall service shutdown on a provider.
            self.thread.join(timeout=1)
