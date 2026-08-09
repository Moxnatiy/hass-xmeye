#!/usr/bin/env python3
"""Walk every known configuration section and command, and record what the device supports.

    XMEYE_HOST=192.168.1.10 XMEYE_PASS=secret python tools/discover.py [--out caps.json]

The script only reads. The result is a JSON map of one firmware's capabilities,
useful afterwards as a reference while developing.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
from datetime import datetime
from typing import Any

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from xmeye import XmeyeClient  # noqa: E402
from xmeye.const import KNOWN_CONFIG_SECTIONS, SYSINFO_SECTIONS, Msg  # noqa: E402
from xmeye.exceptions import XmeyeError  # noqa: E402

#: Commands that are safe to call: they change nothing and start no streams.
READONLY_COMMANDS: list[tuple[str, int, dict[str, Any]]] = [
    ("SystemInfo", Msg.SYSINFO, {"Name": "SystemInfo"}),
    ("StorageInfo", Msg.SYSINFO, {"Name": "StorageInfo"}),
    ("WorkState", Msg.SYSINFO, {"Name": "WorkState"}),
    ("SystemFunction", Msg.SYSTEM_FUNCTION, {"Name": "SystemFunction"}),
    ("EncodeCapability", Msg.SYSTEM_FUNCTION, {"Name": "EncodeCapability"}),
    ("ChannelTitle", Msg.CONFIG_CHANNELTITLE_GET, {"Name": "ChannelTitle"}),
    ("OPTimeQuery", Msg.TIME_QUERY, {"Name": "OPTimeQuery"}),
    ("Users", Msg.USERS_GET, {"Name": ""}),
    ("Groups", Msg.GROUPS_GET, {"Name": ""}),
    ("AuthorityList", Msg.FULL_AUTHORITY_LIST, {"Name": ""}),
    ("UpgradeInfo", Msg.UPGRADE_INFO, {"Name": "OPSystemUpgrade"}),
    ("OPSNAP", Msg.SNAPSHOT, {"Name": "OPSNAP", "OPSNAP": {"Channel": 0}}),
]


#: Fields whose values must never reach the report. The Sofia password hash is
#: equivalent to the password itself, since logging in with it works directly,
#: so it is redacted as well.
_SECRET_KEY = re.compile(
    r"pass\s?word|passwd|secret|apikey|_key$|^key$|token|serialno|uuid",
    re.IGNORECASE,
)
REDACTED = "***"


def redact(value: Any, key: str = "") -> Any:
    """Strip secrets out of an arbitrary structure."""
    if key and _SECRET_KEY.search(key) and isinstance(value, (str, int)):
        return REDACTED
    if isinstance(value, dict):
        return {k: redact(v, k) for k, v in value.items()}
    if isinstance(value, list):
        return [redact(v, key) for v in value]
    return value


def shape(value: Any, depth: int = 0, key: str = "") -> Any:
    """Describe the shape of a reply without carrying all of its data."""
    if key and _SECRET_KEY.search(key) and isinstance(value, (str, int)):
        return REDACTED
    if isinstance(value, dict):
        if depth >= 2:
            return f"<{len(value)} fields>"
        return {k: shape(v, depth + 1, k) for k, v in list(value.items())[:40]}
    if isinstance(value, list):
        if not value:
            return []
        return [shape(value[0], depth + 1, key), f"…×{len(value)}"]
    if isinstance(value, str):
        return value if len(value) <= 48 else value[:45] + "…"
    return value


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default=os.environ.get("XMEYE_HOST", ""))
    parser.add_argument("--user", default=os.environ.get("XMEYE_USER", "admin"))
    parser.add_argument("--out", default="capabilities.json")
    parser.add_argument(
        "--full", action="store_true", help="store full values instead of the shape"
    )
    args = parser.parse_args()

    password = os.environ.get("XMEYE_PASS", "")
    if not args.host or not password:
        print("Set XMEYE_HOST and XMEYE_PASS")
        return 2

    report: dict[str, Any] = {
        "host": args.host,
        "scanned_at": datetime.now().isoformat(timespec="seconds"),
        "commands": {},
        "config": {},
        "config_unsupported": [],
    }

    async with XmeyeClient(args.host, username=args.user, password=password) as dvr:
        report["login"] = redact(dvr.login_info)
        info = await dvr.device_info()
        report["device"] = {
            "model": info.hardware,
            "firmware": info.software_version,
            "serial": REDACTED,
        }
        print(f"→ {info.hardware} {info.software_version}\n")

        print("-- Commands " + "-" * 47)
        for name, msgid, payload in READONLY_COMMANDS:
            try:
                reply = await dvr.command(msgid, payload, check=False)
            except XmeyeError as err:
                report["commands"][name] = {"msgid": int(msgid), "error": str(err)}
                print(f"  ✗ {name:<18} msgid={int(msgid):<5} {err}")
                continue
            ret = reply.get("Ret")
            body = reply.get(name if name in reply else "", reply)
            supported = ret in (100, 110, 111, 515)
            report["commands"][name] = {
                "msgid": int(msgid),
                "ret": ret,
                "supported": supported,
                "result": (redact(body) if args.full else shape(body)),
            }
            mark = "✓" if supported else "✗"
            print(f"  {mark} {name:<18} msgid={int(msgid):<5} Ret={ret}")

        print("\n-- System information " + "-" * 37)
        for name in SYSINFO_SECTIONS:
            value = await dvr.get_sysinfo(name, check=False)
            ok = not (isinstance(value, dict) and value.get("Ret") not in (None, 100))
            report["config"][f"sysinfo:{name}"] = redact(value) if args.full else shape(value)
            print(f"  {'✓' if ok else '✗'} {name}")

        print("\n-- Configuration tree (by root container) " + "-" * 17)
        tree = await dvr.config_tree()
        leaves: list[str] = []
        for root, body in sorted(tree.items()):
            if isinstance(body, dict):
                names = sorted(body)
                leaves += [f"{root}.{n}" for n in names]
                empty = [n for n in names if body[n] is None]
                print(f"  {root:<18} {len(names):>3} subsections"
                      + (f", empty: {len(empty)}" if empty else ""))
            else:
                kind = f"array[{len(body)}]" if isinstance(body, list) else type(body).__name__
                print(f"  {root:<18} {kind}")
            report["config"][root] = redact(body) if args.full else shape(body)
        report["config_leaves"] = leaves
        print(f"  -> leaves in the tree: {len(leaves)}")

        print("\n-- Sections available through a dedicated request " + "-" * 9)
        for name in KNOWN_CONFIG_SECTIONS:
            try:
                value = await dvr.get_config(name, check=False)
            except XmeyeError as err:
                report["config_unsupported"].append(name)
                print(f"  ✗ {name:<28} {type(err).__name__}")
                continue
            unsupported = isinstance(value, dict) and value.get("Ret") not in (None, 100)
            if unsupported or value is None:
                report["config_unsupported"].append(name)
                print(f"  ✗ {name:<28} Ret={value.get('Ret') if isinstance(value, dict) else None}")
                continue
            report["config"][name] = redact(value) if args.full else shape(value)
            size = len(value) if isinstance(value, (dict, list)) else 1
            print(f"  + {name:<28} ({size} items)")

    supported = len(report["config"])
    unavailable = len(report["config_unsupported"])
    print(f"\n{'=' * 60}")
    print(f"Configuration: {supported} sections read, {unavailable} unavailable")
    print(f"Leaves in the tree: {len(report.get('config_leaves', []))}")
    print(f"Commands: {sum(1 for c in report['commands'].values() if c.get('supported'))}"
          f"/{len(report['commands'])}")

    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=2, default=str)
    print(f"Written to {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
