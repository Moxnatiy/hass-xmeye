"""Tests for parsing device responses.

The raw data comes from real NBD8008R-U replies (firmware V4.03.R11.061B0197).
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from xmeye.models import (
    DeviceInfo,
    Disk,
    NetworkInfo,
    RecordFile,
    WorkState,
    format_hex_ip,
    parse_hex_int,
    parse_hex_ip,
    parse_time,
)

SYSTEM_INFO = {
    "AlarmInChannel": 0,
    "AlarmOutChannel": 0,
    "AudioInChannel": 0,
    "BuildTime": "2022-08-29 15:09:23",
    "DeviceRunTime": "0x00124E52",
    "DeviceType": 4,
    "DigChannel": 32,
    "ExtraChannel": 0,
    "HardWare": "NBD8008R-U",
    "SerialNo": "0123456789abcdef",
    "SoftWareVersion": "V4.03.R11.061B0197.12001.130000.0000000",
    "TalkInChannel": 1,
    "TalkOutChannel": 1,
    "VideoInChannel": 0,
    "VideoOutChannel": 1,
}

NET_COMMON = {
    "GateWay": "0x0164A8C0",
    "HostIP": "0x0A01A8C0",
    "HostName": "LocalHost",
    "HttpPort": 80,
    "MAC": "00:11:22:33:44:55",
    "SSLPort": 8443,
    "Submask": "0x00FFFFFF",
    "TCPMaxConn": 10,
    "TCPPort": 34567,
    "UDPPort": 34568,
}


# ----------------------------------------------------------------------
# Primitives
# ----------------------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("0x0004A85C", 305244), ("0x00000000", 0), (42, 42), ("", 0), (None, 0)],
)
def test_parse_hex_int(raw: object, expected: int) -> None:
    assert parse_hex_int(raw) == expected


def test_parse_hex_ip_uses_reversed_byte_order() -> None:
    # 0x0A01A8C0 -> bytes 0A 01 A8 C0 in reverse order -> 192.168.1.10
    assert parse_hex_ip("0x0A01A8C0") == "192.168.1.10"
    assert parse_hex_ip("0x0164A8C0") == "192.168.100.1"
    assert parse_hex_ip("0x00FFFFFF") == "255.255.255.0"


def test_hex_ip_round_trip() -> None:
    for address in ("192.168.1.10", "10.0.0.1", "255.255.255.0", "0.0.0.0"):
        assert parse_hex_ip(format_hex_ip(address)) == address


def test_format_hex_ip_rejects_garbage() -> None:
    with pytest.raises(ValueError, match="IPv4"):
        format_hex_ip("not an address")


def test_parse_time_treats_zero_date_as_missing() -> None:
    assert parse_time("0000-00-00 00:00:00") is None
    assert parse_time("2026-08-09 15:54:26") == datetime(2026, 8, 9, 15, 54, 26)
    assert parse_time("garbage") is None


# ----------------------------------------------------------------------
# Models
# ----------------------------------------------------------------------


def test_device_info_parsing() -> None:
    info = DeviceInfo.from_raw(SYSTEM_INFO)
    assert info.hardware == "NBD8008R-U"
    assert info.serial_number == "0123456789abcdef"
    assert info.channels == 32  # an NVR reports its channels in DigChannel
    assert info.uptime == timedelta(seconds=0x124E52)
    assert info.build_time == datetime(2022, 8, 29, 15, 9, 23)
    assert info.supports_talk is True


def test_device_info_falls_back_to_analog_channel_count() -> None:
    info = DeviceInfo.from_raw({**SYSTEM_INFO, "DigChannel": 0, "VideoInChannel": 16})
    assert info.channels == 16


def test_network_info_parsing() -> None:
    net = NetworkInfo.from_raw(NET_COMMON)
    assert net.ip == "192.168.1.10"
    assert net.gateway == "192.168.100.1"
    assert net.netmask == "255.255.255.0"
    assert net.tcp_port == 34567
    assert net.max_connections == 10


def test_work_state_decodes_motion_bitmask() -> None:
    state = WorkState.from_raw(
        {
            "AlarmState": {"VideoMotion": "0x00000005", "VideoLoss": "0x00000000"},
            "ChannelState": [
                {"Bitrate": 3252, "Record": True},
                {"Bitrate": 0, "Record": False},
                {"Bitrate": 512, "Record": True},
            ],
        }
    )
    assert state.motion_channels() == [0, 2]
    assert [c.index for c in state.channels if c.recording] == [0, 2]
    assert state.channels[0].bitrate_kbps == 3252


def test_disk_drops_empty_partitions() -> None:
    disk = Disk.from_raw(
        0,
        {
            "PartNumber": 1,
            "Partition": [
                {
                    "TotalSpace": "0x0004A85C",
                    "RemainSpace": "0x00000000",
                    "IsCurrent": True,
                    "NewStartTime": "2026-07-26 14:49:22",
                    "NewEndTime": "2026-08-09 15:54:26",
                },
                {"TotalSpace": "0x00000000", "RemainSpace": "0x00000000"},
            ],
        },
    )
    assert len(disk.partitions) == 1
    part = disk.partitions[0]
    assert part.total_mb == 305244
    assert part.used_percent == 100.0
    assert part.newest_record == datetime(2026, 8, 9, 15, 54, 26)


def test_record_file_parses_name_and_size() -> None:
    item = RecordFile.from_raw(
        {
            "BeginTime": "2026-08-08 15:46:44",
            "EndTime": "2026-08-08 16:11:35",
            "FileLength": "0x00071CCD",
            "FileName": "/idea0/2026-08-08/001/15.46.44-16.11.35[R][@b78][0].h264",
            "DiskNo": 0,
            "SerialNo": 0,
        },
        channel=3,
    )
    assert item.event == "schedule"
    assert item.stream == 0
    assert item.channel == 3
    # FileLength is measured in kilobytes, verified against a real download
    assert item.size_kb == 466125
    assert item.size_bytes == 466125 * 1024
    assert item.duration == timedelta(minutes=24, seconds=51)


def test_record_file_recognises_motion_event() -> None:
    item = RecordFile.from_raw(
        {
            "FileName": "/idea0/2026-08-08/001/16.11.35-16.11.46[M][@c5c][1].h264",
            "BeginTime": "2026-08-08 16:11:35",
            "EndTime": "2026-08-08 16:11:46",
            "FileLength": "0x000020A6",
        }
    )
    assert item.event == "motion"
    assert item.stream == 1


def test_record_file_survives_unknown_name_format() -> None:
    item = RecordFile.from_raw({"FileName": "something new", "FileLength": "0x10"})
    assert item.event == ""
    assert item.size_kb == 16
    assert item.duration is None
