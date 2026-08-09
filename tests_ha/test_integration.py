"""Tests for the XMeye integration inside a real Home Assistant.

These tests bring up an actual Home Assistant instance and connect it to a real
recorder. Without ``XMEYE_PASS`` they are skipped.
"""

from __future__ import annotations

import pytest
from custom_components.xmeye.const import CONF_CHANNELS, DOMAIN
from homeassistant.config_entries import ConfigEntryState
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er
from pytest_homeassistant_custom_component.common import MockConfigEntry


@pytest.fixture
async def entry(hass: HomeAssistant, device_credentials) -> MockConfigEntry:
    """A configured integration connected to the recorder."""
    config_entry = MockConfigEntry(
        domain=DOMAIN,
        data=device_credentials,
        options={CONF_CHANNELS: [0]},
        title="NBD8008R-U",
        unique_id="test-serial",
    )
    config_entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(config_entry.entry_id)
    await hass.async_block_till_done()
    return config_entry


def _camera(hass: HomeAssistant, entry: MockConfigEntry) -> str:
    """The main camera of a channel.

    Every channel has two cameras, one per stream. The main one follows the
    stream chosen in the options, and its entity id does not change with them.
    """
    registry = er.async_get(hass)
    return next(
        item.entity_id
        for item in er.async_entries_for_config_entry(registry, entry.entry_id)
        if item.domain == "camera" and item.unique_id.endswith("_camera")
    )


async def test_entry_loads(hass: HomeAssistant, entry: MockConfigEntry) -> None:
    assert entry.state is ConfigEntryState.LOADED


async def test_coordinator_has_live_data(hass: HomeAssistant, entry: MockConfigEntry) -> None:
    coordinator = hass.data[DOMAIN][entry.entry_id]
    data = coordinator.data
    assert data is not None
    assert data.device.hardware, "the model was not read"
    assert data.device.channels > 0
    assert data.state is not None
    assert data.disks, "the recorder reported no disks"


async def test_devices_registered(hass: HomeAssistant, entry: MockConfigEntry) -> None:
    """The recorder and each channel must be separate devices."""
    registry = dr.async_get(hass)
    devices = dr.async_entries_for_config_entry(registry, entry.entry_id)
    assert len(devices) >= 2

    recorder = next(d for d in devices if (DOMAIN, entry.entry_id) in d.identifiers)
    assert recorder.model
    assert recorder.sw_version
    channels = [d for d in devices if d.via_device_id == recorder.id]
    assert channels, "the channel did not attach to the recorder"


async def test_all_platforms_produce_entities(
    hass: HomeAssistant, entry: MockConfigEntry
) -> None:
    registry = er.async_get(hass)
    entities = er.async_entries_for_config_entry(registry, entry.entry_id)
    by_platform: dict[str, int] = {}
    for item in entities:
        by_platform[item.domain] = by_platform.get(item.domain, 0) + 1

    for platform in (
        Platform.CAMERA,
        Platform.SENSOR,
        Platform.BINARY_SENSOR,
        Platform.SWITCH,
        Platform.BUTTON,
    ):
        assert by_platform.get(platform.value), f"platform {platform} produced no entities"


async def test_sensor_states_are_real(hass: HomeAssistant, entry: MockConfigEntry) -> None:
    """Sensors must carry real values rather than 'unknown'."""
    registry = er.async_get(hass)
    entities = er.async_entries_for_config_entry(registry, entry.entry_id)
    sensors = {
        item.unique_id.removeprefix(f"{entry.entry_id}_"): hass.states.get(item.entity_id)
        for item in entities
        if item.domain == "sensor"
    }

    assert sensors["channels_online"].state not in (None, "unknown", "unavailable")
    assert int(sensors["channels_online"].state) >= 0
    assert float(sensors["disk_free"].state) >= 0
    assert sensors["uptime"].state not in (None, "unknown")
    # the archive bounds are real dates from the disk
    assert sensors["archive_from"].state not in (None, "unknown", "unavailable")


async def test_camera_stream_source(hass: HomeAssistant, entry: MockConfigEntry) -> None:
    """The camera must yield a working RTSP URL with the right channel numbering."""
    from homeassistant.components.camera import async_get_stream_source

    source = await async_get_stream_source(hass, _camera(hass, entry))
    assert source
    assert source.startswith("rtsp://")
    # DVRIP counts channels from zero, RTSP from one
    assert "channel=1" in source
    # the native Xiongmai form: in the Dahua style the recorder ignores the stream choice
    assert "real_stream" in source
    assert "/cam/realmonitor" not in source


async def test_services_registered(hass: HomeAssistant, entry: MockConfigEntry) -> None:
    for service in (
        "ptz",
        "search_recordings",
        "download_recording",
        "get_config",
        "set_config",
        "talk",
    ):
        assert hass.services.has_service(DOMAIN, service), f"service {service} is not registered"


async def test_search_recordings_service(hass: HomeAssistant, entry: MockConfigEntry) -> None:
    """The search service must return real recordings from the archive."""
    from datetime import datetime, timedelta

    end = datetime.now()
    response = await hass.services.async_call(
        DOMAIN,
        "search_recordings",
        {
            "config_entry_id": entry.entry_id,
            "channel": 0,
            "start": end - timedelta(hours=6),
            "end": end,
        },
        blocking=True,
        return_response=True,
    )
    assert response["count"] > 0, "six hours should hold recordings"
    first = response["recordings"][0]
    assert first["name"].endswith(".h264")
    assert first["size_bytes"] > 0
    assert first["event"] in ("schedule", "motion", "alarm", "manual", "")


async def test_get_config_service(hass: HomeAssistant, entry: MockConfigEntry) -> None:
    response = await hass.services.async_call(
        DOMAIN,
        "get_config",
        {"config_entry_id": entry.entry_id, "section": "NetWork.NetCommon"},
        blocking=True,
        return_response=True,
    )
    assert response["value"]["TCPPort"] == 34567


async def test_panel_registered(hass: HomeAssistant, entry: MockConfigEntry) -> None:
    panels = hass.data.get("frontend_panels", {})
    assert "xmeye" in panels, "the panel did not appear in the sidebar"
    assert panels["xmeye"].sidebar_title == "XMeye"


async def test_unload(hass: HomeAssistant, entry: MockConfigEntry) -> None:
    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.NOT_LOADED
    assert entry.entry_id not in hass.data[DOMAIN]


async def test_camera_per_stream(hass: HomeAssistant, entry: MockConfigEntry) -> None:
    """A channel must have two cameras: the main and the sub stream.

    Without both, the stream switch in the panel would do nothing for HLS and
    snapshots: they go through the camera entity, which serves one stream only.
    """
    registry = er.async_get(hass)
    cameras = [
        item
        for item in er.async_entries_for_config_entry(registry, entry.entry_id)
        if item.domain == "camera"
    ]
    assert len(cameras) == 2, "there should be two cameras per channel"

    sources = {}
    for item in cameras:
        camera = hass.data["camera"].get_entity(item.entity_id)
        assert camera is not None, f"{item.entity_id} is disabled, so the switch will not work"
        sources[camera.stream_name] = await camera.stream_source()

    assert "stream=0.sdp" in sources["main"]
    assert "stream=1.sdp" in sources["sub"]
