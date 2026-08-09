#!/usr/bin/env python3
"""Sync the protocol library with the copy inside the integration.

    python tools/sync_lib.py [--check]

The library is not published on PyPI, and HACS installs dependencies only from
there, so a copy ships with the integration. The source of truth is
``src/xmeye/``; ``--check`` only reports drift and changes nothing.
"""

from __future__ import annotations

import argparse
import filecmp
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "src" / "xmeye"
TARGET = ROOT / "custom_components" / "xmeye" / "xmeyelib"


def modules() -> list[str]:
    return sorted(p.name for p in SOURCE.glob("*.py"))


def differences() -> list[str]:
    problems = []
    for name in modules():
        target = TARGET / name
        if not target.exists():
            problems.append(f"missing {name}")
        elif not filecmp.cmp(SOURCE / name, target, shallow=False):
            problems.append(f"differs {name}")
    for extra in TARGET.glob("*.py"):
        if extra.name not in modules():
            problems.append(f"stray {extra.name}")
    return problems


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()

    problems = differences()
    if args.check:
        if problems:
            print("The copy has drifted from the source:")
            for item in problems:
                print(f"  {item}")
            print("Run: python tools/sync_lib.py")
            return 1
        print(f"The copy matches the source ({len(modules())} modules)")
        return 0

    TARGET.mkdir(parents=True, exist_ok=True)
    for extra in TARGET.glob("*.py"):
        if extra.name not in modules():
            extra.unlink()
    for name in modules():
        shutil.copy2(SOURCE / name, TARGET / name)
    print(f"Copied {len(modules())} modules into {TARGET.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
