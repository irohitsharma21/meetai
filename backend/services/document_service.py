"""
Briefing documents - the files a participant brings into a meeting.

A participant uploads their pitch deck, spec or notes to a meeting. While the
meeting runs, `briefing_service` listens to what *other people* say and, when
one of those documents can answer it, slips the owner a private cue. This
module is everything underneath that: parsing, chunking, indexing, retrieval
and keeping the original file so it can be emailed on later.

Design notes
------------
**Chunks follow the document's own structure.** A slide is the unit a
presenter thinks in ("it's on slide 4"), so a deck is chunked one slide per
chunk - title, body and speaker notes together, because the notes are often
where the actual number lives. PDFs chunk per page, Word and Markdown per
heading section. Only when a unit is long is it windowed further, and every
window keeps its parent's locator so a cue can always say *where* the fact is.

**Privacy is per owner, not per meeting.** A document belongs to the person
who uploaded it. Every query is filtered on (meeting_id, owner): uploading a
deck to a meeting shares nothing with the other participants.

**Where the record lives depends on where Qdrant lives.** A document record
carries its chunk texts, so vectors can always be rebuilt from it.

* With a Qdrant *server* configured (`QDRANT_URL`, e.g. Qdrant Cloud) the
  server is the store of record: document metadata and chunks go in a
  payload-only `briefing_docs` collection and the original file in
  `briefing_files`. The app host's disk and database can then be ephemeral
  (Render's free tier wipes both on every restart) without an upload being
  lost.
* With embedded Qdrant, records stay in the app database and files on local
  disk - there is no durable remote to put them in, and the vector index is
  treated as a cache rebuilt on first use.

**Semantic when possible, lexical always.** The embedding model and the vector
store are *borrowed* from `search_service` - embedded Qdrant holds an
exclusive lock on its directory, so opening a second client on the same path
would fail. When semantic search is disabled or cannot load, retrieval falls
back to a pure-python BM25 scorer, so the feature works with zero setup.
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import math
import mimetypes
import os
import re
import uuid
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

from db.mongodb import get_db

# ── configuration (module-local env reads, so core/config stays untouched) ──
MAX_BYTES = int(os.getenv("BRIEFING_MAX_BYTES", str(10 * 1024 * 1024)))
DATA_DIR = os.getenv("BRIEFING_DATA_DIR", "./data/briefing")
COLLECTION = os.getenv("BRIEFING_QDRANT_COLLECTION", "briefing_chunks")
RECORDS_COLLECTION = os.getenv("BRIEFING_RECORDS_COLLECTION", "briefing_docs")
FILES_COLLECTION = os.getenv("BRIEFING_FILES_COLLECTION", "briefing_files")
# A 10 MB PDF can hold a book. Indexing every page of it would make the owner's
# upload slow and every lookup noisier for no benefit in a live meeting.
MAX_CHUNKS = int(os.getenv("BRIEFING_MAX_CHUNKS", "1500"))

# Window size for splitting a long page or section. ~160 words is long enough
# to carry a fact with its context, short enough that the embedding of the
# chunk is still *about* that fact rather than averaged away.
CHUNK_WORDS = 160
CHUNK_OVERLAP = 40

KINDS = {
    ".pdf": ("pdf", "application/pdf"),
    ".pptx": ("pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"),
    ".docx": ("docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    ".txt": ("txt", "text/plain"),
    ".md": ("md", "text/markdown"),
    ".markdown": ("md", "text/markdown"),
}
_MIME_TO_EXT = {
    "application/pdf": ".pdf",
    KINDS[".pptx"][1]: ".pptx",
    KINDS[".docx"][1]: ".docx",
    "text/plain": ".txt",
    "text/markdown": ".md",
}


# ── errors (the router maps each to its status code) ─────────────────────
class DocumentError(ValueError):
    status_code = 400


class UnsupportedDocument(DocumentError):
    status_code = 415


class DocumentTooLarge(DocumentError):
    status_code = 413


class NoExtractableText(DocumentError):
    status_code = 422


# ── parsing ───────────────────────────────────────────────────────────────
@dataclass
class Unit:
    """One natural unit of a document: a slide, a page or a section."""
    locator: str
    text: str


def _clean(text: str) -> str:
    text = text.replace("\x00", " ").replace(" ", " ")
    text = re.sub(r"[ \t\f\v]+", " ", text)
    text = re.sub(r"\s*\n\s*", "\n", text)
    return text.strip()


def _parse_pdf(data: bytes) -> tuple[list[Unit], int]:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(data))
    if reader.is_encrypted:
        try:
            reader.decrypt("")
        except Exception as exc:
            raise NoExtractableText(
                "This PDF is password-protected. Remove the password and upload it again."
            ) from exc

    units: list[Unit] = []
    for n, page in enumerate(reader.pages, start=1):
        try:
            text = _clean(page.extract_text() or "")
        except Exception:
            text = ""
        if text:
            units.append(Unit(f"Page {n}", text))
    return units, len(reader.pages)


def _parse_pptx(data: bytes) -> tuple[list[Unit], int]:
    from pptx import Presentation

    prs = Presentation(io.BytesIO(data))

    def shape_text(shape) -> list[str]:
        out: list[str] = []
        if getattr(shape, "has_text_frame", False) and shape.has_text_frame:
            out.extend(p.text for p in shape.text_frame.paragraphs if p.text.strip())
        if getattr(shape, "has_table", False) and shape.has_table:
            for row in shape.table.rows:
                cells = [c.text.strip() for c in row.cells if c.text.strip()]
                if cells:
                    out.append(" | ".join(cells))
        for child in getattr(shape, "shapes", []) or []:   # group shapes
            out.extend(shape_text(child))
        return out

    units: list[Unit] = []
    slides = list(prs.slides)
    for n, slide in enumerate(slides, start=1):
        title_shape = slide.shapes.title
        title = (title_shape.text.strip() if title_shape is not None and title_shape.has_text_frame else "")
        body: list[str] = []
        for shape in slide.shapes:
            if title_shape is not None and shape.shape_id == title_shape.shape_id:
                continue
            body.extend(shape_text(shape))

        notes = ""
        if slide.has_notes_slide and slide.notes_slide.notes_text_frame is not None:
            notes = slide.notes_slide.notes_text_frame.text.strip()

        parts = [title] if title else []
        parts.extend(body)
        if notes:
            parts.append(f"Speaker notes: {notes}")
        text = _clean("\n".join(parts))
        if text:
            units.append(Unit(f"Slide {n}", text))
    return units, len(slides)


def _parse_docx(data: bytes) -> tuple[list[Unit], int]:
    import docx

    document = docx.Document(io.BytesIO(data))
    sections: list[list[str]] = [[]]
    for para in document.paragraphs:
        text = para.text.strip()
        if not text:
            continue
        style = (para.style.name if para.style is not None else "") or ""
        if style.startswith("Heading") or style == "Title":
            if sections[-1]:
                sections.append([])
        sections[-1].append(text)

    # Tables carry exactly the numbers people ask about; keep them as their own
    # section rather than dropping them.
    for table in document.tables:
        rows = []
        for row in table.rows:
            cells = [c.text.strip() for c in row.cells if c.text.strip()]
            if cells:
                rows.append(" | ".join(dict.fromkeys(cells)))
        if rows:
            sections.append(rows)

    return _sections_to_units(sections)


def _parse_markdown(text: str) -> tuple[list[Unit], int]:
    sections: list[list[str]] = [[]]
    in_fence = False
    for line in text.splitlines():
        if line.strip().startswith("```"):
            in_fence = not in_fence
        if not in_fence and re.match(r"^\s{0,3}#{1,6}\s+\S", line):
            if sections[-1]:
                sections.append([])
            line = line.strip().lstrip("#").strip()
        if line.strip():
            sections[-1].append(line.rstrip())
    return _sections_to_units(sections)


def _parse_text(text: str) -> tuple[list[Unit], int]:
    """Plain text has no headings: group paragraphs into ~CHUNK_WORDS sections."""
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    sections: list[list[str]] = [[]]
    words = 0
    for para in paragraphs:
        n = len(para.split())
        if sections[-1] and words + n > CHUNK_WORDS:
            sections.append([])
            words = 0
        sections[-1].append(para)
        words += n
    return _sections_to_units(sections)


def _sections_to_units(sections: list[list[str]]) -> tuple[list[Unit], int]:
    sections = [s for s in sections if s]
    units = [
        Unit(f"Section {n}", _clean("\n".join(lines)))
        for n, lines in enumerate(sections, start=1)
    ]
    units = [u for u in units if u.text]
    return units, len(sections)


def _decode_text(data: bytes) -> str:
    for encoding in ("utf-8-sig", "utf-16", "cp1252"):
        try:
            text = data.decode(encoding)
            if encoding == "utf-16" and "\x00" in text:
                continue
            return text
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def parse_document(kind: str, data: bytes) -> tuple[list[Unit], int]:
    """Return (units, page/slide/section count). Raises NoExtractableText."""
    try:
        if kind == "pdf":
            units, pages = _parse_pdf(data)
        elif kind == "pptx":
            units, pages = _parse_pptx(data)
        elif kind == "docx":
            units, pages = _parse_docx(data)
        elif kind == "md":
            units, pages = _parse_markdown(_decode_text(data))
        else:
            units, pages = _parse_text(_decode_text(data))
    except DocumentError:
        raise
    except Exception as exc:
        raise NoExtractableText(
            f"Could not read this {kind.upper()} file ({type(exc).__name__}). "
            "It may be corrupt or saved in an older format."
        ) from exc

    if not units:
        if kind == "pdf":
            raise NoExtractableText(
                "No text could be extracted from this PDF - it looks like a scanned "
                "image. Upload a text-based PDF (or run OCR on it first)."
            )
        raise NoExtractableText("No text could be extracted from this document.")
    return units, pages


def chunk_units(units: Iterable[Unit]) -> list[dict]:
    """Split long units into overlapping word windows, keeping each locator."""
    chunks: list[dict] = []
    step = CHUNK_WORDS - CHUNK_OVERLAP
    for unit in units:
        words = unit.text.split()
        if len(words) <= CHUNK_WORDS + CHUNK_OVERLAP:
            chunks.append({"locator": unit.locator, "text": unit.text})
            continue
        # Windows are cut on words, but the text keeps its line breaks where
        # possible so a slide's bullet structure survives into the quote.
        for start in range(0, len(words), step):
            window = words[start : start + CHUNK_WORDS]
            chunks.append({"locator": unit.locator, "text": " ".join(window)})
            if start + CHUNK_WORDS >= len(words):
                break
    for i, c in enumerate(chunks):
        c["i"] = i
    return chunks[:MAX_CHUNKS]


# ── lexical scoring (the zero-setup path) ─────────────────────────────────
STOPWORDS = frozenset("""
a about above after again against all also am an and any are aren't as at be
because been before being below between both but by can can't could couldn't
did didn't do does doesn't doing don't down during each few for from further
get got had hadn't has hasn't have haven't having he her here hers herself him
himself his how i if in into is isn't it it's its itself just let's like me
more most much my myself no nor not now of off on once only or other ought our
ours ourselves out over own really same she should shouldn't so some such than
that that's the their theirs them themselves then there there's these they
this those through to too under until up very was wasn't we were weren't what
what's when where which while who whom why will with won't would wouldn't you
your yours yourself yourselves yeah yes ok okay oh ohh uh um hmm right well
sure thing things kind sort gonna wanna guess think know mean say said tell
ok alright actually basically literally maybe probably pretty lot one two go
going see look thanks thank please hi hello hey guys everyone
""".split())

_TOKEN = re.compile(r"[a-z0-9][a-z0-9\-\.]*[a-z0-9]|[a-z0-9]")


def _stem(token: str) -> str:
    # Deliberately crude: good enough that "slides"/"slide" and
    # "priced"/"pricing" meet, without pulling in an NLP dependency.
    for suffix in ("ing", "ies", "es", "ed", "s"):
        if len(token) > len(suffix) + 3 and token.endswith(suffix):
            token = token[: -len(suffix)] + ("y" if suffix == "ies" else "")
            break
    # "store"/"stored", "price"/"pricing": drop a final e so both sides meet.
    if len(token) > 4 and token.endswith("e"):
        token = token[:-1]
    return token


def tokens(text: str) -> list[str]:
    out = []
    for raw in _TOKEN.findall(text.lower().replace("’", "'")):
        raw = raw.strip(".-")
        # Single letters are mostly the tail of a contraction ("what's" -> s).
        if not raw or raw in STOPWORDS or (len(raw) == 1 and not raw.isdigit()):
            continue
        out.append(_stem(raw))
    return out


class LexicalIndex:
    """BM25 over one owner's chunks, plus a normalised 'coverage' score."""

    def __init__(self, chunks: list[dict]) -> None:
        self.chunks = chunks
        self.docs = [Counter(tokens(c["text"])) for c in chunks]
        self.lengths = [sum(d.values()) or 1 for d in self.docs]
        self.avg = (sum(self.lengths) / len(self.lengths)) if self.lengths else 1.0
        df: Counter = Counter()
        for d in self.docs:
            df.update(d.keys())
        n = max(len(self.docs), 1)
        self.idf = {t: math.log(1 + (n - f + 0.5) / (f + 0.5)) for t, f in df.items()}
        self.unseen_idf = math.log(1 + (n + 0.5) / 0.5)

    def search(self, query: str, k: int = 3) -> list[tuple[dict, float]]:
        """
        Rank with BM25, but *report* coverage in [0, 1]: the idf-weighted share
        of the query's content words that occur in the chunk. BM25's raw scale
        depends on corpus size, which makes it useless for a fixed threshold;
        coverage means the same thing for a 3-slide deck and a 90-page PDF.
        """
        q = list(dict.fromkeys(tokens(query)))
        if not q or not self.docs:
            return []
        weights = {t: self.idf.get(t, self.unseen_idf) for t in q}
        total = sum(weights.values()) or 1.0

        k1, b = 1.4, 0.75
        ranked = []
        for chunk, tf, length in zip(self.chunks, self.docs, self.lengths):
            bm25 = 0.0
            covered = 0.0
            for t in q:
                f = tf.get(t, 0)
                if not f:
                    continue
                covered += weights[t]
                bm25 += weights[t] * f * (k1 + 1) / (f + k1 * (1 - b + b * length / self.avg))
            if bm25 > 0:
                ranked.append((bm25, covered / total, chunk))
        ranked.sort(key=lambda r: r[0], reverse=True)
        return [(chunk, cov) for _, cov, chunk in ranked[:k]]


