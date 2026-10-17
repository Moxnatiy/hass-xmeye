"""The record schedule's round trip between the firmware's periods and the grid.

The firmware keeps seven days of six periods, "1 08:30:00-17:00:00", each with
a mask of what to record; the panel paints half-hour slots. What matters is
that reading a day and writing it back loses nothing, and that a day which
cannot fit six periods is refused rather than cut short.

Run through node, because the code lives in the panel's own module. Skipped
where node is not installed; the CI image has it.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

MODULE = (
    Path(__file__).resolve().parent.parent
    / "custom_components"
    / "xmeye"
    / "panel"
    / "schedule.js"
)

EMPTY = ["0 00:00:00-00:00:00"] * 5
EMPTY_MASKS = ["0x00000000"] * 5


def run(script: str):
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is unavailable")
    done = subprocess.run(
        [node, "--input-type=module", "-e",
         f"const m = await import({json.dumps(MODULE.as_uri())});" + script],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert done.returncode == 0, done.stderr
    return json.loads(done.stdout)


def test_the_factory_day_round_trips() -> None:
    """What the dev recorder holds: always, all day, in the first period."""
    periods = ["1 00:00:00-24:00:00", *EMPTY]
    masks = ["0x00000007", *EMPTY_MASKS]
    got = run(
        f"const s = m.dayToSlots({json.dumps(periods)}, {json.dumps(masks)});"
        "console.log(JSON.stringify({slots: [...new Set(s)], day: m.slotsToDay(s)}));"
    )
    assert got["slots"] == [7]
    assert got["day"] == {"periods": periods, "masks": masks}


def test_a_working_week_day() -> None:
    """Motion at night, continuous during the day, nothing at lunch."""
    periods = [
        "1 00:00:00-08:00:00",
        "1 08:00:00-12:30:00",
        "1 13:30:00-18:00:00",
        "1 18:00:00-24:00:00",
        "0 00:00:00-00:00:00",
        "0 00:00:00-00:00:00",
    ]
    masks = ["0x00000002", "0x00000007", "0x00000007", "0x00000006", *EMPTY_MASKS[:2]]
    got = run(
        f"const s = m.dayToSlots({json.dumps(periods)}, {json.dumps(masks)});"
        "console.log(JSON.stringify({lunch: s.slice(25, 27), count: m.periodCount(s),"
        " day: m.slotsToDay(s)}));"
    )
    assert got["lunch"] == [0, 0]
    assert got["count"] == 4
    assert got["day"] == {"periods": periods, "masks": masks}


def test_a_seventh_period_is_refused() -> None:
    """Seven runs have nowhere to go; dropping one would leave a gap unrecorded."""
    got = run(
        "const s = new Array(m.SLOTS).fill(0);"
        "for (let i = 0; i < 7; i++) s[i * 4] = 7;"
        "console.log(JSON.stringify({count: m.periodCount(s), day: m.slotsToDay(s)}));"
    )
    assert got == {"count": 7, "day": None}


def test_disabled_and_maskless_periods_record_nothing() -> None:
    periods = ["0 08:00:00-18:00:00", "1 08:00:00-18:00:00", *EMPTY[:4]]
    masks = ["0x00000007", "0x00000000", *EMPTY_MASKS[:4]]
    got = run(
        f"const s = m.dayToSlots({json.dumps(periods)}, {json.dumps(masks)});"
        "console.log(JSON.stringify(s.some(Boolean)));"
    )
    assert got is False


def test_alignment_is_noticed() -> None:
    """A day set to the minute in the recorder's menu is not rebuilt unpainted."""
    got = run(
        "console.log(JSON.stringify(["
        "m.dayIsAligned(['1 08:30:00-17:00:00'], ['0x7']),"
        "m.dayIsAligned(['1 08:15:00-17:00:00'], ['0x7']),"
        "m.dayIsAligned(['0 08:15:00-17:00:00'], ['0x7'])]));"
    )
    assert got == [True, False, True]


def test_masks_and_kinds() -> None:
    got = run(
        "console.log(JSON.stringify({"
        "fmt: [0, 6, 7].map(m.formatMask),"
        "parse: ['0x00000006', '0x7', 4].map(m.parseMask),"
        "kind: [0, 1, 2, 4, 6, 7].map(m.maskKind)}));"
    )
    assert got == {
        "fmt": ["0x00000000", "0x00000006", "0x00000007"],
        "parse": [6, 7, 4],
        "kind": ["none", "always", "motion", "alarm", "event", "always"],
    }
