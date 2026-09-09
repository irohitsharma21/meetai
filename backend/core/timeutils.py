"""
Datetime coercion for values that have been through the database.

Documents are stored as JSON, so a datetime written on the way in comes back
as an ISO 8601 string on the way out. Mongo would have handed back a real
datetime, which is why code written against Mongo does arithmetic on these
fields directly - and why that code raises

    TypeError: unsupported operand type(s) for -: 'datetime.datetime' and 'str'

the moment the SQLite backend is used. Ending a meeting hit exactly that.

Every read of a stored timestamp should go through `as_datetime`, which
accepts whatever the active backend returns and always yields something safe
to subtract, compare or format.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional


def as_datetime(value: Any) -> Optional[datetime]:
    """
    Coerce a stored timestamp into a timezone-aware datetime.

    Returns None for anything unparseable rather than raising: a missing or
    malformed timestamp should degrade a duration to "unknown", never fail the
    request that happens to touch it.
    """
    if value is None:
        return None

    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        # fromisoformat gained "Z" support only in 3.11; normalising here keeps
        # this working regardless of the interpreter.
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        try:
            parsed = datetime.fromisoformat(text)
        except ValueError:
            return None
    else:
        return None

    # Naive values are assumed UTC, because that is what the application writes.
    # Mixing naive and aware datetimes raises on subtraction, which is the same
    # class of failure this function exists to prevent.
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def elapsed_seconds(start: Any, end: Optional[datetime] = None) -> Optional[int]:
    """
    Whole seconds between two stored timestamps, or None if start is unusable.

    Clamped at zero: a negative duration is always a clock or data problem, and
    reporting "-3 seconds" to a user is worse than reporting nothing.
    """
    started = as_datetime(start)
    if started is None:
        return None
    finished = end or datetime.now(timezone.utc)
    if finished.tzinfo is None:
        finished = finished.replace(tzinfo=timezone.utc)
    return max(int((finished - started).total_seconds()), 0)
