"""Recorder and channel sensors."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorEntityDescription,
    SensorStateClass,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory, UnitOfDataRate, UnitOfInformation
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.util import dt as dt_util

from .const import DOMAIN
from .coordinator import XmeyeCoordinator, XmeyeData
from .entity import XmeyeChannelEntity, XmeyeEntity


def _as_local(value: datetime | None) -> datetime | None:
    """The recorder's timestamps carry no zone, so treat them as local."""
    return dt_util.as_local(value.replace(tzinfo=dt_util.DEFAULT_TIME_ZONE)) if value else None


@dataclass(frozen=True, kw_only=True)
class XmeyeSensorDescription(SensorEntityDescription):
    """Description of a recorder sensor."""

    value: Callable[[XmeyeData], Any]
    attributes: Callable[[XmeyeData], dict[str, Any]] | None = None


def _disk_used_percent(data: XmeyeData) -> float | None:
    parts = [p for d in data.disks for p in d.partitions if p.total_mb]
    if not parts:
        return None
    total = sum(p.total_mb for p in parts)
    used = sum(p.used_mb for p in parts)
    return round(used / total * 100, 1)


RECORDER_SENSORS: tuple[XmeyeSensorDescription, ...] = (
    XmeyeSensorDescription(
        key="uptime",
        translation_key="uptime",
        device_class=SensorDeviceClass.TIMESTAMP,
        entity_category=EntityCategory.DIAGNOSTIC,
        value=lambda d: (
            dt_util.utcnow() - d.device.uptime if d.device.uptime else None
        ),
    ),
    XmeyeSensorDescription(
        key="total_bitrate",
        translation_key="total_bitrate",
        native_unit_of_measurement=UnitOfDataRate.KILOBITS_PER_SECOND,
        device_class=SensorDeviceClass.DATA_RATE,
        state_class=SensorStateClass.MEASUREMENT,
        value=lambda d: d.total_bitrate,
    ),
    XmeyeSensorDescription(
        key="channels_online",
        translation_key="channels_online",
        state_class=SensorStateClass.MEASUREMENT,
        value=lambda d: sum(1 for c in d.channels if c.online),
        attributes=lambda d: {
            "configured": sum(1 for c in d.channels if c.configured),
            "total": d.device.channels,
        },
    ),
    XmeyeSensorDescription(
        key="recording_channels",
        translation_key="recording_channels",
        state_class=SensorStateClass.MEASUREMENT,
        value=lambda d: len(d.recording_channels),
        attributes=lambda d: {"channels": d.recording_channels},
    ),
    XmeyeSensorDescription(
        key="disk_used",
        translation_key="disk_used",
        native_unit_of_measurement="%",
        state_class=SensorStateClass.MEASUREMENT,
        value=_disk_used_percent,
        attributes=lambda d: {
            "disks": [
                {
                    "total_gb": round(disk.total_mb / 1024, 1),
                    "free_gb": round(disk.free_mb / 1024, 1),
                    "partitions": len(disk.partitions),
                }
                for disk in d.disks
            ]
        },
    ),
    XmeyeSensorDescription(
        key="disk_free",
        translation_key="disk_free",
        native_unit_of_measurement=UnitOfInformation.GIGABYTES,
        device_class=SensorDeviceClass.DATA_SIZE,
        state_class=SensorStateClass.MEASUREMENT,
        suggested_display_precision=1,
        value=lambda d: round(sum(disk.free_mb for disk in d.disks) / 1024, 2),
    ),
    XmeyeSensorDescription(
        key="archive_from",
        translation_key="archive_from",
        device_class=SensorDeviceClass.TIMESTAMP,
        value=lambda d: _as_local(d.archive_from),
    ),
    XmeyeSensorDescription(
        key="archive_to",
        translation_key="archive_to",
        device_class=SensorDeviceClass.TIMESTAMP,
        value=lambda d: _as_local(d.archive_to),
    ),
    XmeyeSensorDescription(
        key="device_time",
        translation_key="device_time",
        device_class=SensorDeviceClass.TIMESTAMP,
        entity_category=EntityCategory.DIAGNOSTIC,
        value=lambda d: _as_local(d.device_time),
        attributes=lambda d: {
            "drift_seconds": (
                round((datetime.now() - d.device_time).total_seconds())
                if d.device_time
                else None
            )
        },
    ),
)


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    coordinator: XmeyeCoordinator = hass.data[DOMAIN][entry.entry_id]
    entities: list[SensorEntity] = [
        XmeyeSensor(coordinator, description) for description in RECORDER_SENSORS
    ]
    entities += [
        XmeyeChannelBitrate(coordinator, channel)
        for channel in coordinator.enabled_channels
    ]
    async_add_entities(entities)


class XmeyeSensor(XmeyeEntity, SensorEntity):
    """A recorder-level sensor."""

    entity_description: XmeyeSensorDescription

    def __init__(
        self, coordinator: XmeyeCoordinator, description: XmeyeSensorDescription
    ) -> None:
        super().__init__(coordinator, description.key)
        self.entity_description = description

    @property
    def native_value(self) -> Any:
        if not self.coordinator.data:
            return None
        return self.entity_description.value(self.coordinator.data)

    @property
    def extra_state_attributes(self) -> dict[str, Any] | None:
        if not self.coordinator.data or not self.entity_description.attributes:
            return None
        return self.entity_description.attributes(self.coordinator.data)


class XmeyeChannelBitrate(XmeyeChannelEntity, SensorEntity):
    """Per-channel bitrate: the simplest sign that a camera is alive."""

    _attr_translation_key = "channel_bitrate"
    _attr_native_unit_of_measurement = UnitOfDataRate.KILOBITS_PER_SECOND
    _attr_device_class = SensorDeviceClass.DATA_RATE
    _attr_state_class = SensorStateClass.MEASUREMENT

    def __init__(self, coordinator: XmeyeCoordinator, channel: int) -> None:
        super().__init__(coordinator, channel, "bitrate")

    @property
    def native_value(self) -> int | None:
        return self.coordinator.data.bitrate(self.channel) if self.coordinator.data else None
