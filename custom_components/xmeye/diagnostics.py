"""Diagnostics for bug reports."""

from __future__ import annotations

from typing import Any

from homeassistant.components.diagnostics import async_redact_data
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .const import DOMAIN
from .coordinator import XmeyeCoordinator

#: Never included in the report. The Sofia password hash is equivalent to the
#: password itself, and the serial number identifies the device in the XMeye cloud.
REDACT = {"password", "host", "serial_number", "serial", "mac", "unique_id"}


async def async_get_config_entry_diagnostics(
    hass: HomeAssistant, entry: ConfigEntry
) -> dict[str, Any]:
    coordinator: XmeyeCoordinator = hass.data[DOMAIN][entry.entry_id]
    data = coordinator.data

    return {
        "entry": {
            "data": async_redact_data(dict(entry.data), REDACT),
            "options": dict(entry.options),
        },
        "coordinator": {
            "last_update_success": coordinator.last_update_success,
            "reconnects": coordinator.client.reconnects,
            "update_interval": str(coordinator.update_interval),
            "enabled_channels": coordinator.enabled_channels,
        },
        "login_info": async_redact_data(dict(coordinator.client.login_info), REDACT),
        "device": (
            async_redact_data(dict(data.device.raw), REDACT) if data else None
        ),
        "channels": (
            [
                {
                    "index": c.index,
                    "status": c.status,
                    "resolution": c.current_resolution,
                    "max_resolution": c.max_resolution,
                }
                for c in data.channels
            ]
            if data
            else []
        ),
        "storage": (
            [
                {
                    "total_mb": disk.total_mb,
                    "free_mb": disk.free_mb,
                    "partitions": [
                        {
                            "total_mb": p.total_mb,
                            "free_mb": p.free_mb,
                            "status": p.status,
                            "oldest": str(p.oldest_record),
                            "newest": str(p.newest_record),
                        }
                        for p in disk.partitions
                    ],
                }
                for disk in data.disks
            ]
            if data
            else []
        ),
        "capabilities": data.capabilities if data else {},
    }
