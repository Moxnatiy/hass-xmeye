"""A direct frame channel to the browser for the native player.

HLS in Home Assistant costs around fifteen seconds of latency: segmentation,
player buffer and network headroom all add up. For surveillance that is a lot.

Here frames reach the browser exactly as they came from the recorder, without
segmentation or repackaging, and WebCodecs decodes them in hardware. Latency
stays around a second, and Home Assistant spends no CPU at all: the server only
shuffles bytes.

Live video travels over a WebSocket, one connection for a whole wall, one record
per message::

    kind    1 byte   0 stream info, 1 frame, 3 a channel in trouble
    channel 2 bytes  LE
    flags   1 byte   bit 0 marks a keyframe
    length  4 bytes  LE
    stamp   8 bytes  LE double, milliseconds since the epoch
    payload          Annex-B frame, or JSON for the other two kinds

Each channel names its own stream in the message that asks for it, so a wall of
sub streams can carry a main-stream tile without a second connection.

The archive is the one thing still fetched over HTTP, and deliberately: playback
speed is set by the consumer reading slowly, and it is the response body's own
backpressure that holds the recorder back. A socket would have to grow a
flow-control protocol to replace what TCP already does there.
"""

from __future__ import annotations

import asyncio
import json
import logging
import struct
import time
from datetime import datetime
from http import HTTPStatus

from aiohttp import WSCloseCode, WSMsgType, web
from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant

from . import debuglog
from .const import DOMAIN, STREAM_MAIN
from .xmeyelib import ArchiveStream, LiveStream, StreamType, XmeyeError

_LOGGER = logging.getLogger(__name__)

_FRAME_HEADER = struct.Struct("<BId")

#: Multiplexed record: kind, channel, flags, payload length, timestamp.
#: Kind 0 carries a channel's JSON stream info, kind 1 a video frame. Sixteen
#: bytes, no padding, because the format string is little-endian throughout.
_MUX_HEADER = struct.Struct("<BHBId")
MUX_INFO, MUX_FRAME, MUX_ERROR = 0, 1, 3

#: How many records may wait for the writer before a channel starts shedding.
#: One socket carries every tile, so a camera that outruns the browser must not
#: be allowed to starve the others.
MUX_QUEUE = 240

#: How often the video socket pings. A wall is watched for hours without the
#: viewer touching anything, and an idle connection is what proxies reap.
WS_HEARTBEAT = 25.0

#: How long to wait for a frame before considering the stream dead.
FRAME_TIMEOUT = 20.0

#: How many times a channel is redialled before it is left alone.
#: A camera that is genuinely gone should stop costing the recorder a connection.
MUX_RETRIES = 4

#: Grows with each attempt, so a recorder that is out of connections is not
#: hammered while it recovers.
MUX_RETRY_DELAY = 3.0


