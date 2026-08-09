"""High-level asynchronous XMeye / Xiongmai DVRIP client."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable, Iterable
from datetime import datetime
from typing import Any, Self
from urllib.parse import quote

from .const import (
    CONFIG_ROOTS,
    DEFAULT_PORT,
    DEFAULT_RTSP_PORT,
    OK_CODES,
    Msg,
    PtzCommand,
    Ret,
)
from .exceptions import (
    CommandFailed,
    DeviceSilent,
    LoginFailed,
    NotConnected,
    UnsupportedFeature,
)
from .models import (
    ChannelStatus,
    DeviceInfo,
    Disk,
    Group,
    LogEntry,
    NetworkInfo,
    RecordFile,
    User,
    WorkState,
    format_time,
    parse_time,
)
from .protocol import DvripConnection, Packet, login_payload

_LOGGER = logging.getLogger(__name__)

#: Safety margin for KeepAlive relative to the AliveInterval the device reports.
KEEPALIVE_MARGIN = 5.0

#: Recordings returned per ``OPFileQuery`` (measured on an NBD8008R-U).
SEARCH_PAGE_SIZE = 64


class XmeyeClient:
    """A control session with the recorder.

    One instance holds one TCP connection, sends KeepAlive and issues commands.
    Open separate connections for video streams and archive downloads: the
    device is limited by ``TCPMaxConn``, typically ten.

    ::

        async with XmeyeClient("192.168.0.10", password="...") as dvr:
            info = await dvr.device_info()
    """

    def __init__(
        self,
        host: str,
        *,
        username: str = "admin",
        password: str = "",
        port: int = DEFAULT_PORT,
        timeout: float = 10.0,
        keepalive: bool = True,
        on_alarm: Callable[[dict[str, Any]], None] | None = None,
    ) -> None:
        self.host = host
        self.port = port
        self.username = username
        self._password = password
        self._keepalive_enabled = keepalive
        self._on_alarm = on_alarm

        self._conn = DvripConnection(
            host=host, port=port, timeout=timeout, on_event=self._handle_event
        )
        self._keepalive_task: asyncio.Task | None = None
        #: How many times the connection had to be rebuilt.
        self.reconnects = 0
        self._alive_interval: float = 20.0
        self.login_info: dict[str, Any] = {}

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    @property
    def connected(self) -> bool:
        return self._conn.connected

    @property
    def session_id(self) -> str:
        """SessionID in the format the device expects."""
        return f"0x{self._conn.session:08X}"

    async def __aenter__(self) -> Self:
        await self.login()
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        await self.close()

    async def login(self) -> dict[str, Any]:
        """Connect and authenticate."""
        reply = await self._authenticate()
        if self._keepalive_enabled and self._keepalive_task is None:
            self._keepalive_task = asyncio.create_task(
                self._keepalive_loop(), name=f"xmeye-keepalive-{self.host}"
            )
        return reply

    async def _authenticate(self) -> dict[str, Any]:
        """Open the connection and log in without touching background tasks."""
        await self._conn.connect()
        payload = login_payload(self.username, self._password)
        reply = await self._conn.request_json(Msg.LOGIN, payload)
        ret = reply.get("Ret", Ret.UNKNOWN_ERROR)
        if ret not in OK_CODES:
            await self._conn.close()
            raise LoginFailed(str(CommandFailed(ret, "Login", reply)))

        self.login_info = reply
        # The firmware states the interval; keep a margin so the session survives.
        interval = float(reply.get("AliveInterval", 20) or 20)
        self._alive_interval = max(interval - KEEPALIVE_MARGIN, 5.0)
        _LOGGER.debug("Logged in to %s, session=%s", self.host, self.session_id)
        return reply

    async def _heal(self) -> None:
        """Rebuild the connection if it lost trust.

        DVRIP has no request-to-reply correlation id, so after a timeout there
        is no guarantee that the next reply belongs to the next request.
        Reconnecting is the only way back to a defined state, and on a local
        network it costs tens of milliseconds.
        """
        if not (self._conn.desynced or not self._conn.connected):
            return
        self.reconnects += 1
        _LOGGER.debug("Reconnecting to %s (attempt %d)", self.host, self.reconnects)
        await self._conn.close()
        await self._authenticate()

    async def close(self) -> None:
        """Log out and close the connection."""
        if self._keepalive_task is not None:
            self._keepalive_task.cancel()
            try:
                await self._keepalive_task
            except asyncio.CancelledError:
                pass
            self._keepalive_task = None
        if self._conn.connected:
            try:
                await self._conn.send(Msg.LOGOUT, {"Name": "", "SessionID": self.session_id})
            except (NotConnected, OSError):
                pass
        await self._conn.close()

    async def _keepalive_loop(self) -> None:
        while True:
            await asyncio.sleep(self._alive_interval)
            try:
                await self._conn.request_json(
                    Msg.KEEPALIVE, {"Name": "KeepAlive", "SessionID": self.session_id}
                )
            except asyncio.CancelledError:
                raise
            except Exception as err:  # noqa: BLE001 - KeepAlive must not kill the client
                _LOGGER.warning("KeepAlive to %s failed: %s", self.host, err)
                return

    def _handle_event(self, packet: Packet) -> None:
        if packet.msgid == Msg.ALARM_NOTIFY and self._on_alarm is not None:
            try:
                data = packet.json()
            except Exception:  # noqa: BLE001
                return
            if isinstance(data, dict):
                self._on_alarm(data)

    # ------------------------------------------------------------------
    # Core calls
    # ------------------------------------------------------------------

    async def command(
        self,
        msgid: int,
        payload: dict[str, Any] | None = None,
        *,
        check: bool = True,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """Send any command, filling in SessionID and checking ``Ret``.

        If the previous request timed out, the connection is rebuilt first:
        otherwise a late reply could pass as the answer to this one.
        """
        await self._heal()
        body: dict[str, Any] = {"Name": "", "SessionID": self.session_id}
        body.update(payload or {})
        reply = await self._conn.request_json(msgid, body, timeout=timeout)
        if check:
            self._check(reply, body.get("Name") or str(msgid))
        return reply

    @staticmethod
    def _check(reply: dict[str, Any], what: str) -> None:
        ret = reply.get("Ret")
        if ret is None or ret in OK_CODES:
            return
        if ret in (Ret.NO_SUCH_CONFIG, Ret.UNSUPPORTED_VERSION):
            raise UnsupportedFeature(ret, what, reply)
        raise CommandFailed(ret, what, reply)

    async def get_config(
        self, name: str, *, default: bool = False, check: bool = True
    ) -> Any:
        """Read a configuration section.

        :param default: read factory values (``1044``) instead of current ones (``1042``).
        """
        msgid = Msg.DEFAULT_CONFIG_GET if default else Msg.CONFIG_GET
        reply = await self.command(msgid, {"Name": name}, check=check)
        return reply.get(name, reply)

    async def set_config(self, name: str, value: Any) -> dict[str, Any]:
        """Write a configuration section."""
        return await self.command(Msg.CONFIG_SET, {"Name": name, name: value})

    async def config_tree(
        self, roots: Iterable[str] | None = None, *, timeout: float = 20.0
    ) -> dict[str, Any]:
        """Read the root configuration containers in one pass.

        Faster and more complete than probing leaves one by one: a root returns
        all of its subsections together. Roots that are unavailable or silent
        are simply absent from the result.
        """
        tree: dict[str, Any] = {}
        for root in roots or CONFIG_ROOTS:
            try:
                value = await self.command(
                    Msg.CONFIG_GET, {"Name": root}, check=False, timeout=timeout
                )
            except DeviceSilent:
                # Some containers are too large for the firmware to assemble in
                # time (Detect across 32 channels); read those leaf by leaf.
                _LOGGER.debug("Container %s did not answer", root)
                continue
            body = value.get(root)
            if body is None and value.get("Ret") not in OK_CODES:
                continue
            tree[root] = body
        return tree

    async def get_sysinfo(self, name: str, *, check: bool = True) -> Any:
        """Read system information (``SystemInfo``, ``StorageInfo``, ``WorkState``)."""
        reply = await self.command(Msg.SYSINFO, {"Name": name}, check=check)
        return reply.get(name, reply)

    async def get_ability(self, name: str, *, check: bool = True) -> Any:
        """Read capability levels (``SystemFunction``, ``EncodeCapability``)."""
        reply = await self.command(Msg.SYSTEM_FUNCTION, {"Name": name}, check=check)
        return reply.get(name, reply)

    # ------------------------------------------------------------------
    # Device information
    # ------------------------------------------------------------------

    async def device_info(self) -> DeviceInfo:
        """Model, firmware, serial number, channel count, uptime."""
        return DeviceInfo.from_raw(await self.get_sysinfo("SystemInfo") or {})

    async def work_state(self) -> WorkState:
        """Instantaneous state: bitrates, recording, alarms, motion."""
        return WorkState.from_raw(await self.get_sysinfo("WorkState") or {})

    async def storage(self) -> list[Disk]:
        """Disks and partitions with the bounds of the recordings on them."""
        raw = await self.get_sysinfo("StorageInfo") or []
        return [Disk.from_raw(i, item) for i, item in enumerate(raw)]

    async def capabilities(self) -> dict[str, Any]:
        """``SystemFunction``: what this firmware can do."""
        return await self.get_ability("SystemFunction") or {}

    async def encode_capabilities(self) -> dict[str, Any]:
        """``EncodeCapability``: available streams, resolutions and codecs."""
        return await self.get_ability("EncodeCapability") or {}

    async def network_info(self) -> NetworkInfo:
        """``NetWork.NetCommon`` in readable form."""
        return NetworkInfo.from_raw(await self.get_config("NetWork.NetCommon") or {})

    async def channel_titles(self) -> list[str]:
        """Channel names."""
        reply = await self.command(Msg.CONFIG_CHANNELTITLE_GET, {"Name": "ChannelTitle"})
        return list(reply.get("ChannelTitle", []) or [])

    async def channel_statuses(self) -> list[ChannelStatus]:
        """Connection state of each channel (NVR and HVR only)."""
        raw = await self.get_config("NetWork.ChnStatus", check=False)
        if not isinstance(raw, list):
            return []
        return [ChannelStatus.from_raw(i, item) for i, item in enumerate(raw)]

    async def online_channels(self) -> list[ChannelStatus]:
        """Only channels in the ``Connected`` state."""
        return [c for c in await self.channel_statuses() if c.online]

    async def get_time(self) -> datetime | None:
        """The recorder's system time."""
        reply = await self.command(Msg.TIME_QUERY, {"Name": "OPTimeQuery"})
        return parse_time(reply.get("OPTimeQuery"))

    async def set_time(self, value: datetime | None = None) -> dict[str, Any]:
        """Set the system time, defaulting to the host clock."""
        moment = value or datetime.now()
        return await self.command(
            Msg.SYSTEM_MANAGER,
            {"Name": "OPTimeSetting", "OPTimeSetting": format_time(moment)},
        )

    # ------------------------------------------------------------------
    # Users
    # ------------------------------------------------------------------

    async def users(self) -> list[User]:
        reply = await self.command(Msg.USERS_GET, {"Name": ""})
        return [User.from_raw(u) for u in reply.get("Users", []) or []]

    async def groups(self) -> list[Group]:
        reply = await self.command(Msg.GROUPS_GET, {"Name": ""})
        return [Group.from_raw(g) for g in reply.get("Groups", []) or []]

    async def authority_list(self) -> list[str]:
        """Every permission the device supports."""
        reply = await self.command(Msg.FULL_AUTHORITY_LIST, {"Name": ""})
        return list(reply.get("AuthorityList", []) or [])

    # ------------------------------------------------------------------
    # Archive
    # ------------------------------------------------------------------

    async def search_files(
        self,
        begin: datetime,
        end: datetime,
        *,
        channel: int = 0,
        event: str = "*",
        stream: int = 0,
        file_type: str = "h264",
        limit: int | None = None,
    ) -> list[RecordFile]:
        """Find recordings within a time range.

        ``file_type`` stays ``"h264"`` even for H.265: it is only the extension
        label the firmware puts in its reply.

        ``event``: ``"*"`` all, ``"M"`` motion, ``"A"`` alarm, ``"R"`` schedule,
        ``"H"`` manual.
        """
        found: list[RecordFile] = []
        seen: set[str] = set()
        cursor = begin

        # The firmware returns at most SEARCH_PAGE_SIZE records per request and
        # does not flag this in any way: Ret stays 100. So a full page means
        # "there is more", and the cursor moves to the BeginTime of the last
        # file. That overlaps by one record, which the name-based dedup removes.
        while True:
            reply = await self.command(
                Msg.FILE_SEARCH,
                {
                    "Name": "OPFileQuery",
                    "OPFileQuery": {
                        "BeginTime": format_time(cursor),
                        "EndTime": format_time(end),
                        "Channel": channel,
                        "DriverTypeMask": "0x0000FFFF",
                        "Event": event,
                        "StreamType": f"0x{stream:08X}",
                        "Type": file_type,
                    },
                },
                check=False,
                timeout=30.0,
            )
            ret = reply.get("Ret")
            if ret == Ret.SEARCH_FAILED:  # no recordings in this range
                break
            self._check(reply, "OPFileQuery")

            batch = reply.get("OPFileQuery") or []
            new = [
                RecordFile.from_raw(item, channel=channel)
                for item in batch
                if item.get("FileName") not in seen
            ]
            for item in new:
                seen.add(item.name)
            found.extend(new)

            if limit is not None and len(found) >= limit:
                return found[:limit]
            if len(batch) < SEARCH_PAGE_SIZE or not new:
                break
            next_cursor = new[-1].begin or found[-1].begin
            if next_cursor is None or next_cursor < cursor:
                break
            cursor = next_cursor

        return found

    async def recording_range(self) -> tuple[datetime | None, datetime | None]:
        """Earliest and latest moments covered by recordings."""
        disks = await self.storage()
        starts = [p.oldest_record for d in disks for p in d.partitions if p.oldest_record]
        ends = [p.newest_record for d in disks for p in d.partitions if p.newest_record]
        return (min(starts) if starts else None, max(ends) if ends else None)

    async def search_log(
        self, begin: datetime, end: datetime, *, position: int = 0, limit: int = 128
    ) -> list[LogEntry]:
        """Read the system log."""
        reply = await self.command(
            Msg.LOG_SEARCH,
            {
                "Name": "OPLogQuery",
                "OPLogQuery": {
                    "BeginTime": format_time(begin),
                    "EndTime": format_time(end),
                    "LogPosition": position,
                    "Type": "LogAll",
                },
            },
            check=False,
            timeout=30.0,
        )
        if reply.get("Ret") == Ret.SEARCH_FAILED:
            return []
        self._check(reply, "OPLogQuery")
        return [LogEntry.from_raw(i) for i in (reply.get("OPLogQuery") or [])][:limit]

    # ------------------------------------------------------------------
    # Control
    # ------------------------------------------------------------------

    async def ptz(
        self,
        command: str,
        *,
        channel: int = 0,
        step: int = 5,
        stop: bool = False,
        preset: int = -1,
    ) -> dict[str, Any]:
        """Send a PTZ command. See :class:`~xmeye.const.PtzCommand`."""
        return await self.command(
            Msg.PTZ,
            {
                "Name": "OPPTZControl",
                "OPPTZControl": {
                    "Command": command,
                    "Parameter": {
                        "AUX": {"Number": 0, "Status": "On"},
                        "Channel": channel,
                        "MenuOpts": "Enter",
                        "POINT": {"bottom": 0, "left": 0, "right": 0, "top": 0},
                        "Pattern": "SetBegin",
                        "Preset": preset,
                        "Step": step,
                        "Tour": 0,
                    },
                },
            },
        )

    async def ptz_move(
        self, direction: str, *, channel: int = 0, step: int = 5, duration: float = 0.4
    ) -> None:
        """Move the camera for the given number of seconds, then stop."""
        await self.ptz(direction, channel=channel, step=step)
        await asyncio.sleep(duration)
        await self.ptz(direction, channel=channel, step=step, stop=True)

    async def reboot(self) -> dict[str, Any]:
        """Reboot the recorder."""
        return await self.command(
            Msg.SYSTEM_MANAGER, {"Name": "OPMachine", "OPMachine": {"Action": "Reboot"}}
        )

    async def set_guard(self, enabled: bool) -> dict[str, Any]:
        """Arm or disarm alarm reporting over the network."""
        return await self.command(
            Msg.GUARD if enabled else Msg.UNGUARD, {"Name": ""}, check=False
        )

    # ------------------------------------------------------------------
    # Conveniences
    # ------------------------------------------------------------------

    def rtsp_url(
        self,
        channel: int = 1,
        *,
        stream: int = 0,
        port: int = DEFAULT_RTSP_PORT,
        include_credentials: bool = True,
    ) -> str:
        """Build the RTSP URL for a channel.

        Uses Xiongmai's native URL form. The common Dahua-style variant
        (``/cam/realmonitor?channel=N&subtype=M``) is accepted by this recorder
        but **silently ignores ``subtype``** and always returns the main
        stream — verified: both values yield 3840x2160.

        Note that RTSP numbers channels from **1** while DVRIP starts at **0**.
        """
        if include_credentials:
            user = quote(self.username, safe="")
            password = quote(self._password, safe="")
            credentials = f"user={user}&password={password}&"
        else:
            credentials = ""
        return (
            f"rtsp://{self.host}:{port}/{credentials}"
            f"channel={channel}&stream={stream}.sdp?real_stream"
        )

    async def summary(self) -> dict[str, Any]:
        """Collect an overview of the device in a single call."""
        info = await self.device_info()
        state = await self.work_state()
        disks = await self.storage()
        titles = await self.channel_titles()
        statuses = await self.channel_statuses()
        oldest, newest = await self.recording_range()
        return {
            "model": info.hardware,
            "firmware": info.software_version,
            "serial": info.serial_number,
            "uptime": info.uptime,
            "channels_total": info.channels,
            "channels_online": sum(1 for c in statuses if c.online),
            "channel_titles": titles[: info.channels],
            "recording_channels": [c.index for c in state.channels if c.recording],
            "total_bitrate_kbps": sum(c.bitrate_kbps for c in state.channels),
            "disks": [
                {"total_mb": d.total_mb, "free_mb": d.free_mb, "partitions": len(d.partitions)}
                for d in disks
            ],
            "archive_from": oldest,
            "archive_to": newest,
            "supports_talk": info.supports_talk,
        }


__all__ = ["PtzCommand", "XmeyeClient"]
