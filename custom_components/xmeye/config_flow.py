"""Config and options flow for the XMeye integration."""

from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol
from homeassistant.config_entries import (
    ConfigEntry,
    ConfigFlow,
    ConfigFlowResult,
    OptionsFlow,
)
from homeassistant.const import (
    CONF_HOST,
    CONF_PASSWORD,
    CONF_PORT,
    CONF_USERNAME,
)
from homeassistant.core import callback
from homeassistant.helpers.selector import (
    BooleanSelector,
    NumberSelector,
    NumberSelectorConfig,
    NumberSelectorMode,
    SelectOptionDict,
    SelectSelector,
    SelectSelectorConfig,
    SelectSelectorMode,
    TextSelector,
    TextSelectorConfig,
    TextSelectorType,
)

from .const import (
    CONF_CHANNELS,
    CONF_ENABLE_PANEL,
    CONF_RTSP_PORT,
    CONF_SCAN_INTERVAL,
    CONF_SNAPSHOT_STREAM,
    CONF_STREAM,
    CONF_USE_RTSP,
    DEFAULT_PORT,
    DEFAULT_RTSP_PORT,
    DEFAULT_SCAN_INTERVAL,
    DEFAULT_USERNAME,
    DOMAIN,
    MAX_SCAN_INTERVAL,
    MIN_SCAN_INTERVAL,
    STREAM_MAIN,
    STREAM_SUB,
)
from .xmeyelib import LoginFailed, XmeyeClient, XmeyeError

_LOGGER = logging.getLogger(__name__)

STEP_USER_SCHEMA = vol.Schema(
    {
        vol.Required(CONF_HOST): TextSelector(
            TextSelectorConfig(type=TextSelectorType.TEXT, autocomplete="off")
        ),
        vol.Required(CONF_USERNAME, default=DEFAULT_USERNAME): TextSelector(
            TextSelectorConfig(type=TextSelectorType.TEXT, autocomplete="username")
        ),
        vol.Required(CONF_PASSWORD, default=""): TextSelector(
            TextSelectorConfig(type=TextSelectorType.PASSWORD, autocomplete="current-password")
        ),
        vol.Optional(CONF_PORT, default=DEFAULT_PORT): NumberSelector(
            NumberSelectorConfig(min=1, max=65535, mode=NumberSelectorMode.BOX)
        ),
        vol.Optional(CONF_RTSP_PORT, default=DEFAULT_RTSP_PORT): NumberSelector(
            NumberSelectorConfig(min=1, max=65535, mode=NumberSelectorMode.BOX)
        ),
    }
)


async def _async_probe(data: dict[str, Any]) -> dict[str, Any]:
    """Connect and gather what is needed for the title and unique id."""
    client = XmeyeClient(
        data[CONF_HOST],
        username=data[CONF_USERNAME],
        password=data[CONF_PASSWORD],
        port=int(data[CONF_PORT]),
    )
    try:
        await client.login()
        info = await client.device_info()
        channels = await client.channel_statuses()
    finally:
        await client.close()
    return {
        "serial": info.serial_number,
        "model": info.hardware,
        "channels": [c.index for c in channels if c.online] or [0],
        "channel_count": info.channels,
    }


