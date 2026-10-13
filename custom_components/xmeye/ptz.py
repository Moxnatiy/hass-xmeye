"""Pan, tilt and zoom held from the panel.

A camera moves from the start command until the stop command, so whoever starts
a movement owes the stop. A browser cannot be trusted with that alone: a tab
closed mid-press, a phone put to sleep, a network that drops — each leaves the
camera turning until it hits its end stop. So the panel repeats the start while
the button is held, and a watchdog here stops the camera when the repeats stop
coming.

Plain asyncio rather than Home Assistant's helpers, so the offline test suite —
which has no Home Assistant — can run the watchdog for real.

The commands go over a connection of their own. The coordinator's session is
shared with the poll, which holds it for a second or more at a time, and a stop
that waits behind a poll is a camera that overshoots by a second.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from .xmeyelib import PtzCommand, XmeyeClient, XmeyeError

_LOGGER = logging.getLogger(__name__)

#: How long a movement runs without hearing from the panel. The panel repeats
#: every HOLD_REPEAT seconds, so this allows two repeats to go missing.
HOLD_TIMEOUT = 1.5
#: How often the panel repeats a held movement; it reads this from here.
HOLD_REPEAT = 0.5


class PtzControl:
    """One recorder's PTZ: its own connection, and every movement it started."""

    def __init__(self, data: dict[str, Any]) -> None:
        self._data = data
        self._client: XmeyeClient | None = None
        #: One request at a time on the connection, in the order they were asked.
        self._lock = asyncio.Lock()
        #: channel → (command, speed) of the movement under way
        self._moving: dict[int, tuple[str, int]] = {}
        self._watchdogs: dict[int, asyncio.TimerHandle] = {}
        #: Stops the watchdog started, held so they are not collected mid-flight.
        self._stopping: set[asyncio.Task] = set()

    async def _send(self, command: str, **kwargs: Any) -> None:
        async with self._lock:
            for attempt in (1, 2):
                if self._client is None:
                    self._client = XmeyeClient(
                        self._data["host"],
                        username=self._data["username"],
                        password=self._data["password"],
                        port=self._data["port"],
                    )
                try:
                    if not self._client.connected:
                        # login() rather than letting the command connect: it is
                        # what starts the KeepAlive that holds the session open.
                        await self._client.login()
                    await self._client.ptz(command, **kwargs)
                    return
                except XmeyeError:
                    # A connection idle for a long time may have been dropped by
                    # the recorder; one fresh login is worth a try before giving up.
                    client, self._client = self._client, None
                    await client.close()
                    if attempt == 2:
                        raise

    async def move(self, channel: int, command: str, speed: int) -> None:
        """Start a movement, or keep the one under way going."""
        self._arm(channel)
        if self._moving.get(channel) == (command, speed):
            return
        if channel in self._moving:
            await self._stop(channel)
        # Recorded before sending, so a stop that arrives while the start is
        # still on the wire knows what it is stopping.
        self._moving[channel] = (command, speed)
        try:
            await self._send(command, channel=channel, step=speed)
        except XmeyeError:
            self._moving.pop(channel, None)
            self._disarm(channel)
            raise

    async def stop(self, channel: int) -> None:
        """Stop whatever this channel is doing."""
        self._disarm(channel)
        await self._stop(channel)

    async def _stop(self, channel: int) -> None:
        command, speed = self._moving.pop(channel, (PtzCommand.STOP, 5))
        await self._send(command, channel=channel, step=speed, stop=True)

    async def preset(self, channel: int, command: str, number: int) -> None:
        """Go to, save or clear a preset."""
        if channel in self._moving:
            await self.stop(channel)
        await self._send(command, channel=channel, preset=number)

    def _arm(self, channel: int) -> None:
        self._disarm(channel)
        self._watchdogs[channel] = asyncio.get_running_loop().call_later(
            HOLD_TIMEOUT, self._expired, channel
        )

    def _expired(self, channel: int) -> None:
        self._watchdogs.pop(channel, None)
        if channel not in self._moving:
            return
        _LOGGER.debug("PTZ on channel %s stopped: the panel went quiet", channel)
        task = asyncio.get_running_loop().create_task(self._stop_quietly(channel))
        self._stopping.add(task)
        task.add_done_callback(self._stopping.discard)

    def _disarm(self, channel: int) -> None:
        if handle := self._watchdogs.pop(channel, None):
            handle.cancel()

    async def _stop_quietly(self, channel: int) -> None:
        try:
            await self._stop(channel)
        except XmeyeError as err:
            _LOGGER.warning("Could not stop PTZ on channel %s: %s", channel, err)

    async def close(self) -> None:
        """Stop every movement and hang up."""
        for channel in list(self._moving):
            self._disarm(channel)
            await self._stop_quietly(channel)
        if self._client is not None:
            client, self._client = self._client, None
            await client.close()
