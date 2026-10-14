"""The panel's G.711 decoder.

The recorder passes a camera's sound on as G.711, and the browser has no
decoder for it, so the panel carries its own: two tables built from the
formulas in ITU-T G.711. A wrong table is not silence, it is noise at the
right loudness, which is easy to mistake for a bad microphone — so the
formulas are checked against the standard's own values, and the A-law path
against a tone of known pitch.

Run through node, because the decoder lives in the panel's module. Skipped
where node is not installed; the CI image has it.
"""

from __future__ import annotations

import json
import math
import shutil
import subprocess
from pathlib import Path

import pytest

PLAYER = (
    Path(__file__).resolve().parent.parent
    / "custom_components"
    / "xmeye"
    / "panel"
    / "native-player.js"
)


def run(script: str):
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is unavailable")
    done = subprocess.run(
        [node, "--input-type=module", "-e",
         f"const m = await import({json.dumps(PLAYER.as_uri())});" + script],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert done.returncode == 0, done.stderr
    return json.loads(done.stdout)


def test_the_standards_values() -> None:
    """Zero, the smallest step and full scale, both signs, both laws."""
    got = run(
        "console.log(JSON.stringify({"
        "alaw: [0xD5, 0x55, 0xAA, 0x2A].map(m.alawSample),"
        "mulaw: [0xFF, 0x7F, 0x80, 0x00].map(m.mulawSample)}));"
    )
    assert got == {"alaw": [8, -8, 32256, -32256], "mulaw": [0, 0, 32124, -32124]}


def test_both_laws_are_monotonic() -> None:
    """Louder codes decode louder: a swapped segment would break the order."""
    got = run(
        "const up = (f, codes) => codes.map(f).every((v, i, a) => i === 0 || v > a[i - 1]);"
        "const alaw = [...Array(128).keys()].map((i) => (i ^ 0x55) | 0x80)"
        "  .sort((a, b) => m.alawSample(a) - m.alawSample(b));"
        "console.log(JSON.stringify({"
        "alaw: up(m.alawSample, alaw),"
        "mulaw: up(m.mulawSample, [...Array(128).keys()].map((i) => 0xFF - i))}));"
    )
    assert got == {"alaw": True, "mulaw": True}


def test_a_tone_comes_out_at_its_pitch() -> None:
    """A 440 Hz tone, A-law encoded the way a camera would, decodes to 440 Hz."""
    rate, seconds = 8000, 1
    samples = [math.sin(2 * math.pi * 440 * n / rate) * 0.5 for n in range(rate * seconds)]
    encoded = [alaw_encode(round(v * 32767)) for v in samples]
    got = run(
        f"const out = m.decodeAudio(1, Uint8Array.from({json.dumps(encoded)}));"
        "let crossings = 0;"
        "for (let i = 1; i < out.length; i++) if (out[i - 1] < 0 && out[i] >= 0) crossings++;"
        "console.log(JSON.stringify({length: out.length, crossings,"
        " peak: Math.max(...out)}));"
    )
    assert got["length"] == rate * seconds
    assert abs(got["crossings"] - 440) <= 1
    assert 0.45 < got["peak"] < 0.55


def alaw_encode(sample: int) -> int:
    """G.711 A-law, the encoder's side, to make the test signal."""
    sign = 0x80 if sample >= 0 else 0
    magnitude = min(abs(sample) >> 3, 0xFFF)
    if magnitude < 0x20:
        code = magnitude >> 1
    else:
        exponent = magnitude.bit_length() - 5
        code = (exponent << 4) | ((magnitude >> exponent) & 0x0F)
    return (code | sign) ^ 0x55
