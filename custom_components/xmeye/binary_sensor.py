"""Binary sensors: motion, recording, channel and disk state."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from homeassistant.components.binary_sensor import (
    BinarySensorDeviceClass,
    BinarySensorEntity,
    BinarySensorEntityDescription,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN
from .coordinator import XmeyeCoordinator, XmeyeData
from .entity import XmeyeChannelEntity, XmeyeEntity


@dataclass(frozen=True, kw_only=True)
class XmeyeBinaryDescription(BinarySensorEntityDescription):
    value: Callable[[XmeyeData], bool]


@dataclass(frozen=True, kw_only=True)
class XmeyeChannelBinaryDescription(BinarySensorEntityDescription):
    value: Callable[[XmeyeData, int], bool]


def _disk_problem(data: XmeyeData) -> bool:
    """No disk present, or the disk is in an abnormal state."""
    if not data.disks:
        return True
    return any(p.status not in (0, 2) for d in data.disks for p in d.partitions)


RECORDER_SENSORS: tuple[XmeyeBinaryDescription, ...] = (
    XmeyeBinaryDescription(
        key="recording",
        translation_key="recording",
        device_class=BinarySensorDeviceClass.RUNNING,
        value=lambda d: bool(d.recording_channels),
    ),
    XmeyeBinaryDescription(
        key="motion_any",
        translation_key="motion_any",
        device_class=BinarySensorDeviceClass.MOTION,
        value=lambda d: bool(d.state and d.state.video_motion),
    ),
    XmeyeBinaryDescription(
        key="disk_problem",
        translation_key="disk_problem",
        device_class=BinarySensorDeviceClass.PROBLEM,
        entity_category=EntityCategory.DIAGNOSTIC,
        value=_disk_problem,
    ),
    XmeyeBinaryDescription(
        key="alarm_input",
        translation_key="alarm_input",
        device_class=BinarySensorDeviceClass.SAFETY,
        value=lambda d: bool(d.state and d.state.alarm_in),
    ),
)

CHANNEL_SENSORS: tuple[XmeyeChannelBinaryDescription, ...] = (
    XmeyeChannelBinaryDescription(
        key="motion",
        translation_key="channel_motion",
        device_class=BinarySensorDeviceClass.MOTION,
        value=lambda d, ch: d.motion_on(ch),
    ),
    XmeyeChannelBinaryDescription(
        key="recording",
        translation_key="channel_recording",
        device_class=BinarySensorDeviceClass.RUNNING,
        value=lambda d, ch: d.is_recording(ch),
    ),
    XmeyeChannelBinaryDescription(
        key="online",
        translation_key="channel_online",
        device_class=BinarySensorDeviceClass.CONNECTIVITY,
        value=lambda d, ch: ch < len(d.channels) and d.channels[ch].online,
    ),
    XmeyeChannelBinaryDescription(
        key="video_loss",
        translation_key="channel_video_loss",
        device_class=BinarySensorDeviceClass.PROBLEM,
        entity_category=EntityCategory.DIAGNOSTIC,
        value=lambda d, ch: d.video_loss_on(ch),
    ),
    XmeyeChannelBinaryDescription(
        key="blind",
        translation_key="channel_blind",
        device_class=BinarySensorDeviceClass.PROBLEM,
        entity_category=EntityCategory.DIAGNOSTIC,
        value=lambda d, ch: d.blind_on(ch),
    ),
)


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    coordinator: XmeyeCoordinator = hass.data[DOMAIN][entry.entry_id]
    entities: list[BinarySensorEntity] = [
        XmeyeBinarySensor(coordinator, description) for description in RECORDER_SENSORS
    ]
    entities += [
        XmeyeChannelBinarySensor(coordinator, channel, description)
        for channel in coordinator.enabled_channels
        for description in CHANNEL_SENSORS
    ]
    async_add_entities(entities)


class XmeyeBinarySensor(XmeyeEntity, BinarySensorEntity):
    entity_description: XmeyeBinaryDescription

    def __init__(
        self, coordinator: XmeyeCoordinator, description: XmeyeBinaryDescription
    ) -> None:
        super().__init__(coordinator, description.key)
        self.entity_description = description

    @property
    def is_on(self) -> bool | None:
        if not self.coordinator.data:
            return None
        return self.entity_description.value(self.coordinator.data)


class XmeyeChannelBinarySensor(XmeyeChannelEntity, BinarySensorEntity):
    entity_description: XmeyeChannelBinaryDescription

    def __init__(
        self,
        coordinator: XmeyeCoordinator,
        channel: int,
        description: XmeyeChannelBinaryDescription,
    ) -> None:
        super().__init__(coordinator, channel, description.key)
        self.entity_description = description

    @property
    def is_on(self) -> bool | None:
        if not self.coordinator.data:
            return None
        return self.entity_description.value(self.coordinator.data, self.channel)
