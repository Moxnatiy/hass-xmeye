"""Static checks over the panel code.

The panel is JavaScript and these Python tests never run it. But the costliest
mistake here turned out to be structural rather than logical: an edit removed a
method together with the block it lived in and left the call behind. In Chromium
the branch with the call never ran, so everything looked fine, and the breakage
only showed up in the user's Safari. These checks catch that class of problem at
once.
"""

from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

PANEL_DIR = Path(__file__).resolve().parent.parent / "custom_components" / "xmeye" / "panel"
SOURCES = sorted(PANEL_DIR.glob("*.js"))

#: Calls of the form ``this._something(`` — these are what must be defined.
_CALL = re.compile(r"this\.(_[A-Za-z][A-Za-z0-9]*)\s*\(")

#: Method definitions inside a class. ``get``/``set`` count: an accessor that
#: returns a function is called exactly like a method, and reads like one.
_METHOD = re.compile(
    r"^\s{2}(?:async\s+|get\s+|set\s+)?(_[A-Za-z][A-Za-z0-9]*)\s*\(", re.MULTILINE
)

#: Assignments of the form ``this._something = () =>`` also make a method callable.
_ASSIGNED = re.compile(r"this\.(_[A-Za-z][A-Za-z0-9]*)\s*=")


def test_panel_sources_exist() -> None:
    assert SOURCES, "the panel directory holds no modules"


@pytest.mark.parametrize("source", SOURCES, ids=lambda p: p.name)
def test_every_called_method_is_defined(source: Path) -> None:
    """Every ``this._method()`` must be defined in the same module."""
    text = source.read_text(encoding="utf-8")
    defined = set(_METHOD.findall(text)) | set(_ASSIGNED.findall(text))
    called = set(_CALL.findall(text))

    missing = sorted(called - defined)
    assert not missing, (
        f"{source.name}: called but not defined: {missing}. "
        "Most likely the method vanished during a text edit."
    )


@pytest.mark.parametrize("source", SOURCES, ids=lambda p: p.name)
def test_syntax_is_valid(source: Path) -> None:
    """A syntax check through node, when node is available."""
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is unavailable")
    result = subprocess.run(
        [node, "--check", str(source)], capture_output=True, text=True, timeout=60
    )
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize("source", SOURCES, ids=lambda p: p.name)
def test_no_leftover_duplicate_methods(source: Path) -> None:
    """The same method must not be defined twice.

    A duplicate means an edit added a new version without removing the old one:
    the last definition wins, and it is almost never the intended one.
    """
    names = _METHOD.findall(source.read_text(encoding="utf-8"))
    duplicates = sorted({name for name in names if names.count(name) > 1})
    assert not duplicates, f"{source.name}: methods defined twice: {duplicates}"


def test_panel_imports_resolve() -> None:
    """Every import of a sibling module must point at a file that exists."""
    pattern = re.compile(r"""["'](\./[^"'?]+\.js)""")
    for source in SOURCES:
        for target in pattern.findall(source.read_text(encoding="utf-8")):
            assert (PANEL_DIR / target).exists(), f"{source.name} → {target} is missing"


#: Fields assigned a plain value (a flag, a number, a string) and also used as an
#: object (``.something``) are nearly always two meanings sharing one name.
#: ``null`` is left out: assigning it to an object field is ordinary teardown.
_SCALAR_ASSIGN = re.compile(
    r"""this\.(_[A-Za-z][A-Za-z0-9]*)\s*=\s*"""
    r"""(?:true|false|"[^"\n]*"|'[^'\n]*'|\d+(?:\.\d+)?)\s*;"""
)
_OBJECT_USE = re.compile(r"this\.(_[A-Za-z][A-Za-z0-9]*)\.[A-Za-z]")


@pytest.mark.parametrize("source", SOURCES, ids=lambda p: p.name)
def test_no_scalar_and_object_name_collision(source: Path) -> None:
    """One field must not be both a plain value and an object.

    This is exactly how the player broke twice. First ``_pending`` meant "time to
    configure the decoder" to the read loop while the drawing code stored a frame
    in it, so every frame triggered a reconfigure. Then ``_player`` held the live
    playback method ("native"/"hls") *and* the archive player object, so
    ``_stopPlayback()`` nulled the method and the viewer silently dropped to
    snapshots at one frame per second.

    Neither produced an error anywhere near the cause.
    """
    text = source.read_text(encoding="utf-8")
    scalars = set(_SCALAR_ASSIGN.findall(text))
    objects = set(_OBJECT_USE.findall(text))

    collisions = sorted(scalars & objects)
    assert not collisions, (
        f"{source.name}: {collisions} are used both as a plain value and as an "
        "object. Give the two meanings different names."
    )


