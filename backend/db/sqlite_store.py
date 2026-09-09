"""
SQLite-backed document store presenting the Motor collection API.

Why
---
MeetAI uses MongoDB as a plain document store: five methods, eight operators,
no aggregation pipelines. Requiring a running mongod (or an Atlas account)
just to open the app is a large amount of setup friction for something the
data model never actually exploits.

This module implements the exact subset of the Motor async collection API the
application uses, on top of SQLite:

    find_one(filter, projection)      update_one(filter, update)
    insert_one(doc)                   delete_one(filter)
    find(filter) -> cursor            count_documents(filter)
    create_indexes([...])             (async iteration, sort/skip/limit)

Supported query operators: $or, $ne, $in, $text/$search, plus dotted paths
that reach into arrays of subdocuments ("participants.username").
Supported update operators: $set, $push (with $each).
Supported projection operators: $slice, and include/exclude maps.

Documents are stored as JSON. Filtering happens in Python because the query
surface is tiny and the working set is small; uniqueness, which is the part
that must be enforced correctly, is delegated to real SQLite expression
indexes over `json_extract`, so duplicate usernames fail at the database
rather than in application code.

Selecting a backend is the job of `db/mongodb.py`; this module is unaware of
which one is active.
"""

from __future__ import annotations

import json
import re
import uuid
from datetime import date, datetime
from pathlib import Path
from typing import Any, Iterable

import aiosqlite


def _encode(value: Any) -> str:
    """
    JSON-encode a document.

    Datetimes go out as ISO 8601 rather than `str()`, which would emit a space
    between date and time. `new Date()` in the browser is inconsistent about
    that form, and a timestamp that parses as local time instead of UTC shows
    up as a meeting created "6 hours ago" the moment it is created.
    """

    def default(o: Any):
        if isinstance(o, (datetime, date)):
            return o.isoformat()
        return str(o)

    return json.dumps(value, default=default)


# ── document helpers ──────────────────────────────────────────────────
def _get_path(doc: Any, path: str) -> list[Any]:
    """
    Resolve a dotted path, fanning out through arrays.

    Mongo semantics: "participants.username" matches when *any* element of
    `participants` has that username, so this returns every value reachable
    by the path rather than a single one.
    """
    parts = path.split(".")
    current: list[Any] = [doc]

    for part in parts:
        nxt: list[Any] = []
        for node in current:
            if isinstance(node, list):
                for item in node:
                    if isinstance(item, dict) and part in item:
                        nxt.append(item[part])
            elif isinstance(node, dict) and part in node:
                nxt.append(node[part])
        current = nxt
        if not current:
            return []
    return current


def _match_value(values: list[Any], expected: Any) -> bool:
    if isinstance(expected, dict):
        for op, operand in expected.items():
            if op == "$ne":
                if any(v == operand for v in values):
                    return False
            elif op == "$in":
                if not any(v in operand for v in values):
                    return False
            elif op == "$nin":
                if any(v in operand for v in values):
                    return False
            elif op == "$exists":
                if bool(values) != bool(operand):
                    return False
            elif op == "$regex":
                rx = re.compile(operand, re.I)
                if not any(isinstance(v, str) and rx.search(v) for v in values):
                    return False
            elif op == "$gt":
                if not any(v > operand for v in values):
                    return False
            elif op == "$gte":
                if not any(v >= operand for v in values):
                    return False
            elif op == "$lt":
                if not any(v < operand for v in values):
                    return False
            elif op == "$lte":
                if not any(v <= operand for v in values):
                    return False
            else:
                raise NotImplementedError(f"unsupported query operator: {op}")
        return True

    # Scalar equality; a list field matches if any element equals the operand.
    return any(v == expected for v in values)


def _text_search(doc: dict, needle: str) -> bool:
    """
    Stand-in for a Mongo text index.

    Every term must appear somewhere in the serialised document. This is a
    substring match rather than stemmed tokenisation, which is close enough
    for meeting titles and transcripts and, unlike mongomock, actually runs.
    """
    haystack = _encode(doc).lower()
    return all(term in haystack for term in needle.lower().split())


def matches(doc: dict, query: dict) -> bool:
    """Evaluate a Mongo-style filter against one document."""
    for key, expected in query.items():
        if key == "$or":
            if not any(matches(doc, sub) for sub in expected):
                return False
        elif key == "$and":
            if not all(matches(doc, sub) for sub in expected):
                return False
        elif key == "$nor":
            if any(matches(doc, sub) for sub in expected):
                return False
        elif key == "$text":
            if not _text_search(doc, expected.get("$search", "")):
                return False
        else:
            if not _match_value(_get_path(doc, key), expected):
                return False
    return True