# Semantic hit score = cosine + LEXICAL_BONUS * lexical coverage. With
# bge-small, short conversational lines score 0.48-0.60 against unrelated
# slides and 0.53-0.86 against the right one - the ranges overlap. Exact
# rare-word overlap is what separates "who is on your founding team?" (right
# slide, low cosine) from small talk (no shared content words at all).
LEXICAL_BONUS = 0.10


# ── retrieval result ──────────────────────────────────────────────────────
@dataclass
class Hit:
    doc_id: str
    doc_name: str
    locator: str
    text: str
    chunk_index: int
    score: float
    method: str                # "semantic" | "lexical"
    lexical: float = 0.0       # coverage, reported on semantic hits too
    cosine: float = 0.0        # raw embedding similarity (semantic hits)


@dataclass
class _OwnerCorpus:
    chunks: list[dict] = field(default_factory=list)   # with doc_id/doc_name
    lexical: LexicalIndex | None = None
    records: list[dict] = field(default_factory=list)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _point_id(doc_id: str, i: int) -> int:
    return int(hashlib.sha1(f"{doc_id}:{i}".encode()).hexdigest()[:15], 16)


# ── record stores ─────────────────────────────────────────────────────────
class _DatabaseStore:
    """Records in the app database, original files on local disk."""

    remote = False

    @property
    def _col(self):
        return get_db()["briefing_docs"]

    @staticmethod
    def _dir() -> Path:
        path = Path(DATA_DIR).expanduser().resolve()
        path.mkdir(parents=True, exist_ok=True)
        return path

    async def insert(self, record: dict, data: bytes, ext: str) -> None:
        path = self._dir() / f"{record['id']}{ext}"
        await asyncio.get_running_loop().run_in_executor(None, path.write_bytes, data)
        record["file"] = path.name
        await self._col.insert_one(dict(record))

    async def find(self, meeting_id: str, owner: str | None = None) -> list[dict]:
        query = {"meeting_id": meeting_id}
        if owner is not None:
            query["owner"] = owner
        return await self._col.find(query).to_list(None)

    async def get(self, doc_id: str) -> dict | None:
        return await self._col.find_one({"id": doc_id})

    async def delete(self, record: dict) -> None:
        await self._col.delete_one({"id": record["id"]})
        try:
            (self._dir() / record.get("file", "")).unlink(missing_ok=True)
        except Exception:
            pass

    async def read_file(self, record: dict) -> bytes | None:
        if not record.get("file"):
            return None
        try:
            return await asyncio.get_running_loop().run_in_executor(
                None, (self._dir() / record["file"]).read_bytes
            )
        except (FileNotFoundError, OSError):
            return None


