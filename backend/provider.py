"""Real OpenAI image edits: explicit project credential, proxy-only, no retries.

client_factory is a test seam for exercising the *real SDK* with a controlled
HTTP transport. Production always uses the official client and a loopback proxy.
No environment credential, system proxy, direct fallback or fake image path.
"""

import base64
import binascii
import signal
import threading
from contextlib import contextmanager


@contextmanager
def wall_deadline(seconds):
    # Dedicated Linux worker main thread: absolute wall timeout also bounds
    # slow/trickling responses, unlike per-socket inactivity timeouts.
    if seconds <= 0 or threading.current_thread() is not threading.main_thread():
        raise ProviderRejected("Run the dedicated worker main thread")
    previous = signal.getsignal(signal.SIGALRM)

    def elapsed(*args):
        raise ProviderUncertain()

    signal.signal(signal.SIGALRM, elapsed)
    previous_timer = signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)
        if previous_timer[0]:
            signal.setitimer(signal.ITIMER_REAL, *previous_timer)


from openai import APIConnectionError, APIStatusError, DefaultHttpxClient, OpenAI


class ProviderUncertain(Exception):
    """Request may have reached the provider; never automatically replay."""


class ProviderRejected(Exception):
    """Provider returned a definitive rejection (safe, fixed public error)."""


class InvalidOutput(Exception):
    pass


def sdk_client(runtime, timeout):
    http = DefaultHttpxClient(
        proxy=runtime.proxy_url, trust_env=False, follow_redirects=False, timeout=timeout
    )
    return OpenAI(
        api_key=runtime.api_key,
        base_url=runtime.api_base,
        max_retries=0,
        timeout=timeout,
        http_client=http,
        organization="",
        project="",
        webhook_secret="",
    )


class OpenAIProvider:
    def __init__(self, client_factory=None):
        self.client_factory = client_factory or sdk_client

    def configured(self, runtime):
        return bool(runtime.enabled and runtime.api_key and runtime.proxy_url and runtime.model)

    def generate(self, *, photo, reference, prompt, runtime, timeout):
        with wall_deadline(timeout):
            return self._edit(
                photo=photo, reference=reference, prompt=prompt, runtime=runtime, timeout=timeout
            )

    def _edit(self, *, photo, reference, prompt, runtime, timeout):
        if not self.configured(runtime):
            raise ProviderRejected("Provider unavailable")
        try:
            with self.client_factory(runtime, timeout) as client:
                result = client.images.edit(
                    model=runtime.model,
                    image=[
                        ("person.png", photo, "image/png"),
                        ("outfit-panel.png", reference, "image/png"),
                    ],
                    prompt=prompt,
                    n=1,
                    size=runtime.size,
                    quality=runtime.quality,
                    output_format="png",
                    timeout=timeout,
                )
        except APIConnectionError:
            raise ProviderUncertain() from None
        except APIStatusError as exc:
            if exc.status_code >= 500 or exc.status_code in (408, 409):
                raise ProviderUncertain() from None
            raise ProviderRejected() from None
        if not result.data or len(result.data) != 1 or not result.data[0].b64_json:
            raise InvalidOutput()
        encoded = result.data[0].b64_json
        # Bound base64 decode allocation. Output is decoded and pixel-gated again.
        if len(encoded) > 128 * 1024 * 1024:
            raise InvalidOutput()
        try:
            return base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error):
            raise InvalidOutput() from None