def apply_projection(doc: dict, projection: dict | None) -> dict:
    """Support {'field': {'$slice': n}} plus include/exclude maps."""
    if not projection:
        return doc

    out = dict(doc)
    slices = {k: v for k, v in projection.items() if isinstance(v, dict)}
    flags = {k: v for k, v in projection.items() if not isinstance(v, dict)}

    for field, spec in slices.items():
        if "$slice" in spec and isinstance(out.get(field), list):
            n = spec["$slice"]
            out[field] = out[field][n:] if n < 0 else out[field][:n]

    includes = [k for k, v in flags.items() if v and k != "_id"]
    excludes = [k for k, v in flags.items() if not v]

    if includes:
        keep = set(includes) | set(slices) | {"_id"}
        if flags.get("_id") == 0:
            keep.discard("_id")
        out = {k: v for k, v in out.items() if k in keep}
    elif excludes:
        out = {k: v for k, v in out.items() if k not in excludes}

    return out


def apply_update(doc: dict, update: dict) -> dict:
    """Apply $set and $push (with $each) to a document."""
    out = json.loads(_encode(doc))

    for op, spec in update.items():
        if op == "$set":
            for path, value in spec.items():
                _set_path(out, path, value)
        elif op == "$push":
            for path, value in spec.items():
                target = _resolve_container(out, path)
                if not isinstance(target, list):
                    target = []
                    _set_path(out, path, target)
                if isinstance(value, dict) and "$each" in value:
                    target.extend(value["$each"])
                else:
                    target.append(value)
        elif op == "$inc":
            for path, value in spec.items():
                current = _get_path(out, path)
                _set_path(out, path, (current[0] if current else 0) + value)
        elif op == "$unset":
            for path in spec:
                _unset_path(out, path)
        else:
            raise NotImplementedError(f"unsupported update operator: {op}")
    return out


def _set_path(doc: dict, path: str, value: Any) -> None:
    parts = path.split(".")
    node = doc
    for part in parts[:-1]:
        node = node.setdefault(part, {})
    node[parts[-1]] = value


def _unset_path(doc: dict, path: str) -> None:
    parts = path.split(".")
    node = doc
    for part in parts[:-1]:
        if not isinstance(node, dict) or part not in node:
            return
        node = node[part]
    if isinstance(node, dict):
        node.pop(parts[-1], None)


def _resolve_container(doc: dict, path: str) -> Any:
    found = _get_path(doc, path)
    return found[0] if found else None


# ── result objects (mirror pymongo's) ─────────────────────────────────
class InsertOneResult:
    def __init__(self, inserted_id: str) -> None:
        self.inserted_id = inserted_id
        self.acknowledged = True


class UpdateResult:
    def __init__(self, matched: int, modified: int) -> None:
        self.matched_count = matched
        self.modified_count = modified
        self.upserted_id = None
        self.acknowledged = True


class DeleteResult:
    def __init__(self, deleted: int) -> None:
        self.deleted_count = deleted
        self.acknowledged = True


class Cursor:
    """Lazily-sorted async cursor supporting sort/skip/limit chaining."""

    def __init__(self, collection: "SQLiteCollection", query: dict, projection=None):
        self._collection = collection
        self._query = query
        self._projection = projection
        self._sort: tuple[str, int] | None = None
        self._skip = 0
        self._limit = 0

    def sort(self, key: str, direction: int = 1) -> "Cursor":
        self._sort = (key, direction)
        return self

    def skip(self, n: int) -> "Cursor":
        self._skip = n
        return self

    def limit(self, n: int) -> "Cursor":
        self._limit = n
        return self

    async def _resolve(self) -> list[dict]:
        docs = await self._collection._scan(self._query)

        if self._sort:
            key, direction = self._sort
            def sort_key(d: dict):
                vals = _get_path(d, key)
                v = vals[0] if vals else None
                # None sorts last regardless of direction.
                return (v is None, v if v is not None else "")
            docs.sort(key=sort_key, reverse=direction < 0)

        if self._skip:
            docs = docs[self._skip :]
        if self._limit:
            docs = docs[: self._limit]

        return [apply_projection(d, self._projection) for d in docs]

    def __aiter__(self):
        return self._iterate()

    async def _iterate(self):
        for doc in await self._resolve():
            yield doc

    async def to_list(self, length: int | None = None) -> list[dict]:
        docs = await self._resolve()
        return docs[:length] if length else docs


