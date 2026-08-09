"""WebSocket API behind the XMeye panel."""

from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Any

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback

from .const import (
    CONF_RTSP_PORT,
    CONF_STREAM,
    DEFAULT_RTSP_PORT,
    DOMAIN,
    STREAM_MAIN,
    STREAM_SUB,
)
from .coordinator import XmeyeCoordinator
from .xmeyelib import XmeyeError

_LOGGER = logging.getLogger(__name__)

#: Recordings returned to the panel at once, to keep messages small.
MAX_RECORDINGS = 2000


def _coordinators(hass: HomeAssistant) -> dict[str, XmeyeCoordinator]:
    return hass.data.get(DOMAIN, {})


def _require(hass: HomeAssistant, entry_id: str) -> XmeyeCoordinator:
    coordinator = _coordinators(hass).get(entry_id)
    if coordinator is None:
        raise websocket_api.ActiveConnectionError(f"Recorder {entry_id} not found")
    return coordinator


@callback
def async_register_websocket_api(hass: HomeAssistant) -> None:
    """Register the panel commands, idempotently."""
    if hass.data.get(f"{DOMAIN}_ws_registered"):
        return
    hass.data[f"{DOMAIN}_ws_registered"] = True

    websocket_api.async_register_command(hass, ws_list_devices)
    websocket_api.async_register_command(hass, ws_device_detail)
    websocket_api.async_register_command(hass, ws_recordings)
    websocket_api.async_register_command(hass, ws_config_tree)
    websocket_api.async_register_command(hass, ws_config_get)
    websocket_api.async_register_command(hass, ws_log)


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/devices"})
@websocket_api.async_response
async def ws_list_devices(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """A short list of every configured recorder, for the panel selector."""
    devices = []
    for entry_id, coordinator in _coordinators(hass).items():
        data = coordinator.data
        devices.append(
            {
                "entry_id": entry_id,
                "title": coordinator.config_entry.title,
                "host": coordinator.host,
                "available": coordinator.last_update_success and data is not None,
                "model": data.device.hardware if data else None,
                "channels_online": sum(1 for c in data.channels if c.online) if data else 0,
                "channels_total": data.device.channels if data else 0,
            }
        )
    connection.send_result(msg["id"], {"devices": devices})


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/device", vol.Required("entry_id"): str}
)
@websocket_api.async_response
async def ws_device_detail(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Everything the panel shows on its main screen."""
    coordinator = _require(hass, msg["entry_id"])
    data = coordinator.data
    if data is None:
        connection.send_error(msg["id"], "unavailable", "No data from the recorder")
        return

    entry = coordinator.config_entry
    enabled = coordinator.enabled_channels
    rtsp_port = entry.data.get(CONF_RTSP_PORT, DEFAULT_RTSP_PORT)

    from homeassistant.helpers import entity_registry as er

    registry = er.async_get(hass)

    channels = []
    for status in data.channels:
        if not status.configured and status.index not in enabled:
            continue
        # The panel plays video through the Home Assistant camera entity, which
        # brings permissions, tokens and transcoding along without a separate
        # path to the device. One camera per stream lets the panel switch
        # between them without reconfiguring the integration.
        base = f"{msg['entry_id']}_ch{status.index}_camera"
        preferred = entry.options.get(CONF_STREAM, STREAM_SUB)
        cameras: dict[str, str | None] = {}
        for stream in (STREAM_MAIN, STREAM_SUB):
            unique = base if stream == preferred else f"{base}_{stream}"
            cameras[stream] = registry.async_get_entity_id("camera", DOMAIN, unique)
        camera_entity = cameras[preferred]
        channels.append(
            {
                "index": status.index,
                "entity_id": camera_entity,
                "entity_ids": cameras,
                "name": data.channel_name(status.index),
                "status": status.status,
                "online": status.online,
                "resolution": status.current_resolution,
                "max_resolution": status.max_resolution,
                "bitrate": data.bitrate(status.index),
                "recording": data.is_recording(status.index),
                "motion": data.motion_on(status.index),
                "video_loss": data.video_loss_on(status.index),
                "enabled": status.index in enabled,
                # The password deliberately stays out of here: the panel never
                # needs it, and playback goes through the camera entity.
                "rtsp_hint": f"rtsp://{coordinator.host}:{rtsp_port}"
                f"/cam/realmonitor?channel={status.index + 1}&subtype=1",
            }
        )

    connection.send_result(
        msg["id"],
        {
            "entry_id": msg["entry_id"],
            "title": entry.title,
            "host": coordinator.host,
            "device": {
                "model": data.device.hardware,
                "firmware": data.device.software_version,
                "build_time": _iso(data.device.build_time),
                "channels": data.device.channels,
                "uptime_seconds": (
                    int(data.device.uptime.total_seconds()) if data.device.uptime else None
                ),
                "supports_talk": data.device.supports_talk,
                "device_time": _iso(data.device_time),
            },
            "channels": channels,
            "storage": [
                {
                    "index": disk.index,
                    "total_mb": disk.total_mb,
                    "free_mb": disk.free_mb,
                    "partitions": [
                        {
                            "total_mb": p.total_mb,
                            "free_mb": p.free_mb,
                            "used_percent": p.used_percent,
                            "oldest": _iso(p.oldest_record),
                            "newest": _iso(p.newest_record),
                        }
                        for p in disk.partitions
                    ],
                }
                for disk in data.disks
            ],
            "archive": {"from": _iso(data.archive_from), "to": _iso(data.archive_to)},
            "capabilities": data.capabilities,
            "totals": {
                "bitrate": data.total_bitrate,
                "recording": len(data.recording_channels),
            },
        },
    )


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/recordings",
        vol.Required("entry_id"): str,
        vol.Required("channel"): int,
        vol.Optional("start"): str,
        vol.Optional("end"): str,
        vol.Optional("event", default="*"): str,
    }
)
@websocket_api.async_response
async def ws_recordings(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Recordings for the timeline."""
    coordinator = _require(hass, msg["entry_id"])
    end = _parse(msg.get("end")) or datetime.now()
    start = _parse(msg.get("start")) or end - timedelta(days=1)

    try:
        async with coordinator.lock:
            records = await coordinator.client.search_files(
                start,
                end,
                channel=msg["channel"],
                event=msg.get("event", "*"),
                limit=MAX_RECORDINGS,
            )
    except XmeyeError as err:
        connection.send_error(msg["id"], "search_failed", str(err))
        return

    connection.send_result(
        msg["id"],
        {
            "channel": msg["channel"],
            "start": start.isoformat(),
            "end": end.isoformat(),
            "count": len(records),
            "total_bytes": sum(r.size_bytes for r in records),
            "recordings": [
                {
                    "name": r.name,
                    "begin": _iso(r.begin),
                    "end": _iso(r.end),
                    "seconds": r.duration.total_seconds() if r.duration else 0,
                    "size": r.size_bytes,
                    "event": r.event,
                }
                for r in records
            ],
        },
    )


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/config_tree", vol.Required("entry_id"): str}
)
@websocket_api.async_response
async def ws_config_tree(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """The available configuration sections, without their contents."""
    coordinator = _require(hass, msg["entry_id"])
    try:
        async with coordinator.lock:
            tree = await coordinator.client.config_tree()
    except XmeyeError as err:
        connection.send_error(msg["id"], "config_failed", str(err))
        return

    sections = {
        root: sorted(body) if isinstance(body, dict) else []
        for root, body in sorted(tree.items())
    }
    connection.send_result(
        msg["id"],
        {"roots": sections, "count": sum(len(v) or 1 for v in sections.values())},
    )


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/config",
        vol.Required("entry_id"): str,
        vol.Required("section"): str,
    }
)
@websocket_api.async_response
async def ws_config_get(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """The contents of one configuration section."""
    coordinator = _require(hass, msg["entry_id"])
    try:
        async with coordinator.lock:
            value = await coordinator.client.get_config(msg["section"], check=False)
    except XmeyeError as err:
        connection.send_error(msg["id"], "config_failed", str(err))
        return
    connection.send_result(
        msg["id"], {"section": msg["section"], "value": _redact(value)}
    )


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/log",
        vol.Required("entry_id"): str,
        vol.Optional("hours", default=24): int,
    }
)
@websocket_api.async_response
async def ws_log(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """The recorder's system log."""
    coordinator = _require(hass, msg["entry_id"])
    end = datetime.now()
    start = end - timedelta(hours=max(1, min(msg.get("hours", 24), 24 * 30)))
    try:
        async with coordinator.lock:
            entries = await coordinator.client.search_log(start, end, limit=500)
    except XmeyeError as err:
        connection.send_error(msg["id"], "log_failed", str(err))
        return

    connection.send_result(
        msg["id"],
        {
            "entries": [
                {
                    "time": _iso(e.time),
                    "type": e.type,
                    "user": e.user,
                    "data": e.data,
                }
                for e in entries
            ]
        },
    )


#: Keys whose values must never reach the interface. The Sofia password hash is
#: equivalent to the password: it can be used to log in directly.
_SECRET_HINTS = ("password", "passwd", "secret", "key", "token", "serialno", "uuid")


def _redact(value: Any, key: str = "") -> Any:
    if key and any(hint in key.lower() for hint in _SECRET_HINTS):
        return "***"
    if isinstance(value, dict):
        return {k: _redact(v, k) for k, v in value.items()}
    if isinstance(value, list):
        return [_redact(v, key) for v in value]
    return value


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def _parse(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed.replace(tzinfo=None) if parsed.tzinfo else parsed
