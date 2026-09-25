"""
LLM access, provider-agnostic.

Every AI feature in MeetAI goes through this one client: action detection,
minutes, summaries, sentiment, RAG answer composition, the voice assistant,
briefing cues and the delegate agent. Centralising it means providers and
models can be swapped in .env without touching a single prompt.

Three things here are not incidental:

*Several providers, raced with a head start.* Cerebras, Gemini, OpenRouter
and Groq all speak the OpenAI chat-completions dialect, so each is just an
endpoint, a key and a model list. Every configured provider joins an ordered
chain (`LLM_PROVIDERS`). A request starts on the first; if that one fails, or
simply has not answered within its head start (`LLM_HEDGE_FAST_S` for the
live, latency-sensitive calls, `LLM_HEDGE_S` otherwise), the next provider is
started *alongside* it and the first good answer wins. Free tiers fail in
bursts - a 429, a 503 "high demand", a 15 s stall - and a live cue that lands
after the conversation has moved on is worth nothing. Hedging rather than
fanning every request out to every provider keeps the free quotas for when
they are needed.

*Fallback across models within a provider.* On free tiers a single model is
routinely busy for a few seconds, so each provider walks its own model list
before it counts as failed.

*Tolerant JSON parsing.* Several strong free models emit their reasoning
alongside the answer, or wrap JSON in markdown fences. The prompts ask for bare
JSON, but the parser does not assume it got it.
"""

from __future__ import annotations

import asyncio
import json
import re
import time
from dataclasses import dataclass, field
from typing import Callable, List, Optional

import httpx

from core.config import settings
from core.http import async_client


class LLMUnavailable(RuntimeError):
    """Raised when no configured model could answer."""


def extract_json(text: str) -> dict:
    """
    Pull the first JSON object out of a model response.

    Handles bare JSON, markdown-fenced JSON, and JSON preceded by commentary
    ("Here's the analysis: {...}"), which reasoning models produce even when
    told not to.
    """
    if not text:
        raise ValueError("empty response")

    candidates: List[str] = []

    fenced = re.findall(r"```(?:json)?\s*(.*?)```", text, re.DOTALL | re.IGNORECASE)
    candidates.extend(fenced)
    candidates.append(text)

    for candidate in candidates:
        candidate = candidate.strip()
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            pass

        # Scan for a balanced object rather than a greedy {.*} - the greedy
        # form swallows trailing prose and fails on any response that continues
        # past the JSON.
        start = candidate.find("{")
        while start != -1:
            depth, in_string, escaped = 0, False, False
            for i in range(start, len(candidate)):
                ch = candidate[i]
                if in_string:
                    if escaped:
                        escaped = False
                    elif ch == "\\":
                        escaped = True
                    elif ch == '"':
                        in_string = False
                    continue
                if ch == '"':
                    in_string = True
                elif ch == "{":
                    depth += 1
                elif ch == "}":
                    depth -= 1
                    if depth == 0:
                        try:
                            return json.loads(candidate[start : i + 1])
                        except json.JSONDecodeError:
                            break
            start = candidate.find("{", start + 1)

    raise ValueError("no valid JSON object in model response")


def _dedupe(models: List[str]) -> List[str]:
    # dict.fromkeys keeps order while removing duplicates.
    return list(dict.fromkeys(m for m in models if m))


# A 402 (no quota / billing not set up) can be fixed from the provider's
# dashboard while the server keeps running, so it benches a provider for a
# while instead of for the life of the process. A 401 is a wrong key and does
# not fix itself.
PAYMENT_BENCH_S = 600.0


@dataclass
class Provider:
    name: str
    endpoint: str
    key_env: str
    headers: Callable[[], dict]
    models: List[str]
    fast_models: List[str]
    # Extra request fields (e.g. reasoning effort) merged into every payload.
    extra: dict = field(default_factory=dict)
    disabled_reason: Optional[str] = None
    benched_until: float = 0.0

    @property
    def usable(self) -> bool:
        return self.disabled_reason is None and time.monotonic() >= self.benched_until

    def chain(self, fast: bool) -> List[str]:
        return _dedupe(self.fast_models + self.models) if fast else _dedupe(self.models)


