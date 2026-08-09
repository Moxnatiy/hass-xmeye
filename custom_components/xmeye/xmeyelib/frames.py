"""Demultiplex the Xiongmai media stream into frames.

The format comes from the vendor's stream format document and was verified
against real data from an NBD8008R-U. The same format is used for live viewing
(``OPMonitor``) and for archive download (``OPPlayBack``).

Every frame starts with the signature ``00 00 01 <type>``::

    0xFC  keyframe,      16-byte header
    0xFD  delta frame,   8-byte header
    0xFE  picture,       16-byte header (JPEG)
    0xFA  audio,         8-byte header
    0xF9  info,          8-byte header

Keyframe and picture header::

    offset  field
    4       T — bit field: bits 0-3 codec, bits 4-5 high bits of width,
                bits 6-7 high bits of height
    5       F — frame rate (bits 0-4 are significant)
    6       W — low 8 bits of the width divided by 8
    7       H — low 8 bits of the height divided by 8
    8       packed 32-bit date and time
    12      payload length (LE32), excluding the header

Because width and height are extended through byte ``T``, a naive ``W * 8``
gives the wrong answer for 4K: the high bits from ``T`` are required.
"""

from __future__ import annotations

import logging
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import datetime
from enum import IntEnum
from typing import Any

_LOGGER = logging.getLogger(__name__)

#: Frame start signature.
START_CODE = b"\x00\x00\x01"


class FrameType(IntEnum):
    """Frame type byte that follows the signature."""

    VIDEO_I = 0xFC
    VIDEO_P = 0xFD
    PICTURE = 0xFE
    AUDIO = 0xFA
    INFO = 0xF9


#: Header size for each frame type.
HEADER_SIZES = {
    FrameType.VIDEO_I: 16,
    FrameType.PICTURE: 16,
    FrameType.VIDEO_P: 8,
    FrameType.AUDIO: 8,
    FrameType.INFO: 8,
}

#: Video codec: the low four bits of byte ``T``.
VIDEO_CODECS = {0x01: "mpeg4", 0x02: "h264", 0x03: "h265"}

#: Audio codec: the low four bits of byte ``T``.
#: Numbering taken from Xiongmai firmware: PCM8=7, G729=8, IMA_ADPCM=9,
#: G711U=10, G721=11, PCM8_VWIS=12, MS_ADPCM=13, G711A=14, PCM16=15.
AUDIO_CODECS = {
    0x07: "pcm8",
    0x08: "g729",
    0x09: "ima_adpcm",
    0x0A: "g711u",
    0x0B: "g721",
    0x0C: "pcm8_vwis",
    0x0D: "ms_adpcm",
    0x0E: "g711a",
    0x0F: "pcm16",
}

#: Audio codec mapped to its ffmpeg name.
FFMPEG_AUDIO = {"g711a": "alaw", "g711u": "mulaw", "pcm16": "s16le", "pcm8": "u8"}

#: Sample rate index (one-based).
SAMPLE_RATES = (4000, 8000, 11025, 16000, 20000, 22050, 32000, 44100, 48000)


def decode_timestamp(value: int) -> datetime | None:
    """Unpack the frame time from its 32-bit field.

    Layout from the low bits: second 6, minute 6, hour 5, day 5, month 4,
    year 6 (counted from 2000).
    """
    second = value & 0x3F
    minute = (value >> 6) & 0x3F
    hour = (value >> 12) & 0x1F
    day = (value >> 17) & 0x1F
    month = (value >> 22) & 0x0F
    year = 2000 + ((value >> 26) & 0x3F)
    try:
        return datetime(year, month, day, hour, minute, second)
    except ValueError:
        # empty or damaged header
        return None


def encode_timestamp(moment: datetime) -> int:
    """Inverse of :func:`decode_timestamp`."""
    return (
        (moment.second & 0x3F)
        | ((moment.minute & 0x3F) << 6)
        | ((moment.hour & 0x1F) << 12)
        | ((moment.day & 0x1F) << 17)
        | ((moment.month & 0x0F) << 22)
        | (((moment.year - 2000) & 0x3F) << 26)
    )


