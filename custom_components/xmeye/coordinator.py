"""Polling coordinator for the recorder."""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed, ConfigEntryNotReady
from homeassistant.helpers import issue_registry as ir
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .const import (
    CONF_CHANNELS,
    CONF_SCAN_INTERVAL,
    DEFAULT_SCAN_INTERVAL,
    DOMAIN,
)
from .xmeyelib import (
    ChannelStatus,
    DeviceInfo,
    Disk,
    LiveStream,
    LoginFailed,
    WorkState,
    XmeyeClient,
    XmeyeError,
)

_LOGGER = logging.getLogger(__name__)

#: How often to re-read the things that barely change.
SLOW_REFRESH = timedelta(minutes=10)


@dataclass
class XmeyeData:
    """A snapshot of the recorder state."""

    device: DeviceInfo
    channels: list[ChannelStatus] = field(default_factory=list)
    titles: list[str] = field(default_factory=list)
    state: WorkState | None = None
    disks: list[Disk] = field(default_factory=list)
    device_time: datetime | None = None
    archive_from: datetime | None = None
    archive_to: datetime | None = None
    capabilities: dict[str, Any] = field(default_factory=dict)
    available: bool = True

    def channel_name(self, index: int) -> str:
        if index < len(self.titles) and self.titles[index]:
            return self.titles[index]
        if index < len(self.channels) and self.channels[index].name:
            return self.channels[index].name
        return f"Channel {index + 1}"

    @property
    def total_bitrate(self) -> int:
        return sum(c.bitrate_kbps for c in self.state.channels) if self.state else 0

    @property
    def recording_channels(self) -> list[int]:
        return [c.index for c in self.state.channels if c.recording] if self.state else []

    def motion_on(self, index: int) -> bool:
        return bool(self.state and self.state.video_motion >> index & 1)

    def video_loss_on(self, index: int) -> bool:
        return bool(self.state and self.state.video_loss >> index & 1)

    def blind_on(self, index: int) -> bool:
        return bool(self.state and self.state.video_blind >> index & 1)

    def is_recording(self, index: int) -> bool:
        if not self.state or index >= len(self.state.channels):
            return False
        return self.state.channels[index].recording

    def bitrate(self, index: int) -> int:
        if not self.state or index >= len(self.state.channels):
            return 0
        return self.state.channels[index].bitrate_kbps


class XmeyeCoordinator(DataUpdateCoordinator[XmeyeData]):
    """Holds one control session and hands its state to the entities."""

    config_entry: ConfigEntry

    def __init__(
        self,
        hass: HomeAssistant,
        entry: ConfigEntry,
        client: XmeyeClient,
    ) -> None:
        interval = entry.options.get(CONF_SCAN_INTERVAL, DEFAULT_SCAN_INTERVAL)
        super().__init__(
            hass,
            _LOGGER,
            name=f"{DOMAIN} {entry.data['host']}",
            update_interval=timedelta(seconds=interval),
            config_entry=entry,
        )
        self.client = client
        self._slow_due = datetime.min
        self._static: dict[str, Any] = {}
        #: Guards the control session against concurrent calls from services and panel.
        self.lock = asyncio.Lock()

    @property
    def host(self) -> str:
        return self.config_entry.data["host"]

    @property
    def enabled_channels(self) -> list[int]:
        """Channels chosen in the options, or every connected one."""
        configured = self.config_entry.options.get(CONF_CHANNELS)
        if configured:
            return [int(c) for c in configured]
        if self.data:
            online = [c.index for c in self.data.channels if c.online]
            if online:
                return online
        return [0]

    async def _async_update_data(self) -> XmeyeData:
        try:
            async with self.lock:
                return await self._fetch()
        except LoginFailed as err:
            raise ConfigEntryAuthFailed(str(err)) from err
        except XmeyeError as err:
            raise UpdateFailed(f"Recorder {self.host} is not responding: {err}") from err

    async def _fetch(self) -> XmeyeData:
        now = datetime.now()
        refresh_slow = now >= self._slow_due or not self._static

        if refresh_slow:
            # Model, channel names and capabilities only change after a firmware update.
            self._static = {
                "device": await self.client.device_info(),
                "titles": await self.client.channel_titles(),
                "capabilities": await self.client.capabilities(),
            }
            self._slow_due = now + SLOW_REFRESH

        state = await self.client.work_state()
        channels = await self.client.channel_statuses()
        self._flag_new_channels(channels)
        disks = await self.client.storage()
        device_time = await self.client.get_time()

        starts = [p.oldest_record for d in disks for p in d.partitions if p.oldest_record]
        ends = [p.newest_record for d in disks for p in d.partitions if p.newest_record]

        return XmeyeData(
            device=self._static["device"],
            titles=self._static["titles"],
            capabilities=self._static["capabilities"],
            channels=channels,
            state=state,
            disks=disks,
            device_time=device_time,
            archive_from=min(starts) if starts else None,
            archive_to=max(ends) if ends else None,
        )


    def _flag_new_channels(self, channels: list[ChannelStatus]) -> None:
        """Point out cameras the recorder has but the options do not.

        The channel list is chosen once, when the integration is set up, and a
        camera plugged into the recorder later is simply absent from it. Nothing
        is broken, so nothing complains, and the camera quietly never appears —
        which reads as a bug rather than a setting. Rather than override an
        explicit choice, say so and let the user decide.
        """
        chosen = self.config_entry.options.get(CONF_CHANNELS)
        if not chosen:
            # No explicit choice yet, so every connected channel is already used.
            return

        known = {int(c) for c in chosen}
        missing = sorted(c.index for c in channels if c.online and c.index not in known)
        issue_id = f"new_channels_{self.config_entry.entry_id}"

        if not missing:
            ir.async_delete_issue(self.hass, DOMAIN, issue_id)
            return

        names = ", ".join(
            f"{index + 1}. {self.data.channel_name(index) if self.data else index + 1}"
            for index in missing
        )
        ir.async_create_issue(
            self.hass,
            DOMAIN,
            issue_id,
            is_fixable=False,
            severity=ir.IssueSeverity.WARNING,
            translation_key="new_channels",
            translation_placeholders={"names": names, "title": self.config_entry.title},
        )

    async def async_snapshot(self, channel: int, *, use_sub: bool = True) -> bytes | None:
        """A channel snapshot as a raw H.265/H.264 keyframe.

        Taken over a separate connection so the control session stays free. The
        device allows about ten concurrent connections, so snapshots serialise.
        """
        from .xmeyelib import StreamType

        entry = self.config_entry
        stream = LiveStream(
            entry.data["host"],
            username=entry.data["username"],
            password=entry.data["password"],
            port=entry.data["port"],
            channel=channel,
            stream=StreamType.EXTRA1 if use_sub else StreamType.MAIN,
        )
        try:
            await stream.start()
            frame = await stream.keyframe(timeout=15.0)
        except XmeyeError as err:
            _LOGGER.debug("Could not grab a frame from channel %s: %s", channel, err)
            return None
        finally:
            await stream.close()
        return frame.payload if frame else None


async def async_create_client(hass: HomeAssistant, data: dict[str, Any]) -> XmeyeClient:
    """Create and verify the connection, translating errors for Home Assistant."""
    client = XmeyeClient(
        data["host"],
        username=data["username"],
        password=data["password"],
        port=data["port"],
    )
    try:
        await client.login()
    except LoginFailed as err:
        raise ConfigEntryAuthFailed(str(err)) from err
    except XmeyeError as err:
        raise ConfigEntryNotReady(f"No connection to {data['host']}: {err}") from err
    return client
