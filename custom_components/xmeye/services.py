"""Services provided by the XMeye integration."""

from __future__ import annotations

import logging
from datetime import datetime, timedelta
from pathlib import Path

import voluptuous as vol
from homeassistant.core import (
    HomeAssistant,
    ServiceCall,
    ServiceResponse,
    SupportsResponse,
)
from homeassistant.exceptions import HomeAssistantError, ServiceValidationError
from homeassistant.helpers import config_validation as cv

from .const import (
    ATTR_AUDIO_FILE,
    ATTR_CHANNEL,
    ATTR_DIRECTION,
    ATTR_DURATION,
    ATTR_END,
    ATTR_EVENT,
    ATTR_FILENAME,
    ATTR_PRESET,
    ATTR_SECTION,
    ATTR_SPEED,
    ATTR_START,
    ATTR_VALUE,
    DOMAIN,
    PTZ_DIRECTIONS,
    SERVICE_DOWNLOAD_RECORDING,
    SERVICE_GET_CONFIG,
    SERVICE_PTZ,
    SERVICE_SEARCH_RECORDINGS,
    SERVICE_SET_CONFIG,
    SERVICE_TALK,
)
from .coordinator import XmeyeCoordinator
from .xmeyelib import ArchiveStream, TalkStream, XmeyeError

_LOGGER = logging.getLogger(__name__)

CONF_ENTRY = "config_entry_id"

_BASE = {vol.Required(CONF_ENTRY): cv.string}

PTZ_SCHEMA = vol.Schema(
    {
        **_BASE,
        vol.Required(ATTR_DIRECTION): vol.In(sorted(PTZ_DIRECTIONS)),
        vol.Optional(ATTR_CHANNEL, default=0): cv.positive_int,
        vol.Optional(ATTR_SPEED, default=5): vol.All(int, vol.Range(min=1, max=8)),
        vol.Optional(ATTR_DURATION, default=0.5): vol.All(
            vol.Coerce(float), vol.Range(min=0.1, max=10)
        ),
        vol.Optional(ATTR_PRESET): vol.All(int, vol.Range(min=0, max=255)),
    }
)

SEARCH_SCHEMA = vol.Schema(
    {
        **_BASE,
        vol.Optional(ATTR_CHANNEL, default=0): cv.positive_int,
        vol.Optional(ATTR_START): cv.datetime,
        vol.Optional(ATTR_END): cv.datetime,
        vol.Optional(ATTR_EVENT, default="*"): vol.In(["*", "M", "A", "R", "H"]),
    }
)

DOWNLOAD_SCHEMA = vol.Schema(
    {
        **_BASE,
        vol.Required(ATTR_FILENAME): cv.string,
        vol.Required(ATTR_START): cv.datetime,
        vol.Required(ATTR_END): cv.datetime,
        vol.Optional(ATTR_CHANNEL, default=0): cv.positive_int,
    }
)

GET_CONFIG_SCHEMA = vol.Schema({**_BASE, vol.Required(ATTR_SECTION): cv.string})

SET_CONFIG_SCHEMA = vol.Schema(
    {**_BASE, vol.Required(ATTR_SECTION): cv.string, vol.Required(ATTR_VALUE): dict}
)

TALK_SCHEMA = vol.Schema({**_BASE, vol.Required(ATTR_AUDIO_FILE): cv.string})


def _coordinator(hass: HomeAssistant, call: ServiceCall) -> XmeyeCoordinator:
    entry_id = call.data[CONF_ENTRY]
    coordinator = hass.data.get(DOMAIN, {}).get(entry_id)
    if coordinator is None:
        raise ServiceValidationError(f"Recorder {entry_id} is not configured")
    return coordinator


