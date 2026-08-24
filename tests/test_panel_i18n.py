"""The panel's dictionaries against the panel's own source.

The English text is the key, which makes the code readable and costs one thing:
renaming an English string silently drops every other language back to English,
because the lookup simply misses. Nothing errors, nothing logs — a French viewer
just starts seeing English. So the keys are checked against the source here.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

PANEL = Path(__file__).resolve().parent.parent / "custom_components" / "xmeye" / "panel"
SOURCE = PANEL / "xmeye-panel.js"
I18N = PANEL / "i18n.js"

#: ``t("some text")`` and ``t("some text", { ... })`` — what the panel asks for.
#: A long sentence is written as adjacent literals joined by ``+`` so the source
#: keeps its line width; JavaScript concatenates them into the one key the
#: dictionary holds, and so does this.
CALL = re.compile(
    r"""\bt\(\s*("(?:[^"\\]|\\.)*"(?:\s*\+\s*"(?:[^"\\]|\\.)*")*)\s*[,)]""", re.S
)
PIECE = re.compile(r'"((?:[^"\\]|\\.)*)"')

#: One string literal, or several joined by ``+`` — the same thing to JavaScript.
JOINED = re.compile(r'"(?:[^"\\]|\\.)*"(?:\s*\+\s*"(?:[^"\\]|\\.)*")*', re.S)

#: Some text reaches ``t()`` through a table rather than as a literal — the
#: reasons a channel gives, the stream and player names. Those tables are built
#: once at load, before the language is known, so they hold the English source
#: and are translated where they are used. Named here because a regex looking
#: for ``t("…")`` cannot see through the indirection.
INDIRECT = ("WALL_TROUBLE", "WALL_STREAMS", "PLAYERS", "EVENT_LABELS", "SETTINGS_GROUPS")

#: Tables of ``[value, label]`` pairs, where only the label is ever shown.
PAIRED = ("WALL_STREAMS", "PLAYERS")

#: A string with no lowercase letter is the same in every language: a separator,
#: a number, an acronym like HLS or TCP. Demanding a translation for those would
#: fill four dictionaries with entries that copy their own key.
SAME_EVERYWHERE = re.compile(r"[a-z]")

#: A language is named in its own language wherever it is offered — the recorder
#: menu list reads English / Русский / 简体中文 whoever is looking at it. Only the
#: first of those has lowercase Latin letters, so only it needs saying here.
NEVER_TRANSLATED = {"English"}

#: A dictionary entry: a quoted key at the start of a line inside a language.
ENTRY = re.compile(r'^\s{2}"((?:[^"\\]|\\.)*)":', re.MULTILINE)

#: ``const UK = {`` … the languages the module carries.
LANGUAGE = re.compile(r"^const ([A-Z]{2}) = \{$", re.MULTILINE)

PLACEHOLDER = re.compile(r"\{(\w+)\}")


def dictionaries() -> dict[str, dict[str, str]]:
    """Every language's keys, in source order, without executing the module."""
    text = I18N.read_text(encoding="utf-8")
    bounds = [(m.group(1), m.start()) for m in LANGUAGE.finditer(text)]
    found: dict[str, dict[str, str]] = {}
    for index, (name, start) in enumerate(bounds):
        end = bounds[index + 1][1] if index + 1 < len(bounds) else len(text)
        block = text[start:end]
        found[name] = {key: block for key in ENTRY.findall(block)}
    return found


def asked_for() -> set[str]:
    """Every English string the panel can put on screen."""
    text = SOURCE.read_text(encoding="utf-8")
    found = {"".join(PIECE.findall(call)) for call in CALL.findall(text)}
    for name in INDIRECT:
        table = re.search(rf"^const {name} = [{{\[](.*?)^[}}\]];", text, re.M | re.S)
        assert table, f"{name} is gone from the panel; this test needs updating"
        if name == "SETTINGS_GROUPS":
            found |= schema_strings(table.group(1))
            continue
        if name in PAIRED:
            # ``["sub", "Sub"]`` — the first is what the code passes around, the
            # second is what the viewer reads.
            found |= set(re.findall(r'\[\s*"[^"]*"\s*,\s*"([^"]*)"\s*\]', table.group(1)))
            continue
        # Runs of literals joined by + are one string, here as in the calls.
        for run in JOINED.findall(table.group(1)):
            found.add("".join(PIECE.findall(run)))
    return found


