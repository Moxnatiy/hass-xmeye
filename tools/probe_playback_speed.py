#!/usr/bin/env python3
"""Test whether the recorder can be asked to play the archive faster.

    XMEYE_HOST=192.168.1.10 XMEYE_PASS=secret python tools/probe_playback_speed.py

The vendor's SDK carries an action table beside ``Claim``:

    Fast  Slow  Seek  Locate  DownloadPause  DownloadContinue  ForceIframe

so the commands exist in the protocol. Whether a given firmware acts on them is
another question, and this answers it for one device.

**The control run is the point of this tool.** An archive session arrives in
bursts, so a ten-second window measures whichever burst it caught, not the rate:
sending ``Fast`` and watching the next window rise to 2x looks like proof and is
not. The first case here sends nothing at all across six windows, and on the
NBD8008R-U it wanders 1.1 -> 1.1 -> 2.0 -> 1.0 -> 1.4 -> 0.7 on its own. Any
action has to beat that noise floor to mean anything, and none did.

Averaged over 45 seconds with nothing throttling the reader, that recorder
delivers 46 seconds of archive: 1.02x. It paces the archive in real time and the
speed actions change nothing.

Nothing here writes to the recorder: playback is read-only.
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

#: How long to watch the stream for each measurement. Long enough that a group
#: of pictures is not the whole sample, short enough to try many actions.
SAMPLE = 12.0


class Session:
    """One playback session, kept open so control actions can be sent into it."""

    def __init__(self) -> None:
        self.conn = DvripConnection(host=HOST, timeout=15.0)
        self.demuxer = FrameDemuxer()

    @property
    def session_id(self) -> str:
        return f"0x{self.conn.session:08X}"

    async def login(self) -> None:
        await self.conn.connect()
        reply = await self.conn.request_json(Msg.LOGIN, login_payload(USER, PASSWORD))
        if reply.get("Ret") not in OK_CODES:
            raise SystemExit(f"login failed: {reply}")

    def payload(self, action: str, begin: datetime, end: datetime, **extra: object) -> dict:
        parameter = {
            "PlayMode": "ByTime",
            "FileName": "",
            "StreamType": 0,
            "Value": 0,
            "TransMode": "TCP",
            "Channel": CHANNEL,
            **extra,
        }
        return {
            "Name": "OPPlayBack",
            "SessionID": self.session_id,
            "OPPlayBack": {
                "Action": action,
                "StartTime": format_time(begin),
                "EndTime": format_time(end),
                "Parameter": parameter,
            },
        }

    async def claim(self, begin: datetime, end: datetime) -> dict:
        return await self.conn.request_json(
            Msg.PLAY_CLAIM, self.payload("Claim", begin, end), expect=ANY_MESSAGE
        )

    async def act(self, action: str, begin: datetime, end: datetime, **extra: object) -> None:
        """Send a control action into the running session.

        Deliberately fire-and-forget: a reply may or may not come, and waiting
        for one would stall the stream we are trying to measure.
        """
        await self.conn.send(Msg.PLAY, self.payload(action, begin, end, **extra))

    async def measure(self, seconds: float) -> tuple[float, int, str]:
        """Watch the stream and report recorded-seconds per real second.

        The speed is taken between the first and last *timestamped* frame and
        divided by the wall time between those two arrivals — not by the length
        of the window. Only keyframes carry a timestamp, roughly one every two
        seconds, so dividing by the window would lose a whole keyframe interval
        at each edge and read 1.0x as about 0.6x.
        """
        samples: list[tuple[float, datetime]] = []
        frames = 0
        payload_bytes = 0
        started = time.perf_counter()
        deadline = started + seconds

        while time.perf_counter() < deadline:
            packet = await self.conn.next_media(timeout=max(0.2, deadline - time.perf_counter()))
            if packet is None:
                continue
            arrived = time.perf_counter()
            for frame in self.demuxer.feed(packet.payload):
                if not frame.is_video:
                    continue
                frames += 1
                payload_bytes += len(frame.payload)
                if frame.timestamp:
                    samples.append((arrived, frame.timestamp))

        elapsed = time.perf_counter() - started
        rate = f"{payload_bytes / 1024 / elapsed:>6.0f} KB/s"
        if not frames:
            return 0.0, 0, "no frames at all"
        if len(samples) < 2:
            return 0.0, frames, f"{frames:>4} frames, {rate}, no timestamp movement"

        wall = samples[-1][0] - samples[0][0]
        media = (samples[-1][1] - samples[0][1]).total_seconds()
        if wall <= 0:
            return 0.0, frames, f"{frames:>4} frames, {rate}, arrived in one burst"
        note = (
            f"{frames:>4} frames, {rate}, {len(samples):>2} stamps, "
            f"media {samples[0][1]:%H:%M:%S}->{samples[-1][1]:%H:%M:%S} over {wall:.1f}s"
        )
        return media / wall, frames, note

    async def close(self) -> None:
        self.conn.disable_media()
        await self.conn.close()


async def find_window() -> tuple[datetime, datetime]:
    """A stretch of archive long enough to play fast through."""
    async with XmeyeClient(HOST, username=USER, password=PASSWORD) as dvr:
        end = datetime.now() - timedelta(minutes=5)
        files = await dvr.search_files(end - timedelta(hours=6), end, channel=CHANNEL)
    if not files:
        raise SystemExit("no recordings in the last six hours")
    begin = next(f.begin for f in files if f.begin)
    return begin, begin + timedelta(minutes=30)


async def run_case(
    label: str,
    start_action: str,
    actions: list[str],
    *,
    stream_type: int = 0,
    sample: float = SAMPLE,
) -> None:
    """Open a session with one start action, then walk the control actions."""
    print(f"\n{'=' * 74}\n{label}\n{'=' * 74}", flush=True)
    begin, end = await find_window()
    print(f"window {begin:%Y-%m-%d %H:%M:%S} .. {end:%H:%M:%S}, "
          f"channel {CHANNEL}, StreamType {stream_type}", flush=True)

    session = Session()
    await session.login()
    claim = await session.claim(begin, end)
    if claim.get("Ret") not in OK_CODES:
        print(f"  claim refused: Ret={claim.get('Ret')}", flush=True)
        await session.close()
        return

    session.conn.enable_media()
    await session.act(start_action, begin, end, StreamType=stream_type)

    speed, frames, note = await session.measure(sample)
    print(f"  {start_action:<16} {speed:>6.2f}x   {note}", flush=True)
    if not frames:
        print("  nothing arrives; the rest of the run would say nothing", flush=True)
        await session.close()
        return

    for step, action in enumerate(actions, start=1):
        if action != "(idle)":
            await session.act(action, begin, end, StreamType=stream_type)
        speed, frames, note = await session.measure(sample)
        print(f"  {action:<12} #{step:<2} {speed:>6.2f}x   {note}", flush=True)

    await session.close()


async def run_locate(label: str, **locate: object) -> None:
    """Ask a running session to jump elsewhere, and see whether it lands there.

    The device advertises ``SupportPlaybackLocate`` and ``SupportPlayBackExactSeek``,
    and the SDK lists a ``Locate`` action beside ``DownloadPause``/``DownloadContinue``.
    If it works, scrubbing no longer needs a fresh session per jump.
    """
    print(f"\n{'=' * 74}\n{label}\n{'=' * 74}", flush=True)
    begin, end = await find_window()
    target = begin + timedelta(minutes=10)
    print(f"window {begin:%H:%M:%S}..{end:%H:%M:%S}, jump to {target:%H:%M:%S}", flush=True)

    session = Session()
    await session.login()
    claim = await session.claim(begin, end)
    if claim.get("Ret") not in OK_CODES:
        print(f"  claim refused: Ret={claim.get('Ret')}", flush=True)
        await session.close()
        return

    session.conn.enable_media()
    await session.act("DownloadStart", begin, end)
    speed, frames, note = await session.measure(SAMPLE)
    print(f"  before          {speed:>6.2f}x   {note}", flush=True)

    # The jump is expressed differently by each candidate; StartTime moves for all
    # of them, since the device may read the position from there.
    await session.act("Locate", target, end, **locate)
    speed, frames, note = await session.measure(SAMPLE)
    print(f"  after Locate    {speed:>6.2f}x   {note}", flush=True)
    print(f"  landed at the target?  {'yes' if f'{target:%H:%M}' in note else 'no'}", flush=True)
    await session.close()


async def main() -> int:
    if not HOST or not PASSWORD:
        print("Set XMEYE_HOST and XMEYE_PASS")
        return 2

    # The control run comes first and sends nothing at all. Without it a rising
    # then falling speed reads as "Fast worked, then hit a ceiling", when it may
    # only be a session settling and the scene's own bitrate wandering. Whatever
    # the action runs show has to beat this baseline to mean anything.
    await run_case(
        "CONTROL: DownloadStart and then nothing for six windows",
        "DownloadStart",
        ["(idle)"] * 5,
    )

    await run_case(
        "Fast three times",
        "DownloadStart",
        ["Fast"] * 3,
    )

    # If the actions work at all, Slow must go the other way. Same shape as the
    # control would mean neither does anything.
    await run_case(
        "Slow three times",
        "DownloadStart",
        ["Slow"] * 3,
    )

    await run_locate("Locate by StartTime alone")
    await run_locate("Locate with Value as an offset in seconds", Value=600)

    await run_case(
        "DownloadPause, then DownloadContinue",
        "DownloadStart",
        ["DownloadPause", "DownloadContinue"],
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
