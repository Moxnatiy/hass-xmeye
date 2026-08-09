"""XMeye / Xiongmai NVR integration for Home Assistant."""

from __future__ import annotations

import logging
from pathlib import Path

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers.typing import ConfigType

from .const import (
    CONF_ENABLE_PANEL,
    DOMAIN,
    PANEL_ICON,
    PANEL_STATIC_PATH,
    PANEL_TITLE,
    PANEL_URL,
)
from .coordinator import XmeyeCoordinator, async_create_client
from .http import async_register_http
from .services import async_setup_services, async_unload_services
from .websocket import async_register_websocket_api

_LOGGER = logging.getLogger(__name__)

PLATFORMS: list[Platform] = [
    Platform.BINARY_SENSOR,
    Platform.BUTTON,
    Platform.CAMERA,
    Platform.SENSOR,
    Platform.SWITCH,
]

type XmeyeConfigEntry = ConfigEntry[XmeyeCoordinator]


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """One-time setup shared by every recorder."""
    hass.data.setdefault(DOMAIN, {})
    async_register_websocket_api(hass)
    async_register_http(hass)
    await async_setup_services(hass)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: XmeyeConfigEntry) -> bool:
    """Connect to the recorder and bring up its entities."""
    client = await async_create_client(hass, dict(entry.data))
    coordinator = XmeyeCoordinator(hass, entry, client)
    await coordinator.async_config_entry_first_refresh()

    entry.runtime_data = coordinator
    hass.data[DOMAIN][entry.entry_id] = coordinator

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    entry.async_on_unload(entry.add_update_listener(_async_reload_on_options))

    if entry.options.get(CONF_ENABLE_PANEL, True):
        await _async_register_panel(hass)

    return True


async def async_unload_entry(hass: HomeAssistant, entry: XmeyeConfigEntry) -> bool:
    """Disconnect and clean up."""
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unloaded:
        coordinator: XmeyeCoordinator = hass.data[DOMAIN].pop(entry.entry_id)
        await coordinator.client.close()

    if not hass.data[DOMAIN]:
        await _async_remove_panel(hass)
        await async_unload_services(hass)
    return unloaded


async def _async_reload_on_options(hass: HomeAssistant, entry: XmeyeConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)


async def _async_register_panel(hass: HomeAssistant) -> None:
    """Add XMeye as its own item in the sidebar.

    The panel is a full-page web component, in the spirit of the Energy
    dashboard: a channel wall, an archive timeline and the configuration
    browser in one place.
    """
    from homeassistant.components import panel_custom
    from homeassistant.components.http import StaticPathConfig

    if DOMAIN in hass.data.get("frontend_panels", {}):
        return

    panel_dir = Path(__file__).parent / "panel"
    await hass.http.async_register_static_paths(
        [StaticPathConfig(PANEL_STATIC_PATH, str(panel_dir), cache_headers=False)]
    )

    # Browsers cache ES modules for a long time and will not re-request them
    # even without cache headers. Without a version stamp in the URL, a user who
    # upgrades the integration would keep the old panel. The stamp comes from the
    # files' modification time, which works for releases and development alike.
    version = await hass.async_add_executor_job(_panel_version, panel_dir)

    try:
        await panel_custom.async_register_panel(
            hass,
            frontend_url_path=PANEL_URL,
            webcomponent_name="xmeye-panel",
            module_url=f"{PANEL_STATIC_PATH}/xmeye-panel.js?v={version}",
            sidebar_title=PANEL_TITLE,
            sidebar_icon=PANEL_ICON,
            require_admin=False,
            embed_iframe=False,
        )
    except ValueError:
        # another config entry already registered the panel
        _LOGGER.debug("XMeye panel is already registered")
    else:
        _LOGGER.debug("XMeye panel registered at /%s", PANEL_URL)


def _panel_version(panel_dir: Path) -> str:
    """Panel version stamp: the newest modification time of its files."""
    stamps = [int(item.stat().st_mtime) for item in panel_dir.glob("*.js")]
    return str(max(stamps)) if stamps else "0"


async def _async_remove_panel(hass: HomeAssistant) -> None:
    from homeassistant.components import frontend

    frontend.async_remove_panel(hass, PANEL_URL)
