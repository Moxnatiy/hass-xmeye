"""Keeping the recorder's secrets out of the panel, and putting them back.

The panel reads configuration sections to edit them, and a section can hold a
password: an IP camera's, the mail server's, the time server's. Those are
masked before they leave Home Assistant. The panel then sends the section back
whole — the firmware replaces a section entirely — with the mask still in
place, and written as it came, "***" would become the password. So on the way
back every masked value is replaced by the one the recorder holds now.

No Home Assistant here, so the offline tests can run it.
"""

from __future__ import annotations

from typing import Any

#: What a masked value reads as in the panel.
MASK = "***"

#: Keys whose values must never reach the interface. The Sofia password hash is
#: equivalent to the password: it can be used to log in directly.
SECRET_HINTS = ("password", "passwd", "secret", "key", "token", "serialno", "uuid")


def is_secret(key: str) -> bool:
    return bool(key) and any(hint in key.lower() for hint in SECRET_HINTS)


def mask(value: Any, key: str = "") -> Any:
    """A copy of a section with every secret replaced by the mask."""
    if is_secret(key):
        return MASK
    if isinstance(value, dict):
        return {k: mask(v, k) for k, v in value.items()}
    if isinstance(value, list):
        return [mask(v, key) for v in value]
    return value


def unmask(value: Any, current: Any, key: str = "") -> Any:
    """A section from the panel, with each mask replaced by what is stored.

    Walks the two side by side: a list element is matched by position, as the
    firmware's arrays are positional — channel 3 is the third entry. A secret
    the panel actually changed is not the mask and goes through as typed. A
    mask with nothing stored behind it becomes empty rather than "***".
    """
    if value == MASK and is_secret(key):
        return current if current is not None and current != MASK else ""
    if isinstance(value, dict):
        stored = current if isinstance(current, dict) else {}
        return {k: unmask(v, stored.get(k), k) for k, v in value.items()}
    if isinstance(value, list):
        stored = current if isinstance(current, list) else []
        return [
            unmask(v, stored[i] if i < len(stored) else None, key)
            for i, v in enumerate(value)
        ]
    return value
