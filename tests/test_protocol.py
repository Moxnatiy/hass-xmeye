"""Transport layer tests: no real device, only a fake server."""

from __future__ import annotations

import asyncio
import json
import struct

import pytest

from xmeye.const import HEADER_SIZE, MAGIC, Msg
from xmeye.exceptions import DeviceSilent, NotConnected
from xmeye.protocol import (
    DvripConnection,
    Packet,
    build_packet,
    encode_json_payload,
    login_payload,
    sofia_hash,
)

_HEADER = struct.Struct("<BB2xIIBBHI")


# ----------------------------------------------------------------------
# Pure functions
# ----------------------------------------------------------------------


@pytest.mark.parametrize(
    ("password", "expected"),
    [
        ("", "tlJwpbo6"),  # the canonical vector: an empty password
        ("admin", "6QNMIQGe"),
        ("123456", "nTBCS19C"),
        ("tluafed", "OxhlwSG8"),
    ],
)
def test_sofia_hash(password: str, expected: str) -> None:
    assert sofia_hash(password) == expected


def test_sofia_hash_length_and_alphabet() -> None:
    value = sofia_hash("any password at all")
    assert len(value) == 8
    assert value.isalnum()


def test_login_payload_hashes_password() -> None:
    payload = login_payload("admin", "secret")
    assert payload["PassWord"] == sofia_hash("secret")
    assert payload["UserName"] == "admin"
    assert payload["EncryptType"] == "MD5"


def test_login_payload_accepts_ready_hash() -> None:
    payload = login_payload("admin", "tlJwpbo6", hashed=True)
    assert payload["PassWord"] == "tlJwpbo6"


def test_build_packet_layout() -> None:
    raw = build_packet(session=0x51, sequence=7, msgid=Msg.LOGIN, payload=b"abc")
    magic, version, session, sequence, total, current, msgid, length = _HEADER.unpack(
        raw[:HEADER_SIZE]
    )
    assert magic == MAGIC
    assert version == 0
    assert (session, sequence, msgid, length) == (0x51, 7, int(Msg.LOGIN), 3)
    assert (total, current) == (0, 0)
    assert raw[HEADER_SIZE:] == b"abc"


def test_encode_json_payload_terminator() -> None:
    raw = encode_json_payload({"Name": "X"})
    assert raw.endswith(b"\x0a\x00")
    assert json.loads(raw[:-2]) == {"Name": "X"}


def test_encode_json_payload_keeps_unicode() -> None:
    raw = encode_json_payload({"Name": "Küche 日本"})  # non-ASCII on purpose
    assert "Küche 日本".encode() in raw


def test_packet_json_strips_terminator() -> None:
    packet = Packet(session=1, sequence=0, msgid=1001, payload=b'{"Ret":100}\x0a\x00')
    assert packet.json() == {"Ret": 100}


def test_packet_json_tolerates_extra_nuls() -> None:
    packet = Packet(session=1, sequence=0, msgid=1001, payload=b'{"Ret":100}\x0a\x00\x00\x00')
    assert packet.json() == {"Ret": 100}


def test_media_is_detected_by_msgid_not_content() -> None:
    """Regression: a keyframe continuation may start with ``{`` and still be media."""
    chunk = Packet(session=1, sequence=0, msgid=Msg.MONITOR_DATA, payload=b'{\x9a\x00\xff')
    assert chunk.is_media
    assert chunk.looks_like_json  # which is why content is useless for routing

    reply = Packet(session=1, sequence=0, msgid=1001, payload=b'{"Ret":100}')
    assert not reply.is_media


# ----------------------------------------------------------------------
# Fake server
# ----------------------------------------------------------------------


