"""DVRIP / Sofia protocol constants (Xiongmai, XMeye).

Sources:
  * the vendor's own interface specification
  * verified against a live NBD8008R-U running V4.03.R11.061B0197
"""

from __future__ import annotations

from enum import IntEnum

DEFAULT_PORT = 34567
DEFAULT_UDP_PORT = 34568
DEFAULT_RTSP_PORT = 554

#: Magic first byte of every packet.
MAGIC = 0xFF
#: Packet header length in bytes.
HEADER_SIZE = 20
#: JSON payload terminator: newline plus NUL.
PAYLOAD_TERMINATOR = b"\x0a\x00"

#: Alphabet used by the Sofia password hash.
SOFIA_HASH_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"


class Msg(IntEnum):
    """Message identifiers.

    Replies almost always arrive as ``msgid + 1`` (LOGIN 1000 becomes 1001).
    """

    LOGIN = 1000
    LOGIN_RSP = 1001
    LOGOUT = 1002
    LOGOUT_RSP = 1003
    FORCE_LOGOUT = 1004
    KEEPALIVE = 1006
    KEEPALIVE_RSP = 1007

    SYSINFO = 1020  # SystemInfo, StorageInfo, WorkState
    SYSINFO_RSP = 1021

    CONFIG_SET = 1040
    CONFIG_SET_RSP = 1041
    CONFIG_GET = 1042
    CONFIG_GET_RSP = 1043
    DEFAULT_CONFIG_GET = 1044
    DEFAULT_CONFIG_GET_RSP = 1045
    CONFIG_CHANNELTITLE_SET = 1046
    CONFIG_CHANNELTITLE_SET_RSP = 1047
    CONFIG_CHANNELTITLE_GET = 1048
    CONFIG_CHANNELTITLE_GET_RSP = 1049

    SYSTEM_FUNCTION = 1360  # SystemFunction, EncodeCapability
    SYSTEM_FUNCTION_RSP = 1361

    PTZ = 1400
    PTZ_RSP = 1401

    MONITOR_START = 1410
    MONITOR_START_RSP = 1411
    MONITOR_DATA = 1412
    MONITOR_CLAIM = 1413
    MONITOR_CLAIM_RSP = 1414

    PLAY = 1420
    PLAY_RSP = 1421
    PLAY_DATA = 1422
    PLAY_CLAIM = 1424
    PLAY_CLAIM_RSP = 1425
    DOWNLOAD_DATA = 1426

    TALK_START = 1430
    TALK_START_RSP = 1431
    TALK_DATA = 1432
    TALK_CLAIM = 1434
    TALK_CLAIM_RSP = 1435

    FILE_SEARCH = 1440
    FILE_SEARCH_RSP = 1441
    LOG_SEARCH = 1442
    LOG_SEARCH_RSP = 1443
    FILE_SEARCH_BY_TIME = 1444
    FILE_SEARCH_BY_TIME_RSP = 1445

    SYSTEM_MANAGER = 1450  # OPMachine, OPTimeSetting
    SYSTEM_MANAGER_RSP = 1451
    TIME_QUERY = 1452
    TIME_QUERY_RSP = 1453

    DISK_MANAGER = 1460
    DISK_MANAGER_RSP = 1461

    FULL_AUTHORITY_LIST = 1470
    FULL_AUTHORITY_LIST_RSP = 1471
    USERS_GET = 1472
    USERS_GET_RSP = 1473
    GROUPS_GET = 1474
    GROUPS_GET_RSP = 1475
    ADD_GROUP = 1476
    ADD_GROUP_RSP = 1477
    MODIFY_GROUP = 1478
    MODIFY_GROUP_RSP = 1479
    DELETE_GROUP = 1480
    DELETE_GROUP_RSP = 1481
    ADD_USER = 1482
    ADD_USER_RSP = 1483
    MODIFY_USER = 1484
    MODIFY_USER_RSP = 1485
    DELETE_USER = 1486
    DELETE_USER_RSP = 1487
    MODIFY_PASSWORD = 1488
    MODIFY_PASSWORD_RSP = 1489

    GUARD = 1500  # AlarmSet / arm
    GUARD_RSP = 1501
    UNGUARD = 1502
    UNGUARD_RSP = 1503
    ALARM_NOTIFY = 1504  # arrives unsolicited
    NET_ALARM = 1506
    NET_ALARM_RSP = 1507

    NET_KEYBOARD = 1550
    NET_KEYBOARD_RSP = 1551
    SNAPSHOT = 1560
    SNAPSHOT_RSP = 1561

    UPGRADE_INFO = 0x5F0
    UPGRADE_INFO_RSP = 0x5F1
    UPGRADE_SEND_FILE = 0x5F2
    UPGRADE_SEND_FILE_RSP = 0x5F3
    UPGRADE = 0x5F5
    UPGRADE_RSP = 0x5F6

    MAIL_TEST = 1636
    MAIL_TEST_RSP = 1637


