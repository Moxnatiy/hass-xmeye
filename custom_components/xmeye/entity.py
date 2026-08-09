"""Shared base classes for XMeye entities."""

from __future__ import annotations

from homeassistant.helpers.device_registry import DeviceInfo as HaDeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN, MANUFACTURER
from .coordinator import XmeyeCoordinator


class XmeyeEntity(CoordinatorEntity[XmeyeCoordinator]):
    """An entity attached to the recorder as a whole."""

    _attr_has_entity_name = True

    def __init__(self, coordinator: XmeyeCoordinator, key: str) -> None:
        super().__init__(coordinator)
        self._key = key
        self._attr_unique_id = f"{coordinator.config_entry.entry_id}_{key}"
        self._attr_device_info = self._recorder_device()

    def _recorder_device(self) -> HaDeviceInfo:
        entry = self.coordinator.config_entry
        device = self.coordinator.data.device if self.coordinator.data else None
        return HaDeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name=entry.title,
            manufacturer=MANUFACTURER,
            model=device.hardware if device else None,
            sw_version=device.software_version if device else None,
            serial_number=device.serial_number if device else None,
            configuration_url=f"http://{entry.data['host']}",
        )

    @property
    def available(self) -> bool:
        return super().available and self.coordinator.data is not None


class XmeyeChannelEntity(XmeyeEntity):
    """An entity of a single channel.

    Each channel becomes its own Home Assistant device under the recorder, so
    cameras group naturally instead of blurring together.
    """

    def __init__(self, coordinator: XmeyeCoordinator, channel: int, key: str) -> None:
        super().__init__(coordinator, f"ch{channel}_{key}")
        self.channel = channel
        entry = coordinator.config_entry
        self._attr_device_info = HaDeviceInfo(
            identifiers={(DOMAIN, f"{entry.entry_id}_ch{channel}")},
            name=self.channel_name,
            manufacturer=MANUFACTURER,
            model="Channel",
            via_device=(DOMAIN, entry.entry_id),
        )

    @property
    def channel_name(self) -> str:
        if self.coordinator.data:
            return self.coordinator.data.channel_name(self.channel)
        return f"Channel {self.channel + 1}"

    @property
    def available(self) -> bool:
        if not super().available:
            return False
        statuses = self.coordinator.data.channels
        if self.channel < len(statuses):
            return statuses[self.channel].configured
        return True