class XmeyePlaybackView(HomeAssistantView):
    """The channel archive over the same frame stream as live viewing.

    Speed and pause are set by the consumer: it reads only as much as it can
    display, and the browser holds the connection back. The recorder feeds the
    archive at the same unhurried pace, so neither the server nor the browser
    runs out of memory.
    """

    url = "/api/xmeye/playback/{entry_id}/{channel}"
    name = "api:xmeye:playback"
    requires_auth = True

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass

    async def get(
        self, request: web.Request, entry_id: str, channel: str
    ) -> web.StreamResponse:
        coordinator = self.hass.data.get(DOMAIN, {}).get(entry_id)
        if coordinator is None:
            return web.Response(status=HTTPStatus.NOT_FOUND, text="Recorder not found")

        try:
            channel_index = int(channel)
            begin = datetime.fromisoformat(request.query["start"])
            end = datetime.fromisoformat(request.query["end"])
        except (ValueError, KeyError) as err:
            return web.Response(status=HTTPStatus.BAD_REQUEST, text=f"Invalid request: {err}")

        entry = coordinator.config_entry
        begin = begin.replace(tzinfo=None)
        end = end.replace(tzinfo=None)
        stream_index = 0 if request.query.get("stream", "main") == "main" else 1
        # ?fast=1 asks the recorder itself for a decimated fast-scan (Value=2):
        # the same frames spread across ~10x more recording time. It is the only
        # server-side fast-forward the protocol offers, and it stays fully
        # decodable, so the browser can pace it to any rate.
        value = 2 if request.query.get("fast") == "1" else 0

        # Playback has to go by file name, not by time. Asking the recorder for a
        # time range ignores the channel entirely — every ByTime request comes
        # back as channel 0, whatever Channel says — while a request naming a
        # recording plays that recording's channel correctly. Measured on the
        # device: Channel in Parameter, Channel in OPPlayBack, ChannelNo and a
        # channel bitmask all returned channel 0, and only ByName worked.
        try:
            async with coordinator.lock:
                records = await coordinator.client.search_files(
                    begin, end, channel=channel_index
                )
        except XmeyeError as err:
            return web.Response(status=HTTPStatus.BAD_GATEWAY, text=str(err))

        # A recording that started before the requested moment still holds it.
        wanted = sorted(
            (r for r in records if r.begin and r.end and r.end > begin and r.begin < end),
            key=lambda r: r.begin,
        )
        if not wanted:
            return web.Response(
                status=HTTPStatus.NOT_FOUND, text="No recordings in that range"
            )

        response = web.StreamResponse(
            status=HTTPStatus.OK,
            headers={
                "Content-Type": "application/octet-stream",
                "Cache-Control": "no-store",
                "X-Accel-Buffering": "no",
            },
        )

        sent_header = False
        frames = skipped = 0
        archive: ArchiveStream | None = None
        try:
            # One recording is one session, so playing across a stretch of the
            # day means walking the files in order.
            for record in wanted:
                archive = ArchiveStream(
                    entry.data["host"],
                    username=entry.data["username"],
                    password=entry.data["password"],
                    port=entry.data["port"],
                    channel=channel_index,
                )
                archive.stream_index = stream_index
                archive.value = value
                await archive.start()
                async for frame in archive.frames(record, timeout=25):
                    if not frame.is_video or not frame.has_valid_nal:
                        skipped += not frame.has_valid_nal
                        continue

                    if not sent_header:
                        if not frame.keyframe:
                            continue
                        header = json.dumps(
                            {
                                "codec": frame.codec,
                                "width": frame.width,
                                "height": frame.height,
                                "fps": frame.fps or 25,
                                "start": begin.isoformat(),
                                "end": end.isoformat(),
                            }
                        ).encode()
                        await response.prepare(request)
                        await response.write(len(header).to_bytes(4, "little") + header)
                        sent_header = True

                    stamp = (frame.timestamp or record.begin).timestamp() * 1000
                    await response.write(
                        _FRAME_HEADER.pack(
                            1 if frame.keyframe else 0, len(frame.payload), stamp
                        )
                        + frame.payload
                    )
                    frames += 1
                await archive.close()
                archive = None
        except (asyncio.CancelledError, ConnectionResetError):
            _LOGGER.debug("Archive playback for channel %s stopped by the client", channel_index)
        except XmeyeError as err:
            _LOGGER.warning("Archive playback for channel %s dropped: %s", channel_index, err)
            if not sent_header:
                return web.Response(status=HTTPStatus.BAD_GATEWAY, text=str(err))
        finally:
            if archive is not None:
                await archive.close()
            _LOGGER.debug(
                "Archive for channel %s: %d frames from %d recordings, %d service blocks dropped",
                channel_index,
                frames,
                len(wanted),
                skipped,
            )

        return response



