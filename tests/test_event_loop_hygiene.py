"""Nothing in the integration may touch the disk from the event loop.

Home Assistant patches ``open`` to catch this and logs a warning naming the
line, which is how the debug log was found doing it: once per channel per
announcement, with a wall running.

Read off the source, because these modules import Home Assistant and the
offline suite does not have it. The real check is the behavioural one — fifty
notes produced zero writes on the loop thread — but that needs a running loop
and Home Assistant installed, so this is what CI can keep.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

COMPONENT = Path(__file__).resolve().parent.parent / "custom_components" / "xmeye"
DEBUGLOG = COMPONENT / "debuglog.py"

#: Calls that reach the filesystem. Reading one small file at setup is a
#: different matter from writing on every frame, so this is about the writes.
WRITES = re.compile(r"\.open\(|\.write_text\(|\.touch\(|\.unlink\(|\.replace\(")


def method(source: str, name: str) -> str:
    """One method's source, to the next definition at the same indent."""
    found = re.search(
        rf"\n    (?:async )?def {name}\(.*?(?=\n    (?:async )?def |\n\nclass |\n\ndef |\Z)",
        source,
        re.S,
    )
    assert found, f"{name} is gone from debuglog.py; this test needs updating"
    return found.group(0)


def writing_methods(source: str) -> set[str]:
    """Every method whose own body reaches the filesystem."""
    found = set()
    for name in re.findall(r"\n    (?:async )?def (\w+)\(", source):
        if any(WRITES.search(line) for line in method(source, name).splitlines()):
            found.add(name)
    return found


#: Called while the event loop is running, so none of them may reach the disk —
#: not directly, and not through something that does. ``note_client`` is the
#: exception that proves the rule: the view already hands it to an executor.
ON_THE_LOOP = ["note", "turn", "_hold"]


@pytest.mark.parametrize("name", ON_THE_LOOP)
def test_no_debug_log_entry_point_reaches_the_disk(name: str) -> None:
    """Checked one call deep, because the first version of this was not.

    Looking only inside the method missed ``turn`` touching its marker file
    through a helper — the write was one call away, which is exactly where it
    will be next time too.
    """
    source = DEBUGLOG.read_text(encoding="utf-8")
    writers = writing_methods(source)
    assert writers, "nothing writes at all; this test has lost its grip"

    body = method(source, name)
    offending = [line.strip() for line in body.splitlines() if WRITES.search(line)]
    assert not offending, (
        f"{name} touches the disk itself: {offending}. It runs on the event "
        "loop, where a disk round trip stalls every camera on the wall."
    )

    called = {m for m in writers if f"self.{m}(" in body}
    assert not called, (
        f"{name} calls {sorted(called)}, which write. On the loop that is the "
        "same fault one step removed: hold the line and let the executor do it."
    )


def test_the_writer_is_only_reached_from_a_thread() -> None:
    """``_write`` is the one place that writes, and never from the loop."""
    source = DEBUGLOG.read_text(encoding="utf-8")
    callers = {
        line.strip()
        for line in source.splitlines()
        if "self._write(" in line and "def _write" not in line
    }
    # _drain hands it to an executor; note_client is already on one.
    assert callers <= {
        "await self.hass.async_add_executor_job(self._write, batch)",
        "self._write(lines)",
    }, f"unexpected caller of _write: {sorted(callers)}"


def test_the_switch_is_scheduled_as_a_coroutine() -> None:
    """``async_create_background_task`` takes a coroutine, not a future.

    ``async_add_executor_job`` returns a future, and handing that straight to
    the task factory raises — which the first version of this fix did, in the
    one path the behavioural probe happened not to exercise.
    """
    source = DEBUGLOG.read_text(encoding="utf-8")
    for call in re.findall(r"async_create_background_task\(\s*([^,]+),", source):
        assert "async_add_executor_job" not in call, (
            f"a future is being scheduled as a task: {call.strip()}"
        )