# ── collection ────────────────────────────────────────────────────────
class SQLiteCollection:
    """One logical Mongo collection, backed by one SQLite table."""

    def __init__(self, db: "SQLiteDatabase", name: str) -> None:
        self.db = db
        self.name = name
        self._table = re.sub(r"\W", "_", name)

    async def _ensure_table(self) -> None:
        await self.db.conn.execute(
            f'CREATE TABLE IF NOT EXISTS "{self._table}" '
            "(_id TEXT PRIMARY KEY, doc TEXT NOT NULL)"
        )
        await self.db.conn.commit()

    async def _scan(self, query: dict) -> list[dict]:
        await self._ensure_table()
        async with self.db.conn.execute(
            f'SELECT _id, doc FROM "{self._table}"'
        ) as cur:
            rows = await cur.fetchall()

        out = []
        for _id, raw in rows:
            doc = json.loads(raw)
            doc["_id"] = _id
            if matches(doc, query):
                out.append(doc)
        return out

    async def find_one(self, query: dict, projection: dict | None = None) -> dict | None:
        docs = await self._scan(query)
        return apply_projection(docs[0], projection) if docs else None

    def find(self, query: dict | None = None, projection: dict | None = None) -> Cursor:
        return Cursor(self, query or {}, projection)

    async def insert_one(self, doc: dict) -> InsertOneResult:
        await self._ensure_table()
        doc = dict(doc)
        _id = str(doc.pop("_id", None) or uuid.uuid4().hex)
        await self.db.conn.execute(
            f'INSERT INTO "{self._table}" (_id, doc) VALUES (?, ?)',
            (_id, _encode(doc)),
        )
        await self.db.conn.commit()
        return InsertOneResult(_id)

    async def insert_many(self, docs: Iterable[dict]) -> list[str]:
        return [(await self.insert_one(d)).inserted_id for d in docs]

    async def update_one(
        self, query: dict, update: dict, upsert: bool = False
    ) -> UpdateResult:
        docs = await self._scan(query)

        if not docs:
            if upsert:
                seed = {k: v for k, v in query.items() if not k.startswith("$")}
                await self.insert_one(apply_update(seed, update))
                return UpdateResult(0, 1)
            return UpdateResult(0, 0)

        target = docs[0]
        _id = target.pop("_id")
        updated = apply_update(target, update)
        updated.pop("_id", None)

        await self.db.conn.execute(
            f'UPDATE "{self._table}" SET doc = ? WHERE _id = ?',
            (_encode(updated), _id),
        )
        await self.db.conn.commit()
        return UpdateResult(1, 1)

    async def delete_one(self, query: dict) -> DeleteResult:
        docs = await self._scan(query)
        if not docs:
            return DeleteResult(0)
        await self.db.conn.execute(
            f'DELETE FROM "{self._table}" WHERE _id = ?', (docs[0]["_id"],)
        )
        await self.db.conn.commit()
        return DeleteResult(1)

    async def delete_many(self, query: dict) -> DeleteResult:
        docs = await self._scan(query)
        for d in docs:
            await self.db.conn.execute(
                f'DELETE FROM "{self._table}" WHERE _id = ?', (d["_id"],)
            )
        await self.db.conn.commit()
        return DeleteResult(len(docs))

    async def count_documents(self, query: dict | None = None) -> int:
        return len(await self._scan(query or {}))

    async def create_indexes(self, models: list) -> list[str]:
        """
        Translate IndexModel definitions into SQLite expression indexes.

        Only uniqueness carries semantics we must preserve; ordinary indexes
        are created too, but text indexes are skipped because $text is served
        by the Python matcher.
        """
        await self._ensure_table()
        created = []

        for model in models:
            try:
                keys = list(model.document["key"].items())
                name = model.document.get("name") or "_".join(k for k, _ in keys)
                unique = bool(model.document.get("unique"))

                if any(direction == "text" for _, direction in keys):
                    continue

                exprs = ", ".join(
                    f"json_extract(doc, '$.{field}')" for field, _ in keys
                )
                await self.db.conn.execute(
                    f'CREATE {"UNIQUE " if unique else ""}INDEX IF NOT EXISTS '
                    f'"{self._table}_{name}" ON "{self._table}" ({exprs})'
                )
                created.append(name)
            except Exception as exc:  # index creation is best-effort
                print(f"index {model} skipped: {exc}")

        await self.db.conn.commit()
        return created


class SQLiteDatabase:
    """Database handle exposing collections by subscript, like Motor."""

    def __init__(self, conn: aiosqlite.Connection) -> None:
        self.conn = conn
        self._collections: dict[str, SQLiteCollection] = {}

    def __getitem__(self, name: str) -> SQLiteCollection:
        if name not in self._collections:
            self._collections[name] = SQLiteCollection(self, name)
        return self._collections[name]

    def get_collection(self, name: str) -> SQLiteCollection:
        return self[name]


async def connect(path: str | Path) -> tuple[aiosqlite.Connection, SQLiteDatabase]:
    """Open (creating if needed) the SQLite file and return a database handle."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)

    conn = await aiosqlite.connect(str(path))
    # WAL keeps reads from blocking the websocket transcript writes.
    await conn.execute("PRAGMA journal_mode=WAL")
    await conn.execute("PRAGMA synchronous=NORMAL")
    await conn.commit()

    return conn, SQLiteDatabase(conn)