@dataclass(slots=True)
class MediaFrame:
    """A single parsed frame."""

    type: FrameType
    payload: bytes
    codec: str = ""
    keyframe: bool = False
    width: int = 0
    height: int = 0
    fps: int = 0
    timestamp: datetime | None = None
    sample_rate: int = 0
    header: bytes = b""

    @property
    def is_video(self) -> bool:
        return self.type in (FrameType.VIDEO_I, FrameType.VIDEO_P)

    @property
    def has_valid_nal(self) -> bool:
        """Whether the payload looks like real video data.

        The recorder mixes service blocks into the stream, labelled as ordinary
        delta frames: 127 bytes, almost all zeros, identical every time. The
        first unit header there is impossible per the specification — its
        ``nuh_layer_id`` is 32 even though the stream has a single layer.

        Decoders differ in how they react: some silently skip such units,
        others treat the frame as corrupt and stop with an error. Not passing
        them on at all is the safer choice.
        """
        payload = self.payload
        offset = 0
        if payload[:4] == b"\x00\x00\x00\x01":
            offset = 4
        elif payload[:3] == START_CODE:
            offset = 3
        else:
            return False

        if self.codec == "h264":
            if len(payload) <= offset:
                return False
            header = payload[offset]
            # the forbidden bit must be zero and the type must fall in 1..23
            return not header & 0x80 and 1 <= (header & 0x1F) <= 23

        if len(payload) <= offset + 1:
            return False
        first, second = payload[offset], payload[offset + 1]
        if first & 0x80:  # forbidden bit
            return False
        layer_id = ((first & 0x01) << 5) | (second >> 3)
        temporal_id_plus1 = second & 0x07
        nal_type = (first >> 1) & 0x3F
        return layer_id == 0 and temporal_id_plus1 >= 1 and nal_type <= 40

    @property
    def is_audio(self) -> bool:
        return self.type is FrameType.AUDIO

    @property
    def is_picture(self) -> bool:
        return self.type is FrameType.PICTURE

    def __len__(self) -> int:
        return len(self.payload)


@dataclass
class StreamInfo:
    """Stream parameters gathered from the first keyframe."""

    video_codec: str = ""
    width: int = 0
    height: int = 0
    fps: int = 0
    audio_codec: str = ""
    sample_rate: int = 0
    first_timestamp: datetime | None = None
    last_timestamp: datetime | None = None
    video_frames: int = 0
    audio_frames: int = 0
    keyframes: int = 0
    video_bytes: int = 0
    audio_bytes: int = 0
    extra: dict[str, Any] = field(default_factory=dict)

    @property
    def resolution(self) -> str:
        return f"{self.width}x{self.height}" if self.width else "—"

    def update(self, frame: MediaFrame) -> None:
        if frame.is_video:
            self.video_frames += 1
            self.video_bytes += len(frame.payload)
            if frame.keyframe:
                self.keyframes += 1
                self.video_codec = frame.codec or self.video_codec
                self.width = frame.width or self.width
                self.height = frame.height or self.height
                self.fps = frame.fps or self.fps
        elif frame.is_audio:
            self.audio_frames += 1
            self.audio_bytes += len(frame.payload)
            self.audio_codec = frame.codec or self.audio_codec
            self.sample_rate = frame.sample_rate or self.sample_rate
        if frame.timestamp:
            self.first_timestamp = self.first_timestamp or frame.timestamp
            self.last_timestamp = frame.timestamp