class _VideoSession:
    """The channels one video socket is currently carrying.

    A wall is edited while it runs — a channel is switched off, another joins,
    the tiles are reordered. Rebuilding the connection for that would drop every
    camera to bring one back, so the set of channels is instead editable in
    place: each channel is a task feeding the shared queue, and adding or
    removing one leaves the others untouched.

    Each channel names its own stream, so one connection carries a wall of sub
    streams with a main-stream tile among them. Tying the stream type to the
    connection instead would mean a second connection for that one tile, which
    is the thing this exists to avoid.
    """

    def __init__(self, hass: HomeAssistant, entry, queue: asyncio.Queue) -> None:
        self.hass = hass
        self.entry = entry
        self.queue = queue
        self.pumps: dict[int, asyncio.Task] = {}
        self.streams: dict[int, StreamType] = {}

    def _note(self, source: str, detail: str) -> None:
        debuglog.note(self.hass, source, detail)

    @property
    def channels(self) -> set[int]:
        return set(self.pumps)

    def add(self, channel: int, stream: StreamType) -> None:
        if channel in self.pumps:
            return
        self.streams[channel] = stream
        self.pumps[channel] = asyncio.create_task(self._pump(channel))

    def drop(self, channel: int) -> None:
        task = self.pumps.pop(channel, None)
        self.streams.pop(channel, None)
        if task is not None:
            task.cancel()

    def set_channels(self, wanted: dict[int, StreamType]) -> None:
        # A channel whose stream type changed is dropped and dialled again: it is
        # a different stream from the recorder, not the same one adjusted.
        dropped = {
            channel
            for channel in self.channels
            if channel not in wanted or self.streams.get(channel) is not wanted[channel]
        }
        added = set(wanted) - (self.channels - dropped)
        for channel in dropped:
            self.drop(channel)
        for channel, stream in wanted.items():
            self.add(channel, stream)
        if dropped or added:
            _LOGGER.debug(
                "Video session now carries %s (added %s, dropped %s)",
                sorted(self.channels),
                sorted(added),
                sorted(dropped),
            )
            self._note(
                "mux",
                f"carries {sorted(self.channels)} "
                f"(added {sorted(added)}, dropped {sorted(dropped)})",
            )

    async def close(self) -> None:
        pumps = list(self.pumps.values())
        self.pumps.clear()
        for task in pumps:
            task.cancel()
        await asyncio.gather(*pumps, return_exceptions=True)

    async def _say(
        self,
        channel: int,
        reason: str,
        detail: str = "",
        attempt: int = 0,
        retry_in: float = 0.0,
    ) -> None:
        """Tell the browser why a tile is not showing anything.

        Without this a channel that goes quiet leaves its tile on "connecting"
        for as long as the page is open, while every other tile keeps playing —
        which reads as the whole integration having hung, and is the one failure
        the viewer cannot tell apart from a frozen picture.

        The reason travels as a word rather than a sentence: the wording belongs
        to the panel, which is written in the user's language, and the server has
        no business deciding it.
        """
        payload = json.dumps(
            {
                "channel": channel,
                "reason": reason,
                "detail": detail,
                "attempt": attempt,
                "retryIn": round(retry_in),
            }
        ).encode()
        await self.queue.put((MUX_ERROR, channel, 0, 0.0, payload))

    async def _pump(self, channel: int) -> None:
        """One channel, kept alive: a stream that ends or falls silent is redialled.

        The recorder drops a channel for its own reasons — it recycles the
        connection, the camera reboots, the link blinks. The stream simply ends,
        and before this the pump ended with it and the tile sat there forever.
        """
        for attempt in range(1, MUX_RETRIES + 2):
            detail = ""
            try:
                await self._carry(channel)
                reason = "ended"
            except asyncio.CancelledError:
                raise
            except TimeoutError:
                reason = "silent"
            except (XmeyeError, ConnectionResetError, OSError) as err:
                reason = "failed"
                detail = str(err) or err.__class__.__name__

            if attempt > MUX_RETRIES:
                _LOGGER.warning("Multiplex channel %s gave up: %s %s", channel, reason, detail)
                self._note(f"channel {channel}", f"gave up after {reason} {detail}".strip())
                await self._say(channel, reason, detail)
                return

            delay = MUX_RETRY_DELAY * attempt
            _LOGGER.debug(
                "Multiplex channel %s: %s %s; retry %d in %.0fs",
                channel,
                reason,
                detail,
                attempt,
                delay,
            )
            self._note(
                f"channel {channel}", f"{reason} {detail}; retry {attempt} in {delay:.0f}s".strip()
            )
            await self._say(channel, reason, detail, attempt, delay)
            await asyncio.sleep(delay)

    async def _carry(self, channel: int) -> None:
        """One connection's worth of frames, into the shared queue."""
        entry = self.entry
        stream = LiveStream(
            entry.data["host"],
            username=entry.data["username"],
            password=entry.data["password"],
            port=entry.data["port"],
            channel=channel,
            stream=self.streams.get(channel, StreamType.EXTRA1),
        )
        announced = False
        opened = time.monotonic()
        waited = 0
        try:
            await stream.start()
            frames = stream.frames()
            while True:
                # FRAME_TIMEOUT was declared for this and never applied here: a
                # silent channel used to hold its recorder connection open for as
                # long as the page stayed open, and the recorder has about ten to
                # give in total.
                async with asyncio.timeout(FRAME_TIMEOUT):
                    frame = await anext(frames, None)
                if frame is None:
                    return
                if not frame.is_video or not frame.has_valid_nal:
                    continue
                if not announced:
                    if not frame.keyframe:
                        # Nothing can be shown before one: a decoder is configured
                        # from a keyframe. How long that takes is the recorder's
                        # keyframe interval, and it is the usual reason one tile
                        # comes up seconds after another.
                        waited += 1
                        continue
                    _LOGGER.debug(
                        "Multiplex channel %s announced %sx%s %s after %.2fs "
                        "and %d frames waiting for a keyframe",
                        channel,
                        frame.width,
                        frame.height,
                        frame.codec,
                        time.monotonic() - opened,
                        waited,
                    )
                    self._note(
                        f"channel {channel}",
                        f"announced {frame.width}x{frame.height} {frame.codec} after "
                        f"{time.monotonic() - opened:.2f}s, {waited} frames waiting for a key",
                    )
                    info = json.dumps(
                        {
                            "channel": channel,
                            "codec": frame.codec,
                            "width": frame.width,
                            "height": frame.height,
                            "fps": frame.fps or 25,
                        }
                    ).encode()
                    await self.queue.put((MUX_INFO, channel, 0, 0.0, info))
                    announced = True

                stamp = (frame.timestamp or datetime.now()).timestamp() * 1000
                record = (
                    MUX_FRAME,
                    channel,
                    1 if frame.keyframe else 0,
                    stamp,
                    frame.payload,
                )
                try:
                    self.queue.put_nowait(record)
                except asyncio.QueueFull:
                    # The browser is behind. Dropping a delta frame leaves a gap
                    # the decoder recovers from at the next keyframe; blocking
                    # here would hold up every other camera.
                    if frame.keyframe:
                        await self.queue.put(record)
        finally:
            await stream.close()


