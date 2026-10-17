"""What a configuration write's answer means.

The recorder answers 603 to a change of its menu language, every time: it took
the value and will use it after a restart. The library used to read that as a
failure ("configuration must be saved"), so the panel reported an error for a
setting that had in fact been written — and then the language changed on the
next reboot anyway. The codes are named here as the SDK names them.
"""

from __future__ import annotations

import pytest

from xmeye import CommandFailed, XmeyeClient, needs_restart


def answering(monkeypatch: pytest.MonkeyPatch, ret: int) -> None:
    async def command(self, msgid, payload, **kwargs):
        return {"Name": payload["Name"], "Ret": ret}

    monkeypatch.setattr(XmeyeClient, "command", command)


@pytest.mark.parametrize("ret", [150, 602, 603])
async def test_a_write_kept_for_after_a_restart_is_a_success(monkeypatch, ret) -> None:
    answering(monkeypatch, ret)
    reply = await XmeyeClient("192.0.2.1").set_config("General.Location", {"Language": "English"})
    assert needs_restart(reply)


async def test_a_plain_success_needs_no_restart(monkeypatch) -> None:
    answering(monkeypatch, 100)
    reply = await XmeyeClient("192.0.2.1").set_config("General.General", {})
    assert not needs_restart(reply)


@pytest.mark.parametrize("ret", [604, 605, 606, 608])
async def test_a_refused_write_still_raises(monkeypatch, ret) -> None:
    answering(monkeypatch, ret)
    with pytest.raises(CommandFailed) as caught:
        await XmeyeClient("192.0.2.1").set_config("General.General", {})
    assert caught.value.ret == ret
