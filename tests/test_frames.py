"""Tests for the media stream demuxer.

The headers come from real NBD8008R-U frames: a 4K H.265 keyframe and its deltas.
"""

from __future__ import annotations

import struct
from datetime import datetime

import pytest

from xmeye.frames import (
    FrameDemuxer,
    FrameType,
    decode_timestamp,
    demux,
    encode_timestamp,
    to_elementary_stream,
)

#: A real keyframe header: H.265, 3840x2160, 21 fps, 2026-08-08 21:38:57.
#: T=0x53 carries both the codec (0x3) and the high bits of width and height.
REAL_IFRAME_HEADER = bytes.fromhex("000001fc5315e00eb959116a9b850000")

VIDEO_PAYLOAD = b"\x00\x00\x00\x01\x40\x01" + b"\xAA" * 40
PFRAME_PAYLOAD = b"\x00\x00\x00\x01\x02\x01" + b"\xBB" * 20
AUDIO_PAYLOAD = b"\xCC" * 320


def iframe(
    payload: bytes, *, flags: int = 0x53, fps: int = 21, when: datetime | None = None
) -> bytes:
    stamp = encode_timestamp(when or datetime(2026, 8, 8, 21, 38, 57))
    return (
        b"\x00\x00\x01\xfc"
        + bytes([flags, fps, 0xE0, 0x0E])
        + struct.pack("<I", stamp)
        + struct.pack("<I", len(payload))
        + payload
    )


def pframe(payload: bytes) -> bytes:
    return b"\x00\x00\x01\xfd" + struct.pack("<I", len(payload)) + payload


def audio(payload: bytes, *, codec: int = 0x0E, rate_index: int = 2) -> bytes:
    return (
        b"\x00\x00\x01\xfa"
        + bytes([codec, rate_index])
        + struct.pack("<H", len(payload))
        + payload
    )


# ----------------------------------------------------------------------
# Frame time
# ----------------------------------------------------------------------


def test_decode_real_timestamp() -> None:
    raw = int.from_bytes(REAL_IFRAME_HEADER[8:12], "little")
    assert decode_timestamp(raw) == datetime(2026, 8, 8, 21, 38, 57)


@pytest.mark.parametrize(
    "moment",
    [
        datetime(2026, 8, 9, 16, 39, 1),
        datetime(2000, 1, 1, 0, 0, 0),
        datetime(2063, 12, 31, 23, 59, 59),
    ],
)
def test_timestamp_round_trip(moment: datetime) -> None:
    assert decode_timestamp(encode_timestamp(moment)) == moment


def test_decode_timestamp_rejects_garbage() -> None:
    assert decode_timestamp(0) is None  # month 0 does not exist


# ----------------------------------------------------------------------
# Keyframe header
# ----------------------------------------------------------------------


def test_real_iframe_header_yields_4k() -> None:
    """The key detail: without the high bits from ``T`` this reads 1792x112, not 4K."""
    frames = demux(REAL_IFRAME_HEADER + b"\x00" * 0x859B)
    assert len(frames) == 1
    frame = frames[0]
    assert frame.codec == "h265"
    assert (frame.width, frame.height) == (3840, 2160)
    assert frame.fps == 21
    assert frame.keyframe
    assert frame.timestamp == datetime(2026, 8, 8, 21, 38, 57)


@pytest.mark.parametrize(
    ("flags", "width", "height"),
    [
        (0x02, 1792, 112),  # no extension: the low bytes as they are
        (0x12, 3840, 112),  # high bits of the width
        (0x42, 1792, 2160),  # high bits of the height
        (0x53, 3840, 2160),  # both, H.265
    ],
)
def test_resolution_extension_bits(flags: int, width: int, height: int) -> None:
    frame = demux(iframe(VIDEO_PAYLOAD, flags=flags))[0]
    assert (frame.width, frame.height) == (width, height)


def test_codec_from_low_nibble() -> None:
    assert demux(iframe(VIDEO_PAYLOAD, flags=0x02))[0].codec == "h264"
    assert demux(iframe(VIDEO_PAYLOAD, flags=0x03))[0].codec == "h265"
    assert demux(iframe(VIDEO_PAYLOAD, flags=0x01))[0].codec == "mpeg4"


def test_unknown_codec_is_reported_not_hidden() -> None:
    assert "unknown" in demux(iframe(VIDEO_PAYLOAD, flags=0x09))[0].codec


# ----------------------------------------------------------------------
# Other frame types
# ----------------------------------------------------------------------


def test_pframe_parsing() -> None:
    frame = demux(pframe(PFRAME_PAYLOAD))[0]
    assert frame.type is FrameType.VIDEO_P
    assert not frame.keyframe
    assert frame.payload == PFRAME_PAYLOAD


def test_audio_frame_parsing() -> None:
    frame = demux(audio(AUDIO_PAYLOAD))[0]
    assert frame.type is FrameType.AUDIO
    assert frame.codec == "g711a"
    assert frame.sample_rate == 8000  # index 2 in the table, counted from one
    assert frame.payload == AUDIO_PAYLOAD


def test_audio_frame_uses_16bit_length() -> None:
    """An audio frame carries a 2-byte length, not 4, or parsing drifts."""
    stream = audio(AUDIO_PAYLOAD) + pframe(PFRAME_PAYLOAD)
    frames = demux(stream)
    assert [f.type for f in frames] == [FrameType.AUDIO, FrameType.VIDEO_P]


# ----------------------------------------------------------------------
# Assembly from packets
# ----------------------------------------------------------------------


