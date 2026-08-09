#!/usr/bin/env python3
"""Study the service blocks the recorder mixes into its video stream.

    XMEYE_HOST=192.168.1.10 XMEYE_PASS=secret \
        python tools/analyse_service_blocks.py [--seconds 60] [--stream main]

These blocks are marked as ordinary delta frames but carry no video: the header
of their first NAL is impossible under the specification. Safari's decoder
stopped with an error because of them, so the library filters them out
(``MediaFrame.has_valid_nal``).

The script collects them, shows their structure, and checks whether the content
changes while something moves in front of the camera. That is the one open
question: across every quiet observation the content stayed identical byte for
byte.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from xmeye import LiveStream, XmeyeClient  # noqa: E402
from xmeye.const import StreamType  # noqa: E402


def describe(payload: bytes) -> list[str]:
    """Summarise a block: its non-zero bytes and their offsets."""
    nonzero = [(i, b) for i, b in enumerate(payload) if b]
    lines = [
        f"length {len(payload)} B, non-zero {len(nonzero)}, zero {len(payload) - len(nonzero)}",
        "  " + " ".join(f"[{i}]={b:02x}" for i, b in nonzero),
    ]
    return lines


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default=os.environ.get("XMEYE_HOST", ""))
    parser.add_argument("--channel", type=int, default=0)
    parser.add_argument("--stream", choices=["main", "sub"], default="main")
    parser.add_argument("--seconds", type=float, default=60)
    args = parser.parse_args()

    password = os.environ.get("XMEYE_PASS", "")
    if not args.host or not password:
        print("Set XMEYE_HOST and XMEYE_PASS")
        return 2

    motion_seen = False

    async def watch_motion() -> None:
        """Watch the recorder's own motion detection at the same time."""
        nonlocal motion_seen
        async with XmeyeClient(args.host, password=password) as dvr:
            while True:
                state = await dvr.work_state()
                if state.video_motion >> args.channel & 1:
                    motion_seen = True
                await asyncio.sleep(1)

    watcher = asyncio.create_task(watch_motion())
    stream = LiveStream(
        args.host,
        password=password,
        channel=args.channel,
        stream=StreamType.MAIN if args.stream == "main" else StreamType.EXTRA1,
    )
    await stream.start()

    variants: dict[bytes, list[float]] = {}
    video = 0
    start = time.perf_counter()
    try:
        async for frame in stream.frames(duration=args.seconds):
            if not frame.is_video:
                continue
            if frame.has_valid_nal:
                video += 1
                continue
            variants.setdefault(frame.payload, []).append(time.perf_counter() - start)
    finally:
        await stream.close()
        watcher.cancel()

    total = sum(len(times) for times in variants.values())
    print(f"stream {args.stream}, channel {args.channel}, {args.seconds:.0f} s")
    print(f"video frames: {video}, service blocks: {total}, distinct variants: {len(variants)}")
    print(f"motion during the observation: {'yes' if motion_seen else 'none recorded'}")

    if not variants:
        print("no service blocks: this stream is free of them")
        return 0

    moments = sorted(t for times in variants.values() for t in times)
    gaps = [b - a for a, b in zip(moments, moments[1:], strict=False)]
    if gaps:
        print(f"interval: {min(gaps):.2f}-{max(gaps):.2f} s, mean {sum(gaps) / len(gaps):.2f} s")

    for number, (payload, times) in enumerate(variants.items(), start=1):
        print(f"\nvariant {number}: seen {len(times)} times")
        for line in describe(payload):
            print("  " + line)

    if len(variants) == 1 and not motion_seen:
        print(
            "\nThe content never changed, but nothing moved either, so whether it"
            "\ndepends on events in view is still open. Repeat while walking past"
            "\nthe camera."
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
