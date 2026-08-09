"""Switches: motion detection and alarm reporting."""

from __future__ import annotations

import logging
from typing import Any

from homeassistant.components.switch import SwitchEntity, SwitchEntityDescription
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN
from .coordinator import XmeyeCoordinator
from .entity import XmeyeChannelEntity
from .xmeyelib import XmeyeError

_LOGGER = logging.getLogger(__name__)

#: Configuration sections toggled the same way: a per-channel array with Enable.
DETECT_SECTIONS = {
    "motion_detect": ("Detect.MotionDetect", "channel_motion_detect"),
    "blind_detect": ("Detect.BlindDetect", "channel_blind_detect"),
    "loss_detect": ("Detect.LossDetect", "channel_loss_detect"),
}


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    coordinator: XmeyeCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities(
        XmeyeDetectSwitch(coordinator, channel, key, section, translation_key)
        for channel in coordinator.enabled_channels
        for key, (section, translation_key) in DETECT_SECTIONS.items()
    )


class XmeyeDetectSwitch(XmeyeChannelEntity, SwitchEntity):
    """Enable a detector on one channel.

    The state is read from the recorder on demand rather than in the polling
    loop: detectors are toggled rarely, and an extra request every fifteen
    seconds would load the control session for nothing.
    """

    _attr_entity_category = EntityCategory.CONFIG

    def __init__(
        self,
        coordinator: XmeyeCoordinator,
        channel: int,
        key: str,
        section: str,
        translation_key: str,
    ) -> None:
        super().__init__(coordinator, channel, key)
        self._section = section
        self._attr_translation_key = translation_key
        self.entity_description = SwitchEntityDescription(
            key=key, translation_key=translation_key
        )
        self._is_on: bool | None = None

    @property
    def is_on(self) -> bool | None:
        return self._is_on

    async def async_update(self) -> None:
        try:
            async with self.coordinator.lock:
                config = await self.coordinator.client.get_config(
                    self._section, check=False
                )
        except XmeyeError as err:
            _LOGGER.debug("Could not read %s: %s", self._section, err)
            return
        if isinstance(config, list) and self.channel < len(config):
            self._is_on = bool(config[self.channel].get("Enable"))

    async def async_turn_on(self, **kwargs: Any) -> None:
        await self._set(True)

    async def async_turn_off(self, **kwargs: Any) -> None:
        await self._set(False)

    async def _set(self, enabled: bool) -> None:
        try:
            async with self.coordinator.lock:
                config = await self.coordinator.client.get_config(self._section)
                if not isinstance(config, list) or self.channel >= len(config):
                    raise HomeAssistantError(
                        f"The recorder has no {self._section} setting for channel "
                        f"{self.channel + 1}"
                    )
                # The firmware only accepts the whole array, so change one item
                # and send the rest back untouched.
                config[self.channel]["Enable"] = enabled
                await self.coordinator.client.set_config(self._section, config)
        except XmeyeError as err:
            raise HomeAssistantError(f"Could not change {self._section}: {err}") from err
        self._is_on = enabled
        self.async_write_ha_state()
