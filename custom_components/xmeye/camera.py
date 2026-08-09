"""Cameras for the recorder's channels."""

from __future__ import annotations

import asyncio
import logging
from typing import Any
from urllib.parse import quote

from homeassistant.components.camera import Camera, CameraEntityFeature
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import (
    CONF_RTSP_PORT,
    CONF_STREAM,
    CONF_USE_RTSP,
    DEFAULT_RTSP_PORT,
    DOMAIN,
    STREAM_MAIN,
    STREAM_SUB,
)
from .coordinator import XmeyeCoordinator
from .entity import XmeyeChannelEntity
from .stream_keeper import ChannelStreamKeeper
from .xmeyelib import MediaFrame

_LOGGER = logging.getLogger(__name__)

#: Largest snapshot width when no size is requested. A full 4K frame is around
#: 700 KB as JPEG, which wastes both bandwidth and encoding time for a card.
DEFAULT_SNAPSHOT_WIDTH = 1280

#: How long the same JPEG is served. Keyframes arrive every one to two and a
#: half seconds, so re-encoding more often buys nothing.
JPEG_TTL = 2.0

#: How often Home Assistant may ask for a frame on the MJPEG fallback path.
#: The default of half a second is out of reach for this recorder.
FRAME_INTERVAL = 2.0


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    coordinator: XmeyeCoordinator = hass.data[DOMAIN][entry.entry_id]
    preferred = entry.options.get(CONF_STREAM, STREAM_SUB)

    # Two cameras per channel, one per stream. That allows watching both the 4K
    # and the small stream without reconfiguring the integration, and lets the
    # panel switch between them on the fly. The one chosen in the options stays
    # the primary entity so its id does not change when settings do.
    entities: list[XmeyeCamera] = []
    for channel in coordinator.enabled_channels:
        for stream in (STREAM_MAIN, STREAM_SUB):
            entities.append(
                XmeyeCamera(coordinator, channel, stream, primary=stream == preferred)
            )
    async_add_entities(entities)


