"""The developer report: what a bug report needs to be actionable.

These recorders vary wildly. The same DVRIP command answers differently on two
firmwares of the same vendor, half the optional features are advertised in a
capability map nobody documents, and the frame container has model-specific
quirks. Asking a reporter to describe that by hand does not work; asking them to
press one button does.

The module deliberately holds **no Home Assistant imports**, so the redaction —
the part that must not be wrong — can be unit tested offline.

Everything here is redacted before it leaves: the password and its Sofia hash
(which is password-equivalent), serial numbers, MAC addresses and the recorder's
address. A report is meant to be pasted into a public issue.
"""

from __future__ import annotations

import json
import re
from typing import Any

#: Keys whose values never leave the recorder. Matched as substrings, lowercase,
#: because firmwares spell them inconsistently (``PassWord``, ``SerialNo``).
SECRET_KEYS: tuple[str, ...] = (
    "password",
    "passwd",
    "secret",
    "token",
    "serialno",
    "serial_number",
    "uuid",
    "mac",
    "key",
)

#: Values that identify the installation rather than the model. An address is
#: not a secret, but a public one in an issue invites strangers to knock.
_IPV4 = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")
_MAC = re.compile(r"\b(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}\b")
#: Xiongmai stores addresses as little-endian hex, e.g. "0x0A01A8C0".
_HEX_IP = re.compile(r"\b0x[0-9a-fA-F]{8}\b")

REDACTED = "***"


def redact(value: Any, key: str = "") -> Any:
    """Strip secrets from an arbitrary structure, by key and by value shape.

    Both passes matter: the key pass catches ``PassWord`` wherever it hides, and
    the value pass catches an address that turned up under an innocent name.
    """
    if key and any(hint in key.lower() for hint in SECRET_KEYS):
        return REDACTED
    if isinstance(value, dict):
        return {k: redact(v, k) for k, v in value.items()}
    if isinstance(value, list):
        return [redact(v, key) for v in value]
    if isinstance(value, str):
        for pattern in (_MAC, _IPV4, _HEX_IP):
            value = pattern.sub(REDACTED, value)
    return value


def enabled_capabilities(capabilities: dict[str, Any]) -> list[str]:
    """The capability flags this firmware reports as on.

    This is the single most useful thing in the report: it is how one model
    differs from another, and it is what decides whether a feature can be
    supported at all.
    """
    return sorted(
        f"{group}.{name}"
        for group, items in capabilities.items()
        if isinstance(items, dict)
        for name, flag in items.items()
        if flag is True
    )


def format_report(data: dict[str, Any]) -> str:
    """Render the report as Markdown, ready to paste into an issue."""
    out: list[str] = ["## XMeye diagnostic report", ""]

    def section(title: str, rows: list[tuple[str, Any]]) -> None:
        out.append(f"### {title}")
        out.append("")
        for name, value in rows:
            out.append(f"- **{name}**: {value}")
        out.append("")

    env = data.get("environment", {})
    section(
        "Environment",
        [
            ("Integration", env.get("integration_version")),
            ("Home Assistant", env.get("homeassistant_version")),
            ("Python", env.get("python_version")),
        ],
    )

    device = data.get("device", {})
    section(
        "Recorder",
        [
            ("Model", device.get("model")),
            ("Firmware", device.get("firmware")),
            ("Build", device.get("build_time")),
            ("Type", device.get("device_type")),
            ("Channels", device.get("channels")),
            ("Two-way audio", device.get("supports_talk")),
        ],
    )

    health = data.get("health", {})
    section(
        "Connection health",
        [
            ("Polling succeeded", health.get("last_update_success")),
            ("Reconnects", health.get("reconnects")),
            ("Update interval", health.get("update_interval")),
            ("Enabled channels", health.get("enabled_channels")),
        ],
    )

    channels = data.get("channels", [])
    if channels:
        out += [
            "### Channels",
            "",
            "| # | Status | Resolution | Max | Bitrate | Recording |",
            "|---|---|---|---|---|---|",
        ]
        for c in channels:
            out.append(
                f"| {c.get('index')} | {c.get('status')} | {c.get('resolution')} "
                f"| {c.get('max_resolution')} | {c.get('bitrate') or '—'} "
                f"| {c.get('recording')} |"
            )
        out.append("")

    options = data.get("options", {})
    if options:
        section("Integration options", sorted(options.items()))

    caps = data.get("capabilities_enabled", [])
    if caps:
        out += [
            "### Capabilities reported by the firmware",
            "",
            f"<details><summary>{len(caps)} flags enabled</summary>",
            "",
            "```",
            *caps,
            "```",
            "",
            "</details>",
            "",
        ]

    encode = data.get("encode")
    if encode:
        out += [
            "### Encoder configuration",
            "",
            "<details><summary>Simplify.Encode</summary>",
            "",
            "```json",
            json.dumps(encode, indent=2, ensure_ascii=False, default=str),
            "```",
            "",
            "</details>",
            "",
        ]

    out += [
        "---",
        "",
        "_Generated by the XMeye panel. Passwords, hashes, serial numbers, MAC "
        "and IP addresses are removed automatically._",
    ]
    return "\n".join(out)
