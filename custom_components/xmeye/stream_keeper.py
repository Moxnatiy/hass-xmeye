"""A persistent channel connection for fast snapshots.

Opening a fresh DVRIP session per snapshot is expensive: login, claiming the
channel and waiting for the next keyframe add up to 0.4-0.7 seconds, and that
is per frame per card. Instead one connection stays open, frames keep arriving,
and the latest keyframe is handed out immediately.

The connection opens only when snapshots are actually wanted and closes after a
quiet period: the recorder allows about ten concurrent connections, so holding
them forever is not an option.
"""

from __future__ import annotations

import asyncio
import logging
import time

from homeassistant.core import HomeAssistant

from .xmeyelib import LiveStream, MediaFrame, StreamType, XmeyeError

_LOGGER = logging.getLogger(__name__)

#: How long to hold the connection after the last frame request.
IDLE_TIMEOUT = 60.0

#: How long to wait for the first keyframe after the stream starts.
FIRST_FRAME_TIMEOUT = 20.0

#: The age past which a frame is stale and waiting for a new one is better.
STALE_AFTER = 30.0


class ChannelStreamKeeper:
    """Keeps a live channel stream and caches the latest keyframe."""

    def __init__(
        self,
        hass: HomeAssistant,
        *,
        host: str,
        username: str,
        password: str,
        port: int,
        channel: int,
        sub_stream: bool = True,
        idle_timeout: float = IDLE_TIMEOUT,
    ) -> None:
        self.hass = hass
        self.channel = channel
        self._host = host
        self._username = username
        self._password = password
        self._port = port
        self._stream_type = StreamType.EXTRA1 if sub_stream else StreamType.MAIN
        self._idle_timeout = idle_timeout

        self._task: asyncio.Task | None = None
        self._stream: LiveStream | None = None
        self._frame: MediaFrame | None = None
        self._frame_at = 0.0
        self._last_used = 0.0
        self._first_frame = asyncio.Event()
        self._lock = asyncio.Lock()
        #: Frames served from cache without a new connection, for diagnostics.
        self.cache_hits = 0
        self.restarts = 0

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    @property
    def frame_stamp(self) -> float:
        """Timestamp of the latest frame, used as the image cache key."""
        return self._frame_at

    @property
    def frame_age(self) -> float:
        return time.monotonic() - self._frame_at if self._frame else float("inf")

    async def async_get_keyframe(self) -> MediaFrame | None:
        """The latest keyframe, starting the stream if needed."""
        self._last_used = time.monotonic()

        if self._frame is not None and self.frame_age < STALE_AFTER:
            self.cache_hits += 1
            return self._frame

        async with self._lock:
            # a frame may have arrived while we waited for the lock
            if self._frame is not None and self.frame_age < STALE_AFTER:
                self.cache_hits += 1
                return self._frame
            if not self.running:
                await self._async_start()
            try:
                await asyncio.wait_for(self._first_frame.wait(), FIRST_FRAME_TIMEOUT)
            except TimeoutError:
                _LOGGER.debug("Channel %s did not deliver a keyframe in time", self.channel)
                return self._frame
        return self._frame

    async def _async_start(self) -> None:
        self._first_frame.clear()
        self._task = self.hass.async_create_background_task(
            self._run(), name=f"xmeye-keeper-ch{self.channel}", eager_start=False
        )

    async def _run(self) -> None:
        """Read the stream and refresh the cache while there is demand."""
        stream = LiveStream(
            self._host,
            username=self._username,
            password=self._password,
            port=self._port,
            channel=self.channel,
            stream=self._stream_type,
        )
        self._stream = stream
        try:
            await stream.start()
            async for frame in stream.frames():
                if frame.keyframe:
                    self._frame = frame
                    self._frame_at = time.monotonic()
                    self._first_frame.set()
                # Demand is gone; release the connection for other consumers.
                if time.monotonic() - self._last_used > self._idle_timeout:
                    _LOGGER.debug("Channel %s went quiet, closing the stream", self.channel)
                    break
        except asyncio.CancelledError:
            raise
        except XmeyeError as err:
            _LOGGER.debug("Stream for channel %s dropped: %s", self.channel, err)
            self.restarts += 1
        finally:
            self._stream = None
            self._first_frame.set()  # wake anyone waiting
            try:
                await stream.close()
            except XmeyeError:
                pass

    async def async_stop(self) -> None:
        """Stop the stream and release the connection."""
        task, self._task = self._task, None
        if task is not None and not task.done():
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        self._frame = None