async def async_setup_services(hass: HomeAssistant) -> None:
    """Register the services once for the whole domain."""
    if hass.services.has_service(DOMAIN, SERVICE_PTZ):
        return

    async def handle_ptz(call: ServiceCall) -> None:
        coordinator = _coordinator(hass, call)
        command = PTZ_DIRECTIONS[call.data[ATTR_DIRECTION]]
        try:
            async with coordinator.lock:
                if (preset := call.data.get(ATTR_PRESET)) is not None:
                    await coordinator.client.ptz(
                        "GotoPreset", channel=call.data[ATTR_CHANNEL], preset=preset
                    )
                    return
                await coordinator.client.ptz_move(
                    command,
                    channel=call.data[ATTR_CHANNEL],
                    step=call.data[ATTR_SPEED],
                    duration=call.data[ATTR_DURATION],
                )
        except XmeyeError as err:
            raise HomeAssistantError(f"PTZ command failed: {err}") from err

    async def handle_search(call: ServiceCall) -> ServiceResponse:
        coordinator = _coordinator(hass, call)
        end = call.data.get(ATTR_END) or datetime.now()
        start = call.data.get(ATTR_START) or end - timedelta(days=1)
        try:
            async with coordinator.lock:
                records = await coordinator.client.search_files(
                    _naive(start),
                    _naive(end),
                    channel=call.data[ATTR_CHANNEL],
                    event=call.data[ATTR_EVENT],
                )
        except XmeyeError as err:
            raise HomeAssistantError(f"Recording search failed: {err}") from err

        return {
            "count": len(records),
            "total_bytes": sum(r.size_bytes for r in records),
            "recordings": [
                {
                    "name": r.name,
                    "begin": r.begin.isoformat() if r.begin else None,
                    "end": r.end.isoformat() if r.end else None,
                    "seconds": r.duration.total_seconds() if r.duration else None,
                    "size_bytes": r.size_bytes,
                    "event": r.event,
                }
                for r in records
            ],
        }

    async def handle_download(call: ServiceCall) -> ServiceResponse:
        coordinator = _coordinator(hass, call)
        entry = coordinator.config_entry
        target = Path(hass.config.path("media"), "xmeye")
        target.mkdir(parents=True, exist_ok=True)

        begin, end = _naive(call.data[ATTR_START]), _naive(call.data[ATTR_END])
        stem = f"ch{call.data[ATTR_CHANNEL]}_{begin:%Y%m%d_%H%M%S}"
        raw_path = target / f"{stem}.h265"

        archive = ArchiveStream(
            entry.data["host"],
            username=entry.data["username"],
            password=entry.data["password"],
            port=entry.data["port"],
            channel=call.data[ATTR_CHANNEL],
        )
        try:
            await archive.start()
            data = await archive.download(
                call.data[ATTR_FILENAME], begin=begin, end=end, timeout=60
            )
        except XmeyeError as err:
            raise HomeAssistantError(f"Could not download the recording: {err}") from err
        finally:
            await archive.close()

        if not data:
            raise HomeAssistantError("The recorder returned no frames")

        await hass.async_add_executor_job(raw_path.write_bytes, data)
        return {
            "path": str(raw_path),
            "bytes": len(data),
            "frames": archive.info.video_frames,
            "resolution": archive.info.resolution,
            "codec": archive.info.video_codec,
        }

    async def handle_get_config(call: ServiceCall) -> ServiceResponse:
        coordinator = _coordinator(hass, call)
        try:
            async with coordinator.lock:
                value = await coordinator.client.get_config(
                    call.data[ATTR_SECTION], check=False
                )
        except XmeyeError as err:
            raise HomeAssistantError(f"Could not read the section: {err}") from err
        return {"section": call.data[ATTR_SECTION], "value": value}

    async def handle_set_config(call: ServiceCall) -> None:
        coordinator = _coordinator(hass, call)
        try:
            async with coordinator.lock:
                await coordinator.client.set_config(
                    call.data[ATTR_SECTION], call.data[ATTR_VALUE]
                )
        except XmeyeError as err:
            raise HomeAssistantError(f"Could not write the section: {err}") from err
        await coordinator.async_request_refresh()

    async def handle_talk(call: ServiceCall) -> None:
        coordinator = _coordinator(hass, call)
        entry = coordinator.config_entry
        path = call.data[ATTR_AUDIO_FILE]
        if not hass.config.is_allowed_path(path):
            raise ServiceValidationError(f"Access to {path} is not allowed")

        audio = await hass.async_add_executor_job(Path(path).read_bytes)
        talk = TalkStream(
            entry.data["host"],
            username=entry.data["username"],
            password=entry.data["password"],
            port=entry.data["port"],
        )
        try:
            await talk.start()
            await talk.send(audio)
        except XmeyeError as err:
            raise HomeAssistantError(f"Could not send the audio: {err}") from err
        finally:
            await talk.close()

    hass.services.async_register(DOMAIN, SERVICE_PTZ, handle_ptz, schema=PTZ_SCHEMA)
    hass.services.async_register(
        DOMAIN,
        SERVICE_SEARCH_RECORDINGS,
        handle_search,
        schema=SEARCH_SCHEMA,
        supports_response=SupportsResponse.ONLY,
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_DOWNLOAD_RECORDING,
        handle_download,
        schema=DOWNLOAD_SCHEMA,
        supports_response=SupportsResponse.OPTIONAL,
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_GET_CONFIG,
        handle_get_config,
        schema=GET_CONFIG_SCHEMA,
        supports_response=SupportsResponse.ONLY,
    )
    hass.services.async_register(
        DOMAIN, SERVICE_SET_CONFIG, handle_set_config, schema=SET_CONFIG_SCHEMA
    )
    hass.services.async_register(DOMAIN, SERVICE_TALK, handle_talk, schema=TALK_SCHEMA)


async def async_unload_services(hass: HomeAssistant) -> None:
    for service in (
        SERVICE_PTZ,
        SERVICE_SEARCH_RECORDINGS,
        SERVICE_DOWNLOAD_RECORDING,
        SERVICE_GET_CONFIG,
        SERVICE_SET_CONFIG,
        SERVICE_TALK,
    ):
        hass.services.async_remove(DOMAIN, service)


def _naive(value: datetime) -> datetime:
    """The recorder runs on its own local time, without zones."""
    return value.replace(tzinfo=None) if value.tzinfo else value
