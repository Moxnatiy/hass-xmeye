"""Measuring what snapshots cost inside a real Home Assistant.

These are not only assertions: they print figures so that an optimisation can be
checked rather than taken on trust.
"""

from __future__ import annotations

import time

import pytest
from custom_components.xmeye.const import CONF_CHANNELS, DOMAIN
from homeassistant.components.camera import async_get_image
from homeassistant.core import HomeAssistant
from homeassistant.helpers import entity_registry as er
from pytest_homeassistant_custom_component.common import MockConfigEntry


@pytest.fixture
async def entry(hass: HomeAssistant, device_credentials) -> MockConfigEntry:
    config_entry = MockConfigEntry(
        domain=DOMAIN,
        data=device_credentials,
        options={CONF_CHANNELS: [0]},
        title="NBD8008R-U",
        unique_id="perf-serial",
    )
    config_entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(config_entry.entry_id)
    await hass.async_block_till_done()
    return config_entry


def _camera(hass: HomeAssistant, entry: MockConfigEntry) -> str:
    """The main camera of channel 0.

    Every channel has two cameras, one per stream. The main one follows the
    stream chosen in the options, and its entity id does not change.
    """
    registry = er.async_get(hass)
    return next(
        item.entity_id
        for item in er.async_entries_for_config_entry(registry, entry.entry_id)
        if item.domain == "camera" and item.unique_id.endswith("_camera")
    )


async def test_snapshot_burst_is_cheap(hass: HomeAssistant, entry: MockConfigEntry) -> None:
    """A burst of snapshots must cost as much as one: the frame comes from a live
    connection.

    Before the optimisation each snapshot opened a fresh DVRIP session and waited
    for a keyframe, about 0.8 seconds apiece.
    """
    camera = _camera(hass, entry)

    t0 = time.perf_counter()
    first = await async_get_image(hass, camera, width=640)
    first_cost = time.perf_counter() - t0

    costs = []
    for _ in range(5):
        t = time.perf_counter()
        image = await async_get_image(hass, camera, width=640)
        costs.append(time.perf_counter() - t)
        assert image.content

    average = sum(costs) / len(costs)
    print(
        f"\n  first snapshot: {first_cost:.3f}s ({len(first.content) / 1024:.0f} KB)"
        f"\n  next five: {average:.3f}s on average"
        f" (min {min(costs):.3f}, max {max(costs):.3f})"
    )

    # Repeat snapshots must come from the cache instead of a fresh connection.
    assert average < 0.35, f"a repeat snapshot costs too much: {average:.3f}s"


async def test_snapshot_size_is_reasonable(
    hass: HomeAssistant, entry: MockConfigEntry
) -> None:
    """A frame for a card must not weigh as much as a full-size 4K JPEG."""
    camera = _camera(hass, entry)

    thumb = await async_get_image(hass, camera, width=640)
    full = await async_get_image(hass, camera)
    print(
        f"\n  width 640: {len(thumb.content) / 1024:.0f} KB"
        f"\n  without a requested size: {len(full.content) / 1024:.0f} KB"
    )

    assert len(thumb.content) < 120 * 1024, "the thumbnail is too large"
    # without an explicit size the camera caps the width itself, to avoid a 4K JPEG
    assert len(full.content) < 400 * 1024


async def test_keeper_reuses_single_connection(
    hass: HomeAssistant, entry: MockConfigEntry
) -> None:
    """Ten requests in a row must not open ten connections."""
    camera_id = _camera(hass, entry)
    component = hass.data["camera"]
    camera = component.get_entity(camera_id)

    for _ in range(10):
        await async_get_image(hass, camera_id, width=320)

    keeper = camera._keeper  # noqa: SLF001 - deliberate, this tests internal machinery
    print(
        f"\n  frame cache hits: {keeper.cache_hits}"
        f"\n  stream restarts: {keeper.restarts}"
        f"\n  stream running: {keeper.running}"
    )
    assert keeper.cache_hits >= 8, "the frame is not being reused"
    assert keeper.restarts == 0, "the stream had to be brought up again"


async def test_stream_options_for_smoothness(
    hass: HomeAssistant, entry: MockConfigEntry
) -> None:
    """RTSP over TCP and wall-clock timing: both fight stutter."""
    camera_id = _camera(hass, entry)
    camera = hass.data["camera"].get_entity(camera_id)
    assert camera.stream_options["rtsp_transport"] == "tcp"
    assert camera.stream_options["use_wallclock_as_timestamps"] is True


async def test_frame_interval_is_realistic(
    hass: HomeAssistant, entry: MockConfigEntry
) -> None:
    """The MJPEG fallback must not ask for frames faster than they can be served."""
    camera_id = _camera(hass, entry)
    camera = hass.data["camera"].get_entity(camera_id)
    assert camera.frame_interval >= 1.0


