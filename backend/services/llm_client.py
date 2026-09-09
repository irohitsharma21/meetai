"""
LLM access, provider-agnostic.

Every AI feature in MeetAI goes through this one client: action detection,
minutes, summaries, sentiment, RAG answer composition and the voice assistant.
Centralising it means the model can be swapped in .env without touching a
single prompt.

Two things here are not incidental:

*Fallback across models.* The default configuration uses OpenRouter's free
tier, where a 429 is routine rather than exceptional - a model can be busy for
a few seconds and fine immediately after. A single-model client would surface
that as "AI reports are broken". This one walks a list of models and only
gives up when every one of them refuses.

*Tolerant JSON parsing.* Several strong free models emit their reasoning
alongside the answer, or wrap JSON in markdown fences. The prompts ask for bare
JSON, but the parser does not assume it got it.
"""

from __future__ import annotations

import json
import re
from typing import List, Optional

import httpx

from core.config import settings


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


class LLMClient:
    """OpenAI-dialect chat client with an ordered model fallback."""

    def __init__(self) -> None:
        self._provider = "openrouter" if settings.openrouter_configured else (
            "groq" if settings.groq_configured else None
        )
        # Set on a hard authentication failure so a dead key is reported once
        # rather than retried on every request.
        self._disabled_reason: Optional[str] = None

    # ── capability ────────────────────────────────────────────────────────────
    @property
    def available(self) -> bool:
        return self._provider is not None and self._disabled_reason is None

    @property
    def status(self) -> dict:
        return {
            "available": self.available,
            "provider": self._provider,
            "model": self._models()[0] if self._provider else None,
            "reason": self._disabled_reason
            or (
                None
                if self._provider
                else "No LLM key set. Add OPENROUTER_API_KEY to backend/.env."
            ),
        }

    # ── configuration ─────────────────────────────────────────────────────────
    def _models(self, fast: bool = False) -> List[str]:
        if self._provider == "groq":
            return [settings.GROQ_LLM_FAST_MODEL if fast else settings.GROQ_LLM_MODEL]

        primary = settings.OPENROUTER_FAST_MODEL if fast else settings.OPENROUTER_MODEL
        chain = [primary, *settings.OPENROUTER_FALLBACK_MODELS]
        # dict.fromkeys keeps order while removing a duplicate primary.
        return list(dict.fromkeys(m for m in chain if m))

    def _endpoint(self) -> str:
        if self._provider == "groq":
            return "https://api.groq.com/openai/v1/chat/completions"
        return f"{settings.OPENROUTER_BASE_URL.rstrip('/')}/chat/completions"

    def _headers(self) -> dict:
        if self._provider == "groq":
            return {"Authorization": f"Bearer {settings.GROQ_API_KEY}"}
        return {
            "Authorization": f"Bearer {settings.OPENROUTER_API_KEY}",
            # OpenRouter attributes usage with these; harmless if unset.
            "HTTP-Referer": settings.OPENROUTER_SITE_URL,
            "X-Title": settings.OPENROUTER_APP_NAME,
        }

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
        Ask the first model that will answer.

        A 401 disables the client outright - a rejected key never fixes itself.
        A 429 or a server-side error moves to the next model, because on a free
        tier that usually means "this model is busy", not "the request is bad".
        """
        if self._provider is None:
            raise LLMUnavailable(
                "No LLM is configured. Add OPENROUTER_API_KEY to backend/.env "
                "(free models are available at https://openrouter.ai/models)."
            )
        if self._disabled_reason:
            raise LLMUnavailable(self._disabled_reason)

        models = self._models(fast=fast)
        attempts: List[str] = []

        async with httpx.AsyncClient(timeout=timeout) as client:
            for model in models:
                payload = {
                    "model": model,
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": temperature,
                    "max_tokens": max_tokens,
                }
                if json_mode:
                    payload["response_format"] = {"type": "json_object"}

                try:
                    response = await client.post(
                        self._endpoint(), headers=self._headers(), json=payload
                    )
                except Exception as exc:  # network-level failure
                    attempts.append(f"{model}: {type(exc).__name__}")
                    continue

                if response.status_code == 401:
                    self._disabled_reason = (
                        f"The {self._provider} API key was rejected (401). AI "
                        "features are off until a valid key is set in backend/.env."
                    )
                    raise LLMUnavailable(self._disabled_reason)

                if response.status_code >= 400:
                    attempts.append(f"{model}: HTTP {response.status_code}")
                    continue

                try:
                    data = response.json()
                    message = data["choices"][0]["message"]
                    content = (message.get("content") or "").strip()
                except Exception as exc:
                    attempts.append(f"{model}: malformed response ({type(exc).__name__})")
                    continue

                if not content:
                    # Some reasoning models return an empty content field and
                    # put everything in `reasoning`; treat that as usable
                    # rather than throwing the whole answer away.
                    content = (message.get("reasoning") or "").strip()
                if content:
                    return content

                attempts.append(f"{model}: empty response")

        raise LLMUnavailable(
            "Every configured model declined the request. Tried - "
            + "; ".join(attempts)
        )

    async def chat_json(
        self,
        prompt: str,
        temperature: float = 0.1,
        fast: bool = False,
        max_tokens: int = 4096,
    ) -> dict:
        """Chat, then parse the reply as JSON."""
        raw = await self.chat(
            prompt,
            temperature=temperature,
            fast=fast,
            max_tokens=max_tokens,
            json_mode=True,
        )
        return extract_json(raw)

    async def _probe(self, model: str, timeout: float = 20.0) -> None:
        """Single-model liveness check used by verify()."""
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(
                self._endpoint(),
                headers=self._headers(),
                json={
                    "model": model,
                    "messages": [{"role": "user", "content": "ok"}],
                    "max_tokens": 4,
                },
            )
        if response.status_code == 401:
            self._disabled_reason = (
                f"The {self._provider} API key was rejected (401). AI features "
                "are off until a valid key is set in backend/.env."
            )
            raise LLMUnavailable(self._disabled_reason)
        response.raise_for_status()

    async def verify(self) -> None:
        """
        Probe the configured key once at startup.

        Same reasoning as the transcription probe: a dead key should be visible
        on /health before anyone starts a meeting, not after the first report
        fails.
        """
        if self._provider is None:
            return
        try:
            # Probe the primary model only, and briefly. Walking the whole
            # fallback chain here would multiply the timeout by its length for
            # no benefit: the chain is exercised on real requests anyway.
            await self._probe(self._models()[0], timeout=20)
            print(f"LLM ready: {self._provider}/{self._models()[0]}")
        except LLMUnavailable as exc:
            print(f"LLM unavailable: {exc}")
        except Exception as exc:
            print(f"Could not verify the LLM ({type(exc).__name__}); continuing.")


llm_client = LLMClient()