class _QdrantStore:
    """
    Records and original files in a Qdrant server, as payload-only points.

    Payloads live on disk on the server (`on_disk_payload`), so a 10 MB deck
    does not sit in the cluster's RAM. The file is a separate collection from
    the record because every list/owner lookup reads records, and none of
    those should drag megabytes of base64 across the network.
    """

    remote = True

    def __init__(self) -> None:
        self._client = None
        self._ready = False

    def _connect(self):
        if self._client is None:
            from qdrant_client import QdrantClient
            from core.config import settings

            self._client = QdrantClient(
                url=settings.QDRANT_URL, api_key=settings.QDRANT_API_KEY or None, timeout=60,
            )
        if not self._ready:
            from qdrant_client.models import PayloadSchemaType

            existing = {c.name for c in self._client.get_collections().collections}
            for name, fields in (
                (RECORDS_COLLECTION, ("id", "meeting_id", "owner")),
                (FILES_COLLECTION, ("doc_id",)),
            ):
                if name not in existing:
                    self._client.create_collection(name, vectors_config={}, on_disk_payload=True)
                # Qdrant Cloud's strict mode refuses unindexed filters.
                for f in fields:
                    self._client.create_payload_index(name, f, PayloadSchemaType.KEYWORD)
            self._ready = True
        return self._client

    async def _run(self, fn, *args):
        def call():
            return fn(self._connect(), *args)
        return await asyncio.get_running_loop().run_in_executor(None, call)

    @staticmethod
    def _pid(doc_id: str) -> str:
        try:
            return str(uuid.UUID(hex=doc_id))
        except ValueError:
            return str(uuid.uuid5(uuid.NAMESPACE_URL, doc_id))

    async def insert(self, record: dict, data: bytes, ext: str) -> None:
        import base64
        from qdrant_client.models import PointStruct

        pid = self._pid(record["id"])
        blob = base64.b64encode(data).decode("ascii")

        def write(client):
            # File first: an orphaned file is unreachable without its record,
            # while a record without its file would advertise a doc that
            # cannot be emailed.
            client.upsert(FILES_COLLECTION, [PointStruct(
                id=pid, vector={}, payload={"doc_id": record["id"], "owner": record["owner"], "data": blob},
            )], wait=True)
            client.upsert(RECORDS_COLLECTION, [PointStruct(
                id=pid, vector={}, payload=dict(record),
            )], wait=True)

        await self._run(write)

    async def find(self, meeting_id: str, owner: str | None = None) -> list[dict]:
        from qdrant_client.models import FieldCondition, Filter, MatchValue

        must = [FieldCondition(key="meeting_id", match=MatchValue(value=meeting_id))]
        if owner is not None:
            must.append(FieldCondition(key="owner", match=MatchValue(value=owner)))

        def scroll(client):
            out, offset = [], None
            while True:
                points, offset = client.scroll(
                    RECORDS_COLLECTION, scroll_filter=Filter(must=must),
                    limit=256, offset=offset, with_payload=True,
                )
                out.extend(p.payload for p in points)
                if offset is None:
                    return out

        return await self._run(scroll)

    async def get(self, doc_id: str) -> dict | None:
        pid = self._pid(doc_id)

        def fetch(client):
            points = client.retrieve(RECORDS_COLLECTION, ids=[pid], with_payload=True)
            return points[0].payload if points else None

        return await self._run(fetch)

    async def delete(self, record: dict) -> None:
        from qdrant_client.models import PointIdsList

        pid = self._pid(record["id"])

        def drop(client):
            client.delete(RECORDS_COLLECTION, points_selector=PointIdsList(points=[pid]), wait=True)
            client.delete(FILES_COLLECTION, points_selector=PointIdsList(points=[pid]), wait=True)

        await self._run(drop)

    async def read_file(self, record: dict) -> bytes | None:
        import base64

        pid = self._pid(record["id"])

        def fetch(client):
            points = client.retrieve(FILES_COLLECTION, ids=[pid], with_payload=["data"])
            return base64.b64decode(points[0].payload["data"]) if points else None

        return await self._run(fetch)


