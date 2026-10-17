"""Secrets out of the panel, and back in before a write.

The settings page sends a section back whole, as the firmware wants it, and the
section it edited had its passwords masked. Written as it came, the mask would
become the password: an IP camera would stop connecting, the time server would
reject the recorder. These check that the mask is replaced by what is stored,
and that a password actually typed goes through.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    "masking",
    Path(__file__).resolve().parent.parent / "custom_components" / "xmeye" / "masking.py",
)
masking = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(masking)

CAMERA = {
    "ConnType": "SINGLE",
    "Decoder": [
        {"IPAddress": "192.168.100.150", "PassWord": "s3cret", "UserName": "admin", "Port": 80}
    ],
    "Enable": True,
}


def test_secrets_are_masked_at_any_depth() -> None:
    masked = masking.mask({"NTP": {"Server": {"Password": "x", "Name": "pool"}}, "DDNSKey": "k"})
    assert masked == {"NTP": {"Server": {"Password": "***", "Name": "pool"}}, "DDNSKey": "***"}


def test_an_untouched_password_is_put_back() -> None:
    edited = masking.mask(CAMERA)
    edited["Decoder"][0]["Port"] = 8080
    written = masking.unmask(edited, CAMERA)
    assert written["Decoder"][0]["PassWord"] == "s3cret"
    assert written["Decoder"][0]["Port"] == 8080


def test_a_typed_password_goes_through() -> None:
    edited = masking.mask(CAMERA)
    edited["Decoder"][0]["PassWord"] = "new-one"
    assert masking.unmask(edited, CAMERA)["Decoder"][0]["PassWord"] == "new-one"


def test_a_mask_with_nothing_behind_it_becomes_empty() -> None:
    """A camera added in a channel that had none: never "***" as a password."""
    added = {"Decoder": [{"IPAddress": "192.168.100.143", "PassWord": "***"}]}
    assert masking.unmask(added, {"Decoder": None})["Decoder"][0]["PassWord"] == ""


def test_lists_match_by_position() -> None:
    """Per-channel arrays: channel 2's password stays channel 2's."""
    stored = [{"PassWord": "a"}, {"PassWord": "b"}, {"PassWord": "c"}]
    back = masking.unmask(masking.mask(stored), stored)
    assert [e["PassWord"] for e in back] == ["a", "b", "c"]


def test_the_mask_in_a_plain_field_is_left_alone() -> None:
    """A camera named "***" is a name, not a secret."""
    assert masking.unmask({"ConfName": "***"}, {"ConfName": "x"}) == {"ConfName": "***"}
