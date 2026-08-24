"""Tests for the media stream demuxer.

The headers come from real NBD8008R-U frames: a 4K H.265 keyframe and its deltas.
"""

from __future__ import annotations

import struct
from datetime import datetime, timedelta

import pytest

from xmeye.frames import (
    FrameDemuxer,
    FrameType,
    MediaClock,
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

def test_h264_delta_frames_survive_the_service_block_filter() -> None:
    """Regression: an H.264 delta frame must not be mistaken for a service block.

    Only a keyframe header carries the codec. Read as H.265, an H.264 slice
    header of ``0x41`` gives ``nuh_layer_id`` 32 — the very marker the filter
    rejects — so every delta frame was dropped and the browser got keyframes
    alone: one picture, then a still image at a fraction of the bitrate.
    """
    demuxer = FrameDemuxer()
    # A real H.264 keyframe starts with an SPS (0x67); its delta frames are
    # non-IDR slices (0x41). Both taken from an NBD8008R-U 720p stream.
    key = iframe(b"\x00\x00\x00\x01\x67\x64\x00\x28" + b"\x00" * 16, flags=0x02)
    delta = pframe(b"\x00\x00\x00\x01\x41\x9a\x00\x40" + b"\x00" * 16)

    frames = list(demuxer.feed(key)) + list(demuxer.feed(delta))
    assert len(frames) == 2
    assert demuxer.info.video_codec == "h264"

    keyframe, delta_frame = frames
    assert keyframe.has_valid_nal, "the keyframe was rejected"
    assert delta_frame.codec == "h264", "the delta frame did not inherit the codec"
    assert delta_frame.has_valid_nal, "the delta frame was taken for a service block"


def test_hevc_service_block_is_still_rejected_after_a_keyframe() -> None:
    """The fix must not blunt the filter it works around.

    Stamping the codec onto delta frames means the H.265 branch now runs with a
    codec set, which is exactly when the real service block has to be caught.
    """
    demuxer = FrameDemuxer()
    list(demuxer.feed(iframe(VIDEO_PAYLOAD)))
    blocks = list(demuxer.feed(pframe(SERVICE_BLOCK)))
    assert blocks and not blocks[0].has_valid_nal


class TestMediaClock:
    """The timeline the archive is played by.

    The recorder stamps keyframes only, and only to the second. Everything the
    player does with time — pacing, the ×N speed, the cursor on the timeline —
    is built on what this class makes of that.
    """

    #: A recording is a group of pictures every 1.2 s or so, twenty-five frames
    #: at the twenty-one frames a second the recorder reports.
    FPS = 21
    START = datetime(2026, 8, 8, 21, 38, 57)

    def gop(self, demuxer: FrameDemuxer, when: datetime) -> list:
        data = iframe(VIDEO_PAYLOAD, fps=self.FPS, when=when)
        data += pframe(PFRAME_PAYLOAD) * 24
        return list(demuxer.feed(data))

    def test_delta_frames_get_a_time_of_their_own(self) -> None:
        """The whole point: without this, twenty-four frames in twenty-five have
        no time and a player pacing itself by them shows one burst a second."""
        clock = MediaClock()
        stamps = [
            clock.stamp(f, self.START) for f in self.gop(FrameDemuxer(), self.START)
        ]

        assert stamps == sorted(stamps), "the timeline steps backwards"
        assert len(set(stamps)) == len(stamps), "two frames share a moment"
        gaps = [b - a for a, b in zip(stamps, stamps[1:], strict=False)]
        # Floating seconds since the epoch resolve to about a quarter of a
        # microsecond, so a millisecond is the honest tolerance here.
        assert all(abs(gap - 1 / self.FPS) < 1e-3 for gap in gaps)

    def test_rounding_to_the_second_never_drags_the_clock_back(self) -> None:
        """A keyframe's stamp is truncated, so it is usually *behind* the truth.

        Following it anyway would jerk playback back by up to a second at every
        group of pictures — and hand the panel a position that jumps about.
        """
        demuxer = FrameDemuxer()
        clock = MediaClock()
        stamps = []
        # Groups really 25/21 s apart; the recorder can only say 57, 58, 59.
        for index in range(4):
            when = self.START + timedelta(seconds=int(index * 25 / self.FPS))
            stamps += [clock.stamp(f, self.START) for f in self.gop(demuxer, when)]

        assert stamps == sorted(stamps)
        expected = self.START.timestamp() + (len(stamps) - 1) / self.FPS
        assert abs(stamps[-1] - expected) < 1e-4, "the clock was pulled off the truth"

    def test_a_keyframe_that_is_genuinely_later_is_followed(self) -> None:
        """Between recordings, and in a fast-scan, time really does jump."""
        demuxer = FrameDemuxer()
        clock = MediaClock()
        for frame in self.gop(demuxer, self.START):
            clock.stamp(frame, self.START)

        later = self.START + timedelta(minutes=7)
        jumped = [clock.stamp(f, later) for f in self.gop(demuxer, later)]
        assert jumped[0] == later.timestamp()

    def test_without_a_keyframe_the_recording_start_anchors_it(self) -> None:
        """A stream joined mid group of pictures still has to start somewhere."""
        clock = MediaClock()
        deltas = list(FrameDemuxer().feed(pframe(PFRAME_PAYLOAD) * 3))
        stamps = [clock.stamp(f, self.START) for f in deltas]
        assert stamps[0] == self.START.timestamp()
        assert stamps == sorted(stamps)