def _build_providers() -> List[Provider]:
    s = settings
    available: dict[str, Provider] = {}

    if s.CEREBRAS_API_KEY:
        extra = {"reasoning_effort": s.CEREBRAS_REASONING_EFFORT} if s.CEREBRAS_REASONING_EFFORT else {}
        available["cerebras"] = Provider(
            name="cerebras",
            endpoint="https://api.cerebras.ai/v1/chat/completions",
            key_env="CEREBRAS_API_KEY",
            headers=lambda: {"Authorization": f"Bearer {settings.CEREBRAS_API_KEY}"},
            models=[s.CEREBRAS_MODEL],
            fast_models=[s.CEREBRAS_FAST_MODEL],
            extra=extra,
        )
    if s.GEMINI_API_KEY:
        available["gemini"] = Provider(
            name="gemini",
            endpoint="https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
            key_env="GEMINI_API_KEY",
            headers=lambda: {"Authorization": f"Bearer {settings.GEMINI_API_KEY}"},
            models=list(s.GEMINI_MODELS),
            fast_models=list(s.GEMINI_FAST_MODELS),
        )
    if s.OPENROUTER_API_KEY:
        available["openrouter"] = Provider(
            name="openrouter",
            endpoint=f"{s.OPENROUTER_BASE_URL.rstrip('/')}/chat/completions",
            key_env="OPENROUTER_API_KEY",
            headers=lambda: {
                "Authorization": f"Bearer {settings.OPENROUTER_API_KEY}",
                # OpenRouter attributes usage with these; harmless if unset.
                "HTTP-Referer": settings.OPENROUTER_SITE_URL,
                "X-Title": settings.OPENROUTER_APP_NAME,
            },
            models=[s.OPENROUTER_MODEL, *s.OPENROUTER_FALLBACK_MODELS],
            fast_models=[s.OPENROUTER_FAST_MODEL],
        )
    if s.GROQ_API_KEY:
        available["groq"] = Provider(
            name="groq",
            endpoint="https://api.groq.com/openai/v1/chat/completions",
            key_env="GROQ_API_KEY",
            headers=lambda: {"Authorization": f"Bearer {settings.GROQ_API_KEY}"},
            models=[s.GROQ_LLM_MODEL],
            fast_models=[s.GROQ_LLM_FAST_MODEL],
        )

    order = [p.strip().lower() for p in s.LLM_PROVIDERS.split(",") if p.strip()]
    chain = [available[name] for name in order if name in available]
    # A configured provider missing from LLM_PROVIDERS still counts, last.
    chain += [p for name, p in available.items() if name not in order]
    return chain


