"""How a PTZ command is put to the recorder.

``OPPTZControl`` starts and stops a movement with the same command, told apart
only by ``Preset``: 65535 starts, -1 stops. Sending -1 for both — what the
client did until a camera that could move was put on the dev recorder — is
answered with OK every time and moves nothing.
"""

from __future__ import annotations

import asyncio
import importlib.util
import sys
import types
from pathlib import Path
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


# ---------------------------------------------------------------------------
# The panel's side: PtzControl in the integration
# ---------------------------------------------------------------------------

COMPONENT = Path(__file__).resolve().parent.parent / "custom_components" / "xmeye"


def _load_ptz_module():
    """``ptz.py`` on its own, with the library in place of its vendored copy.

    The integration package imports Home Assistant on the way in, and the
    offline suite does not have it; this module needs only asyncio and the
    library, so it is loaded under a stand-in package. The vendored copy is
    checked to match the library elsewhere, so nothing is lost.
    """
    import xmeye

    package = types.ModuleType("_xmeye_component")
    package.__path__ = [str(COMPONENT)]
    sys.modules["_xmeye_component"] = package
    sys.modules["_xmeye_component.xmeyelib"] = xmeye
    spec = importlib.util.spec_from_file_location("_xmeye_component.ptz", COMPONENT / "ptz.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


ptz_module = _load_ptz_module()


class FakeClient:
    """Records every PTZ command, with the time it was sent."""

    log: list[tuple[float, str, int, bool]] = []

    def __init__(self, host: str, **kwargs: Any) -> None:
        self.connected = False

    async def login(self) -> None:
        self.connected = True

    async def ptz(self, command, *, channel=0, step=5, stop=False, preset=None):
        FakeClient.log.append((asyncio.get_running_loop().time(), command, channel, stop))
        # The wire takes time: without it nothing ever overlaps, and the race
        # below could not happen.
        await asyncio.sleep(0.01)
        return {"Ret": 100}

    async def close(self) -> None:
        self.connected = False


@pytest.fixture
def control(monkeypatch: pytest.MonkeyPatch):
    FakeClient.log = []
    monkeypatch.setattr(ptz_module, "XmeyeClient", FakeClient)
    monkeypatch.setattr(ptz_module, "HOLD_TIMEOUT", 0.2)
    return ptz_module.PtzControl({"host": "192.0.2.1", "username": "u", "password": "", "port": 1})


async def test_a_held_movement_is_started_once_and_stopped_on_release(control) -> None:
    for _ in range(4):
        await control.move(2, "DirectionLeft", 5)
        await asyncio.sleep(0.05)
    await control.stop(2)

    assert [(c, ch, stop) for _, c, ch, stop in FakeClient.log] == [
        ("DirectionLeft", 2, False),
        ("DirectionLeft", 2, True),
    ]


async def test_the_camera_stops_when_the_panel_goes_quiet(control) -> None:
    """A tab closed mid-press must not leave the camera turning."""
    await control.move(2, "DirectionUp", 5)
    started = FakeClient.log[0][0]
    await asyncio.sleep(0.35)

    assert [(c, stop) for _, c, _, stop in FakeClient.log] == [
        ("DirectionUp", False),
        ("DirectionUp", True),
    ]
    assert FakeClient.log[1][0] - started >= 0.2


async def test_repeats_keep_the_watchdog_away(control) -> None:
    for _ in range(6):
        await control.move(2, "ZoomTile", 5)
        await asyncio.sleep(0.1)
    assert all(not stop for *_, stop in FakeClient.log)
    await control.close()
    assert FakeClient.log[-1][1:] == ("ZoomTile", 2, True)


async def test_a_new_direction_stops_the_old_one_first(control) -> None:
    await control.move(2, "DirectionLeft", 5)
    await control.move(2, "DirectionRight", 5)
    await control.stop(2)

    assert [(c, stop) for _, c, _, stop in FakeClient.log] == [
        ("DirectionLeft", False),
        ("DirectionLeft", True),
        ("DirectionRight", False),
        ("DirectionRight", True),
    ]


async def test_a_stop_racing_the_start_stops_that_movement(control) -> None:
    """The panel can send a stop before the start's reply is back."""
    await asyncio.gather(control.move(2, "DirectionDown", 5), control.stop(2))
    await asyncio.sleep(0.3)

    assert [(c, stop) for _, c, _, stop in FakeClient.log] == [
        ("DirectionDown", False),
        ("DirectionDown", True),
    ]
