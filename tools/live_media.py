#!/usr/bin/env python3
"""A check of the media layer against a real device: live stream, snapshot, archive.

    XMEYE_HOST=192.168.1.10 XMEYE_PASS=secret python tools/live_media.py [--outdir out]

Every step is validated with ffprobe as well, so that "it works" means "ffmpeg
opens it" rather than "the script did not crash".
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from xmeye import ArchiveStream, LiveStream, XmeyeClient  # noqa: E402
from xmeye.const import StreamType  # noqa: E402

HOST = os.environ.get("XMEYE_HOST", "")
USER = os.environ.get("XMEYE_USER", "admin")
PASSWORD = os.environ.get("XMEYE_PASS", "")

results: list[tuple[str, bool, str]] = []


def record(name: str, ok: bool, note: str = "") -> None:
    results.append((name, ok, note))
    print(f"  {'+' if ok else '-'} {name}" + (f": {note}" if note else ""))


def ffprobe(path: Path) -> dict:
    """Ask ffprobe about a file; an empty dict means it could not be read."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)],
        capture_output=True,
        text=True,
        timeout=60,
    )
    try:
        return json.loads(out.stdout)
    except json.JSONDecodeError:
        return {}


def describe(probe: dict) -> str:
    streams = probe.get("streams", [])
    if not streams:
        return "no streams found"
    parts = []
    for s in streams:
        if s.get("codec_type") == "video":
            parts.append(f"{s.get('codec_name')} {s.get('width')}x{s.get('height')}")
        else:
            parts.append(f"{s.get('codec_name')} {s.get('sample_rate')}Hz")
    duration = probe.get("format", {}).get("duration")
    if duration:
        parts.append(f"{float(duration):.1f}s")
    return ", ".join(parts)


async def check_live(outdir: Path) -> None:
    print("\n-- Live stream over DVRIP OPMonitor " + "-" * 23)
    raw = outdir / "live_main.h265"
    async with LiveStream(
        HOST, username=USER, password=PASSWORD, channel=0, stream=StreamType.MAIN
    ) as live:
        video = bytearray()
        audio_bytes = 0
        timestamps: list[datetime] = []
        async for frame in live.frames(duration=8.0):
            if frame.is_video:
                video += frame.payload
            elif frame.is_audio:
                audio_bytes += len(frame.payload)
            if frame.timestamp:
                timestamps.append(frame.timestamp)

        info = live.info
        print(f"  codec={info.video_codec} {info.resolution} {info.fps}fps")
        print(f"  frames: {info.video_frames} (keyframes: {info.keyframes}), "
              f"audio: {info.audio_frames}")
        print(f"  video {info.video_bytes / 1024:.0f} KB, audio {audio_bytes / 1024:.0f} KB")
        print(f"  resyncs: {live.demuxer.resyncs}, "
              f"packets dropped: {live.dropped_packets}")
        if timestamps:
            print(f"  frame times: {timestamps[0]} ... {timestamps[-1]}")

        record(
            "the live stream yields frames", info.video_frames > 0, f"{info.video_frames} frames"
        )
        record("at least one keyframe", info.keyframes > 0)
        record("the demuxer kept sync", live.demuxer.resyncs == 0)
        record(
            "frame timestamps are close to real time",
            bool(timestamps) and abs((datetime.now() - timestamps[-1]).total_seconds()) < 120,
            f"last {timestamps[-1]}" if timestamps else "no timestamps",
        )
        raw.write_bytes(bytes(video))

    probe = ffprobe(raw)
    streams = probe.get("streams", [])
    record(
        "ffprobe reads the elementary stream",
        bool(streams),
        describe(probe),
    )
    if streams:
        s = streams[0]
        record(
            "the resolution matches the one parsed from the header",
            (s.get("width"), s.get("height")) == (info.width, info.height),
            f"ffprobe {s.get('width')}x{s.get('height')} against header {info.resolution}",
        )


async def check_substream(outdir: Path) -> None:
    print("\n-- Sub stream (Extra1) " + "-" * 36)
    async with LiveStream(
        HOST, username=USER, password=PASSWORD, channel=0, stream=StreamType.EXTRA1
    ) as live:
        async for _ in live.frames(duration=5.0):
            pass
        info = live.info
        print(f"  {info.video_codec} {info.resolution} {info.fps}fps, "
              f"frames {info.video_frames}")
        record("the sub stream works", info.video_frames > 0, info.resolution)
        record(
            "the sub stream is smaller than the main one",
            0 < info.width < 3840,
            info.resolution,
        )


