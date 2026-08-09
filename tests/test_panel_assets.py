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

#: Method definitions inside a class.
_METHOD = re.compile(r"^\s{2}(?:async\s+)?(_[A-Za-z][A-Za-z0-9]*)\s*\(", re.MULTILINE)

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


#: Fields that look like a flag (``= true/false``) and like an object at the same
#: time (``.something`` or ``= <expression>``) are nearly always a name collision.
_FLAG_ASSIGN = re.compile(r"this\.(_[A-Za-z][A-Za-z0-9]*)\s*=\s*(?:true|false)\s*;")
_OBJECT_USE = re.compile(r"this\.(_[A-Za-z][A-Za-z0-9]*)\.[A-Za-z]")


@pytest.mark.parametrize("source", SOURCES, ids=lambda p: p.name)
def test_no_flag_and_object_name_collision(source: Path) -> None:
    """One field must not be both a flag and an object.

    This is exactly how the player broke: the read loop used ``_pending`` to mean
    "time to configure the decoder", while the drawing code stored a frame in it.
    Every frame triggered a reconfigure and the video fell apart, with no error
    visible in the code itself.
    """
    text = source.read_text(encoding="utf-8")
    flags = set(_FLAG_ASSIGN.findall(text))
    objects = set(_OBJECT_USE.findall(text))

    collisions = sorted(flags & objects)
    assert not collisions, (
        f"{source.name}: {collisions} are used both as a flag and as an object. "
        "Give the two meanings different names."
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
