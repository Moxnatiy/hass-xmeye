#!/usr/bin/env python3
"""Watch what the integration's video socket actually sends, without a browser.

    HA_TOKEN=... python tools/probe_multiplex.py --channels 0,1,2 --seconds 20
    HA_TOKEN=... python tools/probe_multiplex.py --channels 0:main,1,2

A tile that comes up late, or blinks and comes back, has two possible causes and
they look identical on screen: either the server delivered it that way, or the
browser did. This opens the same socket the panel opens and reports the timing of
every record, so the server's half can be ruled in or out on its own.

A channel may name its own stream — ``0:main`` — because the socket carries a
stream type per channel rather than one for the whole connection.

Nothing here writes to the recorder or to Home Assistant. The socket is a read.

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
MUX_INFO, MUX_FRAME, MUX_ERROR = 0, 1, 3

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
        self.troubles: list[tuple[float, str]] = []

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
    for index in sorted(channels):
        for at, message in channels[index].troubles:
            print(f"  ch{index} at {at:5.2f}s: {message}")


class MuxParser:
    """Records out of the shared stream, kept apart from the socket that carries
    them so the framing can be tested without a Home Assistant to talk to."""

    def __init__(self) -> None:
        self.buffer = bytearray()
        self.channels: dict[int, ChannelReport] = {}

    def feed(self, chunk: bytes, now: float) -> None:
        self.buffer += chunk
        while len(self.buffer) >= MUX_HEADER.size:
            kind, channel, flags, length, _ms = MUX_HEADER.unpack_from(self.buffer)
            if len(self.buffer) < MUX_HEADER.size + length:
                return
            payload = bytes(self.buffer[MUX_HEADER.size : MUX_HEADER.size + length])
            del self.buffer[: MUX_HEADER.size + length]

            item = self.channels.setdefault(channel, ChannelReport(channel))
            if kind == MUX_INFO:
                item.note_info(now, json.loads(payload))
            elif kind == MUX_FRAME:
                item.note_frame(now, bool(flags & 1), len(payload))
            elif kind == MUX_ERROR:
                said = json.loads(payload)
                detail = f" ({said['detail']})" if said.get("detail") else ""
                item.troubles.append((now, f"{said['reason']}{detail}"))


async def read_socket(session, url: str, wanted: list[dict], seconds: float):
    """Open the video socket, ask for the channels, and time what comes back."""
    import aiohttp

    parser = MuxParser()
    started = time.monotonic()

    async with session.ws_connect(url, heartbeat=30, max_msg_size=0) as socket:
        await socket.send_json({"channels": wanted})
        print(f"  socket open, asked for {len(wanted)} channels")
        async for message in socket:
            if message.type is aiohttp.WSMsgType.BINARY:
                parser.feed(message.data, time.monotonic() - started)
            if time.monotonic() - started >= seconds:
                break
    return parser.channels


async def signed_socket_url(base: str, token: str, entry: str) -> str:
    """Ask Home Assistant to sign a video-socket address, over its own API.

    The same two steps the panel takes: authenticate on the Home Assistant
    WebSocket API, then ask this integration for a signed path — a browser
    cannot put a header on a WebSocket, and neither can this.
    """
    import aiohttp

    ws_base = base.replace("https://", "wss://").replace("http://", "ws://")
    async with (
        aiohttp.ClientSession() as session,
        session.ws_connect(f"{ws_base}/api/websocket") as socket,
    ):
        await socket.receive_json()  # auth_required
        await socket.send_json({"type": "auth", "access_token": token})
        hello = await socket.receive_json()
        if hello.get("type") != "auth_ok":
            sys.exit("Home Assistant refused the token.")
        await socket.send_json({"id": 1, "type": "xmeye/stream_url", "entry_id": entry})
        reply = await socket.receive_json()
        if not reply.get("success"):
            sys.exit(f"Could not get a signed address: {reply}")
        return f"{ws_base}{reply['result']['path']}"


def parse_wanted(raw: str) -> list[dict]:
    """``0:main,1,2`` — a channel list where a channel may name its stream."""
    wanted = []
    for part in raw.split(","):
        if not part:
            continue
        channel, _, stream = part.partition(":")
        wanted.append({"channel": int(channel), "stream": stream or "sub"})
    return wanted


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
    parser.add_argument(
        "--channels", default="0,1,2", help="e.g. 0,1,2 or 0:main,1,2"
    )
    parser.add_argument("--seconds", type=float, default=20.0)
    args = parser.parse_args()

    base = os.environ.get("HA_URL", "http://localhost:8123").rstrip("/")
    wanted = parse_wanted(args.channels)
    token = find_token()
    headers = {"Authorization": f"Bearer {token}"}

    async with aiohttp.ClientSession(
        headers=headers, timeout=aiohttp.ClientTimeout(total=args.seconds + 30)
    ) as session:
        entry = await find_entry(session, base)
        url = await signed_socket_url(base, token, entry)
        started = time.monotonic()
        found = await read_socket(session, url, wanted, args.seconds)
        report(found, time.monotonic() - started, "one socket")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
