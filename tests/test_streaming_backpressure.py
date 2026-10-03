"""The wall's channels must never stop reading their recorder.

These are read off the source rather than run, because ``http.py`` imports Home
Assistant and the offline suite does not have it. That is a weak kind of test
and it is here anyway: the fault it guards is invisible in every ordinary run,
takes two minutes of a real stream to appear, and then never stops.

What happened: a channel that could not fit a keyframe into the shared queue
waited for room. The browser had stopped reading, so room never came, and that
task is the only reader of its own DVRIP connection — so the recorder's queue
filled behind it and every packet after that was dropped. Measured on the
device: the shared queue pinned full from 30 s, drops beginning at 130 s and
climbing for as long as it was watched. A user's log had one connection at
19,170,855.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

HTTP = Path(__file__).resolve().parent.parent / "custom_components" / "xmeye" / "http.py"


def body_of(name: str) -> str:
    """The source of one method, up to the next one at the same indent."""
    source = HTTP.read_text(encoding="utf-8")
    found = re.search(
        rf"\n    async def {name}\(.*?(?=\n    (?:async )?def |\n\nclass |\Z)", source, re.S
    )
    assert found, f"{name} is gone from http.py; this test needs updating"
    return found.group(0)


def test_a_channel_never_waits_without_a_deadline_for_the_browser() -> None:
    """``await queue.put`` with nothing bounding it is the whole fault."""
    carry = body_of("_carry")
    unbounded = [
        line.strip()
        for line in carry.splitlines()
        if re.search(r"await self\.queue\.put\(", line)
    ]
    assert unbounded, "the put is gone entirely; check this still describes the code"

    # Every one of them has to sit under a timeout. The deadline is what turns
    # "this channel pauses" into "this channel keeps the recorder read".
    assert "asyncio.timeout(QUEUE_WAIT)" in carry, (
        "a channel waits for the browser with no deadline. While it waits it "
        "reads nothing from the recorder, whose queue then overflows and drops "
        "every packet from then on — which does not stop when the browser "
        "recovers, because nothing is reading to notice."
    )


def test_giving_up_on_a_keyframe_is_not_giving_up_on_the_stream() -> None:
    """After the deadline the loop must carry on, not return or raise."""
    carry = body_of("_carry")
    after = carry.split("except TimeoutError:", 1)
    assert len(after) == 2, "the deadline no longer has a handler"
    handler = after[1].split("finally:", 1)[0]
    for word in ("return", "raise", "break"):
        assert not re.search(rf"\n\s+{word}\b", handler), (
            f"the handler says {word!r}: a browser that stutters would end the "
            "channel instead of costing it one keyframe"
        )


@pytest.mark.parametrize("name", ["QUEUE_WAIT", "MUX_QUEUE"])
def test_the_limits_are_named_and_explained(name: str) -> None:
    source = HTTP.read_text(encoding="utf-8")
    declared = re.search(rf"^{name} = ", source, re.M)
    assert declared, f"{name} is gone"


def test_the_socket_writer_does_not_die_in_silence() -> None:
    """A writer that stops must close the socket behind it.

    Nothing awaited that task. When the send side failed, the reader went on
    waiting for a message that would never come, the channels went on filling a
    queue with no reader, and their recorder connections stayed open behind it.
    """
    source = HTTP.read_text(encoding="utf-8")
    writer = re.search(r"async def pump_to_socket.*?(?=\n        try:)", source, re.S)
    assert writer, "pump_to_socket is gone; this test needs updating"
    assert "await socket.close()" in writer.group(0), (
        "the writer can stop without closing the socket, which leaves the "
        "reader waiting and the channels pumping into nothing"
    )
