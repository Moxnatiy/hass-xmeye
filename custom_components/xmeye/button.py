"""Buttons: reboot and clock synchronisation."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime

from homeassistant.components.button import (
    ButtonDeviceClass,
    ButtonEntity,
    ButtonEntityDescription,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN
from .coordinator import XmeyeCoordinator
from .entity import XmeyeEntity
from .xmeyelib import XmeyeClient, XmeyeError


@dataclass(frozen=True, kw_only=True)
class XmeyeButtonDescription(ButtonEntityDescription):
    action: Callable[[XmeyeClient], Awaitable[object]]


BUTTONS: tuple[XmeyeButtonDescription, ...] = (
    XmeyeButtonDescription(
        key="reboot",
        translation_key="reboot",
        device_class=ButtonDeviceClass.RESTART,
        entity_category=EntityCategory.CONFIG,
        action=lambda client: client.reboot(),
    ),
    XmeyeButtonDescription(
        key="sync_time",
        translation_key="sync_time",
        entity_category=EntityCategory.CONFIG,
        action=lambda client: client.set_time(datetime.now()),
    ),
)


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    coordinator: XmeyeCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities(XmeyeButton(coordinator, description) for description in BUTTONS)


class XmeyeButton(XmeyeEntity, ButtonEntity):
    entity_description: XmeyeButtonDescription

    def __init__(
        self, coordinator: XmeyeCoordinator, description: XmeyeButtonDescription
    ) -> None:
        super().__init__(coordinator, description.key)
        self.entity_description = description

    async def async_press(self) -> None:
        try:
            async with self.coordinator.lock:
                await self.entity_description.action(self.coordinator.client)
        except XmeyeError as err:
            raise HomeAssistantError(
                f"Command {self.entity_description.key} failed: {err}"
            ) from err
        await self.coordinator.async_request_refresh()