class FrameDemuxer:
    """Incremental parsing of a byte stream into frames.

    DVRIP packets do not align with frame boundaries: one frame may arrive in
    several packets, and one packet may hold several frames. Feed everything
    that arrives and collect whatever frames come out.

    ::

        demuxer = FrameDemuxer()
        for frame in demuxer.feed(chunk):
            ...
    """

    def __init__(self, *, max_buffer: int = 16 * 1024 * 1024) -> None:
        self._buffer = bytearray()
        self._max_buffer = max_buffer
        self.info = StreamInfo()
        #: How many times sync was lost MID-stream. A non-zero value means data
        #: was lost, unlike :attr:`initial_skip`.
        self.resyncs = 0
        #: Bytes discarded before the first signature. The device starts a live
        #: stream mid-frame, so one such skip at the beginning is normal.
        self.initial_skip = 0
        self._synced = False

    def __len__(self) -> int:
        return len(self._buffer)

    def feed(self, data: bytes) -> Iterator[MediaFrame]:
        """Feed more data and yield every frame that could be assembled."""
        self._buffer += data
        if len(self._buffer) > self._max_buffer:
            # Guard against unbounded growth if the stream is hopelessly out of sync.
            _LOGGER.warning("Demuxer buffer overflowed, resetting")
            self._buffer.clear()
            self.resyncs += 1
            return
        while (frame := self._next()) is not None:
            self._synced = True
            self.info.update(frame)
            yield frame

    def _next(self) -> MediaFrame | None:
        if not self._resync():
            return None
        buffer = self._buffer
        if len(buffer) < 8:
            return None

        kind = FrameType(buffer[3])
        header_size = HEADER_SIZES[kind]
        if len(buffer) < header_size:
            return None

        if kind in (FrameType.VIDEO_I, FrameType.PICTURE):
            length = int.from_bytes(buffer[12:16], "little")
        elif kind is FrameType.VIDEO_P:
            length = int.from_bytes(buffer[4:8], "little")
        else:  # audio and info frames carry a 16-bit length
            length = int.from_bytes(buffer[6:8], "little")

        total = header_size + length
        if len(buffer) < total:
            return None

        header = bytes(buffer[:header_size])
        payload = bytes(buffer[header_size:total])
        del buffer[:total]
        return self._build(kind, header, payload)

    @staticmethod
    def _build(kind: FrameType, header: bytes, payload: bytes) -> MediaFrame:
        if kind in (FrameType.VIDEO_I, FrameType.PICTURE):
            flags = header[4]
            width = ((((flags >> 4) & 0x03) << 8) | header[6]) * 8
            height = ((((flags >> 6) & 0x03) << 8) | header[7]) * 8
            codec = (
                "jpeg"
                if kind is FrameType.PICTURE
                else VIDEO_CODECS.get(flags & 0x0F, f"unknown(0x{flags & 0x0F:X})")
            )
            return MediaFrame(
                type=kind,
                payload=payload,
                codec=codec,
                keyframe=True,
                width=width,
                height=height,
                fps=header[5] & 0x1F,
                timestamp=decode_timestamp(int.from_bytes(header[8:12], "little")),
                header=header,
            )

        if kind is FrameType.AUDIO:
            index = header[5]
            return MediaFrame(
                type=kind,
                payload=payload,
                codec=AUDIO_CODECS.get(header[4] & 0x0F, f"unknown(0x{header[4] & 0x0F:X})"),
                sample_rate=SAMPLE_RATES[index - 1] if 1 <= index <= len(SAMPLE_RATES) else 0,
                header=header,
            )

        return MediaFrame(type=kind, payload=payload, header=header)

    def _resync(self) -> bool:
        """Advance the buffer to the nearest valid frame signature."""
        buffer = self._buffer
        while True:
            if len(buffer) < 4:
                return False
            if buffer[:3] == START_CODE and buffer[3] in _KNOWN_TYPES:
                return True
            offset = buffer.find(START_CODE, 1)
            if offset < 0:
                # keep the last two bytes: a signature may straddle two packets
                skipped = max(len(buffer) - 2, 0)
                del buffer[:skipped]
                if not self._synced:
                    self.initial_skip += skipped
                return False
            if self._synced:
                _LOGGER.debug("Lost sync, skipped %d bytes", offset)
                self.resyncs += 1
            else:
                self.initial_skip += offset
            del buffer[:offset]


_KNOWN_TYPES = frozenset(int(t) for t in FrameType)


def demux(data: bytes) -> list[MediaFrame]:
    """Parse a fully downloaded block of data, such as an archive file."""
    demuxer = FrameDemuxer()
    return list(demuxer.feed(data))


def to_elementary_stream(frames: list[MediaFrame] | Iterator[MediaFrame]) -> bytes:
    """Join video frames into an Annex-B elementary stream that ffmpeg accepts."""
    return b"".join(f.payload for f in frames if f.is_video)


__all__ = [
    "AUDIO_CODECS",
    "FFMPEG_AUDIO",
    "SAMPLE_RATES",
    "VIDEO_CODECS",
    "FrameDemuxer",
    "FrameType",
    "MediaFrame",
    "StreamInfo",
    "decode_timestamp",
    "demux",
    "encode_timestamp",
    "to_elementary_stream",
]
