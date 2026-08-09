"""Typed models for the data the recorder returns.

Every model keeps the device's raw dictionary in ``raw``: firmware varies, and
keeping the original beats losing a field we did not know about.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

DVR_TIME_FORMAT = "%Y-%m-%d %H:%M:%S"

#: Recording file name: ``15.46.44-16.11.35[R][@b78][0].h264``
_FILENAME_RE = re.compile(
    r"(?P<begin>\d{2}\.\d{2}\.\d{2})-(?P<end>\d{2}\.\d{2}\.\d{2})"
    r"\[(?P<event>[A-Z*])]\[@(?P<ident>[0-9a-fA-F]+)]\[(?P<stream>\d+)]"
)

#: Event markers used in file names.
EVENT_LABELS = {
    "R": "schedule",  # scheduled recording
    "M": "motion",  # motion detection
    "A": "alarm",  # alarm input
    "H": "manual",  # manual recording
    "*": "all",
}


def parse_hex_int(value: Any, default: int = 0) -> int:
    """Parse ``"0x0004A85C"`` or a plain number."""
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value:
        try:
            return int(value, 16 if value.lower().startswith("0x") else 10)
        except ValueError:
            return default
    return default


def parse_hex_ip(value: Any) -> str:
    """Parse an IP the Xiongmai way: ``"0x0A01A8C0"`` becomes ``"192.168.1.10"``.

    The bytes are stored in the reverse of the usual network order.
    """
    raw = parse_hex_int(value, -1)
    if raw < 0:
        return str(value)
    octets = [(raw >> shift) & 0xFF for shift in (0, 8, 16, 24)]
    return ".".join(str(o) for o in octets)


def format_hex_ip(address: str) -> str:
    """Inverse of :func:`parse_hex_ip`."""
    try:
        parts = [int(p) for p in address.split(".")]
    except ValueError as err:
        raise ValueError(f"Not an IPv4 address: {address!r}") from err
    if len(parts) != 4 or any(not 0 <= p <= 255 for p in parts):
        raise ValueError(f"Not an IPv4 address: {address!r}")
    raw = parts[0] | (parts[1] << 8) | (parts[2] << 16) | (parts[3] << 24)
    return f"0x{raw:08X}"


def parse_time(value: Any) -> datetime | None:
    """Parse ``"2026-08-09 15:54:26"``; ``"0000-00-00 00:00:00"`` becomes ``None``."""
    if not isinstance(value, str) or value.startswith("0000-00-00"):
        return None
    try:
        return datetime.strptime(value, DVR_TIME_FORMAT)
    except ValueError:
        return None


def format_time(value: datetime) -> str:
    return value.strftime(DVR_TIME_FORMAT)


@dataclass(slots=True)
class DeviceInfo:
    """Reply to ``SystemInfo``."""

    hardware: str = ""
    software_version: str = ""
    build_time: datetime | None = None
    serial_number: str = ""
    device_type: int = 0
    channels: int = 0
    extra_channels: int = 0
    video_out_channels: int = 0
    audio_in_channels: int = 0
    talk_in_channels: int = 0
    talk_out_channels: int = 0
    alarm_in_channels: int = 0
    alarm_out_channels: int = 0
    uptime: timedelta | None = None
    raw: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_raw(cls, data: dict[str, Any]) -> DeviceInfo:
        runtime = parse_hex_int(data.get("DeviceRunTime"))
        return cls(
            hardware=data.get("HardWare", ""),
            software_version=data.get("SoftWareVersion", ""),
            build_time=parse_time(data.get("BuildTime")),
            serial_number=data.get("SerialNo", ""),
            device_type=data.get("DeviceType", 0),
            # HVR and NVR report the channel count in DigChannel, DVR in VideoInChannel
            channels=data.get("DigChannel") or data.get("VideoInChannel") or 0,
            extra_channels=data.get("ExtraChannel", 0),
            video_out_channels=data.get("VideoOutChannel", 0),
            audio_in_channels=data.get("AudioInChannel", 0),
            talk_in_channels=data.get("TalkInChannel", 0),
            talk_out_channels=data.get("TalkOutChannel", 0),
            alarm_in_channels=data.get("AlarmInChannel", 0),
            alarm_out_channels=data.get("AlarmOutChannel", 0),
            uptime=timedelta(seconds=runtime) if runtime else None,
            raw=data,
        )

    @property
    def supports_talk(self) -> bool:
        return bool(self.talk_in_channels and self.talk_out_channels)


@dataclass(slots=True)
class ChannelStatus:
    """A single entry from ``NetWork.ChnStatus``."""

    index: int
    name: str = ""
    status: str = ""
    current_resolution: str = ""
    max_resolution: str = ""
    raw: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_raw(cls, index: int, data: dict[str, Any]) -> ChannelStatus:
        return cls(
            index=index,
            name=data.get("ChnName", ""),
            status=data.get("Status", ""),
            current_resolution=data.get("CurRes", ""),
            max_resolution=data.get("MaxRes", ""),
            raw=data,
        )

    @property
    def online(self) -> bool:
        return self.status == "Connected"

    @property
    def configured(self) -> bool:
        return self.status != "NoConfig"


@dataclass(slots=True)
class ChannelState:
    """A single entry from ``WorkState.ChannelState``."""

    index: int
    bitrate_kbps: int = 0
    recording: bool = False


@dataclass(slots=True)
class WorkState:
    """Reply to ``WorkState``: the device state right now."""

    channels: list[ChannelState] = field(default_factory=list)
    alarm_in: int = 0
    alarm_out: int = 0
    video_blind: int = 0
    video_loss: int = 0
    video_motion: int = 0
    raw: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_raw(cls, data: dict[str, Any]) -> WorkState:
        alarm = data.get("AlarmState", {}) or {}
        channels = [
            ChannelState(
                index=i,
                bitrate_kbps=item.get("Bitrate", 0),
                recording=bool(item.get("Record")),
            )
            for i, item in enumerate(data.get("ChannelState", []) or [])
        ]
        return cls(
            channels=channels,
            alarm_in=parse_hex_int(alarm.get("AlarmIn")),
            alarm_out=parse_hex_int(alarm.get("AlarmOut")),
            video_blind=parse_hex_int(alarm.get("VideoBlind")),
            video_loss=parse_hex_int(alarm.get("VideoLoss")),
            video_motion=parse_hex_int(alarm.get("VideoMotion")),
            raw=data,
        )

    def motion_channels(self) -> list[int]:
        """Indices of channels currently reporting motion."""
        return [i for i in range(64) if self.video_motion >> i & 1]


@dataclass(slots=True)
class Partition:
    """A hard disk partition."""

    total_mb: int = 0
    free_mb: int = 0
    is_current: bool = False
    status: int = 0
    driver_type: int = 0
    oldest_record: datetime | None = None
    newest_record: datetime | None = None
    raw: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_raw(cls, data: dict[str, Any]) -> Partition:
        return cls(
            total_mb=parse_hex_int(data.get("TotalSpace")),
            free_mb=parse_hex_int(data.get("RemainSpace")),
            is_current=bool(data.get("IsCurrent")),
            status=data.get("Status", 0),
            driver_type=data.get("DirverType", 0),
            # NewStartTime and OldStartTime bound the recordings on disk
            oldest_record=(
                parse_time(data.get("OldStartTime")) or parse_time(data.get("NewStartTime"))
            ),
            newest_record=parse_time(data.get("NewEndTime")) or parse_time(data.get("OldEndTime")),
            raw=data,
        )

    @property
    def used_mb(self) -> int:
        return max(self.total_mb - self.free_mb, 0)

    @property
    def used_percent(self) -> float:
        return round(self.used_mb / self.total_mb * 100, 1) if self.total_mb else 0.0


@dataclass(slots=True)
class Disk:
    """A physical disk from ``StorageInfo``."""

    index: int
    model: str = ""
    partitions: list[Partition] = field(default_factory=list)
    raw: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_raw(cls, index: int, data: dict[str, Any]) -> Disk:
        parts = [Partition.from_raw(p) for p in data.get("Partition", []) or []]
        # the firmware always returns a fixed-length array; drop the empty slots
        parts = [p for p in parts[: data.get("PartNumber", len(parts))] if p.total_mb]
        return cls(index=index, model=data.get("ModelNumber", ""), partitions=parts, raw=data)

    @property
    def total_mb(self) -> int:
        return sum(p.total_mb for p in self.partitions)

    @property
    def free_mb(self) -> int:
        return sum(p.free_mb for p in self.partitions)


@dataclass(slots=True)
class NetworkInfo:
    """``NetWork.NetCommon`` in readable form."""

    host_name: str = ""
    ip: str = ""
    gateway: str = ""
    netmask: str = ""
    mac: str = ""
    http_port: int = 0
    tcp_port: int = 0
    udp_port: int = 0
    ssl_port: int = 0
    max_connections: int = 0
    transfer_plan: str = ""
    monitor_mode: str = ""
    raw: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_raw(cls, data: dict[str, Any]) -> NetworkInfo:
        return cls(
            host_name=data.get("HostName", ""),
            ip=parse_hex_ip(data.get("HostIP")),
            gateway=parse_hex_ip(data.get("GateWay")),
            netmask=parse_hex_ip(data.get("Submask")),
            mac=data.get("MAC", ""),
            http_port=data.get("HttpPort", 0),
            tcp_port=data.get("TCPPort", 0),
            udp_port=data.get("UDPPort", 0),
            ssl_port=data.get("SSLPort", 0),
            max_connections=data.get("TCPMaxConn", 0),
            transfer_plan=data.get("TransferPlan", ""),
            monitor_mode=data.get("MonMode", ""),
            raw=data,
        )


@dataclass(slots=True)
class RecordFile:
    """A single entry from ``OPFileQuery``."""

    name: str
    begin: datetime | None
    end: datetime | None
    size_kb: int = 0
    disk: int = 0
    serial: int = 0
    channel: int = 0
    event: str = ""
    stream: int = 0
    raw: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_raw(cls, data: dict[str, Any], channel: int = 0) -> RecordFile:
        name = data.get("FileName", "")
        event, stream = "", 0
        if match := _FILENAME_RE.search(name):
            event = EVENT_LABELS.get(match["event"], match["event"])
            stream = int(match["stream"])
        return cls(
            name=name,
            begin=parse_time(data.get("BeginTime")),
            end=parse_time(data.get("EndTime")),
            # FileLength is measured in kilobytes (verified against a downloaded file)
            size_kb=parse_hex_int(data.get("FileLength")),
            disk=data.get("DiskNo", 0),
            serial=data.get("SerialNo", 0),
            channel=channel,
            event=event,
            stream=stream,
            raw=data,
        )

    @property
    def size_bytes(self) -> int:
        return self.size_kb * 1024

    @property
    def duration(self) -> timedelta | None:
        if self.begin and self.end:
            return self.end - self.begin
        return None


@dataclass(slots=True)
class LogEntry:
    """A single system log entry."""

    time: datetime | None
    type: str = ""
    user: str = ""
    data: str = ""
    position: int = 0
    raw: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_raw(cls, item: dict[str, Any]) -> LogEntry:
        return cls(
            time=parse_time(item.get("Time")),
            type=item.get("Type", ""),
            user=item.get("User", ""),
            data=item.get("Data", ""),
            position=item.get("Position", 0),
            raw=item,
        )


@dataclass(slots=True)
class User:
    """A user account."""

    name: str
    group: str = ""
    memo: str = ""
    shared: bool = False
    authorities: list[str] = field(default_factory=list)
    raw: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_raw(cls, data: dict[str, Any]) -> User:
        return cls(
            name=data.get("Name", ""),
            group=data.get("Group", ""),
            memo=data.get("Memo", ""),
            shared=bool(data.get("Sharable")),
            authorities=list(data.get("AuthorityList", []) or []),
            raw=data,
        )


@dataclass(slots=True)
class Group:
    """A user group."""

    name: str
    memo: str = ""
    authorities: list[str] = field(default_factory=list)
    raw: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_raw(cls, data: dict[str, Any]) -> Group:
        return cls(
            name=data.get("Name", ""),
            memo=data.get("Memo", ""),
            authorities=list(data.get("AuthorityList", []) or []),
            raw=data,
        )


__all__ = [
    "ChannelState",
    "ChannelStatus",
    "DeviceInfo",
    "Disk",
    "Group",
    "LogEntry",
    "NetworkInfo",
    "Partition",
    "RecordFile",
    "User",
    "WorkState",
    "format_hex_ip",
    "format_time",
    "parse_hex_int",
    "parse_hex_ip",
    "parse_time",
]
