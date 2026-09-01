"""Validated JSON input helpers for the voice actuator's Python bridges."""

from __future__ import annotations

import json
from typing import Any

_DANGEROUS_KEYS = {"__proto__", "constructor", "prototype"}


class JsonInputError(ValueError):
    """Raised when a bridge payload is not a safe JSON object."""


def _has_dangerous_key(value: Any) -> bool:
    if isinstance(value, dict):
        return any(
            key in _DANGEROUS_KEYS or _has_dangerous_key(nested)
            for key, nested in value.items()
        )
    if isinstance(value, list):
        return any(_has_dangerous_key(item) for item in value)
    return False


def parse_json_object(raw: str, label: str) -> dict[str, Any]:
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise JsonInputError(f"{label} must be valid JSON") from exc
    if not isinstance(value, dict):
        raise JsonInputError(f"{label} must be a JSON object")
    if _has_dangerous_key(value):
        raise JsonInputError(f"{label} contains a dangerous JSON key")
    return value
