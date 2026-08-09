"""DVRIP / Sofia transport layer.

Packet layout (little-endian, 20-byte header)::

    offset  size  field
    0       1     0xFF
    1       1     version (0)
    2       2     reserved
    4       4     SessionID
    8       4     sequence number
    12      1     total packets in the reply
    13      1     index of this packet
    14      2     message id
    16      4     payload length
    20      N     payload (JSON + b"\\n\\x00", or raw media)
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import struct
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from typing import Any

from .const import (
    DEFAULT_PORT,
    HEADER_SIZE,
    MAGIC,
    MEDIA_MESSAGES,
    PAYLOAD_TERMINATOR,
    SOFIA_HASH_ALPHABET,
    UNSOLICITED,
    Msg,
)
from .exceptions import ConnectionFailed, DeviceSilent, NotConnected, ProtocolError

_LOGGER = logging.getLogger(__name__)

_HEADER = struct.Struct("<BB2xIIBBHI")

#: Largest payload we are willing to accept, as a guard against garbage.
MAX_PAYLOAD = 64 * 1024 * 1024

#: Value of ``expect`` that accepts a reply with any msgid.
ANY_MESSAGE = 0


def sofia_hash(password: str) -> str:
    """Compute the eight-character Sofia password hash.

    The MD5 of the password is folded pairwise: each pair of bytes is summed,
    taken modulo 62, and used to index the ``0-9A-Za-z`` alphabet.

    >>> sofia_hash("")
    'tlJwpbo6'
    """
    digest = hashlib.md5(password.encode("utf-8")).digest()
    return "".join(
        SOFIA_HASH_ALPHABET[(digest[i] + digest[i + 1]) % 62] for i in range(0, 16, 2)
    )


@dataclass(slots=True)
class Packet:
    """A single DVRIP packet."""

    session: int
    sequence: int
    msgid: int
    payload: bytes
    total: int = 1
    current: int = 0

    @property
    def is_media(self) -> bool:
        """Whether the payload is raw media.

        Decided by msgid alone; payload content is unusable for this.
        """
        return self.msgid in MEDIA_MESSAGES

    @property
    def looks_like_json(self) -> bool:
        """Rough content check. For diagnostics only, never for routing."""
        return self.payload.lstrip()[:1] in (b"{", b"[")

    def json(self) -> Any:
        """Parse the payload as JSON.

        The device terminates JSON with ``\\n\\x00``, and some firmware appends
        extra NUL bytes; all of that is stripped.
        """
        raw = self.payload.rstrip(b"\x00").rstrip(b"\n").rstrip(b"\x00")
        if not raw:
            return {}
        try:
            return json.loads(raw.decode("utf-8", errors="replace"))
        except json.JSONDecodeError as err:
            raise ProtocolError(
                f"Malformed JSON in message {self.msgid}: {raw[:200]!r}"
            ) from err


def build_packet(session: int, sequence: int, msgid: int, payload: bytes) -> bytes:
    """Build a complete packet for sending."""
    return _HEADER.pack(MAGIC, 0, session, sequence, 0, 0, msgid, len(payload)) + payload


def encode_json_payload(data: Any) -> bytes:
    """Serialise a JSON payload the way the device expects it."""
    text = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    return text.encode("utf-8") + PAYLOAD_TERMINATOR


@dataclass
class _Pending:
    """A request awaiting its reply."""

    sequence: int
    expected: int | None
    future: asyncio.Future[Packet]


@dataclass
class DvripConnection:
    """An asynchronous connection to the device.

    One request at a time, serialised by an ``asyncio.Lock``. A background task
    reads packets and routes them: replies to futures, unsolicited messages
    (alarms, forced logout) to ``on_event``, binary media to a queue.
    """

    host: str
    port: int = DEFAULT_PORT
    timeout: float = 10.0
    connect_timeout: float = 5.0
    on_event: Callable[[Packet], None] | None = None

    session: int = 0
    _reader: asyncio.StreamReader | None = field(default=None, repr=False)
    _writer: asyncio.StreamWriter | None = field(default=None, repr=False)
    _sequence: int = field(default=0, repr=False)
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock, repr=False)
    _pending: _Pending | None = field(default=None, repr=False)
    _reader_task: asyncio.Task | None = field(default=None, repr=False)
    _media_queue: asyncio.Queue[Packet | None] | None = field(default=None, repr=False)
    _closing: bool = field(default=False, repr=False)
    _desynced: bool = field(default=False, repr=False)
    #: How many media packets had to be dropped because the consumer lagged.
    dropped_media: int = field(default=0, repr=False)

    @property
    def connected(self) -> bool:
        return self._writer is not None and not self._writer.is_closing()

    @property
    def desynced(self) -> bool:
        """Whether the connection lost trust after a timeout.

        While this is set, any reply may belong to an abandoned request. The
        correct response is to reconnect.
        """
        return self._desynced

    async def connect(self) -> None:
        """Open the TCP connection and start the background reader."""
        if self.connected:
            return
        self._closing = False
        try:
            self._reader, self._writer = await asyncio.wait_for(
                asyncio.open_connection(self.host, self.port, limit=MAX_PAYLOAD),
                timeout=self.connect_timeout,
            )
        except (TimeoutError, OSError) as err:
            raise ConnectionFailed(f"Could not connect to {self.host}:{self.port}: {err}") from err
        self._sequence = 0
        self._desynced = False
        self._reader_task = asyncio.create_task(
            self._read_loop(), name=f"xmeye-reader-{self.host}"
        )
        _LOGGER.debug("Connected to %s:%s", self.host, self.port)

    async def close(self) -> None:
        """Close the connection and stop the background task."""
        self._closing = True
        if self._reader_task is not None:
            self._reader_task.cancel()
            try:
                await self._reader_task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001 - ignored while closing
                pass
            self._reader_task = None
        if self._writer is not None:
            try:
                self._writer.close()
                await self._writer.wait_closed()
            except (OSError, asyncio.CancelledError):
                pass
        self._reader = self._writer = None
        self._fail_pending(NotConnected("Connection closed"))
        if self._media_queue is not None:
            self._media_queue.put_nowait(None)

    # ------------------------------------------------------------------
    # Reading
    # ------------------------------------------------------------------

    async def _read_packet(self) -> Packet:
        assert self._reader is not None
        header = await self._reader.readexactly(HEADER_SIZE)
        magic, _version, session, sequence, total, current, msgid, length = _HEADER.unpack(
            header
        )
        if magic != MAGIC:
            raise ProtocolError(f"Bad magic byte: 0x{magic:02X}")
        if length > MAX_PAYLOAD:
            raise ProtocolError(f"Declared payload length is too large: {length}")
        payload = await self._reader.readexactly(length) if length else b""
        return Packet(
            session=session,
            sequence=sequence,
            msgid=msgid,
            payload=payload,
            total=total,
            current=current,
        )

    async def _read_loop(self) -> None:
        try:
            while True:
                packet = await self._read_packet()
                if packet.session:
                    self.session = packet.session
                self._dispatch(packet)
        except asyncio.CancelledError:
            raise
        except (asyncio.IncompleteReadError, ConnectionResetError, OSError) as err:
            if not self._closing:
                _LOGGER.debug("Connection to %s dropped: %s", self.host, err)
            self._fail_pending(ConnectionFailed(f"Connection dropped: {err}"))
            if self._media_queue is not None:
                self._media_queue.put_nowait(None)
        except ProtocolError as err:
            _LOGGER.warning("Protocol error from %s: %s", self.host, err)
            self._fail_pending(err)

    def _dispatch(self, packet: Packet) -> None:
        pending = self._pending
        # Correlation is only possible by msgid: DVRIP carries no request id.
        # The sequence number does NOT mirror ours — the firmware keeps its own
        # counter, which matches only while every request gets exactly one
        # reply. On OPMonitor the two diverge.
        answers_pending = (
            pending is not None
            and not pending.future.done()
            and (pending.expected is None or packet.msgid == pending.expected)
        )
        if answers_pending:
            if packet.sequence != pending.sequence:
                _LOGGER.debug(
                    "Sequence number diverged: sent %d, received %d",
                    pending.sequence,
                    packet.sequence,
                )
            self._pending = None
            pending.future.set_result(packet)
            return

        # Only msgid decides whether this is media; see the MEDIA_MESSAGES note.
        if self._media_queue is not None and packet.msgid in MEDIA_MESSAGES:
            try:
                self._media_queue.put_nowait(packet)
            except asyncio.QueueFull:
                # The consumer is behind. For live video a fresh frame beats a stale
                # one, so make room by discarding the oldest packet.
                try:
                    self._media_queue.get_nowait()
                    self._media_queue.put_nowait(packet)
                except (asyncio.QueueEmpty, asyncio.QueueFull):
                    pass
                self.dropped_media += 1
                if self.dropped_media % 100 == 1:
                    _LOGGER.warning(
                        "Media consumer is behind, packets dropped: %d", self.dropped_media
                    )
            return

        if packet.msgid in UNSOLICITED or self.on_event is not None:
            if self.on_event is not None:
                try:
                    self.on_event(packet)
                except Exception:  # noqa: BLE001 - a user callback must not kill the reader
                    _LOGGER.exception("Event handler raised")
            return

        _LOGGER.debug(
            "Packet with no recipient: msgid=%s len=%s", packet.msgid, len(packet.payload)
        )

    def _fail_pending(self, err: Exception) -> None:
        pending, self._pending = self._pending, None
        if pending is not None and not pending.future.done():
            pending.future.set_exception(err)

    # ------------------------------------------------------------------
    # Requests
    # ------------------------------------------------------------------

    async def send(self, msgid: int, payload: Any = b"") -> int:
        """Send a packet without waiting for a reply. Returns the sequence number used."""
        if not self.connected:
            raise NotConnected("Not connected")
        assert self._writer is not None
        raw = payload if isinstance(payload, (bytes, bytearray)) else encode_json_payload(payload)
        sequence = self._sequence
        self._writer.write(build_packet(self.session, sequence, msgid, bytes(raw)))
        self._sequence += 1
        await self._writer.drain()
        return sequence

    async def request(
        self,
        msgid: int,
        payload: Any = b"",
        *,
        expect: int | None = None,
        timeout: float | None = None,
    ) -> Packet:
        """Send a request and wait for its reply.

        By default ``msgid + 1`` is expected, which is how the device numbers
        replies. Pass ``expect=ANY_MESSAGE`` to accept any msgid: a few commands
        (``OPMonitor``, ``OPPlayBack``) do not follow that rule.
        """
        if not self.connected:
            raise NotConnected("Not connected")
        expected = msgid + 1 if expect is None else expect
        async with self._lock:
            loop = asyncio.get_running_loop()
            future: asyncio.Future[Packet] = loop.create_future()
            # Register the pending request BEFORE sending: the reply can arrive
            # before we return from await drain().
            self._pending = _Pending(
                sequence=self._sequence, expected=expected or None, future=future
            )
            try:
                await self.send(msgid, payload)
                return await asyncio.wait_for(future, timeout or self.timeout)
            except TimeoutError as err:
                # The protocol has no correlation id, so after a timeout there is
                # no way to tell "no reply is coming" from "the reply is late". A
                # late reply would be handed to the next request as its own, so the
                # only honest option is to treat the connection as desynchronised.
                self._desynced = True
                raise DeviceSilent(
                    f"Device did not answer message {msgid} within {timeout or self.timeout}s"
                ) from err
            finally:
                if self._pending is not None and self._pending.future is future:
                    self._pending = None

    async def request_json(
        self,
        msgid: int,
        payload: Any = b"",
        *,
        expect: int | None = None,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """Same as :meth:`request`, but parses the JSON reply."""
        packet = await self.request(msgid, payload, expect=expect, timeout=timeout)
        data = packet.json()
        if not isinstance(data, dict):
            raise ProtocolError(f"Expected a JSON object, got {type(data).__name__}")
        return data

    # ------------------------------------------------------------------
    # Media stream
    # ------------------------------------------------------------------

    def enable_media(self, maxsize: int = 1024) -> None:
        """Start collecting raw (non-JSON) packets into a queue.

        Call this BEFORE the command that starts the stream, or the first
        packets are lost.
        """
        self._media_queue = asyncio.Queue(maxsize=maxsize)
        self.dropped_media = 0

    def disable_media(self) -> None:
        """Stop collecting media packets and wake the reader."""
        if self._media_queue is not None:
            self._media_queue.put_nowait(None)

    async def next_media(self, timeout: float | None = None) -> Packet | None:
        """Wait for the next media packet.

        Returns ``None`` when the stream ends or ``timeout`` expires.
        """
        queue = self._media_queue
        if queue is None:
            raise NotConnected("Call enable_media() first")
        if timeout is None:
            return await queue.get()
        try:
            return await asyncio.wait_for(queue.get(), timeout)
        except TimeoutError:
            return None

    async def media_packets(self) -> AsyncIterator[Packet]:
        """Iterate raw packets: video, audio, archive download.

        Requires a prior :meth:`enable_media`. Ends when the connection closes
        or :meth:`disable_media` is called.
        """
        queue = self._media_queue
        if queue is None:
            raise NotConnected("Call enable_media() first")
        while True:
            packet = await queue.get()
            if packet is None:
                return
            yield packet


def login_payload(username: str, password: str, *, hashed: bool = False) -> dict[str, str]:
    """Build the payload for :attr:`Msg.LOGIN`."""
    return {
        "EncryptType": "MD5",
        "LoginType": "DVRIP-Web",
        "PassWord": password if hashed else sofia_hash(password),
        "UserName": username,
    }


__all__ = [
    "DvripConnection",
    "Msg",
    "Packet",
    "build_packet",
    "encode_json_payload",
    "login_payload",
    "sofia_hash",
]