class XmeyeWallSocketView(HomeAssistantView):
    """The wall over a WebSocket: frames out, channel changes in.

    The same records as the multiplexed response, on a connection that can be
    written to from both ends. That folds the separate control request back in —
    a browser cannot write into a request whose response it is still reading,
    which is why changing a channel needed one — and it costs a socket the
    browser counts against a limit of 255 rather than 6.

    One record per message, so nothing has to be reassembled at the other end:
    a WebSocket preserves message boundaries where a byte stream does not.

    Authorization arrives in the address, signed by Home Assistant, because a
    browser cannot put a header on a WebSocket.
    """

    url = "/api/xmeye/ws/{entry_id}"
    name = "api:xmeye:ws"
    requires_auth = True

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass

    async def get(self, request: web.Request, entry_id: str) -> web.WebSocketResponse:
        coordinator = self.hass.data.get(DOMAIN, {}).get(entry_id)
        socket = web.WebSocketResponse(heartbeat=WS_HEARTBEAT, max_msg_size=0)
        await socket.prepare(request)
        if coordinator is None:
            await socket.close(code=WSCloseCode.POLICY_VIOLATION, message=b"no recorder")
            return socket

        queue: asyncio.Queue[tuple[int, int, int, float, bytes]] = asyncio.Queue(MUX_QUEUE)
        session: _VideoSession | None = None
        writer: asyncio.Task | None = None
        sent = 0

        async def pump_to_socket() -> None:
            nonlocal sent
            while True:
                kind, channel, flags, stamp, payload = await queue.get()
                # Awaited, not fired and forgotten: this is where a browser that
                # reads slowly pushes back on us, and the queue above it is what
                # decides which frames to drop when it does.
                await socket.send_bytes(
                    _MUX_HEADER.pack(kind, channel, flags, len(payload), stamp) + payload
                )
                sent += 1

        try:
            debuglog.note(self.hass, "ws", "socket opened")
            async for message in socket:
                if message.type is not WSMsgType.TEXT:
                    continue
                try:
                    said = message.json()
                except ValueError:
                    continue

                try:
                    wanted = _parse_wanted(said.get("channels"))
                except (ValueError, TypeError, AttributeError):
                    continue
                if not wanted:
                    continue

                if session is None:
                    session = _VideoSession(self.hass, coordinator.config_entry, queue)
                    writer = asyncio.create_task(pump_to_socket())
                session.set_channels(wanted)
        except (asyncio.CancelledError, ConnectionResetError):
            _LOGGER.debug("Video socket for %s closed by the client", entry_id)
        finally:
            if writer is not None:
                writer.cancel()
                await asyncio.gather(writer, return_exceptions=True)
            if session is not None:
                await session.close()
            _LOGGER.debug("Video socket for %s: %d records", entry_id, sent)
            debuglog.note(self.hass, "ws", f"socket closed after {sent} records")

        return socket


