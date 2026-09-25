"""
Outbound HTTP clients that do not stall the event loop.

`httpx.AsyncClient()` builds a fresh SSL context on construction - loading
and parsing the whole certifi CA bundle - synchronously, on whatever thread
constructs it. That thread is the event loop. Measured on the Windows dev box:
4-7 s per client, which froze every meeting's transcript, cues and
translations for that long each time a provider was called. On Linux it is
tens of milliseconds, but it is still paid on every call.

Building the context once at import time (i.e. at start-up, before the server
accepts connections) and handing it to every client makes construction
effectively free (~1 ms).
"""

from __future__ import annotations

import ssl

import certifi
import httpx

SSL_CONTEXT: ssl.SSLContext = ssl.create_default_context(cafile=certifi.where())


def async_client(**kwargs) -> httpx.AsyncClient:
    """An httpx.AsyncClient that reuses the process-wide SSL context."""
    kwargs.setdefault("verify", SSL_CONTEXT)
    return httpx.AsyncClient(**kwargs)