def schema_strings(block: str) -> set[str]:
    """The settings schema, whose every quoted string is not for the viewer.

    A field carries a recorder key as well as a label, and an option carries the
    value written back as well as the words shown; taking the lot would demand
    translations of "OverWrite" and "115200".
    """
    found = set()
    for named in re.finditer(r"(?:title|hint|label|warning):\s*(" + JOINED.pattern + ")", block):
        found.add("".join(PIECE.findall(named.group(1))))
    # Two-element arrays in this schema are always options, written across one
    # line or several, so they are found directly rather than by first locating
    # the ``options:`` they belong to.
    for pair in re.finditer(r'\[\s*(?:"[^"]*"|\d+)\s*,\s*"([^"]*)"\s*\]', block):
        found.add(pair.group(1))
    return found


def test_the_panel_asks_for_translations() -> None:
    assert asked_for(), "no t() calls found — the extraction is broken, not the panel"
    assert dictionaries(), "no language blocks found in i18n.js"


@pytest.mark.parametrize("language", sorted(dictionaries()))
def test_no_dictionary_key_is_orphaned(language: str) -> None:
    """A key nothing asks for is a string that was renamed and left behind."""
    orphans = sorted(set(dictionaries()[language]) - asked_for())
    assert not orphans, (
        f"{language} translates strings the panel never asks for: {orphans}. "
        "Either the English text changed, or the entry is dead."
    )


@pytest.mark.parametrize("language", sorted(dictionaries()))
def test_every_language_covers_the_same_ground(language: str) -> None:
    """One language ahead of the others means a viewer sees a mixture.

    English is exempt: its dictionary holds only the handful of strings it
    cannot answer with the source text, which is the plural rules.
    """
    languages = dictionaries()
    if language == "EN":
        return
    reference = max(languages.values(), key=len)
    missing = sorted(set(reference) - set(languages[language]))
    assert not missing, f"{language} is missing: {missing}"


@pytest.mark.parametrize("language", sorted(set(dictionaries()) - {"EN"}))
def test_every_string_the_panel_shows_is_translated(language: str) -> None:
    """The other half of the orphan check, and the one a viewer notices.

    An untranslated string does not fail anywhere — it simply appears in English
    in the middle of a German page. Only counting them catches that.
    """
    wanted = {
        text
        for text in asked_for() - NEVER_TRANSLATED
        if SAME_EVERYWHERE.search(text)
    }
    untranslated = sorted(wanted - set(dictionaries()[language]))
    assert not untranslated, (
        f"{language} has no translation for {len(untranslated)} strings, "
        f"starting with: {untranslated[:5]}"
    )


def test_placeholders_match_the_source_text() -> None:
    """A value the panel passes must have somewhere to go in every language."""
    text = I18N.read_text(encoding="utf-8")
    bounds = [(m.group(1), m.start()) for m in LANGUAGE.finditer(text)]
    for index, (language, start) in enumerate(bounds):
        end = bounds[index + 1][1] if index + 1 < len(bounds) else len(text)
        block = text[start:end]
        for line in block.splitlines():
            entry = re.match(r'^\s{2}"((?:[^"\\]|\\.)*)":\s*"(.*)",?$', line)
            if not entry:
                continue  # a function entry, checked by reading rather than regex
            key, value = entry.groups()
            assert set(PLACEHOLDER.findall(key)) == set(PLACEHOLDER.findall(value)), (
                f"{language} {key!r}: placeholders differ from the source text"
            )
