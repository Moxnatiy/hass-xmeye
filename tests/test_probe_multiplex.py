"""The multiplex probe's framing.

The probe exists to say whether the server or the browser staggered a tile, and
a probe that mis-frames records answers that question confidently and wrongly.
So the parser is exercised here against a stream built to the same struct the
server packs with, including the split that a socket actually delivers: records
arrive cut in half far more often than whole.
"""

from __future__ import annotations

import importlib.util
import json
import struct
from pathlib import Path

import pytest

MODULE = Path(__file__).resolve().parent.parent / "tools" / "probe_multiplex.py"
spec = importlib.util.spec_from_file_location("probe_multiplex", MODULE)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


def record(kind: int, channel: int, flags: int, payload: bytes, stamp: float = 0.0) -> bytes:
    return probe.MUX_HEADER.pack(kind, channel, flags, len(payload), stamp) + payload


def stream() -> bytes:
    """Two channels announcing, then frames from both interleaved."""
    parts = []
    for channel, codec in ((0, "h265"), (1, "h264")):
        info = {"channel": channel, "codec": codec, "width": 704, "height": 576, "fps": 10}
        parts.append(record(probe.MUX_INFO, channel, 0, json.dumps(info).encode()))
        parts.append(record(probe.MUX_FRAME, channel, 1, b"\x00" * 900))
    for _ in range(4):
        parts.append(record(probe.MUX_FRAME, 0, 0, b"\x00" * 100))
        parts.append(record(probe.MUX_FRAME, 1, 0, b"\x00" * 200))
    return b"".join(parts)


def test_records_are_read_back_whole() -> None:
    parser = probe.MuxParser()
    parser.feed(stream(), now=0.0)

    assert sorted(parser.channels) == [0, 1]
    assert parser.channels[0].info["codec"] == "h265"
    assert parser.channels[1].info["codec"] == "h264"
    assert parser.channels[0].frames == 5
    assert parser.channels[0].keyframes == 1
    assert parser.channels[0].bytes == 900 + 4 * 100
    assert parser.channels[1].bytes == 900 + 4 * 200


@pytest.mark.parametrize("size", [1, 3, 16, 17, 64, 999])
def test_a_record_split_across_reads_is_still_one_record(size: int) -> None:
    """A socket hands over whatever it has, not whole records.

    Sixteen and seventeen are the interesting sizes: a chunk that ends exactly on
    the header boundary, and one that ends a byte past it.
    """
    whole = probe.MuxParser()
    whole.feed(stream(), now=0.0)

    piecemeal = probe.MuxParser()
    data = stream()
    for at in range(0, len(data), size):
        piecemeal.feed(data[at : at + size], now=0.0)

    assert sorted(piecemeal.channels) == sorted(whole.channels)
    for index, item in whole.channels.items():
        assert piecemeal.channels[index].frames == item.frames
        assert piecemeal.channels[index].bytes == item.bytes
        assert piecemeal.channels[index].info == item.info


def test_a_channel_in_trouble_is_reported_with_its_reason() -> None:
    """The server says why a tile is blank; the probe must not swallow it."""
    said = json.dumps(
        {"channel": 1, "reason": "silent", "detail": "", "attempt": 1, "retryIn": 3}
    ).encode()
    parser = probe.MuxParser()
    parser.feed(record(probe.MUX_ERROR, 1, 0, said), now=21.0)
    assert parser.channels[1].troubles == [(21.0, "silent")]
    assert parser.channels[1].frames == 0


def test_a_reason_carrying_a_detail_keeps_it() -> None:
    """A connection failure says what failed; the word alone would lose that."""
    said = json.dumps(
        {"channel": 0, "reason": "failed", "detail": "login refused", "attempt": 0, "retryIn": 0}
    ).encode()
    parser = probe.MuxParser()
    parser.feed(record(probe.MUX_ERROR, 0, 0, said), now=1.5)
    assert parser.channels[0].troubles == [(1.5, "failed (login refused)")]


def test_a_gap_in_the_frames_is_reported_as_a_stall() -> None:
    """The symptom the probe is for: a channel that goes quiet mid-stream."""
    item = probe.ChannelReport(0)
    item.note_frame(0.0, keyframe=True, size=100)
    item.note_frame(0.1, keyframe=False, size=100)
    item.note_frame(4.0, keyframe=False, size=100)  # silence in between
    item.note_frame(4.1, keyframe=False, size=100)

    assert item.stalls == [(0.1, 4.0)]
    assert item.at_first_key == 0.0


def test_the_header_matches_the_server() -> None:
    """Both sides pack the same sixteen bytes, or every field lands shifted."""
    server = (Path(__file__).resolve().parent.parent
              / "custom_components" / "xmeye" / "http.py").read_text(encoding="utf-8")
    assert '_MUX_HEADER = struct.Struct("<BHBId")' in server
    assert probe.MUX_HEADER.format == "<BHBId"
    assert probe.MUX_HEADER.size == struct.calcsize("<BHBId") == 16
    assert "MUX_INFO, MUX_FRAME, MUX_ERROR = 0, 1, 3" in server
    assert (probe.MUX_INFO, probe.MUX_FRAME, probe.MUX_ERROR) == (0, 1, 3)
