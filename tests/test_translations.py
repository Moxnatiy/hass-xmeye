"""Every language says the same things, in the same places.

Translations rot quietly: a key is added in English and nowhere else, and the
only symptom is a raw identifier appearing in one user's interface and nobody
else's. Home Assistant will not complain, so this does.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

TRANSLATIONS = (
    Path(__file__).resolve().parent.parent / "custom_components" / "xmeye" / "translations"
)
BASE = TRANSLATIONS / "en.json"
OTHERS = sorted(p for p in TRANSLATIONS.glob("*.json") if p != BASE)

#: ``{host}``, ``{names}`` — Home Assistant fills these in, and a translation
#: that drops or renames one produces a broken sentence at best.
PLACEHOLDER = re.compile(r"\{(\w+)\}")


def load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def leaves(value, path: str = "") -> dict[str, str]:
    if isinstance(value, dict):
        found: dict[str, str] = {}
        for key, item in value.items():
            found |= leaves(item, f"{path}/{key}")
        return found
    return {path: value}


def test_there_are_translations_to_check() -> None:
    assert BASE.exists(), "en.json is the source every other file is measured against"
    assert OTHERS, "no other languages found"


@pytest.mark.parametrize("path", OTHERS, ids=lambda p: p.name)
def test_same_keys_as_english(path: Path) -> None:
    english = leaves(load(BASE))
    other = leaves(load(path))

    missing = sorted(set(english) - set(other))
    extra = sorted(set(other) - set(english))
    assert not missing, f"{path.name} is missing: {missing}"
    assert not extra, f"{path.name} has keys English does not: {extra}"


@pytest.mark.parametrize("path", OTHERS, ids=lambda p: p.name)
def test_placeholders_survive_translation(path: Path) -> None:
    """A translated sentence must still name every value put into it."""
    english = leaves(load(BASE))
    other = leaves(load(path))

    for key, text in english.items():
        assert set(PLACEHOLDER.findall(text)) == set(PLACEHOLDER.findall(other[key])), (
            f"{path.name} {key}: placeholders differ — "
            f"{PLACEHOLDER.findall(text)} against {PLACEHOLDER.findall(other[key])}"
        )


@pytest.mark.parametrize("path", [BASE, *OTHERS], ids=lambda p: p.name)
def test_nothing_is_left_untranslated_by_accident(path: Path) -> None:
    """No empty strings, and no leftover markers from a half-finished pass."""
    for key, text in leaves(load(path)).items():
        assert isinstance(text, str) and text.strip(), f"{path.name} {key} is empty"
        assert "TODO" not in text, f"{path.name} {key} still says TODO"
