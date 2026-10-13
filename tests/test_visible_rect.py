"""The correction for decoders that misreport a frame's visible area.

Issue #5: Edge on Windows, decoding HEVC in hardware, returns frames whose
``visibleRect`` is far smaller than the picture they hold, so the native player
drew a corner of each frame blown up to fill the tile. ``trueVisibleRect``
decides when a frame needs its visible area put right, and to what.

Run through node, because the function lives in the panel's own module and a
copy of its logic in Python would only test the copy. Skipped where node is
not installed; the CI image has it.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

PLAYER = (
    Path(__file__).resolve().parent.parent
    / "custom_components"
    / "xmeye"
    / "panel"
    / "native-player.js"
)

#: (name, frame as the decoder describes it, stream info from the recorder, expected)
CASES = [
    (
        # The figures from the report: coded 1952x1088, the picture 1928x1088,
        # and Edge claiming 1280x720 of it.
        "edge, as reported",
        {"codedWidth": 1952, "codedHeight": 1088,
         "visibleRect": {"x": 0, "y": 0, "width": 1280, "height": 720},
         "displayWidth": 1280, "displayHeight": 720},
        {"width": 1928, "height": 1088},
        {"x": 0, "y": 0, "width": 1928, "height": 1088},
    ),
    (
        # What Chrome hands back for the same kind of stream: left alone.
        "chrome, 4K main stream",
        {"codedWidth": 3840, "codedHeight": 2176,
         "visibleRect": {"x": 0, "y": 0, "width": 3840, "height": 2160},
         "displayWidth": 3840, "displayHeight": 2160},
        {"width": 3840, "height": 2160},
        None,
    ),
    (
        "chrome, sub stream",
        {"codedWidth": 704, "codedHeight": 576,
         "visibleRect": {"x": 0, "y": 0, "width": 704, "height": 576},
         "displayWidth": 704, "displayHeight": 576},
        {"width": 704, "height": 576},
        None,
    ),
    (
        # The recorder rounds to eight pixels and the SPS crops to the pixel, so
        # a visible area a few pixels off the header is honest, not a fault.
        "header rounding is not a fault",
        {"codedWidth": 2880, "codedHeight": 1632,
         "visibleRect": {"x": 0, "y": 0, "width": 2880, "height": 1620},
         "displayWidth": 2880, "displayHeight": 1620},
        {"width": 2880, "height": 1624},
        None,
    ),
    (
        # A frame cannot show more than it holds; the target is clamped to the
        # coded size rather than asking for an area the constructor refuses.
        "never beyond the coded size",
        {"codedWidth": 1920, "codedHeight": 1080,
         "visibleRect": {"x": 0, "y": 0, "width": 1280, "height": 720},
         "displayWidth": 1280, "displayHeight": 720},
        {"width": 2560, "height": 1440},
        {"x": 0, "y": 0, "width": 1920, "height": 1080},
    ),
    (
        # Without the recorder's own figure there is nothing trustworthy to put
        # in its place, so the decoder's stands.
        "no stream info",
        {"codedWidth": 1952, "codedHeight": 1088,
         "visibleRect": {"x": 0, "y": 0, "width": 1280, "height": 720},
         "displayWidth": 1280, "displayHeight": 720},
        None,
        None,
    ),
]


def test_true_visible_rect() -> None:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is unavailable")
    script = (
        f"const m = await import({json.dumps(PLAYER.as_uri())});"
        f"const cases = {json.dumps([[frame, info] for _, frame, info, _ in CASES])};"
        "console.log(JSON.stringify(cases.map(([f, i]) => m.trueVisibleRect(f, i))));"
    )
    done = subprocess.run(
        [node, "--input-type=module", "-e", script],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert done.returncode == 0, done.stderr

    got = json.loads(done.stdout)
    wrong = [
        f"{name}: expected {expected}, got {answer}"
        for (name, _, _, expected), answer in zip(CASES, got, strict=True)
        if answer != expected
    ]
    assert not wrong, "\n".join(wrong)


def test_every_drawn_frame_goes_through_the_correction() -> None:
    """The function is no use unless the paint path asks it.

    Read off the source: ``_draw`` must hand each decoded frame to ``_uncrop``
    before it is held for the next screen refresh, or the correction exists and
    nothing calls it. Both the live wall and the archive draw through ``_draw``.
    """
    source = PLAYER.read_text(encoding="utf-8")
    draw = source.split("\n  _draw(frame) {", 1)
    assert len(draw) == 2, "_draw is gone; this test needs updating"
    body = draw[1].split("\n  }\n", 1)[0]
    uncrop = body.find("this._uncrop(frame)")
    held = body.find("this._pendingFrame = frame")
    assert uncrop != -1, "_draw never asks _uncrop to put the visible area right"
    assert held != -1, "_draw no longer holds the frame; this test needs updating"
    assert uncrop < held, "the frame is held for painting before it is corrected"