def _make_store():
    from core.config import settings
    return _QdrantStore() if settings.QDRANT_URL else _DatabaseStore()


class DocumentService:
    """Store, index and search one participant's documents for one meeting."""

    def __init__(self) -> None:
        # meeting_id -> owners with at least one doc. The live pipeline asks
        # this for every transcript line, so it must not touch the database.
        self._owners: dict[str, set[str]] = {}
        # (meeting_id, owner) -> chunks + lexical index
        self._corpus: dict[tuple[str, str], _OwnerCorpus] = {}
        # doc ids whose vectors are known to be present in the collection
        self._indexed: set[str] = set()
        self._collection_ready = False
        self._semantic_failed: str | None = None
        # Embedded Qdrant persists through SQLite, which rejects concurrent use
        # from several executor threads ("bad parameter or other API misuse").
        # Every vector operation goes through this lock; each is ~100 ms.
        self._vector_lock = asyncio.Lock()
        self._store = _make_store()

    async def _vec(self, fn, *args):
        loop = asyncio.get_running_loop()
        if self._store.remote:
            # A Qdrant server has no such constraint, and serialising network
            # round-trips would put every owner's cue behind everyone else's.
            return await loop.run_in_executor(None, fn, *args)
        async with self._vector_lock:
            return await loop.run_in_executor(None, fn, *args)

    # ── plumbing ──────────────────────────────────────────────────────
    @property
    def storage(self) -> str:
        return "qdrant" if self._store.remote else "database"

    @staticmethod
    def public(record: dict) -> dict:
        """The BriefingDoc shape the API promises."""
        return {
            "id": record["id"],
            "name": record.get("name", ""),
            "kind": record.get("kind", "txt"),
            "size": int(record.get("size", 0)),
            "pages": int(record.get("pages", 0)),
            "chunks": int(record.get("chunks", 0)),
            "created_at": record.get("created_at", ""),
            "status": record.get("status", "ready"),
        }

    def invalidate(self, meeting_id: str, owner: str | None = None) -> None:
        self._owners.pop(meeting_id, None)
        if owner is None:
            for key in [k for k in self._corpus if k[0] == meeting_id]:
                self._corpus.pop(key, None)
        else:
            self._corpus.pop((meeting_id, owner), None)

    # ── semantic backend (borrowed from search_service) ───────────────
    @property
    def semantic_enabled(self) -> bool:
        from services.search_service import search_service
        return search_service.enabled and self._semantic_failed is None

    async def _semantic(self):
        """
        Return search_service once its model and client are loaded, else None.

        Borrowing is not optional: embedded Qdrant locks its directory, so a
        second QdrantClient on the same path would fail to open. A failure here
        (no network for the first model download, a missing wheel) disables the
        semantic path for this process and retrieval continues lexically.
        """
        if not self.semantic_enabled:
            return None
        from services.search_service import search_service
        try:
            await search_service.initialise()
            if not search_service.ready:
                return None
            if not self._collection_ready:
                await self._vec(self._ensure_collection, search_service)
            return search_service
        except Exception as exc:
            self._semantic_failed = f"{type(exc).__name__}: {exc}"
            print(f"[briefing] semantic retrieval unavailable, using lexical: {self._semantic_failed}")
            return None

    def _ensure_collection(self, svc) -> None:
        from qdrant_client.models import Distance, PayloadSchemaType, VectorParams

        client = svc._client
        existing = {c.name for c in client.get_collections().collections}
        if COLLECTION not in existing:
            client.create_collection(
                collection_name=COLLECTION,
                vectors_config=VectorParams(size=svc._dim, distance=Distance.COSINE),
            )
        if self._store.remote:
            # Strict mode (Qdrant Cloud) rejects filters on unindexed fields.
            for f in ("meeting_id", "owner", "doc_id"):
                client.create_payload_index(COLLECTION, f, PayloadSchemaType.KEYWORD)
        self._collection_ready = True

    def _embed(self, svc, texts: list[str]) -> list[list[float]]:
        return [v.tolist() for v in svc._embedder.embed(texts)]

    def _upsert_sync(self, svc, record: dict) -> None:
        from qdrant_client.models import PointStruct

        chunks = record.get("chunk_texts") or []
        if not chunks:
            return
        # The chunk text already leads with the slide title or section heading,
        # which is what lets a bare table of numbers retrieve on its topic.
        vectors = self._embed(svc, [c["text"] for c in chunks])
        points = [
            PointStruct(
                id=_point_id(record["id"], c["i"]),
                vector=v,
                payload={
                    "doc_id": record["id"],
                    "doc_name": record["name"],
                    "meeting_id": record["meeting_id"],
                    "owner": record["owner"],
                    "chunk_index": c["i"],
                    "locator": c["locator"],
                    "text": c["text"],
                },
            )
            for c, v in zip(chunks, vectors)
        ]
        for start in range(0, len(points), 256):
            svc._client.upsert(
                collection_name=COLLECTION, points=points[start : start + 256], wait=True
            )
        self._indexed.add(record["id"])

    def _drop_sync(self, svc, doc_id: str) -> None:
        from qdrant_client.models import FieldCondition, Filter, FilterSelector, MatchValue

        svc._client.delete(
            collection_name=COLLECTION,
            points_selector=FilterSelector(filter=Filter(must=[
                FieldCondition(key="doc_id", match=MatchValue(value=doc_id))
            ])),
            wait=True,
        )
        self._indexed.discard(doc_id)

    def _count_sync(self, svc, doc_id: str) -> int:
        from qdrant_client.models import FieldCondition, Filter, MatchValue

        return svc._client.count(
            collection_name=COLLECTION,
            count_filter=Filter(must=[
                FieldCondition(key="doc_id", match=MatchValue(value=doc_id))
            ]),
            exact=True,
        ).count

    # ── public API ────────────────────────────────────────────────────
    async def add_doc(
        self, meeting_id: str, owner: str, filename: str, data: bytes,
        content_type: str | None = None,
    ) -> dict:
        """Parse, chunk, store and index an upload. Returns a BriefingDoc."""
        if len(data) > MAX_BYTES:
            raise DocumentTooLarge(
                f"Documents are limited to {MAX_BYTES // (1024 * 1024)} MB."
            )
        name = Path(filename or "document").name[:200] or "document"
        ext = Path(name).suffix.lower()
        if ext not in KINDS:
            ext = _MIME_TO_EXT.get((content_type or "").split(";")[0].strip().lower(), ext)
        if ext not in KINDS:
            raise UnsupportedDocument(
                "Unsupported file type. Upload a PDF, PowerPoint (.pptx), Word "
                "(.docx), Markdown or plain-text file."
            )
        if not data:
            raise NoExtractableText("The uploaded file is empty.")
        kind, mime = KINDS[ext]

        loop = asyncio.get_running_loop()
        units, pages = await loop.run_in_executor(None, parse_document, kind, data)
        chunks = chunk_units(units)

        doc_id = uuid.uuid4().hex
        record = {
            "id": doc_id,
            "meeting_id": meeting_id,
            "owner": owner,
            "name": name,
            "kind": kind,
            "mime": mime,
            "size": len(data),
            "pages": pages,
            "chunks": len(chunks),
            "created_at": _now_iso(),
            "status": "ready",
            "chunk_texts": chunks,
        }
        await self._store.insert(record, data, ext)
        self.invalidate(meeting_id, owner)

        # Embedding runs after the response: on a fresh host the first call
        # also downloads the model, and an upload should not hang on that.
        # Retrieval re-checks and fills in any vectors still missing.
        asyncio.create_task(self._index_later(record))
        return self.public(record)

    async def _index_later(self, record: dict) -> None:
        try:
            svc = await self._semantic()
            if svc is not None:
                await self._vec(self._upsert_sync, svc, record)
        except Exception as exc:
            # The record and the lexical path are intact; vectors are rebuilt
            # on first retrieval.
            print(f"[briefing] indexing {record['id']} deferred: {type(exc).__name__}: {exc}")

    async def list_docs(self, meeting_id: str, owner: str) -> list[dict]:
        docs = await self._store.find(meeting_id, owner)
        docs.sort(key=lambda d: d.get("created_at", ""))
        return [self.public(d) for d in docs]

    async def delete_doc(self, meeting_id: str, doc_id: str, owner: str) -> bool:
        record = await self._store.get(doc_id)
        if not record or record.get("meeting_id") != meeting_id or record.get("owner") != owner:
            return False
        await self._store.delete(record)
        self.invalidate(meeting_id, owner)

        svc = await self._semantic()
        if svc is not None:
            try:
                await self._vec(self._drop_sync, svc, doc_id)
            except Exception as exc:
                print(f"[briefing] vector delete for {doc_id} skipped: {exc}")
        return True

    async def delete_meeting_docs(self, meeting_id: str) -> int:
        """Remove every participant's documents for a meeting being deleted."""
        records = await self._store.find(meeting_id)
        for record in records:
            await self.delete_doc(meeting_id, record["id"], record["owner"])
        return len(records)

    async def get_file(self, doc_id: str, owner: str) -> tuple[str, bytes, str] | None:
        """
        (original filename, bytes, mime) for a doc the owner uploaded, or None.

        None also covers the file having vanished from an ephemeral disk: the
        record survives a redeploy, the upload directory may not.
        """
        record = await self._store.get(doc_id)
        if not record or record.get("owner") != owner:
            return None
        try:
            data = await self._store.read_file(record)
        except Exception as exc:
            print(f"[briefing] reading file for {doc_id} failed: {type(exc).__name__}: {exc}")
            return None
        if data is None:
            return None
        mime = record.get("mime") or mimetypes.guess_type(record.get("name", ""))[0] \
            or "application/octet-stream"
        return record.get("name", "document"), data, mime

    async def owners(self, meeting_id: str) -> set[str]:
        """Who has documents in this meeting. Cached; cheap on the hot path."""
        cached = self._owners.get(meeting_id)
        if cached is not None:
            return cached
        docs = await self._store.find(meeting_id)
        owners = {d["owner"] for d in docs if d.get("owner")}
        self._owners[meeting_id] = owners
        return owners

    async def _load_corpus(self, meeting_id: str, owner: str) -> _OwnerCorpus:
        key = (meeting_id, owner)
        corpus = self._corpus.get(key)
        if corpus is not None:
            return corpus
        records = await self._store.find(meeting_id, owner)
        chunks: list[dict] = []
        for r in records:
            for c in r.get("chunk_texts") or []:
                chunks.append({**c, "doc_id": r["id"], "doc_name": r.get("name", "")})
        corpus = _OwnerCorpus(chunks=chunks, lexical=LexicalIndex(chunks), records=records)
        self._corpus[key] = corpus
        return corpus

    async def _ensure_vectors(self, svc, corpus: _OwnerCorpus) -> None:
        """Re-embed any doc whose vectors are missing (e.g. a wiped data dir)."""
        for record in corpus.records:
            if record["id"] in self._indexed:
                continue
            count = await self._vec(self._count_sync, svc, record["id"])
            if count < len(record.get("chunk_texts") or []):
                await self._vec(self._upsert_sync, svc, record)
            else:
                self._indexed.add(record["id"])

    async def retrieve(
        self, meeting_id: str, owner: str, query: str, k: int = 3,
        semantic: bool = True,
    ) -> list[Hit]:
        """Top-k chunks from the owner's docs for this meeting."""
        corpus = await self._load_corpus(meeting_id, owner)
        if not corpus.chunks:
            return []

        coverage = {
            (c["doc_id"], c["i"]): cov for c, cov in corpus.lexical.search(query, k=len(corpus.chunks))
        }

        svc = await self._semantic() if semantic else None
        if svc is not None:
            try:
                await self._ensure_vectors(svc, corpus)
                # Over-fetch, then rerank on the hybrid score: a chunk that
                # shares the question's rare words ("uptime", "Pro") should
                # beat one that is merely about the same kind of thing.
                points = await self._vec(self._query_sync, svc, meeting_id, owner, query, k * 3)
                hits = []
                for p in points:
                    i = int(p.payload.get("chunk_index", 0))
                    cov = coverage.get((p.payload["doc_id"], i), 0.0)
                    hits.append(Hit(
                        doc_id=p.payload["doc_id"], doc_name=p.payload.get("doc_name", ""),
                        locator=p.payload.get("locator", ""), text=p.payload.get("text", ""),
                        chunk_index=i, score=min(1.0, float(p.score) + LEXICAL_BONUS * cov),
                        method="semantic", lexical=cov, cosine=float(p.score),
                    ))
                hits.sort(key=lambda h: h.score, reverse=True)
                return hits[:k]
            except Exception as exc:
                print(f"[briefing] semantic query failed, using lexical: {type(exc).__name__}: {exc}")

        return [
            Hit(
                doc_id=c["doc_id"], doc_name=c["doc_name"], locator=c["locator"],
                text=c["text"], chunk_index=c["i"], score=cov, method="lexical", lexical=cov,
            )
            for c, cov in corpus.lexical.search(query, k=k)
        ]

    def _query_sync(self, svc, meeting_id: str, owner: str, query: str, k: int):
        from qdrant_client.models import FieldCondition, Filter, MatchValue

        vector = self._embed(svc, [query])[0]
        return svc._client.query_points(
            collection_name=COLLECTION,
            query=vector,
            limit=k,
            query_filter=Filter(must=[
                FieldCondition(key="meeting_id", match=MatchValue(value=meeting_id)),
                FieldCondition(key="owner", match=MatchValue(value=owner)),
            ]),
            with_payload=True,
        ).points


document_service = DocumentService()