#: Messages the device sends on its own, without a request.
UNSOLICITED = frozenset({Msg.ALARM_NOTIFY, Msg.FORCE_LOGOUT})

#: Messages whose payload is raw media rather than JSON.
#:
#: Media and JSON must NOT be told apart by payload content: the continuation of
#: a large keyframe starts with arbitrary compressed bytes, and ``{`` or ``[``
#: turn up among them. Such a chunk would be parsed as JSON and vanish from the
#: stream, leaving the demuxer out of sync. Route by msgid only.
MEDIA_MESSAGES = frozenset(
    {
        Msg.MONITOR_DATA,
        Msg.PLAY_DATA,
        Msg.DOWNLOAD_DATA,
        Msg.TALK_DATA,
    }
)


class Ret(IntEnum):
    """Result codes carried in the ``Ret`` field."""

    OK = 100
    UNKNOWN_ERROR = 101
    UNSUPPORTED_VERSION = 102
    ILLEGAL_REQUEST = 103
    ALREADY_LOGGED_IN = 104
    NOT_LOGGED_IN = 105
    BAD_CREDENTIALS = 106
    NO_PERMISSION = 107
    TIMEOUT = 108
    SEARCH_FAILED = 109
    SEARCH_OK_COMPLETE = 110
    SEARCH_OK_PARTIAL = 111
    USER_ALREADY_EXISTS = 112
    USER_NOT_EXISTS = 113
    GROUP_ALREADY_EXISTS = 114
    GROUP_NOT_EXISTS = 115
    ALGORITHM_ERROR = 124
    RESERVED_ACCOUNT = 202
    WRONG_PASSWORD = 203
    ACCOUNT_DISABLED = 204
    ACCOUNT_LOCKED = 205
    ILLEGAL_TIME = 206
    BLACKLISTED = 207
    NO_SUCH_CONFIG = 607
    UPGRADE_STARTED = 511
    UPGRADE_NOT_STARTED = 512
    UPGRADE_DATA_ERROR = 513
    UPGRADE_ERROR = 514
    UPGRADE_SUCCESS = 515


RET_MESSAGES: dict[int, str] = {
    100: "OK",
    101: "Unknown error",
    102: "Protocol version not supported",
    103: "Malformed request",
    104: "User already logged in",
    105: "User not logged in",
    106: "Wrong user name or password",
    107: "Not enough permissions",
    108: "Timed out",
    109: "Search failed",
    110: "Search complete, all results returned",
    111: "Search complete, partial results returned",
    112: "User already exists",
    113: "No such user",
    114: "Group already exists",
    115: "No such group",
    117: "Malformed message",
    118: "No permission for the PTZ protocol",
    121: "Could not parse the request",
    124: "Encryption algorithm error",
    202: "Reserved account is not authorised",
    203: "Wrong password",
    204: "Account disabled",
    205: "Account locked",
    206: "Time outside the allowed range",
    207: "Blacklisted",
    511: "Firmware upgrade started",
    512: "Upgrade did not start",
    513: "Upgrade data error",
    514: "Upgrade failed",
    515: "Upgrade succeeded",
    602: "Reboot required",
    603: "Configuration must be saved",
    604: "Invalid parameter value",
    605: "No such user",
    606: "Authentication error",
    607: "No such configuration section",
    608: "Configuration is locked",
}

#: Codes that mean success.
OK_CODES = frozenset({100, 110, 111, 515})


class StreamType:
    """Stream type for ``OPMonitor``."""

    MAIN = "Main"
    EXTRA1 = "Extra1"
    EXTRA2 = "Extra2"