class FakeDevice:
    """A minimal DVRIP server for checking how the client behaves."""

    def __init__(self) -> None:
        self.server: asyncio.AbstractServer | None = None
        self.port = 0
        self.received: list[Packet] = []
        #: msgid -> how many first requests to ignore (imitating a silent firmware)
        self.silent_for: dict[int, int] = {}
        #: msgid -> reply delay in seconds
        self.delay_for: dict[int, float] = {}
        #: payloads to send as media after the next reply
        self.media_payloads: list[bytes] = []

    async def start(self) -> None:
        self.server = await asyncio.start_server(self._handle, "127.0.0.1", 0)
        self.port = self.server.sockets[0].getsockname()[1]

    async def stop(self) -> None:
        if self.server is not None:
            self.server.close()
            await self.server.wait_closed()

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            while True:
                header = await reader.readexactly(HEADER_SIZE)
                _, _, session, sequence, _, _, msgid, length = _HEADER.unpack(header)
                payload = await reader.readexactly(length) if length else b""
                self.received.append(Packet(session, sequence, msgid, payload))

                if self.silent_for.get(msgid, 0) > 0:
                    self.silent_for[msgid] -= 1
                    continue
                if delay := self.delay_for.get(msgid):
                    await asyncio.sleep(delay)

                body: dict = {"Ret": 100, "SessionID": "0x00000051"}
                if msgid == Msg.LOGIN:
                    body |= {"AliveInterval": 21, "ChannelNum": 32, "DataUseAES": False}
                else:
                    request = json.loads(payload[:-2]) if length else {}
                    name = request.get("Name", "")
                    body["Name"] = name
                    if name:
                        body[name] = {"echo": name}
                # real firmware numbers its packets with its own counter; here
                # the two match because each request gets exactly one reply
                writer.write(
                    build_packet(0x51, sequence, msgid + 1, encode_json_payload(body))
                )
                for chunk in self.media_payloads:
                    writer.write(build_packet(0x51, 0, Msg.MONITOR_DATA, chunk))
                await writer.drain()
        except (asyncio.IncompleteReadError, ConnectionResetError):
            pass


@pytest.fixture
async def device():
    fake = FakeDevice()
    await fake.start()
    yield fake
    await fake.stop()


@pytest.fixture
async def conn(device: FakeDevice):
    connection = DvripConnection(host="127.0.0.1", port=device.port, timeout=1.0)
    await connection.connect()
    yield connection
    await connection.close()


async def test_request_returns_matching_response(conn: DvripConnection) -> None:
    reply = await conn.request_json(Msg.LOGIN, login_payload("admin", ""))
    assert reply["Ret"] == 100
    assert conn.session == 0x51


async def test_session_is_adopted_from_response(conn: DvripConnection) -> None:
    await conn.request_json(Msg.LOGIN, login_payload("admin", ""))
    await conn.request_json(Msg.CONFIG_GET, {"Name": "General.Location"})
    # the client must put the received SessionID into subsequent packets
    assert conn.session == 0x51


async def test_sequence_increments_per_request(conn: DvripConnection, device: FakeDevice) -> None:
    await conn.request_json(Msg.LOGIN, login_payload("admin", ""))
    await conn.request_json(Msg.CONFIG_GET, {"Name": "A"})
    await conn.request_json(Msg.CONFIG_GET, {"Name": "B"})
    assert [p.sequence for p in device.received] == [0, 1, 2]


async def test_silent_request_raises_device_silent(
    conn: DvripConnection, device: FakeDevice
) -> None:
    device.silent_for[Msg.CONFIG_GET] = 1
    with pytest.raises(DeviceSilent):
        await conn.request_json(Msg.CONFIG_GET, {"Name": "Detect"}, timeout=0.2)


async def test_timeout_marks_connection_desynced(
    conn: DvripConnection, device: FakeDevice
) -> None:
    """After a timeout the connection cannot be trusted.

    DVRIP has no correlation identifier: a late reply to an abandoned request is
    indistinguishable from the reply to the next one. So the transport does not
    try to sort it out; it raises a flag and the client reconnects.
    """
    assert not conn.desynced
    device.delay_for[Msg.CONFIG_GET] = 0.3
    with pytest.raises(DeviceSilent):
        await conn.request_json(Msg.CONFIG_GET, {"Name": "Slow"}, timeout=0.05)
    assert conn.desynced


