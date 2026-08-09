#!/usr/bin/env python3
"""An integration check of the library against a real recorder.

    XMEYE_HOST=192.168.1.10 XMEYE_PASS=secret python tools/live_check.py

The script changes nothing on the device; it only reads.
"""

from __future__ import annotations

import asyncio
import logging
import os
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from xmeye import XmeyeClient, XmeyeError  # noqa: E402

HOST = os.environ.get("XMEYE_HOST", "")
USER = os.environ.get("XMEYE_USER", "admin")
PASSWORD = os.environ.get("XMEYE_PASS", "")

PASS_MARK, FAIL_MARK, SKIP_MARK = "✓", "✗", "–"
results: list[tuple[str, bool, str]] = []


async def check(name: str, coro) -> object:
    """Run one check, print the result, and keep going when it fails."""
    try:
        value = await coro
    except XmeyeError as err:
        results.append((name, False, str(err)))
        print(f"{FAIL_MARK} {name}: {err}")
        return None
    except Exception as err:  # noqa: BLE001
        results.append((name, False, f"{type(err).__name__}: {err}"))
        print(f"{FAIL_MARK} {name}: {type(err).__name__}: {err}")
        return None
    results.append((name, True, ""))
    return value


async def main() -> int:
    if not HOST or not PASSWORD:
        print("Set XMEYE_HOST and XMEYE_PASS")
        return 2

    logging.basicConfig(level=logging.WARNING)
    alarms: list[dict] = []

    client = XmeyeClient(HOST, username=USER, password=PASSWORD, on_alarm=alarms.append)
    print(f"-> Connecting to {HOST}:{client.port} as {USER}\n")

    login = await check("login", client.login())
    if login is None:
        return 1
    print(f"  session={client.session_id} AliveInterval={login.get('AliveInterval')}s "
          f"DataUseAES={login.get('DataUseAES')}\n")

    if info := await check("device_info", client.device_info()):
        print(f"  {info.hardware}  {info.software_version}")
        print(f"  S/N {info.serial_number}  channels={info.channels}  uptime={info.uptime}")
        print(f"  two-way audio: {'yes' if info.supports_talk else 'no'}\n")

    if net := await check("network_info", client.network_info()):
        print(f"  {net.ip}/{net.netmask} gw={net.gateway} mac={net.mac}")
        print(f"  http={net.http_port} dvrip={net.tcp_port} max_conn={net.max_connections}\n")

    if (now := await check("get_time", client.get_time())) is not None:
        drift = abs((datetime.now() - now).total_seconds())
        print(f"  device time: {now}  drift from host: {drift:.0f}s\n")

    if titles := await check("channel_titles", client.channel_titles()):
        print(f"  {len(titles)} channel titles, first: {titles[:4]}\n")

    if statuses := await check("channel_statuses", client.channel_statuses()):
        online = [c for c in statuses if c.online]
        print(f"  {len(statuses)} channels, {len(online)} online")
        for c in online:
            print(
                f"    #{c.index} {c.name}: {c.status} "
                f"{c.current_resolution} (max {c.max_resolution})"
            )
        print()

    if state := await check("work_state", client.work_state()):
        active = [c for c in state.channels if c.bitrate_kbps or c.recording]
        print(f"  recording channels: {[c.index for c in state.channels if c.recording]}")
        for c in active:
            print(f"    #{c.index} bitrate={c.bitrate_kbps} kbps record={c.recording}")
        print(f"  motion right now on: {state.motion_channels() or '-'}\n")

    if disks := await check("storage", client.storage()):
        for d in disks:
            for p in d.partitions:
                print(f"  disk{d.index}: {p.total_mb} MB, {p.free_mb} MB free "
                      f"({p.used_percent}% used)")
                print(f"         recordings: {p.oldest_record} ... {p.newest_record}")
        print()

    if caps := await check("capabilities", client.capabilities()):
        enabled = sorted(
            f"{group}.{name}"
            for group, items in caps.items()
            if isinstance(items, dict)
            for name, value in items.items()
            if value is True
        )
        print(f"  capabilities enabled: {len(enabled)}")
        print(f"  e.g.: {', '.join(enabled[:8])}\n")

    await check("encode_capabilities", client.encode_capabilities())

    if users := await check("users", client.users()):
        print(f"  users: {[(u.name, u.group) for u in users]}\n")
    if groups := await check("groups", client.groups()):
        print(f"  groups: {[g.name for g in groups]}\n")
    if auth := await check("authority_list", client.authority_list()):
        print(f"  rights in total: {len(auth)}\n")

    rng = await check("recording_range", client.recording_range())
    if rng:
        print(f"  archive: {rng[0]} ... {rng[1]}\n")

    end = datetime.now()
    files = await check(
        "search_files (24 h)",
        client.search_files(end - timedelta(days=1), end, channel=0, limit=5000),
    )
    if files:
        by_event: dict[str, int] = {}
        for f in files:
            by_event[f.event] = by_event.get(f.event, 0) + 1
        total_mb = sum(f.size_bytes for f in files) / 1024 / 1024
        print(f"  found {len(files)} recordings, {total_mb:.0f} MB, by event: {by_event}")
        first = files[0]
        print(f"  first: {first.begin} -> {first.end} ({first.duration}) "
              f"{first.size_kb} KB event={first.event}")
        print(f"          {first.name}\n")

    logs = await check(
        "search_log", client.search_log(end - timedelta(days=1), end, limit=5)
    )
    if logs:
        print(f"  log: {len(logs)} entries")
        for entry in logs[:5]:
            print(f"    {entry.time} [{entry.type}] {entry.user}: {entry.data[:60]}")
        print()

    print(f"  RTSP: {client.rtsp_url(1, include_credentials=False)}\n")

    # KeepAlive: the session must survive a pause longer than AliveInterval
    interval = float(login.get("AliveInterval", 20))
    print(f"-> KeepAlive check: waiting {interval + 4:.0f}s...")
    await asyncio.sleep(interval + 4)
    after = await check("session alive after KeepAlive", client.get_time())
    if after:
        print(f"  session alive, time {after}\n")

    await client.close()
    ok = sum(1 for _, good, _ in results if good)
    print(f"\n{'=' * 60}\nSummary: {ok}/{len(results)} checks passed")
    for name, good, err in results:
        if not good:
            print(f"  {FAIL_MARK} {name}: {err}")
    if alarms:
        print(f"  alarms received: {len(alarms)}")
    return 0 if ok == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