class XmeyeConfigFlow(ConfigFlow, domain=DOMAIN):
    """Adding a recorder."""

    VERSION = 1

    def __init__(self) -> None:
        self._reauth_entry: ConfigEntry | None = None

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        errors: dict[str, str] = {}

        if user_input is not None:
            data = {
                CONF_HOST: user_input[CONF_HOST],
                CONF_USERNAME: user_input[CONF_USERNAME],
                CONF_PASSWORD: user_input[CONF_PASSWORD],
                CONF_PORT: int(user_input.get(CONF_PORT, DEFAULT_PORT)),
                CONF_RTSP_PORT: int(user_input.get(CONF_RTSP_PORT, DEFAULT_RTSP_PORT)),
            }
            try:
                probe = await _async_probe(data)
            except LoginFailed:
                errors["base"] = "invalid_auth"
            except XmeyeError:
                errors["base"] = "cannot_connect"
            except Exception:  # noqa: BLE001
                _LOGGER.exception("Unexpected error while connecting")
                errors["base"] = "unknown"
            else:
                # The serial number is steadier than an IP, which DHCP may change.
                unique = probe["serial"] or f"{data[CONF_HOST]}:{data[CONF_PORT]}"
                await self.async_set_unique_id(unique)
                self._abort_if_unique_id_configured(updates=data)
                return self.async_create_entry(
                    title=probe["model"] or data[CONF_HOST],
                    data=data,
                    options={CONF_CHANNELS: probe["channels"]},
                )

        return self.async_show_form(
            step_id="user",
            data_schema=self.add_suggested_values_to_schema(
                STEP_USER_SCHEMA, user_input or {}
            ),
            errors=errors,
        )

    async def async_step_reauth(
        self, entry_data: dict[str, Any]
    ) -> ConfigFlowResult:
        self._reauth_entry = self.hass.config_entries.async_get_entry(
            self.context["entry_id"]
        )
        return await self.async_step_reauth_confirm()

    async def async_step_reauth_confirm(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Recorder passwords change more often than anything else."""
        errors: dict[str, str] = {}
        entry = self._reauth_entry
        assert entry is not None

        if user_input is not None:
            data = {**entry.data, CONF_PASSWORD: user_input[CONF_PASSWORD]}
            try:
                await _async_probe(data)
            except LoginFailed:
                errors["base"] = "invalid_auth"
            except XmeyeError:
                errors["base"] = "cannot_connect"
            else:
                return self.async_update_reload_and_abort(entry, data=data)

        return self.async_show_form(
            step_id="reauth_confirm",
            data_schema=vol.Schema(
                {
                    vol.Required(CONF_PASSWORD): TextSelector(
                        TextSelectorConfig(type=TextSelectorType.PASSWORD)
                    )
                }
            ),
            errors=errors,
            description_placeholders={"host": entry.data[CONF_HOST]},
        )

    @staticmethod
    @callback
    def async_get_options_flow(entry: ConfigEntry) -> XmeyeOptionsFlow:
        return XmeyeOptionsFlow()


class XmeyeOptionsFlow(OptionsFlow):
    """What to show and how often to poll."""

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        entry = self.config_entry
        if user_input is not None:
            return self.async_create_entry(
                data={
                    CONF_CHANNELS: [int(c) for c in user_input[CONF_CHANNELS]],
                    CONF_STREAM: user_input[CONF_STREAM],
                    CONF_SNAPSHOT_STREAM: user_input[CONF_SNAPSHOT_STREAM],
                    CONF_SCAN_INTERVAL: int(user_input[CONF_SCAN_INTERVAL]),
                    CONF_USE_RTSP: user_input[CONF_USE_RTSP],
                    CONF_ENABLE_PANEL: user_input[CONF_ENABLE_PANEL],
                }
            )

        coordinator = self.hass.data.get(DOMAIN, {}).get(entry.entry_id)
        channel_options = self._channel_options(coordinator)
        options = entry.options

        schema = vol.Schema(
            {
                vol.Required(
                    CONF_CHANNELS,
                    default=[str(c) for c in options.get(CONF_CHANNELS, [0])],
                ): SelectSelector(
                    SelectSelectorConfig(
                        options=channel_options,
                        multiple=True,
                        mode=SelectSelectorMode.LIST,
                    )
                ),
                vol.Required(
                    CONF_STREAM, default=options.get(CONF_STREAM, STREAM_SUB)
                ): SelectSelector(
                    SelectSelectorConfig(
                        options=[STREAM_MAIN, STREAM_SUB],
                        translation_key="stream",
                    )
                ),
                vol.Required(
                    CONF_SNAPSHOT_STREAM,
                    default=options.get(CONF_SNAPSHOT_STREAM, STREAM_MAIN),
                ): SelectSelector(
                    SelectSelectorConfig(
                        options=[STREAM_MAIN, STREAM_SUB],
                        translation_key="stream",
                    )
                ),
                vol.Required(
                    CONF_SCAN_INTERVAL,
                    default=options.get(CONF_SCAN_INTERVAL, DEFAULT_SCAN_INTERVAL),
                ): NumberSelector(
                    NumberSelectorConfig(
                        min=MIN_SCAN_INTERVAL,
                        max=MAX_SCAN_INTERVAL,
                        step=5,
                        unit_of_measurement="s",
                        mode=NumberSelectorMode.SLIDER,
                    )
                ),
                vol.Required(
                    CONF_USE_RTSP, default=options.get(CONF_USE_RTSP, True)
                ): BooleanSelector(),
                vol.Required(
                    CONF_ENABLE_PANEL, default=options.get(CONF_ENABLE_PANEL, True)
                ): BooleanSelector(),
            }
        )
        return self.async_show_form(step_id="init", data_schema=schema)

    @staticmethod
    def _channel_options(coordinator: Any) -> list[SelectOptionDict]:
        """List the channels, marking their connection state."""
        if coordinator is None or not coordinator.data:
            return [SelectOptionDict(value="0", label="Channel 1")]

        options: list[SelectOptionDict] = []
        for channel in coordinator.data.channels:
            if not channel.configured:
                continue
            name = coordinator.data.channel_name(channel.index)
            mark = "" if channel.online else " (offline)"
            options.append(
                SelectOptionDict(
                    value=str(channel.index), label=f"{channel.index + 1}. {name}{mark}"
                )
            )
        return options or [SelectOptionDict(value="0", label="Channel 1")]
