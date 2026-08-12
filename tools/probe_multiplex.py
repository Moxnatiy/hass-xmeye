#!/usr/bin/env python3
"""Watch what the integration's video endpoints actually send, without a browser.

    HA_TOKEN=... python tools/probe_multiplex.py --channels 0,1,2 --seconds 20
    HA_TOKEN=... python tools/probe_multiplex.py --channels 0,1,2 --split

A tile that comes up late, or blinks and comes back, has two possible causes and
they look identical on screen: either the server delivered it that way, or the
browser did. This reads the same HTTP endpoints the panel reads and reports the
timing of every record, so the server's half can be ruled in or out on its own.

``--split`` opens the old one-connection-per-channel endpoints instead of the
shared one, which separates "the multiplexer staggers channels" from "this
recorder starts channels slowly" — the same control-run discipline the archive
speed probe needed.

Nothing here writes to the recorder or to Home Assistant. Both endpoints are
reads.

The token is a Home Assistant long-lived access token (Profile -> Security). It
is read from ``HA_TOKEN`` or from ``.local/ha-token``, which is gitignored, and
is never printed.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import pathlib
import struct
import sys
import time

#: Mirrors _MUX_HEADER in custom_components/xmeye/http.py.
MUX_HEADER = struct.Struct("<BHBId")
MUX_INFO, MUX_FRAME, MUX_HELLO = 0, 1, 2

#: Mirrors _FRAME_HEADER, the single-channel format.
FRAME_HEADER = struct.Struct("<BId")

#: A gap longer than this is worth naming: a camera at 10 fps still owes a frame
#: every 100 ms, so a second of silence is a stall rather than jitter.
STALL = 1.0


class ChannelReport:
    """What one channel did over the life of the connection."""

    def __init__(self, channel: int) -> None:
        self.channel = channel
        self.info: dict | None = None
        self.at_info: float | None = None
        self.at_first_frame: float | None = None
        self.at_first_key: float | None = None
        self.at_last_frame: float | None = None
        self.frames = 0
        self.keyframes = 0
        self.bytes = 0
        self.stalls: list[tuple[float, float]] = []

    def note_info(self, now: float, info: dict) -> None:
        self.info = info
        if self.at_info is None:
            self.at_info = now

    def note_frame(self, now: float, keyframe: bool, size: int) -> None:
        if self.at_first_frame is None:
            self.at_first_frame = now
        if keyframe and self.at_first_key is None:
            self.at_first_key = now
        if self.at_last_frame is not None and now - self.at_last_frame > STALL:
            self.stalls.append((self.at_last_frame, now))
        self.at_last_frame = now
        self.frames += 1
        self.keyframes += 1 if keyframe else 0
        self.bytes += size


def _stamp(value: float | None) -> str:
    return "     —" if value is None else f"{value:6.2f}s"


def report(channels: dict[int, ChannelReport], elapsed: float, label: str) -> None:
    print(f"\n{label}, {elapsed:.1f}s")
    print(
        f"  {'ch':>3}  {'info at':>7}  {'1st key':>7}  {'frames':>6}  {'keys':>5} "
        f" {'fps':>5}  {'Mbps':>6}  codec        size      stalls"
    )
    for index in sorted(channels):
        item = channels[index]
        span = (
            (item.at_last_frame - item.at_first_frame)
            if item.at_first_frame is not None and item.at_last_frame is not None
            else 0.0
        )
        fps = item.frames / span if span > 0.2 else 0.0
        mbps = (item.bytes * 8 / 1e6) / span if span > 0.2 else 0.0
        info = item.info or {}
        size = (
            f"{info.get('width', '?')}x{info.get('height', '?')}" if info else "—"
        )
        stalls = (
            " ".join(f"{a:.1f}→{b:.1f}" for a, b in item.stalls[:3]) or "—"
        )
        print(
            f"  {index:>3}  {_stamp(item.at_info)}  {_stamp(item.at_first_key)}  "
            f"{item.frames:>6}  {item.keyframes:>5}  {fps:>5.1f}  {mbps:>6.2f}  "
            f"{info.get('codec', '—'):<11}  {size:<9} {stalls}"
        )

    starts = [c.at_first_key for c in channels.values() if c.at_first_key is not None]
    silent = [i for i, c in channels.items() if c.at_first_key is None]
    print()
    if len(starts) > 1:
        spread = max(starts) - min(starts)
        print(f"  first pictures spread over {spread:.2f}s")
        # This is the number the staggered-tiles question turns on. Under a
        # second is the keyframe interval doing its normal work; several seconds
        # means the channels genuinely queued behind each other.
        if spread > 2.0:
            print("  -> the server itself staggers them; not the browser")
        else:
            print("  -> the server starts them together; a stagger on screen is the client's")
    if silent:
        print(f"  no picture at all from {silent} within the window")


class MuxParser:
    """Records out of the shared stream, kept apart from the socket that carries
    them so the framing can be tested without a Home Assistant to talk to."""

    def __init__(self) -> None:
        self.buffer = bytearray()
        self.channels: dict[int, ChannelReport] = {}
        self.session_at: float | None = None

    def feed(self, chunk: bytes, now: float) -> None:
        self.buffer += chunk
        while len(self.buffer) >= MUX_HEADER.size:
            kind, channel, flags, length, _ms = MUX_HEADER.unpack_from(self.buffer)
            if len(self.buffer) < MUX_HEADER.size + length:
                return
            payload = bytes(self.buffer[MUX_HEADER.size : MUX_HEADER.size + length])
            del self.buffer[: MUX_HEADER.size + length]

            if kind == MUX_HELLO:
                self.session_at = now
                continue
            item = self.channels.setdefault(channel, ChannelReport(channel))
            if kind == MUX_INFO:
                item.note_info(now, json.loads(payload))
            elif kind == MUX_FRAME:
                item.note_frame(now, bool(flags & 1), len(payload))


async def read_mux(session, url: str, seconds: float) -> dict[int, ChannelReport]:
    parser = MuxParser()
    started = time.monotonic()
    announced = False

    async with session.get(url) as response:
        response.raise_for_status()
        async for chunk in response.content.iter_any():
            parser.feed(chunk, time.monotonic() - started)
            if parser.session_at is not None and not announced:
                announced = True
                print(f"  session opened at {parser.session_at:.2f}s")
            if time.monotonic() - started >= seconds:
                break
    return parser.channels


async def read_single(session, url: str, channel: int, seconds: float) -> ChannelReport:
    """The one-channel endpoint: a 4-byte JSON header, then frames."""
    item = ChannelReport(channel)
    started = time.monotonic()
    buffer = bytearray()
    header_read = False

    async with session.get(url) as response:
        response.raise_for_status()
        async for chunk in response.content.iter_any():
            buffer += chunk
            while True:
                now = time.monotonic() - started
                if not header_read:
                    if len(buffer) < 4:
                        break
                    length = int.from_bytes(buffer[:4], "little")
                    if len(buffer) < 4 + length:
                        break
                    item.note_info(now, json.loads(bytes(buffer[4 : 4 + length])))
                    del buffer[: 4 + length]
                    header_read = True
                    continue
                if len(buffer) < FRAME_HEADER.size:
                    break
                flags, length, _stampms = FRAME_HEADER.unpack_from(buffer)
                if len(buffer) < FRAME_HEADER.size + length:
                    break
                del buffer[: FRAME_HEADER.size + length]
                item.note_frame(now, bool(flags & 1), length)
            if time.monotonic() - started >= seconds:
                break
    return item


def find_token() -> str:
    token = os.environ.get("HA_TOKEN", "").strip()
    if token:
        return token
    stored = pathlib.Path(__file__).resolve().parent.parent / ".local" / "ha-token"
    if stored.exists():
        return stored.read_text(encoding="utf-8").strip()
    sys.exit(
        "No token. Set HA_TOKEN, or put a long-lived access token in "
        ".local/ha-token (Profile -> Security -> Long-lived access tokens)."
    )


async def find_entry(session, base: str) -> str:
    """The XMeye config entry, so the tool does not need it spelt out."""
    entry = os.environ.get("XMEYE_ENTRY", "").strip()
    if entry:
        return entry
    async with session.get(f"{base}/api/config/config_entries/entry") as response:
        response.raise_for_status()
        entries = await response.json()
    ours = [e for e in entries if e.get("domain") == "xmeye"]
    if not ours:
        sys.exit("No xmeye config entry on this Home Assistant.")
    if len(ours) > 1:
        names = ", ".join(f"{e['title']}={e['entry_id']}" for e in ours)
        sys.exit(f"Several recorders; choose one with XMEYE_ENTRY: {names}")
    print(f"recorder: {ours[0]['title']}")
    return ours[0]["entry_id"]


async def main() -> None:
    # Imported here rather than at the top: everything above is pure framing and
    # is tested in the library's own virtualenv, which has no dependencies at all.
    import aiohttp

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--channels", default="0,1,2", help="comma-separated, e.g. 0,1,2")
    parser.add_argument("--seconds", type=float, default=20.0)
    parser.add_argument("--stream", default="sub", choices=["sub", "main"])
    parser.add_argument(
        "--split",
        action="store_true",
        help="one connection per channel, the way the wall did before 0.4.0",
    )
    args = parser.parse_args()

    base = os.environ.get("HA_URL", "http://localhost:8123").rstrip("/")
    channels = [int(part) for part in args.channels.split(",") if part]
    headers = {"Authorization": f"Bearer {find_token()}"}

    async with aiohttp.ClientSession(
        headers=headers, timeout=aiohttp.ClientTimeout(total=args.seconds + 30)
    ) as session:
        entry = await find_entry(session, base)

        if args.split:
            print(f"opening {len(channels)} separate connections")
            started = time.monotonic()
            reports = await asyncio.gather(
                *[
                    read_single(
                        session,
                        f"{base}/api/xmeye/native/{entry}/{c}?stream={args.stream}",
                        c,
                        args.seconds,
                    )
                    for c in channels
                ]
            )
            report(
                {r.channel: r for r in reports},
                time.monotonic() - started,
                "one connection per channel",
            )
            return

        params = f"channels={','.join(str(c) for c in channels)}&stream={args.stream}"
        print(f"opening one connection for {len(channels)} channels")
        started = time.monotonic()
        found = await read_mux(session, f"{base}/api/xmeye/native/{entry}?{params}", args.seconds)
        report(found, time.monotonic() - started, "one shared connection")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