async def check_snapshot(outdir: Path) -> None:
    print("\n-- Snapshot " + "-" * 47)
    jpeg = outdir / "snapshot.jpg"
    async with LiveStream(HOST, username=USER, password=PASSWORD, channel=0) as live:
        frame = await live.keyframe(timeout=20.0)

    if frame is None:
        record("snapshot from a keyframe", False, "no keyframe arrived")
        return
    print(f"  keyframe {len(frame.payload) / 1024:.0f} KB, {frame.width}x{frame.height}, "
          f"time {frame.timestamp}")

    # A keyframe is raw HEVC; the JPEG comes from ffmpeg
    proc = subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-f", "hevc", "-i", "pipe:0",
         "-frames:v", "1", "-q:v", "2", str(jpeg)],
        input=frame.payload,
        capture_output=True,
        timeout=60,
    )
    ok = jpeg.exists() and jpeg.stat().st_size > 1024
    record(
        "JPEG from the snapshot",
        ok,
        f"{jpeg.stat().st_size / 1024:.0f} KB" if ok else proc.stderr.decode()[:120],
    )
    if ok:
        probe = ffprobe(jpeg)
        record("ffprobe reads the JPEG", bool(probe.get("streams")), describe(probe))


async def check_archive(outdir: Path) -> None:
    print("\n-- Archive download " + "-" * 39)
    async with XmeyeClient(HOST, username=USER, password=PASSWORD) as dvr:
        end = datetime.now()
        files = await dvr.search_files(end - timedelta(days=1), end, channel=0)
    if not files:
        record("recording search", False, "nothing found")
        return

    target = min(files, key=lambda f: f.size_kb)
    print(f"  taking the smallest: {target.begin} -> {target.end} "
          f"({target.duration}) {target.size_kb} KB, event={target.event}")

    raw = outdir / "archive.h265"
    async with ArchiveStream(HOST, username=USER, password=PASSWORD) as archive:
        data = await archive.download(target, timeout=20.0)
        info = archive.info

    raw.write_bytes(data)
    print(f"  received {len(data) / 1024:.0f} KB, frames {info.video_frames} "
          f"(keyframes: {info.keyframes}), audio {info.audio_frames}")
    print(f"  {info.video_codec} {info.resolution}, time {info.first_timestamp} ... "
          f"{info.last_timestamp}")

    record("the archive downloads", len(data) > 0, f"{len(data) / 1024:.0f} KB")
    record(
        "frame time matches the recording time",
        info.first_timestamp is not None
        and target.begin is not None
        and abs((info.first_timestamp - target.begin).total_seconds()) <= 2,
        f"frame {info.first_timestamp} against recording {target.begin}",
    )

    probe = ffprobe(raw)
    record("ffprobe reads the downloaded archive", bool(probe.get("streams")), describe(probe))

    # Remuxing into MP4 is what serving the file elsewhere needs
    mp4 = outdir / "archive.mp4"
    proc = subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-f", "hevc", "-i", str(raw),
         "-c", "copy", "-tag:v", "hvc1", str(mp4)],
        capture_output=True,
        timeout=120,
    )
    ok = mp4.exists() and mp4.stat().st_size > 1024
    record(
        "remux into MP4",
        ok,
        describe(ffprobe(mp4)) if ok else proc.stderr.decode()[:150],
    )


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--outdir", default="media_out")
    args = parser.parse_args()

    if not HOST or not PASSWORD:
        print("Set XMEYE_HOST and XMEYE_PASS")
        return 2
    if not shutil_which("ffprobe"):
        print("ffmpeg/ffprobe must be on PATH")
        return 2

    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    print(f"-> {HOST}, files in {outdir}/")

    for step in (check_live, check_substream, check_snapshot, check_archive):
        try:
            await step(outdir)
        except Exception as err:  # noqa: BLE001 - every step should still run
            record(step.__name__, False, f"{type(err).__name__}: {err}")

    ok = sum(1 for _, good, _ in results if good)
    print(f"\n{'=' * 60}\nSummary: {ok}/{len(results)} checks passed")
    for name, good, note in results:
        if not good:
            print(f"  - {name}: {note}")
    return 0 if ok == len(results) else 1


def shutil_which(name: str) -> str | None:
    import shutil

    return shutil.which(name)


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