async def test_reconnect_clears_desync(conn: DvripConnection, device: FakeDevice) -> None:
    device.silent_for[Msg.CONFIG_GET] = 1
    with pytest.raises(DeviceSilent):
        await conn.request_json(Msg.CONFIG_GET, {"Name": "Nope"}, timeout=0.1)
    assert conn.desynced

    await conn.close()
    await conn.connect()
    assert not conn.desynced
    reply = await conn.request_json(Msg.CONFIG_GET, {"Name": "Works"}, timeout=1.0)
    assert reply["Name"] == "Works"


async def test_media_chunk_starting_with_brace_is_not_parsed_as_json(
    conn: DvripConnection, device: FakeDevice
) -> None:
    """Regression: a keyframe chunk starting with ``{`` must reach the media queue.

    This is exactly where data used to be lost: routing by payload content sent
    roughly every 128th chunk into the JSON parser and the demuxer lost sync.
    """
    await conn.request_json(Msg.LOGIN, login_payload("admin", ""))
    conn.enable_media()
    device.media_payloads = [b"{\x9a\x00\xff" * 4, b"[\x01\x02\x03" * 4]
    await conn.request_json(Msg.CONFIG_GET, {"Name": "StartStream"})

    got = [await conn.next_media(timeout=1.0) for _ in range(2)]
    assert [p.payload for p in got if p] == device.media_payloads


async def test_request_after_close_raises(conn: DvripConnection) -> None:
    await conn.close()
    with pytest.raises(NotConnected):
        await conn.request_json(Msg.KEEPALIVE, {"Name": "KeepAlive"})


async def test_unsolicited_packet_goes_to_handler(device: FakeDevice) -> None:
    events: list[Packet] = []
    connection = DvripConnection(
        host="127.0.0.1", port=device.port, timeout=1.0, on_event=events.append
    )
    await connection.connect()
    try:
        # a packet with someone else's sequence number must satisfy no request
        await connection.request_json(Msg.LOGIN, login_payload("admin", ""))
        writer = connection._writer  # noqa: SLF001 - deliberate, this tests the transport
        assert writer is not None
        connection._dispatch(  # noqa: SLF001
            Packet(0x51, 999, Msg.ALARM_NOTIFY, encode_json_payload({"Name": "AlarmInfo"}))
        )
        assert events and events[0].msgid == Msg.ALARM_NOTIFY
    finally:
        await connection.close()


# ----------------------------------------------------------------------
# Client behaviour on top of the transport
# ----------------------------------------------------------------------


async def test_client_reconnects_after_timeout(device: FakeDevice) -> None:
    """The client must bring the connection back up after the device goes silent."""
    from xmeye import XmeyeClient

    client = XmeyeClient(
        "127.0.0.1", port=device.port, password="", timeout=0.15, keepalive=False
    )
    await client.login()
    try:
        device.silent_for[Msg.CONFIG_GET] = 1
        with pytest.raises(DeviceSilent):
            await client.get_config("Detect")
        assert client.reconnects == 0  # healing is deferred until the next command

        value = await client.get_config("General.Location")
        assert value == {"echo": "General.Location"}
        assert client.reconnects == 1
        assert not client._conn.desynced  # noqa: SLF001
    finally:
        await client.close()


async def test_client_survives_several_silent_sections(device: FakeDevice) -> None:
    """Walking unknown sections must not break the session; the first attempt did."""
    from xmeye import XmeyeClient

    client = XmeyeClient(
        "127.0.0.1", port=device.port, password="", timeout=0.15, keepalive=False
    )
    await client.login()
    try:
        for _ in range(3):
            device.silent_for[Msg.CONFIG_GET] = 1
            with pytest.raises(DeviceSilent):
                await client.get_config("Silent")
            assert await client.get_config("Alive") == {"echo": "Alive"}
        assert client.reconnects == 3
    finally:
        await client.close()
