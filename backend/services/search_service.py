"""
Semantic search across meeting transcripts — "ask your meetings".

Answers questions like *"when did we agree the migration deadline?"* by
retrieving the transcript passages that actually discuss it and citing the
speaker and timestamp, so every claim is traceable back to something that was
said rather than to model recall.

Design notes
------------
**Embeddings run locally.** `fastembed` executes a quantised ONNX model on
CPU — roughly 130 MB, no API key, no per-query cost, and no transcript
content leaving the host. Meeting transcripts are exactly the kind of data
that should not be shipped to a third party to be indexed.

**Qdrant runs embedded.** `QdrantClient(path=...)` keeps vectors in a local
directory, so semantic search needs no extra service in development or on a
single-instance deployment. Setting `QDRANT_URL` switches to a real server
with no other change.

**Chunks are windows of consecutive turns, not single utterances.** A lone
line ("Yes, Thursday morning.") carries almost no retrievable meaning; the
question it answers is in the preceding turn. Windows overlap so an exchange
is never split across a boundary and lost.

The answer step is optional: retrieval works with no LLM key at all and
returns ranked passages. With Groq configured it also composes a direct
answer grounded in those passages.
"""

from __future__ import annotations

import asyncio
import hashlib
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

from core.config import settings
from models.meeting_model import TranscriptEntry

# Turns per chunk, and how many turns the next chunk rewinds by.
CHUNK_TURNS = 6
CHUNK_STRIDE = 3


class SearchUnavailable(RuntimeError):
    """Raised when search is used while disabled or not yet initialised."""


@dataclass
class Passage:
    meeting_id: str
    meeting_title: str
    text: str
    speakers: list[str]
    start_time: str
    score: float

    def to_dict(self) -> dict:
        return {
            "meeting_id": self.meeting_id,
            "meeting_title": self.meeting_title,
            "text": self.text,
            "speakers": self.speakers,
            "start_time": self.start_time,
            "score": round(self.score, 4),
        }


def _chunk(entries: Sequence[TranscriptEntry]) -> list[dict]:
    """Group consecutive turns into overlapping windows."""
    entries = [e for e in entries if (e.text or "").strip()]
    if not entries:
        return []

    chunks: list[dict] = []
    for start in range(0, len(entries), CHUNK_STRIDE):
        window = entries[start : start + CHUNK_TURNS]
        if not window:
            break

        text = "\n".join(f"{e.speaker}: {e.text.strip()}" for e in window)
        chunks.append({
            "text": text,
            "speakers": sorted({e.speaker for e in window}),
            "start_time": window[0].time or "00:00:00",
        })

        if start + CHUNK_TURNS >= len(entries):
            break
    return chunks


