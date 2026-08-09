"""Media sessions: live viewing and archive download.

Each stream needs its **own TCP connection** with its own login. The control
session :class:`~xmeye.client.XmeyeClient` will not do, because once a stream
starts the connection carries binary data. The device is limited by
``TCPMaxConn``, typically ten.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from datetime import datetime
from typing import Any, Self

from .const import DEFAULT_PORT, OK_CODES, Msg, StreamType
from .exceptions import CommandFailed, LoginFailed, XmeyeError
from .frames import FrameDemuxer, MediaFrame, StreamInfo
from .models import RecordFile, format_time
from .protocol import ANY_MESSAGE, DvripConnection, login_payload

_LOGGER = logging.getLogger(__name__)


class _MediaSession:
    """Shared parts of a media session: its own connection, login, media queue."""

    def __init__(
        self,
        host: str,
        *,
        username: str = "admin",
        password: str = "",
        port: int = DEFAULT_PORT,
        timeout: float = 15.0,
    ) -> None:
        self.host = host
        self._username = username
        self._password = password
        self._conn = DvripConnection(host=host, port=port, timeout=timeout)
        self.demuxer = FrameDemuxer()
        self._started = False

    @property
    def info(self) -> StreamInfo:
        """Stream parameters gathered while parsing."""
        return self.demuxer.info

    @property
    def session_id(self) -> str:
        return f"0x{self._conn.session:08X}"

    @property
    def dropped_packets(self) -> int:
        return self._conn.dropped_media

    async def _login(self) -> dict[str, Any]:
        await self._conn.connect()
        reply = await self._conn.request_json(
            Msg.LOGIN, login_payload(self._username, self._password)
        )
        if reply.get("Ret") not in OK_CODES:
            await self._conn.close()
            raise LoginFailed(str(CommandFailed(reply.get("Ret", 0), "Login", reply)))
        return reply

    async def close(self) -> None:
        self._conn.disable_media()
        await self._conn.close()
        self._started = False

    async def __aenter__(self) -> Self:
        await self.start()
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        await self.close()

    async def start(self) -> None:  # pragma: no cover - defined by subclasses
        raise NotImplementedError


class LiveStream(_MediaSession):
    """Live viewing of a channel through ``OPMonitor``.

    ::

        async with LiveStream("192.168.0.10", password="...", channel=0) as live:
            async for frame in live.frames(limit=100):
                ...
            print(live.info.resolution, live.info.video_codec)

    For most tasks RTSP is simpler and brings hardware decoding for free. This
    path matters when RTSP is disabled or when exact frame timing is needed:
    every keyframe carries its own timestamp with one-second resolution.
    """

    def __init__(
        self,
        host: str,
        *,
        channel: int = 0,
        stream: str = StreamType.MAIN,
        combine_mode: str = "NONE",
        **kwargs: Any,
    ) -> None:
        super().__init__(host, **kwargs)
        self.channel = channel
        self.stream = stream
        self._parameter = {
            "Channel": channel,
            "CombinMode": combine_mode,  # misspelled on purpose: the firmware expects it
            "StreamType": stream,
            "TransMode": "TCP",
        }

    def _payload(self, action: str) -> dict[str, Any]:
        return {
            "Name": "OPMonitor",
            "SessionID": self.session_id,
            "OPMonitor": {"Action": action, "Parameter": self._parameter},
        }

    async def start(self) -> None:
        """Log in, claim the channel and start the stream."""
        await self._login()
        reply = await self._conn.request_json(
            Msg.MONITOR_CLAIM, self._payload("Claim"), expect=ANY_MESSAGE
        )
        if reply.get("Ret") not in OK_CODES:
            await self._conn.close()
            raise CommandFailed(reply.get("Ret", 0), "OPMonitor.Claim", reply)

        # The queue must exist BEFORE Start, or the first frames go nowhere.
        self._conn.enable_media()
        await self._conn.send(Msg.MONITOR_START, self._payload("Start"))
        self._started = True
        _LOGGER.debug("Stream for channel %s (%s) started", self.channel, self.stream)

    async def stop(self) -> None:
        """Stop the stream cleanly, leaving the connection open."""
        if self._started:
            try:
                await self._conn.send(Msg.MONITOR_START, self._payload("Stop"))
            except XmeyeError:
                pass
            self._started = False

    async def close(self) -> None:
        await self.stop()
        await super().close()

    async def frames(
        self,
        *,
        limit: int | None = None,
        duration: float | None = None,
        start_at_keyframe: bool = True,
    ) -> AsyncIterator[MediaFrame]:
        """Iterate over the frames of the stream.

        :param limit: stop after this many frames
        :param duration: stop after this many seconds
        :param start_at_keyframe: skip frames until the first keyframe. The
            device starts a stream mid group of pictures, so without this the
            decoder stumbles on delta frames whose references are missing.
        """
        deadline = asyncio.get_running_loop().time() + duration if duration else None
        count = 0
        waiting = start_at_keyframe
        async for packet in self._conn.media_packets():
            for frame in self.demuxer.feed(packet.payload):
                if waiting:
                    if not frame.keyframe:
                        continue
                    waiting = False
                yield frame
                count += 1
                if limit is not None and count >= limit:
                    return
            if deadline is not None and asyncio.get_running_loop().time() >= deadline:
                return

    async def keyframe(self, *, timeout: float = 15.0) -> MediaFrame | None:
        """Wait for the first keyframe, which is the basis for a snapshot."""

        async def _wait() -> MediaFrame | None:
            async for frame in self.frames():
                if frame.keyframe:
                    return frame
            return None

        try:
            return await asyncio.wait_for(_wait(), timeout)
        except TimeoutError:
            return None


class ArchiveStream(_MediaSession):
    """Archive download through ``OPPlayBack``.

    ::

        async with ArchiveStream("192.168.0.10", password="...") as archive:
            data = await archive.download(record)
    """

    def __init__(self, host: str, *, channel: int = 0, **kwargs: Any) -> None:
        super().__init__(host, **kwargs)
        self.channel = channel
        #: 0 is the main stream, 1 the sub stream.
        self.stream_index = 0
        #: OPPlayBack ``Parameter.Value``. The app always sends 0; on the tested
        #: firmware ``2`` makes the recorder deliver a decimated fast-scan (the
        #: same frames spread across ~10x more recording time, still decodable),
        #: which is the only server-side fast-forward the plaintext protocol
        #: offers. It is a mode selector, not a multiplier: only 2 (weakly 3)
        #: has an effect. See docs/protocol.md.
        self.value = 0

    def _payload(
        self,
        action: str,
        name: str,
        begin: str,
        end: str,
        *,
        by_time: bool = False,
    ) -> dict[str, Any]:
        parameter: dict[str, Any] = {
            "PlayMode": "ByTime" if by_time else "ByName",
            "FileName": name,
            "StreamType": self.stream_index,
            "Value": self.value,
            "TransMode": "TCP",
        }
        if by_time:
            # In time mode the file name is ignored and the channel is needed.
            parameter["Channel"] = self.channel
        return {
            "Name": "OPPlayBack",
            "SessionID": self.session_id,
            "OPPlayBack": {
                "Action": action,
                "StartTime": begin,
                "EndTime": end,
                "Parameter": parameter,
            },
        }

    async def start(self) -> None:
        await self._login()

    @staticmethod
    def _resolve(
        record: RecordFile | str,
        begin: datetime | None,
        end: datetime | None,
    ) -> tuple[str, str, int]:
        if isinstance(record, RecordFile):
            if record.begin is None or record.end is None:
                raise ValueError("The record has no time bounds")
            return format_time(record.begin), format_time(record.end), record.size_bytes
        if begin is None or end is None:
            raise ValueError("Downloading by name needs begin and end")
        return format_time(begin), format_time(end), 0

    async def frames(
        self,
        record: RecordFile | str,
        *,
        begin: datetime | None = None,
        end: datetime | None = None,
        timeout: float = 30.0,
        by_time: bool = False,
        start_at_keyframe: bool = True,
    ) -> AsyncIterator[MediaFrame]:
        """Download a recording, yielding frames as they arrive.

        :param by_time: pull a continuous time range instead of one file. Handy
            when the interval crosses file boundaries; ``record`` is ignored in
            this mode and ``begin`` and ``end`` are required instead.
        :param start_at_keyframe: skip frames until the first keyframe. Needed
            for time mode: an arbitrary moment almost always lands mid group of
            pictures, leaving the decoder without sequence parameters.
        """
        name = "" if by_time else (record.name if isinstance(record, RecordFile) else record)
        if by_time:
            if begin is None or end is None:
                raise ValueError("Time mode needs begin and end")
            start_time, end_time, expected = format_time(begin), format_time(end), 0
        else:
            start_time, end_time, expected = self._resolve(record, begin, end)

        claim = await self._conn.request_json(
            Msg.PLAY_CLAIM,
            self._payload("Claim", name, start_time, end_time, by_time=by_time),
            expect=ANY_MESSAGE,
        )
        if claim.get("Ret") not in OK_CODES:
            raise CommandFailed(claim.get("Ret", 0), "OPPlayBack.Claim", claim)

        self._conn.enable_media()
        await self._conn.send(
            Msg.PLAY,
            self._payload("DownloadStart", name, start_time, end_time, by_time=by_time),
        )
        self._started = True

        received = 0
        waiting = start_at_keyframe
        try:
            while True:
                packet = await self._conn.next_media(timeout)
                if packet is None:
                    # either the stream ended or the firmware went quiet; for a
                    # download both are a normal finish
                    break
                # An empty packet is how the firmware marks end of file.
                if not packet.payload:
                    break
                received += len(packet.payload)
                for frame in self.demuxer.feed(packet.payload):
                    if waiting:
                        if not frame.keyframe:
                            continue
                        waiting = False
                    yield frame
                if expected and received >= expected:
                    break
        finally:
            await self._stop(name, start_time, end_time)

    async def download(
        self,
        record: RecordFile | str,
        *,
        begin: datetime | None = None,
        end: datetime | None = None,
        timeout: float = 30.0,
        by_time: bool = False,
        start_at_keyframe: bool = True,
    ) -> bytes:
        """Download a recording as an Annex-B elementary stream, headers stripped."""
        chunks: list[bytes] = []
        async for frame in self.frames(
            record,
            begin=begin,
            end=end,
            timeout=timeout,
            by_time=by_time,
            start_at_keyframe=start_at_keyframe,
        ):
            if frame.is_video:
                chunks.append(frame.payload)
        return b"".join(chunks)

    async def _stop(self, name: str, begin: str, end: str) -> None:
        if not self._started:
            return
        self._started = False
        try:
            await self._conn.send(Msg.PLAY, self._payload("DownloadStop", name, begin, end))
        except XmeyeError:
            pass
        self._conn.disable_media()


class TalkStream(_MediaSession):
    """Two-way audio through ``OPTalk``.

    The device accepts G.711 in chunks of exactly :data:`CHUNK` bytes, wrapped
    in the same audio header used by the outgoing stream.

    ::

        async with TalkStream("192.168.0.10", password="...") as talk:
            await talk.send(g711_alaw_bytes)
    """

    #: Chunk size the firmware expects: 20 ms of G.711 at 8 kHz.
    CHUNK = 320

    #: Codec mapped to the ``T`` byte of the audio frame header.
    CODEC_IDS = {"g711a": 0x0E, "g711u": 0x0A}

    def __init__(self, host: str, *, codec: str = "g711a", **kwargs: Any) -> None:
        super().__init__(host, **kwargs)
        if codec not in self.CODEC_IDS:
            raise ValueError(f"Unsupported talk codec: {codec}")
        self.codec = codec
        self._tail = b""

    def _payload(self, action: str) -> dict[str, Any]:
        return {
            "Name": "OPTalk",
            "SessionID": self.session_id,
            "OPTalk": {
                "Action": action,
                "AudioFormat": {
                    "BitRate": 128,
                    "EncodeType": "G711_ALAW" if self.codec == "g711a" else "G711_ULAW",
                    "SampleBit": 8,
                    "SampleRate": 8000,
                },
            },
        }

    async def start(self) -> None:
        """Log in and open the voice channel."""
        await self._login()
        claim = await self._conn.request_json(
            Msg.TALK_CLAIM, self._payload("Claim"), expect=ANY_MESSAGE
        )
        if claim.get("Ret") not in OK_CODES:
            await self._conn.close()
            raise CommandFailed(claim.get("Ret", 0), "OPTalk.Claim", claim)
        await self._conn.send(Msg.TALK_START, self._payload("Start"))
        self._started = True

    def _frame(self, chunk: bytes) -> bytes:
        return (
            b"\x00\x00\x01\xfa"
            + bytes([self.CODEC_IDS[self.codec], 0x02])  # 0x02 means 8 kHz
            + len(chunk).to_bytes(2, "little")
            + chunk
        )

    async def send(self, audio: bytes) -> int:
        """Send audio. Returns the number of chunks sent.

        A remainder shorter than :data:`CHUNK` is buffered until the next call:
        the firmware does not accept partial chunks.
        """
        if not self._started:
            raise XmeyeError("Voice channel is not open")
        buffer = self._tail + audio
        sent = 0
        while len(buffer) >= self.CHUNK:
            await self._conn.send(Msg.TALK_DATA, self._frame(buffer[: self.CHUNK]))
            buffer = buffer[self.CHUNK :]
            sent += 1
        self._tail = buffer
        return sent

    async def flush(self) -> None:
        """Flush the remainder, padding it with silence to a full chunk."""
        if self._tail:
            silence = b"\xd5" if self.codec == "g711a" else b"\xff"
            await self._conn.send(
                Msg.TALK_DATA,
                self._frame(self._tail.ljust(self.CHUNK, silence)),
            )
            self._tail = b""

    async def close(self) -> None:
        if self._started:
            try:
                await self.flush()
                await self._conn.send(Msg.TALK_START, self._payload("Stop"))
            except XmeyeError:
                pass
            self._started = False
        await super().close()


__all__ = ["ArchiveStream", "LiveStream", "StreamType", "TalkStream"]