class LLMClient:
    """OpenAI-dialect chat client: a hedged race across providers."""

    def __init__(self) -> None:
        self._providers = _build_providers()
        self._http: tuple[asyncio.AbstractEventLoop, httpx.AsyncClient] | None = None

    def _client(self) -> httpx.AsyncClient:
        """
        One pooled client per event loop.

        A fresh AsyncClient per call pays a new TLS handshake to every
        provider, measured at several seconds to Google from a cold
        connection - longer than the head start a live call gets. Reusing
        connections keeps that cost to once per process. Tied to the loop that
        created it because tests run several loops.
        """
        loop = asyncio.get_running_loop()
        if self._http is None or self._http[0] is not loop or self._http[1].is_closed:
            self._http = (loop, async_client(
                timeout=90.0,
                limits=httpx.Limits(max_connections=32, max_keepalive_connections=16, keepalive_expiry=120),
            ))
        return self._http[1]

    # ── capability ────────────────────────────────────────────────────────────
    @property
    def available(self) -> bool:
        return any(p.disabled_reason is None for p in self._providers)

    def _first_usable(self) -> Optional[Provider]:
        return next((p for p in self._providers if p.usable), None)

    @property
    def status(self) -> dict:
        lead = self._first_usable()
        if not self._providers:
            reason = (
                "No LLM key set. Add CEREBRAS_API_KEY, GEMINI_API_KEY or "
                "OPENROUTER_API_KEY to backend/.env."
            )
        elif not self.available:
            reason = "; ".join(p.disabled_reason for p in self._providers if p.disabled_reason)
        else:
            reason = None
        return {
            "available": self.available,
            "provider": lead.name if lead else None,
            "model": lead.chain(False)[0] if lead else None,
            "chain": [
                {
                    "provider": p.name,
                    "model": p.chain(False)[0],
                    "fast_model": p.chain(True)[0],
                    "state": "ok" if p.usable else ("disabled" if p.disabled_reason else "benched"),
                    "reason": p.disabled_reason,
                }
                for p in self._providers
            ],
            "reason": reason,
        }

    # ── one provider ──────────────────────────────────────────────────────────
    async def _ask_provider(
        self, provider: Provider, client: httpx.AsyncClient, payload_base: dict,
        fast: bool, attempts: List[str], timeout: float = 90.0,
    ) -> str:
        """Walk one provider's models; return content or raise LLMUnavailable."""
        for model in provider.chain(fast):
            if not provider.usable:
                break
            payload = {**payload_base, **provider.extra, "model": model}
            label = f"{provider.name}/{model}"
            try:
                response = await client.post(
                    provider.endpoint, headers=provider.headers(), json=payload, timeout=timeout,
                )
            except Exception as exc:  # network-level failure
                attempts.append(f"{label}: {type(exc).__name__}")
                continue

            code = response.status_code
            if code in (401, 403):
                provider.disabled_reason = (
                    f"The {provider.name} API key was rejected ({code}). Check "
                    f"{provider.key_env} in backend/.env."
                )
                attempts.append(f"{label}: HTTP {code}")
                break
            if code == 402:
                provider.benched_until = time.monotonic() + PAYMENT_BENCH_S
                attempts.append(f"{label}: HTTP 402 (no quota - check billing)")
                break
            if code >= 400:
                attempts.append(f"{label}: HTTP {code}")
                continue

            try:
                message = response.json()["choices"][0]["message"]
                content = (message.get("content") or "").strip()
            except Exception as exc:
                attempts.append(f"{label}: malformed response ({type(exc).__name__})")
                continue

            if not content:
                # Some reasoning models return an empty content field and put
                # everything in `reasoning`; treat that as usable rather than
                # throwing the whole answer away.
                content = (message.get("reasoning") or "").strip()
            if content:
                return content
            attempts.append(f"{label}: empty response")

        raise LLMUnavailable(provider.name)

    # ── requests ──────────────────────────────────────────────────────────────
    async def chat(
        self,
        prompt: str,
        temperature: float = 0.3,
        fast: bool = False,
        max_tokens: int = 4096,
        json_mode: bool = False,
        timeout: float = 90.0,
    ) -> str:
        """
        Race the provider chain with a head start per provider.

        `timeout` bounds the whole call, not each request: a caller that asks
        for an answer within 6 s gets one or an LLMUnavailable at 6 s.
        """
        if not self._providers:
            raise LLMUnavailable(self.status["reason"])
        queue = [p for p in self._providers if p.usable]
        if not queue:
            raise LLMUnavailable(
                self.status["reason"]
                or "Every LLM provider is temporarily out of quota. Try again shortly."
            )

        payload_base: dict = {
            "messages": [{"role": "user", "content": prompt}],
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        if json_mode:
            payload_base["response_format"] = {"type": "json_object"}

        hedge = settings.LLM_HEDGE_FAST_S if fast else settings.LLM_HEDGE_S
        attempts: List[str] = []
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        running: set[asyncio.Task] = set()

        client = self._client()
        def launch() -> None:
            provider = queue.pop(0)
            running.add(asyncio.create_task(
                self._ask_provider(provider, client, payload_base, fast, attempts, timeout)
            ))

        launch()
        try:
            while running:
                remaining = deadline - loop.time()
                if remaining <= 0:
                    attempts.append(f"timed out after {timeout:.0f}s")
                    break
                wait = min(remaining, hedge) if queue else remaining
                done, _ = await asyncio.wait(
                    running, timeout=wait, return_when=asyncio.FIRST_COMPLETED
                )
                for task in done:
                    running.discard(task)
                    if task.exception() is None:
                        return task.result()
                # Start the next provider when one failed, or when the
                # leaders have used up their head start.
                if queue and (done or not running or wait == hedge):
                    launch()
        finally:
            for task in running:
                task.cancel()
            if running:
                await asyncio.gather(*running, return_exceptions=True)

        raise LLMUnavailable(
            "Every configured model declined the request. Tried - "
            + ("; ".join(attempts) or "nothing answered in time")
        )

    async def chat_json(
        self,
        prompt: str,
        temperature: float = 0.1,
        fast: bool = False,
        max_tokens: int = 4096,
        timeout: float = 90.0,
    ) -> dict:
        """Chat, then parse the reply as JSON."""
        raw = await self.chat(
            prompt,
            temperature=temperature,
            fast=fast,
            max_tokens=max_tokens,
            json_mode=True,
            timeout=timeout,
        )
        return extract_json(raw)

    async def verify(self) -> None:
        """
        Probe each configured provider once at startup, concurrently.

        Same reasoning as the transcription probe: a dead key should be visible
        on /health before anyone starts a meeting, not after the first report
        fails. Only the primary model of each provider is probed - the model
        chains are exercised on real requests anyway.
        """
        async def probe(provider: Provider) -> str:
            attempts: List[str] = []
            one = Provider(**{**provider.__dict__, "models": provider.models[:1], "fast_models": []})
            try:
                async with async_client(timeout=20) as client:
                    await self._ask_provider(
                        one, client,
                        {"messages": [{"role": "user", "content": "Reply with: ok"}], "max_tokens": 16},
                        False, attempts,
                    )
                return f"{provider.name}: ready ({one.models[0]})"
            except LLMUnavailable:
                # Carry a 401/402 verdict back onto the real provider.
                provider.disabled_reason = one.disabled_reason
                provider.benched_until = one.benched_until
                return f"{provider.name}: {'; '.join(attempts) or 'no answer'}"
            except Exception as exc:
                return f"{provider.name}: could not verify ({type(exc).__name__})"

        if not self._providers:
            print("LLM unavailable: no provider key set.")
            return
        for line in await asyncio.gather(*(probe(p) for p in self._providers)):
            print(f"[llm] {line}")


llm_client = LLMClient()
