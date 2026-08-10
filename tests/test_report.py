"""Tests for the developer report, above all its redaction.

A report exists to be pasted into a public issue, so a leak here is a leak into
a search engine. The module under test deliberately has no Home Assistant
imports, which is what lets these run offline; it is loaded straight from its
file so that importing it does not pull in the integration package.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

_MODULE = (
    Path(__file__).resolve().parent.parent
    / "custom_components"
    / "xmeye"
    / "report.py"
)


def _load():
    spec = importlib.util.spec_from_file_location("xmeye_report", _MODULE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


report = _load()

#: A password-equivalent value, and the shapes that identify an installation.
PASSWORD = "hunter2!"
SOFIA_HASH = "Ye9mNaRN"


def test_secret_keys_are_replaced_whatever_their_spelling() -> None:
    """Firmwares spell these keys inconsistently, so matching is by substring."""
    data = {
        "PassWord": SOFIA_HASH,
        "password": PASSWORD,
        "SerialNo": "5c0fa60f554f7825",
        "serial_number": "5c0fa60f554f7825",
        "MAC": "00:12:42:81:41:d7",
        "CommunicateKey": "abcd",
        "UUID": "x",
        "Token": "y",
    }
    cleaned = report.redact(data)
    assert set(cleaned.values()) == {report.REDACTED}


def test_secrets_are_replaced_at_any_depth() -> None:
    data = {"a": [{"b": {"PassWord": SOFIA_HASH}}], "ok": "keep me"}
    cleaned = report.redact(data)
    assert cleaned["a"][0]["b"]["PassWord"] == report.REDACTED
    assert cleaned["ok"] == "keep me"


@pytest.mark.parametrize(
    "value",
    [
        "192.168.100.123",
        "host is 10.0.0.1 today",
        "00:12:42:81:41:d7",
        "0x7B64A8C0",
    ],
)
def test_identifying_values_are_scrubbed_even_under_innocent_keys(value: str) -> None:
    """The key pass is not enough: an address can turn up anywhere."""
    cleaned = report.redact({"HostName": value})
    assert report.REDACTED in cleaned["HostName"]
    for fragment in value.split():
        if any(ch.isdigit() for ch in fragment) and ("." in fragment or ":" in fragment):
            assert fragment not in cleaned["HostName"]


def test_ordinary_values_survive() -> None:
    """Redaction must not eat the facts the report exists to carry."""
    data = {
        "model": "NBD8008R-U",
        "firmware": "V4.03.R11.061B0197",
        "channels": 32,
        "resolution": "3840x2160",
        "supports_talk": True,
    }
    assert report.redact(data) == data


def test_version_numbers_are_not_mistaken_for_addresses() -> None:
    """A firmware string has dots and digits but is not an IP."""
    cleaned = report.redact({"firmware": "V4.03.R11.061B0197"})
    assert cleaned["firmware"] == "V4.03.R11.061B0197"


def test_enabled_capabilities_lists_only_the_true_flags() -> None:
    caps = {
        "OtherFunction": {"SupportPlaybackLocate": True, "SupportCloud": False},
        "AlarmFunction": {"MotionDetect": True},
        "Not a group": "ignored",
    }
    assert report.enabled_capabilities(caps) == [
        "AlarmFunction.MotionDetect",
        "OtherFunction.SupportPlaybackLocate",
    ]


def test_format_report_is_markdown_and_carries_the_essentials() -> None:
    text = report.format_report(
        {
            "environment": {"integration_version": "0.2.0"},
            "device": {"model": "NBD8008R-U", "firmware": "V4.03"},
            "health": {"reconnects": 2},
            "channels": [
                {"index": 0, "status": "Connected", "resolution": "4K", "max_resolution": "4K"}
            ],
            "capabilities_enabled": ["OtherFunction.SupportPlaybackLocate"],
        }
    )
    assert text.startswith("## XMeye diagnostic report")
    assert "NBD8008R-U" in text
    assert "OtherFunction.SupportPlaybackLocate" in text
    # The channel table must render as a table, not as a Python repr.
    assert "| 0 | Connected | 4K | 4K |" in text


def test_format_report_survives_a_report_with_nothing_in_it() -> None:
    """An offline recorder still has to produce something sendable."""
    text = report.format_report({})
    assert "## XMeye diagnostic report" in text
