"""Constants for the XMeye integration."""

from __future__ import annotations

from datetime import timedelta
from typing import Final

DOMAIN: Final = "xmeye"
MANUFACTURER: Final = "Xiongmai"

# --- connection settings ---
CONF_CHANNELS: Final = "channels"
CONF_STREAM: Final = "stream"
CONF_SNAPSHOT_STREAM: Final = "snapshot_stream"
CONF_SCAN_INTERVAL: Final = "scan_interval"
CONF_RTSP_PORT: Final = "rtsp_port"
CONF_USE_RTSP: Final = "use_rtsp"
CONF_ENABLE_PANEL: Final = "enable_panel"

DEFAULT_PORT: Final = 34567
DEFAULT_RTSP_PORT: Final = 554
DEFAULT_USERNAME: Final = "admin"
DEFAULT_SCAN_INTERVAL: Final = 15
MIN_SCAN_INTERVAL: Final = 5
MAX_SCAN_INTERVAL: Final = 300

#: The main stream is 4K, the sub stream is small. For previews the sub stream
#: is the better default: far less transcoding work.
STREAM_MAIN: Final = "main"
STREAM_SUB: Final = "sub"
STREAM_OPTIONS: Final = [STREAM_MAIN, STREAM_SUB]

UPDATE_INTERVAL: Final = timedelta(seconds=DEFAULT_SCAN_INTERVAL)

# --- panel ---
PANEL_URL: Final = "xmeye"
PANEL_TITLE: Final = "XMeye"
PANEL_ICON: Final = "mdi:cctv"
PANEL_STATIC_PATH: Final = "/xmeye_panel"

# --- services ---
SERVICE_PTZ: Final = "ptz"
SERVICE_REBOOT: Final = "reboot"
SERVICE_SYNC_TIME: Final = "sync_time"
SERVICE_SEARCH_RECORDINGS: Final = "search_recordings"
SERVICE_DOWNLOAD_RECORDING: Final = "download_recording"
SERVICE_SET_CONFIG: Final = "set_config"
SERVICE_GET_CONFIG: Final = "get_config"
SERVICE_TALK: Final = "talk"

ATTR_CHANNEL: Final = "channel"
ATTR_DIRECTION: Final = "direction"
ATTR_SPEED: Final = "speed"
ATTR_DURATION: Final = "duration"
ATTR_PRESET: Final = "preset"
ATTR_START: Final = "start"
ATTR_END: Final = "end"
ATTR_EVENT: Final = "event"
ATTR_SECTION: Final = "section"
ATTR_VALUE: Final = "value"
ATTR_FILENAME: Final = "filename"
ATTR_AUDIO_FILE: Final = "audio_file"

#: PTZ directions accepted by the service, mapped to protocol commands.
PTZ_DIRECTIONS: Final = {
    "up": "DirectionUp",
    "down": "DirectionDown",
    "left": "DirectionLeft",
    "right": "DirectionRight",
    "up_left": "DirectionLeftUp",
    "up_right": "DirectionRightUp",
    "down_left": "DirectionLeftDown",
    "down_right": "DirectionRightDown",
    "zoom_in": "ZoomTile",
    "zoom_out": "ZoomWide",
    "focus_near": "FocusNear",
    "focus_far": "FocusFar",
    "iris_open": "IrisLarge",
    "iris_close": "IrisSmall",
}

#: Recording events shown in the interface.
EVENT_LABELS: Final = {
    "schedule": "Scheduled",
    "motion": "Motion",
    "alarm": "Alarm",
    "manual": "Manual",
}