async def test_hls_stream_can_start(hass: HomeAssistant, entry: MockConfigEntry) -> None:
    """The panel must receive a real HLS stream, not a snapshot stream."""
    from homeassistant.components.camera import CameraEntityFeature

    camera_id = _camera(hass, entry)
    camera = hass.data["camera"].get_entity(camera_id)

    assert CameraEntityFeature.STREAM in camera.supported_features
    source = await camera.stream_source()
    assert source, "stream_source is empty, so HLS will not start"

    stream = await camera.async_create_stream()
    print(f"\n  source: {source.split('@')[-1]}\n  stream created: {stream is not None}")
    assert stream is not None, "Home Assistant could not create the stream"

    types = camera.camera_capabilities.frontend_stream_types
    print(f"  types offered to the frontend: {types}")
    assert types, "the frontend gets no way to play this"


async def test_substream_url_really_selects_substream(
    hass: HomeAssistant, entry: MockConfigEntry
) -> None:
    """Choosing the sub stream must actually yield a smaller frame.

    The recorder accepts a Dahua-style URL but silently ignores ``subtype`` and
    serves 4K, on which the browser lost about a third of the frames.
    """
    import asyncio

    camera_id = _camera(hass, entry)
    camera = hass.data["camera"].get_entity(camera_id)
    source = await camera.stream_source()
    assert "stream=1.sdp" in source, "the URL does not point at the sub stream"

    process = await asyncio.create_subprocess_exec(
        "ffprobe", "-rtsp_transport", "tcp", "-v", "error",
        "-show_entries", "stream=width,height", "-of", "csv=p=0", source,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    stdout, _ = await asyncio.wait_for(process.communicate(), timeout=40)
    resolution = stdout.decode().strip().splitlines()[0]
    width = int(resolution.split(",")[0])
    print(f"\n  resolution behind the stream URL: {resolution}")
    assert width < 1920, f"the main stream arrived instead of the sub one ({resolution})"


async def test_native_stream_endpoint(
    hass: HomeAssistant, entry: MockConfigEntry, hass_client
) -> None:
    """The native endpoint must serve frames in its own format.

    This is what sidesteps HLS: frames reach the browser without segmentation, so
    latency drops from about fifteen seconds to a fraction of one.
    """
    import json
    import struct

    client = await hass_client()
    response = await client.get(
        f"/api/xmeye/native/{entry.entry_id}/0?stream=sub"
    )
    assert response.status == 200

    # header: a length followed by JSON with the stream parameters
    raw = await response.content.readexactly(4)
    size = int.from_bytes(raw, "little")
    info = json.loads(await response.content.readexactly(size))
    print(f"\n  stream header: {info}")
    assert info["codec"] in ("h265", "h264")
    assert 0 < info["width"] <= 1920, "the sub stream should be small"

    # then frames: flags, length, timestamp
    frames, keyframes, payload_bytes = 0, 0, 0
    for _ in range(20):
        header = await response.content.readexactly(13)
        flags, length, stamp = struct.unpack("<BId", header)
        await response.content.readexactly(length)
        frames += 1
        keyframes += flags & 1
        payload_bytes += length
        assert 0 < length < 8 * 1024 * 1024

    print(f"  frames {frames}, keyframes {keyframes}, {payload_bytes / 1024:.0f} KB")
    assert keyframes >= 1, "the first frame must be a keyframe"
    response.close()


async def test_native_stream_rejects_unknown_recorder(
    hass: HomeAssistant, entry: MockConfigEntry, hass_client
) -> None:
    client = await hass_client()
    response = await client.get("/api/xmeye/native/no-such-entry/0")
    assert response.status == 404


async def test_alt_camera_serves_image(
    hass: HomeAssistant, entry: MockConfigEntry, hass_client
) -> None:
    """The sub-stream camera must serve a frame as well.

    In the browser requests to it came back 404, and this tells us whether the
    fault is on our side.
    """
    registry = er.async_get(hass)
    alt = next(
        item
        for item in er.async_entries_for_config_entry(registry, entry.entry_id)
        if item.domain == "camera" and not item.unique_id.endswith("_camera")
    )
    print(f"\n  sub-stream camera: {alt.entity_id} ({alt.unique_id})")

    camera = hass.data["camera"].get_entity(alt.entity_id)
    image = await camera.async_camera_image(width=640)
    assert image, "the camera served no frame"
    print(f"  frame {len(image) / 1024:.0f} KB")

    client = await hass_client()
    state = hass.states.get(alt.entity_id)
    picture = state.attributes["entity_picture"]
    response = await client.get(f"{picture}&width=640")
    print(f"  HTTP {response.status} through camera_proxy")
    assert response.status == 200