class XmeyeCamera(XmeyeChannelEntity, Camera):
    """Live video for one channel.

    Video goes over RTSP, handled by the built-in ``stream`` component with
    hardware decoding and without our demuxer. Snapshots come over DVRIP
    instead: this recorder has no HTTP snapshot endpoint at all, and ``OPSNAP``
    stays silent on this firmware.
    """

    _attr_supported_features = CameraEntityFeature.STREAM
    _attr_frame_interval = FRAME_INTERVAL

    def __init__(
        self,
        coordinator: XmeyeCoordinator,
        channel: int,
        stream: str = STREAM_SUB,
        *,
        primary: bool = True,
    ) -> None:
        # The primary camera keeps its original id; the alternate gets its own.
        XmeyeChannelEntity.__init__(
            self, coordinator, channel, "camera" if primary else f"camera_{stream}"
        )
        Camera.__init__(self)
        self.stream_name = stream
        self.primary = primary
        self._attr_translation_key = None if primary else f"camera_{stream}"
        self._attr_name = None if primary else (
            "Main stream" if stream == STREAM_MAIN else "Sub stream"
        )
        # Both cameras are enabled: otherwise switching streams would only work
        # after enabling the entity by hand. Each holds a connection to the
        # recorder only while it is actually being watched.
        self._attr_entity_registry_enabled_default = True
        self._jpeg: bytes | None = None
        self._jpeg_key: tuple[float, int] | None = None
        self._jpeg_lock = asyncio.Lock()
        self._keeper: ChannelStreamKeeper | None = None

        entry = coordinator.config_entry
        # Xiongmai stamps stream time unevenly, and RTSP over UDP also loses
        # packets; both look like stutter. These two options remove it at the
        # ffmpeg level, before decoding.
        self.stream_options = {
            "rtsp_transport": "tcp",
            "use_wallclock_as_timestamps": True,
        }
        self._entry_data = entry.data

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        entry = self.coordinator.config_entry
        self._keeper = ChannelStreamKeeper(
            self.hass,
            host=entry.data["host"],
            username=entry.data["username"],
            password=entry.data["password"],
            port=entry.data["port"],
            channel=self.channel,
            # Take the frame from the same stream this camera shows, otherwise
            # the snapshot and the video would disagree.
            sub_stream=self.stream_name == STREAM_SUB,
        )

    async def async_will_remove_from_hass(self) -> None:
        if self._keeper is not None:
            await self._keeper.async_stop()
            self._keeper = None
        await super().async_will_remove_from_hass()

    @property
    def use_rtsp(self) -> bool:
        return bool(self.coordinator.config_entry.options.get(CONF_USE_RTSP, True))

    @property
    def _stream_index(self) -> int:
        return 0 if self.stream_name == STREAM_MAIN else 1

    async def stream_source(self) -> str | None:
        if not self.use_rtsp:
            return None
        entry = self.coordinator.config_entry
        host = entry.data["host"]
        port = entry.data.get(CONF_RTSP_PORT, DEFAULT_RTSP_PORT)
        user = quote(entry.data["username"], safe="")
        password = quote(entry.data["password"], safe="")
        # Xiongmai's native URL form. The recorder accepts the common Dahua
        # style (/cam/realmonitor?channel=N&subtype=M) but silently ignores
        # subtype and always returns the main stream, which is 4K HEVC and costs
        # the browser about a third of its frames.
        # RTSP numbers channels from one, DVRIP from zero.
        return (
            f"rtsp://{host}:{port}/user={user}&password={password}"
            f"&channel={self.channel + 1}&stream={self._stream_index}.sdp?real_stream"
        )

    async def async_camera_image(
        self, width: int | None = None, height: int | None = None
    ) -> bytes | None:
        """A JPEG snapshot at the requested size.

        The frame comes from a persistent connection, so a wall of cards does
        not turn into a queue of connections to the recorder.
        """
        if self._keeper is None:
            return None

        frame = await self._keeper.async_get_keyframe()
        if frame is None:
            return self._jpeg

        target = width or DEFAULT_SNAPSHOT_WIDTH
        key = (self._keeper.frame_stamp, target)
        if self._jpeg is not None and self._jpeg_key == key:
            return self._jpeg

        async with self._jpeg_lock:
            if self._jpeg is not None and self._jpeg_key == key:
                return self._jpeg
            jpeg = await self._to_jpeg(frame, target)
            if jpeg:
                self._jpeg = jpeg
                self._jpeg_key = key
        return self._jpeg

    async def _to_jpeg(self, frame: MediaFrame, width: int) -> bytes | None:
        """Turn a raw keyframe into JPEG, scaled down to the requested width."""
        from homeassistant.components.ffmpeg import get_ffmpeg_manager

        try:
            binary = get_ffmpeg_manager(self.hass).binary
        except (KeyError, AttributeError, ValueError):
            # the ffmpeg component is not up; fall back to the system binary
            binary = "ffmpeg"

        # Take the codec from the parsed frame header rather than guessing:
        # H.264 channels do occur on the same recorder.
        codec = frame.codec if frame.codec in ("hevc", "h264") else "hevc"
        scale = []
        if frame.width and width < frame.width:
            # -2 keeps the aspect ratio and yields the even height the encoder needs
            scale = ["-vf", f"scale={width}:-2:flags=fast_bilinear"]

        process = await asyncio.create_subprocess_exec(
            binary,
            "-hide_banner",
            "-loglevel",
            "error",
            "-threads",
            "2",
            "-f",
            codec,
            "-i",
            "pipe:0",
            *scale,
            "-frames:v",
            "1",
            "-q:v",
            "4",
            "-f",
            "image2",
            "-vcodec",
            "mjpeg",
            "pipe:1",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(
                process.communicate(frame.payload), timeout=20
            )
        except TimeoutError:
            process.kill()
            _LOGGER.warning(
                "ffmpeg did not produce a snapshot for channel %s in time", self.channel
            )
            return None

        if not stdout:
            _LOGGER.debug("ffmpeg produced no image: %s", stderr.decode()[:200])
            return None
        return stdout

    @property
    def is_recording(self) -> bool:
        return bool(self.coordinator.data and self.coordinator.data.is_recording(self.channel))

    @property
    def motion_detection_enabled(self) -> bool:
        return bool(self.coordinator.data and self.coordinator.data.motion_on(self.channel))

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        data = self.coordinator.data
        if not data or self.channel >= len(data.channels):
            return {}
        status = data.channels[self.channel]
        attributes = {
            "channel": self.channel,
            "status": status.status,
            "resolution": status.current_resolution,
            "max_resolution": status.max_resolution,
            "bitrate_kbps": data.bitrate(self.channel),
        }
        if self._keeper is not None:
            attributes["snapshot_stream_active"] = self._keeper.running
        return attributes