class PtzCommand:
    """``OPPTZControl`` commands."""

    UP = "DirectionUp"
    DOWN = "DirectionDown"
    LEFT = "DirectionLeft"
    RIGHT = "DirectionRight"
    UP_LEFT = "DirectionLeftUp"
    UP_RIGHT = "DirectionRightUp"
    DOWN_LEFT = "DirectionLeftDown"
    DOWN_RIGHT = "DirectionRightDown"
    ZOOM_IN = "ZoomTile"
    ZOOM_OUT = "ZoomWide"
    FOCUS_NEAR = "FocusNear"
    FOCUS_FAR = "FocusFar"
    IRIS_OPEN = "IrisLarge"
    IRIS_CLOSE = "IrisSmall"
    STOP = "DirectionUp"  # used together with Stop=True
    GOTO_PRESET = "GotoPreset"
    SET_PRESET = "SetPreset"
    CLEAR_PRESET = "ClearPreset"
    START_TOUR = "StartTour"
    STOP_TOUR = "StopTour"


#: Root configuration containers. Reading a root returns every subsection in one
#: request, which is also the fastest way to learn what a given firmware supports
#: (see :meth:`~xmeye.client.XmeyeClient.config_tree`).
#:
#: Note that some leaves are readable ONLY through their root. On the NBD8008R-U
#: ``AVEnc.Encode`` returns ``Ret 607`` when asked for directly, even though the
#: key is present inside the ``AVEnc`` container.
CONFIG_ROOTS: tuple[str, ...] = (
    "AVEnc",
    "Ability",
    "Alarm",
    "BrowserLanguage",
    "Camera",
    "Detect",
    "Dev",
    "General",
    "Guide",
    "NetWork",
    "OEMcfg",
    "Record",
    "Snap",
    "Storage",
    "System",
    "Uart",
    "Video",
    "fVideo",
)

#: Configuration sections that are documented or known to work. Actual
#: availability depends on the model — see ``tools/discover.py``.
KNOWN_CONFIG_SECTIONS: tuple[str, ...] = (
    "AVEnc.CombineEncode",
    "AVEnc.Encode",
    "AVEnc.SmartH264",
    "AVEnc.VideoColor",
    "AVEnc.VideoWidget",
    "Alarm.AlarmOut",
    "Alarm.LocalAlarm",
    "Alarm.NetAbort",
    "Alarm.NetAlarm",
    "Alarm.NetIPConflict",
    "Alarm.PTZAlarmProtocol",
    "Camera",
    "Camera.Param",
    "Camera.ParamEx",
    "Detect.BlindDetect",
    "Detect.HumanDetection",
    "Detect.LossDetect",
    "Detect.MotionDetect",
    "Detect.VideoAnalyse",
    "Dev.ElectCapacity",
    "General",
    "General.AutoMaintain",
    "General.General",
    "General.Location",
    "NetWork",
    "NetWork.AlarmServer",
    "NetWork.ChnStatus",
    "NetWork.DigManagerShow",
    "NetWork.NetARSP",
    "NetWork.NetCommon",
    "NetWork.NetDDNS",
    "NetWork.NetDHCP",
    "NetWork.NetDNS",
    "NetWork.NetEmail",
    "NetWork.NetFTP",
    "NetWork.NetIPFilter",
    "NetWork.NetMobile",
    "NetWork.NetNTP",
    "NetWork.NetNat",
    "NetWork.NetPPPoE",
    "NetWork.NetRTSP",
    "NetWork.OnlineUpgrade",
    "NetWork.Upnp",
    "Record",
    "Simplify.Encode",
    "Storage",
    "Storage.Snapshot",
    "Storage.StorageFailure",
    "Storage.StorageLowSpace",
    "Storage.StorageNotExist",
    "Uart.Comm",
    "Uart.PTZ",
    "Uart.PTZPreset",
    "Uart.PTZTour",
    "Video.AudioInFormat",
    "Video.GUISet",
    "Video.Play",
    "Video.TVAdjust",
    "Video.Tour",
    "fVideo.GUISet",
    "fVideo.OSDInfo",
)

#: Sections read through ``Msg.SYSINFO`` (1020) rather than CONFIG_GET.
SYSINFO_SECTIONS: tuple[str, ...] = (
    "SystemInfo",
    "StorageInfo",
    "WorkState",
    "TimeZone",
)