class SearchService:
    """Indexes transcripts and answers questions over them."""

    def __init__(self) -> None:
        self._client = None
        self._embedder = None
        self._dim: int | None = None
        self._ready = False
        self._lock = asyncio.Lock()

    @property
    def enabled(self) -> bool:
        return settings.SEMANTIC_SEARCH_ENABLED

    @property
    def ready(self) -> bool:
        return self._ready

    async def initialise(self) -> None:
        """
        Load the embedding model and open the vector store.

        Called lazily rather than at startup: the first run downloads the ONNX
        model, and blocking application boot on a network fetch would mean the
        whole app fails to start when only search is unavailable.
        """
        if self._ready or not self.enabled:
            return

        async with self._lock:
            if self._ready:
                return
            await asyncio.get_running_loop().run_in_executor(None, self._load)

    def _load(self) -> None:
        from fastembed import TextEmbedding
        from qdrant_client import QdrantClient
        from qdrant_client.models import Distance, PayloadSchemaType, VectorParams

        self._embedder = TextEmbedding(model_name=settings.EMBEDDING_MODEL)
        self._dim = len(next(iter(self._embedder.embed(["dimension probe"]))))

        if settings.QDRANT_URL:
            self._client = QdrantClient(
                url=settings.QDRANT_URL,
                api_key=settings.QDRANT_API_KEY or None,
                timeout=30,
            )
        else:
            path = Path(settings.QDRANT_PATH).expanduser().resolve()
            path.mkdir(parents=True, exist_ok=True)
            self._client = QdrantClient(path=str(path))

        existing = {c.name for c in self._client.get_collections().collections}
        if settings.QDRANT_COLLECTION not in existing:
            self._client.create_collection(
                collection_name=settings.QDRANT_COLLECTION,
                vectors_config=VectorParams(size=self._dim, distance=Distance.COSINE),
            )

        # Qdrant Cloud runs in strict mode, which rejects a filter on any field
        # without a payload index - every search here filters on meeting_id.
        # Creating an index that already exists is a no-op.
        if settings.QDRANT_URL:
            self._client.create_payload_index(
                collection_name=settings.QDRANT_COLLECTION,
                field_name="meeting_id",
                field_schema=PayloadSchemaType.KEYWORD,
            )

        self._ready = True
        print(
            f"[search] ready — {settings.EMBEDDING_MODEL} ({self._dim}d), "
            f"collection '{settings.QDRANT_COLLECTION}'"
        )

    # ── indexing ──────────────────────────────────────────────────────
    async def index_meeting(
        self, meeting_id: str, title: str, entries: Sequence[TranscriptEntry]
    ) -> int:
        """(Re)index one meeting. Returns the number of chunks stored."""
        if not self.enabled:
            return 0
        await self.initialise()

        chunks = _chunk(entries)
        if not chunks:
            await self.remove_meeting(meeting_id)
            return 0

        return await asyncio.get_running_loop().run_in_executor(
            None, self._index_sync, meeting_id, title, chunks
        )

    def _index_sync(self, meeting_id: str, title: str, chunks: list[dict]) -> int:
        from qdrant_client.models import PointStruct

        vectors = list(self._embedder.embed([c["text"] for c in chunks]))

        points = []
        for i, (chunk, vector) in enumerate(zip(chunks, vectors)):
            # Deterministic id: reindexing a meeting overwrites its points
            # instead of accumulating duplicates on every edit.
            raw = f"{meeting_id}:{i}".encode()
            point_id = int(hashlib.sha1(raw).hexdigest()[:15], 16)
            points.append(
                PointStruct(
                    id=point_id,
                    vector=vector.tolist(),
                    payload={
                        "meeting_id": meeting_id,
                        "meeting_title": title,
                        "chunk_index": i,
                        **chunk,
                    },
                )
            )

        # Drop stale points first: a shortened transcript would otherwise leave
        # orphaned chunks from the previous, longer version.
        self._drop(meeting_id)
        self._client.upsert(
            collection_name=settings.QDRANT_COLLECTION, points=points, wait=True
        )
        return len(points)

    async def remove_meeting(self, meeting_id: str) -> None:
        if not self.enabled or not self._ready:
            return
        await asyncio.get_running_loop().run_in_executor(None, self._drop, meeting_id)

    def _drop(self, meeting_id: str) -> None:
        from qdrant_client.models import FieldCondition, Filter, FilterSelector, MatchValue

        try:
            self._client.delete(
                collection_name=settings.QDRANT_COLLECTION,
                points_selector=FilterSelector(
                    filter=Filter(must=[
                        FieldCondition(key="meeting_id", match=MatchValue(value=meeting_id))
                    ])
                ),
                wait=True,
            )
        except Exception as exc:
            print(f"[search] delete for {meeting_id} skipped: {exc}")

    # ── retrieval ─────────────────────────────────────────────────────
    async def search(
        self,
        query: str,
        limit: int = 6,
        meeting_ids: Sequence[str] | None = None,
    ) -> list[Passage]:
        """Retrieve the passages most relevant to a question."""
        if not self.enabled:
            raise SearchUnavailable(
                "Semantic search is disabled. Set SEMANTIC_SEARCH_ENABLED=true."
            )
        await self.initialise()

        return await asyncio.get_running_loop().run_in_executor(
            None, self._search_sync, query, limit, list(meeting_ids or [])
        )

    def _search_sync(self, query: str, limit: int, meeting_ids: list[str]) -> list[Passage]:
        from qdrant_client.models import FieldCondition, Filter, MatchAny

        vector = next(iter(self._embedder.embed([query]))).tolist()

        flt = None
        if meeting_ids:
            # Scope search to meetings the caller is allowed to read; the API
            # layer supplies that list.
            flt = Filter(must=[
                FieldCondition(key="meeting_id", match=MatchAny(any=meeting_ids))
            ])

        hits = self._client.query_points(
            collection_name=settings.QDRANT_COLLECTION,
            query=vector,
            limit=limit,
            query_filter=flt,
            with_payload=True,
        ).points

        return [
            Passage(
                meeting_id=h.payload["meeting_id"],
                meeting_title=h.payload.get("meeting_title", ""),
                text=h.payload["text"],
                speakers=h.payload.get("speakers", []),
                start_time=h.payload.get("start_time", ""),
                score=float(h.score),
            )
            for h in hits
        ]

    # ── answering ─────────────────────────────────────────────────────
    async def answer(
        self,
        query: str,
        limit: int = 6,
        meeting_ids: Sequence[str] | None = None,
    ) -> dict:
        """
        Retrieve, then compose a grounded answer.

        Without a Groq key the passages are still returned; only the composed
        answer is omitted. Retrieval is the part that must always work.
        """
        passages = await self.search(query, limit=limit, meeting_ids=meeting_ids)

        if not passages:
            return {
                "query": query,
                "answer": "Nothing in the indexed meetings covers that.",
                "passages": [],
                "grounded": False,
            }

        from services.llm_client import llm_client

        if not llm_client.available:
            # Retrieval is the valuable half and it already succeeded, so hand
            # back the passages rather than failing the whole request.
            return {
                "query": query,
                "answer": None,
                "passages": [p.to_dict() for p in passages],
                "grounded": False,
                "note": llm_client.status["reason"]
                        or "No LLM is configured - showing retrieved passages "
                           "without a composed answer.",
            }

        from services.ai_analysis_service import AIAnalysisService

        context = "\n\n".join(
            f"[{i + 1}] Meeting: {p.meeting_title} (at {p.start_time})\n{p.text}"
            for i, p in enumerate(passages)
        )

        prompt = f"""You are answering a question using only the meeting excerpts below.

QUESTION: {query}

EXCERPTS:
{context}

Rules:
- Use only what the excerpts say. Do not add outside knowledge.
- Cite the excerpts you rely on as [1], [2], and so on.
- If the excerpts do not answer the question, say so plainly.
- Be direct. Two or three sentences.
- Name who said what when it matters."""

        try:
            answer = await AIAnalysisService()._chat(prompt, temperature=0.1, fast=False)
        except Exception as exc:
            # A rejected key, a decommissioned model or a rate limit must not
            # lose the retrieval work. Retrieval is the valuable half and it
            # already succeeded, so return the passages and say why the
            # composed answer is missing.
            print(f"[search] answer composition failed: {exc.__class__.__name__}: {exc}")
            return {
                "query": query,
                "answer": None,
                "passages": [p.to_dict() for p in passages],
                "grounded": False,
                "note": (
                    "Retrieved the relevant passages, but could not compose an "
                    f"answer: {exc.__class__.__name__}. Check GROQ_API_KEY."
                ),
            }

        return {
            "query": query,
            "answer": answer,
            "passages": [p.to_dict() for p in passages],
            "grounded": True,
        }

    async def stats(self) -> dict:
        if not self.enabled:
            return {"enabled": False}
        await self.initialise()

        info = self._client.get_collection(settings.QDRANT_COLLECTION)
        return {
            "enabled": True,
            "ready": self._ready,
            "model": settings.EMBEDDING_MODEL,
            "dimensions": self._dim,
            "chunks_indexed": info.points_count,
            "backend": "qdrant-server" if settings.QDRANT_URL else "qdrant-embedded",
        }


search_service = SearchService()
