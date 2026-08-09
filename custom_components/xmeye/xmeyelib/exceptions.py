"""Exceptions raised by the XMeye client."""

from __future__ import annotations

from .const import RET_MESSAGES


class XmeyeError(Exception):
    """Base class for every error this package raises."""


class ConnectionFailed(XmeyeError):
    """The TCP connection could not be established or was lost."""


class DeviceSilent(XmeyeError):
    """The recorder accepted the request but never answered.

    The connection itself stays usable. Some firmware behaves this way for
    configuration section names it does not recognise.
    """


class ProtocolError(XmeyeError):
    """The recorder sent something that does not match the protocol."""


class NotConnected(XmeyeError):
    """The operation needs an open connection."""


class LoginFailed(XmeyeError):
    """Authentication was rejected."""


class CommandFailed(XmeyeError):
    """The recorder answered with an error code in the ``Ret`` field."""

    def __init__(self, ret: int, command: str = "", payload: dict | None = None) -> None:
        self.ret = ret
        self.command = command
        self.payload = payload or {}
        text = RET_MESSAGES.get(ret, "unknown code")
        where = f" ({command})" if command else ""
        super().__init__(f"Ret={ret}: {text}{where}")


class UnsupportedFeature(CommandFailed):
    """The recorder does not support the requested command or config section."""