def test_frame_split_across_many_chunks() -> None:
    """A frame arrives in several packets, as a 4K keyframe always does."""
    stream = iframe(VIDEO_PAYLOAD) + pframe(PFRAME_PAYLOAD)
    demuxer = FrameDemuxer()
    collected = []
    for i in range(0, len(stream), 7):
        collected += list(demuxer.feed(stream[i : i + 7]))
    assert [f.type for f in collected] == [FrameType.VIDEO_I, FrameType.VIDEO_P]
    assert collected[0].payload == VIDEO_PAYLOAD


def test_byte_by_byte_feeding() -> None:
    stream = iframe(VIDEO_PAYLOAD)
    demuxer = FrameDemuxer()
    frames = [f for byte in stream for f in demuxer.feed(bytes([byte]))]
    assert len(frames) == 1
    assert frames[0].payload == VIDEO_PAYLOAD


def test_many_frames_in_one_chunk() -> None:
    stream = iframe(VIDEO_PAYLOAD) + pframe(PFRAME_PAYLOAD) * 3 + audio(AUDIO_PAYLOAD)
    frames = demux(stream)
    assert [f.type for f in frames] == [
        FrameType.VIDEO_I,
        FrameType.VIDEO_P,
        FrameType.VIDEO_P,
        FrameType.VIDEO_P,
        FrameType.AUDIO,
    ]


def test_payload_containing_brace_is_handled() -> None:
    """Regression: ``{`` and ``[`` do occur in a payload and must break nothing."""
    payload = b"{" * 64 + b"[" * 64
    frames = demux(iframe(payload))
    assert frames[0].payload == payload


# ----------------------------------------------------------------------
# Synchronisation
# ----------------------------------------------------------------------


def test_leading_garbage_counts_as_initial_skip_not_resync() -> None:
    """The device starts a live stream mid-frame, which is normal."""
    demuxer = FrameDemuxer()
    frames = list(demuxer.feed(b"\xde\xad\xbe\xef" * 8 + iframe(VIDEO_PAYLOAD)))
    assert len(frames) == 1
    assert demuxer.initial_skip == 32
    assert demuxer.resyncs == 0  # no data was lost mid-stream


def test_corruption_mid_stream_counts_as_resync() -> None:
    """A break after a successful parse, however, is real data loss."""
    demuxer = FrameDemuxer()
    list(demuxer.feed(iframe(VIDEO_PAYLOAD)))
    assert demuxer.resyncs == 0
    frames = list(demuxer.feed(b"\x11\x22\x33\x44" * 4 + pframe(PFRAME_PAYLOAD)))
    assert len(frames) == 1
    assert demuxer.resyncs == 1


def test_incomplete_frame_stays_buffered() -> None:
    demuxer = FrameDemuxer()
    stream = iframe(VIDEO_PAYLOAD)
    assert list(demuxer.feed(stream[:-5])) == []
    assert len(demuxer) > 0
    assert len(list(demuxer.feed(stream[-5:]))) == 1


def test_stream_info_accumulates() -> None:
    demuxer = FrameDemuxer()
    stream = iframe(VIDEO_PAYLOAD) + pframe(PFRAME_PAYLOAD) * 2 + audio(AUDIO_PAYLOAD)
    list(demuxer.feed(stream))
    info = demuxer.info
    assert info.video_frames == 3
    assert info.keyframes == 1
    assert info.audio_frames == 1
    assert info.resolution == "3840x2160"
    assert info.video_codec == "h265"
    assert info.audio_codec == "g711a"


def test_to_elementary_stream_keeps_only_video() -> None:
    frames = demux(iframe(VIDEO_PAYLOAD) + audio(AUDIO_PAYLOAD) + pframe(PFRAME_PAYLOAD))
    assert to_elementary_stream(frames) == VIDEO_PAYLOAD + PFRAME_PAYLOAD


# ----------------------------------------------------------------------
# Service blocks in the stream
# ----------------------------------------------------------------------

#: A real service block from the NBD8008R-U 4K stream: marked as a delta frame
#: but not video at all. Its first NAL has nuh_layer_id = 32, which is
#: impossible in a single-layer stream.
SERVICE_BLOCK = bytes.fromhex(
    "0000000111017800000000000000010" "7d1000100000000000000010000000100"
    "000102f1020e25d1020e25d1261f02f1261f"
) + b"\x00" * 64


def test_service_block_is_rejected() -> None:
    """A service block must not pass for video.

    Some decoders skip such NALs silently; others treat the frame as corrupt and
    stop with an error, so these must not be passed on.
    """
    frame = demux(pframe(SERVICE_BLOCK))[0]
    assert frame.is_video
    assert not frame.has_valid_nal


def test_real_frames_pass_validation() -> None:
    for payload, label in ((VIDEO_PAYLOAD, "key"), (PFRAME_PAYLOAD, "delta")):
        stream = iframe(payload) if label == "key" else pframe(payload)
        frame = demux(stream)[0]
        assert frame.has_valid_nal, f"{label} frame was rejected"


def test_validation_checks_layer_and_temporal_id() -> None:
    # nuh_layer_id != 0: a single-layer stream never has this
    bad_layer = b"\x00\x00\x00\x01\x02\x21" + b"\xAA" * 10
    assert not demux(pframe(bad_layer))[0].has_valid_nal

    # nuh_temporal_id_plus1 == 0 is forbidden by the specification
    bad_tid = b"\x00\x00\x00\x01\x02\x00" + b"\xAA" * 10
    assert not demux(pframe(bad_tid))[0].has_valid_nal

    # the forbidden bit must be zero
    forbidden = b"\x00\x00\x00\x01\x82\x01" + b"\xAA" * 10
    assert not demux(pframe(forbidden))[0].has_valid_nal


def test_validation_without_start_code() -> None:
    assert not demux(pframe(b"\xDE\xAD\xBE\xEF" * 4))[0].has_valid_nal