class XmeyeDebugLogView(HomeAssistantView):
    """Where the panel files its own log, next to the server's.

    The panel knows things no server log can — when a canvas was adopted, when a
    decoder was configured, when a tile actually painted — and the server knows
    things the panel cannot see. Written apart, the two have to be aligned by
    hand across a window a few hundred milliseconds wide. Written together, the
    ordering simply reads off the page.

    ``POST`` ships a batch of entries; ``?on=1``/``?on=0`` turns the file on and
    off; ``GET`` hands the file back so it can be read without shell access.
    """

    url = "/api/xmeye/debug"
    name = "api:xmeye:debug"
    requires_auth = True

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass

    async def get(self, request: web.Request) -> web.Response:
        log = debuglog.get(self.hass)
        switch = request.query.get("on")
        if switch is not None:
            log.turn(switch == "1")
            return web.json_response({"enabled": log.enabled})

        return web.json_response(
            {
                "enabled": log.enabled,
                "text": await self.hass.async_add_executor_job(log.read_in_order),
            }
        )

    async def post(self, request: web.Request) -> web.Response:
        try:
            body = await request.json()
        except ValueError:
            return web.json_response({"error": "Invalid body"}, status=HTTPStatus.BAD_REQUEST)

        log = debuglog.get(self.hass)
        entries = body.get("entries")
        if not isinstance(entries, list):
            return web.json_response({"error": "No entries"}, status=HTTPStatus.BAD_REQUEST)
        # Off the event loop: this touches the disk, and it is called while a
        # wall is running.
        await self.hass.async_add_executor_job(
            log.note_client,
            entries,
            float(body.get("now") or 0.0),
            str(body.get("client") or "")[:8],
        )
        return web.json_response({"enabled": log.enabled, "written": len(entries)})


def _parse_wanted(raw) -> dict[int, StreamType]:
    """What the socket asked for: a stream type per channel.

    ``[{"channel": 0, "stream": "sub"}, {"channel": 3, "stream": "main"}]``.
    Anything unreadable raises, and the caller ignores that message rather than
    tearing down a working wall over one malformed line.
    """
    wanted: dict[int, StreamType] = {}
    for item in raw or []:
        channel = int(item["channel"])
        stream = StreamType.MAIN if item.get("stream") == STREAM_MAIN else StreamType.EXTRA1
        wanted[channel] = stream
    return wanted


def async_register_http(hass: HomeAssistant) -> None:
    """Register the endpoints once for the whole domain."""
    if hass.data.get(f"{DOMAIN}_http_registered"):
        return
    hass.data[f"{DOMAIN}_http_registered"] = True
    hass.http.register_view(XmeyePlaybackView(hass))
    hass.http.register_view(XmeyeWallSocketView(hass))
    hass.http.register_view(XmeyeDebugLogView(hass))