#: ``dataset.someName`` reads in the handlers, and the ``data-some-name``
#: attributes the templates write.
_DATASET_READ = re.compile(r"\.dataset\.([A-Za-z][A-Za-z0-9]*)")
_DATA_ATTR = re.compile(r"data-([a-z][a-z0-9-]*)\s*=")


def _camel(attribute: str) -> str:
    head, *tail = attribute.split("-")
    return head + "".join(part.capitalize() for part in tail)


@pytest.mark.parametrize("source", SOURCES, ids=lambda p: p.name)
def test_dataset_reads_have_matching_attributes(source: Path) -> None:
    """Every ``dataset.x`` read must have a ``data-x`` written somewhere.

    Markup and handlers sit hundreds of lines apart, so renaming an attribute in
    one place and not the other produces a control that silently does nothing.
    """
    text = source.read_text(encoding="utf-8")
    written = {_camel(name) for name in _DATA_ATTR.findall(text)}
    read = set(_DATASET_READ.findall(text))

    orphans = sorted(read - written)
    assert not orphans, (
        f"{source.name}: handlers read {orphans}, but no template writes them."
    )


#: The wall methods that run while players already exist, and so reach the
#: reconciling half of ``_startWall`` rather than its dialling half.
_RECONCILERS = ("_syncWallPlayers", "_sendWallChannels")


def test_wall_restart_clears_the_players_first() -> None:
    """A wall restart asked for from a reconciler must stop the wall first.

    ``_startWall`` reconciles when players exist and dials when none do, and
    ``_syncWallPlayers`` is what reconciling calls. So a reconciler that asks for
    a restart without clearing gets its own caller back, forever: the browser tab
    locks up with no error, and the page has to be killed. That is not a
    hypothetical — it happened, and the only symptom was an unresponsive panel.
    """
    lines = (PANEL_DIR / "xmeye-panel.js").read_text(encoding="utf-8").splitlines()
    method = None
    unguarded = []
    for number, line in enumerate(lines):
        found = re.match(r"\s{2}(?:async\s+)?(_[A-Za-z0-9]+)\(", line)
        if found:
            method = found.group(1)
        if method in _RECONCILERS and "this._startWall()" in line:
            before = "\n".join(lines[max(0, number - 5) : number])
            if "this._stopWall()" not in before:
                unguarded.append(f"{method}, line {number + 1}")

    assert not unguarded, (
        f"restart without clearing the wall first: {unguarded}. Call "
        "this._stopWall() immediately before, or _startWall comes straight back."
    )


def test_paced_playback_never_empties_its_own_read_ahead() -> None:
    """The archive's queue must not be shed the way the live one is.

    Live viewing shows frames as they arrive, so a full queue means the browser
    is hopelessly behind and the only sane move is to drop everything and wait
    for a keyframe. The archive holds the identical queue back on purpose — it
    is a read-ahead buffer, filled at seven times real time and drained by a
    clock, so full is its normal state. Applying the live rule there discarded a
    group of pictures every few seconds and left the decoder waiting for a
    keyframe with nothing on screen. The two cases are one function apart, which
    is exactly how they came to share a rule they should not.
    """
    source = (PANEL_DIR / "native-player.js").read_text(encoding="utf-8")
    body = re.search(r"\n  _enqueue\([^)]*\) \{(.*?)\n  \}\n", source, re.S)
    assert body, "_enqueue is gone from the player; this test needs updating"

    clearing = [
        line
        for line in body.group(1).splitlines()
        if "_backlog.length = 0" in line or "_backlog.length=0" in line
    ]
    if clearing:
        guard = re.search(r"if \(!this\.rate && this\._backlog\.length >= BACKLOG\)", body.group(1))
        assert guard, (
            "_enqueue empties the backlog without checking this.rate first, so "
            "archive playback sheds the read-ahead it is deliberately holding."
        )
