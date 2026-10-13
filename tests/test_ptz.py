"""How a PTZ command is put to the recorder.

``OPPTZControl`` starts and stops a movement with the same command, told apart
only by ``Preset``: 65535 starts, -1 stops. Sending -1 for both — what the
client did until a camera that could move was put on the dev recorder — is
answered with OK every time and moves nothing.
"""

from __future__ import annotations

from typing import Any

import pytest

from xmeye import Msg, PtzCommand, XmeyeClient


@pytest.fixture
def sent(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    """The ``OPPTZControl`` bodies the client sends, in order."""
    bodies: list[dict[str, Any]] = []

    async def command(self, msgid, payload, **kwargs):
        assert msgid == Msg.PTZ
        bodies.append(payload["OPPTZControl"])
        return {"Ret": 100}

    monkeypatch.setattr(XmeyeClient, "command", command)
    return bodies


async def test_a_move_starts_with_65535_and_stops_with_minus_one(sent) -> None:
    client = XmeyeClient("192.0.2.1")
    await client.ptz_move(PtzCommand.LEFT, channel=2, step=6, duration=0)

    assert [b["Command"] for b in sent] == ["DirectionLeft", "DirectionLeft"]
    assert [b["Parameter"]["Preset"] for b in sent] == [65535, -1]
    assert all(b["Parameter"]["Channel"] == 2 for b in sent)
    assert all(b["Parameter"]["Step"] == 6 for b in sent)


async def test_a_preset_command_carries_the_preset_number(sent) -> None:
    client = XmeyeClient("192.0.2.1")
    await client.ptz(PtzCommand.GOTO_PRESET, channel=2, preset=3)
    # A preset number wins over the stop flag: they share the one field.
    await client.ptz(PtzCommand.SET_PRESET, channel=2, preset=4, stop=True)

    assert [b["Parameter"]["Preset"] for b in sent] == [3, 4]
