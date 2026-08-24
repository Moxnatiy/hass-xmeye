"""Asynchronous client for Xiongmai / XMeye recorders (the DVRIP "Sofia" protocol).

    import asyncio
    from xmeye import XmeyeClient

    async def main():
        async with XmeyeClient("192.168.1.10", password="...") as dvr:
            print(await dvr.summary())

    asyncio.run(main())
"""

from .client import XmeyeClient
from .const import DEFAULT_PORT, Msg, PtzCommand, Ret, StreamType
from .exceptions import (
    CommandFailed,
    ConnectionFailed,
    DeviceSilent,
    LoginFailed,
    NotConnected,
    ProtocolError,
    UnsupportedFeature,
    XmeyeError,
)
from .frames import (
    FrameDemuxer,
    FrameType,
    MediaClock,
    MediaFrame,
    StreamInfo,
    decode_timestamp,
    demux,
)
from .models import (
    ChannelState,
    ChannelStatus,
    DeviceInfo,
    Disk,
    Group,
    LogEntry,
    NetworkInfo,
    Partition,
    RecordFile,
    User,
    WorkState,
)
from .protocol import DvripConnection, Packet, sofia_hash
from .stream import ArchiveStream, LiveStream, TalkStream

__version__ = "0.1.0"

__all__ = [
    "TalkStream",
    "demux",
    "decode_timestamp",
    "StreamInfo",
    "MediaClock",
    "MediaFrame",
    "LiveStream",
    "FrameType",
    "FrameDemuxer",
    "ArchiveStream",
    "DEFAULT_PORT",
    "ChannelState",
    "ChannelStatus",
    "CommandFailed",
    "ConnectionFailed",
    "DeviceSilent",
    "DeviceInfo",
    "Disk",
    "DvripConnection",
    "Group",
    "LogEntry",
    "LoginFailed",
    "Msg",
    "NetworkInfo",
    "NotConnected",
    "Packet",
    "Partition",
    "ProtocolError",
    "PtzCommand",
    "RecordFile",
    "Ret",
    "StreamType",
    "UnsupportedFeature",
    "User",
    "WorkState",
    "XmeyeClient",
    "XmeyeError",
    "sofia_hash",
    "__version__",
]
