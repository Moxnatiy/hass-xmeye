#!/usr/bin/env python3
"""Map what OPPlayBack ``Parameter.Value`` does to archive playback.

    XMEYE_HOST=192.168.1.10 XMEYE_PASS=secret python tools/probe_playback_value.py

The vendor app always sent ``Value=0`` and steered speed with an encrypted
command on its control socket, so ``Value``'s own meaning was never tested. It
turns out to matter: on the NBD8008R-U ``Value=2`` makes the recorder deliver a
decimated fast-scan — the same frame throughput scattered across roughly ten
times more recording time, and every frame still decodable. Other values mostly
behave like ``Value=0``, and a couple (1, 4) return nothing, so ``Value`` is a
mode selector rather than a linear multiplier.

The measure that tells modes apart is frames-per-second-of-recording: near 20 is
the full stream, near 2 is a decimated fast-scan. Wall speed alone is
misleading, because with no client pacing every mode races as fast as the link
allows.

Reads the recorder only; playback modifies nothing.
"""

from __future__ import annotations

import asyncio
import os
import sys
import time
from datetime import datetime, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from xmeye import XmeyeClient  # noqa: E402
from xmeye.const import OK_CODES, Msg  # noqa: E402
from xmeye.frames import FrameDemuxer  # noqa: E402
from xmeye.models import format_time  # noqa: E402
from xmeye.protocol import ANY_MESSAGE, DvripConnection, login_payload  # noqa: E402

HOST = os.environ.get("XMEYE_HOST", "")
USER = os.environ.get("XMEYE_USER", "admin")
PASSWORD = os.environ.get("XMEYE_PASS", "")
CHANNEL = int(os.environ.get("XMEYE_CHANNEL", "0"))

SAMPLE = 25.0


async def _window() -> tuple[datetime, datetime]:
    async with XmeyeClient(HOST, username=USER, password=PASSWORD) as dvr:
        start = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
        files = await dvr.search_files(start, start + timedelta(hours=23), channel=CHANNEL)
    begin = next(f.begin for f in files if f.begin)
    return begin, begin + timedelta(hours=4)


def _payload(session_id: str, action: str, begin: datetime, end: datetime, value: int) -> dict:
    return {
        "Name": "OPPlayBack",
        "SessionID": session_id,
        "OPPlayBack": {
            "Action": action,
            "StartTime": format_time(begin),
            "EndTime": format_time(end),
            "Parameter": {
                "PlayMode": "ByTime",
                "FileName": "",
                "Channel": CHANNEL,
                "StreamType": 0,
                "Value": value,
                "TransMode": "TCP",
            },
        },
    }


async def probe(value: int, seconds: float = SAMPLE) -> None:
    begin, end = await _window()
    conn = DvripConnection(host=HOST, timeout=15.0)
    await conn.connect()
    reply = await conn.request_json(Msg.LOGIN, login_payload(USER, PASSWORD))
    if reply.get("Ret") not in OK_CODES:
        print(f"  Value={value}: login Ret={reply.get('Ret')}")
        await conn.close()
        return
    sid = f"0x{conn.session:08X}"

    claim = await conn.request_json(
        Msg.PLAY_CLAIM, _payload(sid, "Claim", begin, end, value), expect=ANY_MESSAGE
    )
    if claim.get("Ret") not in OK_CODES:
        print(f"  Value={value}: claim Ret={claim.get('Ret')}")
        await conn.close()
        return

    conn.enable_media()
    await conn.send(Msg.PLAY, _payload(sid, "DownloadStart", begin, end, value))

    demux = FrameDemuxer()
    frames = keyframes = payload_bytes = 0
    stamps: list[tuple[float, datetime]] = []
    started = time.perf_counter()
    while time.perf_counter() - started < seconds:
        packet = await conn.next_media(timeout=5.0)
        if packet is None:
            break
        now = time.perf_counter()
        for frame in demux.feed(packet.payload):
            if not frame.is_video:
                continue
            frames += 1
            payload_bytes += len(frame.payload)
            if frame.keyframe:
                keyframes += 1
            if frame.timestamp:
                stamps.append((now, frame.timestamp))

    conn.disable_media()
    await conn.close()

    if len(stamps) < 2:
        print(f"  Value={value:<3} {frames} frames, no timestamp movement")
        return
    wall = stamps[-1][0] - stamps[0][0]
    recorded = (stamps[-1][1] - stamps[0][1]).total_seconds()
    rec_fps = frames / recorded if recorded else 0
    kb = payload_bytes / 1024 / wall
    print(
        f"  Value={value:<3} {recorded / wall:>7.1f}x wall | {frames:>4} frames, "
        f"{keyframes} key, {rec_fps:>4.1f} fps-of-recording, {kb:>5.0f} KB/s"
    )


async def main() -> int:
    if not HOST or not PASSWORD:
        print("Set XMEYE_HOST and XMEYE_PASS")
        return 2
    print("OPPlayBack Parameter.Value characterisation:")
    print("  fps-of-recording near 20 = full stream; near 2 = decimated fast-scan\n")
    for value in (0, 1, 2, 3, 4, 5, 8, 16):
        await probe(value)
        await asyncio.sleep(3)
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
