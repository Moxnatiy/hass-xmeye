"""A direct frame channel to the browser for the native player.

HLS in Home Assistant costs around fifteen seconds of latency: segmentation,
player buffer and network headroom all add up. For surveillance that is a lot.

Here frames reach the browser exactly as they came from the recorder, without
segmentation or repackaging, and WebCodecs decodes them in hardware. Latency
stays around a second, and Home Assistant spends no CPU at all: the server only
shuffles bytes.

Wire format::

    header: 4-byte length (LE) + JSON {codec, width, height, fps}
    frames: 1 flags byte (bit 0 marks a keyframe)
            4-byte payload length (LE)
            8-byte timestamp, milliseconds since the epoch (LE double)
            Annex-B payload
"""

from __future__ import annotations

import asyncio
import json
import logging
import secrets
import struct
import time
from datetime import datetime
from http import HTTPStatus

from aiohttp import web
from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant

from .const import DOMAIN, STREAM_MAIN
from .xmeyelib import ArchiveStream, LiveStream, StreamType, XmeyeError

_LOGGER = logging.getLogger(__name__)

_FRAME_HEADER = struct.Struct("<BId")

#: Multiplexed record: kind, channel, flags, payload length, timestamp.
#: Kind 0 carries a channel's JSON stream info, kind 1 a video frame. Sixteen
#: bytes, no padding, because the format string is little-endian throughout.
_MUX_HEADER = struct.Struct("<BHBId")
MUX_INFO, MUX_FRAME, MUX_HELLO = 0, 1, 2

#: Where live multiplex sessions are found by the endpoint that edits them.
MUX_SESSIONS = f"{DOMAIN}_mux_sessions"

#: How many records may wait for the writer before a channel starts shedding.
#: One socket carries every tile, so a camera that outruns the browser must not
#: be allowed to starve the others.
MUX_QUEUE = 240

#: How long to wait for a frame before considering the stream dead.
FRAME_TIMEOUT = 20.0


class XmeyeNativeStreamView(HomeAssistantView):
    """Channel frames as a continuous binary stream."""

    url = "/api/xmeye/native/{entry_id}/{channel}"
    name = "api:xmeye:native"
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
        except ValueError:
            return web.Response(status=HTTPStatus.BAD_REQUEST, text="Invalid channel")

        wanted = request.query.get("stream", "sub")
        entry = coordinator.config_entry
        stream = LiveStream(
            entry.data["host"],
            username=entry.data["username"],
            password=entry.data["password"],
            port=entry.data["port"],
            channel=channel_index,
            stream=StreamType.MAIN if wanted == STREAM_MAIN else StreamType.EXTRA1,
        )

        response = web.StreamResponse(
            status=HTTPStatus.OK,
            headers={
                "Content-Type": "application/octet-stream",
                "Cache-Control": "no-store",
                # Proxies must not buffer this stream.
                "X-Accel-Buffering": "no",
            },
        )

        sent_header = False
        frames = 0
        skipped = 0
        try:
            await stream.start()
            async for frame in stream.frames():
                if not frame.is_video:
                    continue
                # The recorder mixes service blocks into the stream, labelled as
                # delta frames. Some decoders skip them, others treat the frame as
                # corrupt and stop, so they are not forwarded at all.
                if not frame.has_valid_nal:
                    skipped += 1
                    continue

                if not sent_header:
                    if not frame.keyframe:
                        continue  # the decoder needs a keyframe first
                    header = json.dumps(
                        {
                            "codec": frame.codec,
                            "width": frame.width,
                            "height": frame.height,
                            "fps": frame.fps or 25,
                        }
                    ).encode()
                    await response.prepare(request)
                    await response.write(len(header).to_bytes(4, "little") + header)
                    sent_header = True

                stamp = (frame.timestamp or datetime.now()).timestamp() * 1000
                await response.write(
                    _FRAME_HEADER.pack(1 if frame.keyframe else 0, len(frame.payload), stamp)
                    + frame.payload
                )
                frames += 1
        except (asyncio.CancelledError, ConnectionResetError):
            # the browser closed the tab, which is a normal ending
            _LOGGER.debug("Native stream for channel %s closed by the client", channel_index)
        except XmeyeError as err:
            _LOGGER.warning("Native stream for channel %s dropped: %s", channel_index, err)
            if not sent_header:
                return web.Response(status=HTTPStatus.BAD_GATEWAY, text=str(err))
        finally:
            await stream.close()
            _LOGGER.debug(
                "Native stream for channel %s: %d frames sent, %d service blocks dropped",
                channel_index,
                frames,
                skipped,
            )

        return response


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



class _MuxSession:
    """The channels one multiplexed response is currently carrying.

    A wall is edited while it runs — a channel is switched off, another joins,
    the tiles are reordered. Rebuilding the response for that would drop every
    camera to bring one back, so the set of channels is instead editable in
    place: each channel is a task feeding the shared queue, and adding or
    removing one leaves the others untouched.
    """

    def __init__(self, entry, stream_type: StreamType, queue: asyncio.Queue) -> None:
        self.entry = entry
        self.stream_type = stream_type
        self.queue = queue
        self.pumps: dict[int, asyncio.Task] = {}

    @property
    def channels(self) -> set[int]:
        return set(self.pumps)

    def add(self, channel: int) -> None:
        if channel in self.pumps:
            return
        self.pumps[channel] = asyncio.create_task(self._pump(channel))

    def drop(self, channel: int) -> None:
        task = self.pumps.pop(channel, None)
        if task is not None:
            task.cancel()

    def set_channels(self, channels: list[int]) -> None:
        dropped = self.channels - set(channels)
        added = set(channels) - self.channels
        for channel in dropped:
            self.drop(channel)
        for channel in channels:
            self.add(channel)
        if dropped or added:
            _LOGGER.debug(
                "Multiplex session now carries %s (added %s, dropped %s)",
                sorted(self.channels),
                sorted(added),
                sorted(dropped),
            )

    async def close(self) -> None:
        pumps = list(self.pumps.values())
        self.pumps.clear()
        for task in pumps:
            task.cancel()
        await asyncio.gather(*pumps, return_exceptions=True)

    async def _pump(self, channel: int) -> None:
        """One channel: its own recorder connection, into the shared queue."""
        entry = self.entry
        stream = LiveStream(
            entry.data["host"],
            username=entry.data["username"],
            password=entry.data["password"],
            port=entry.data["port"],
            channel=channel,
            stream=self.stream_type,
        )
        announced = False
        opened = time.monotonic()
        waited = 0
        try:
            await stream.start()
            async for frame in stream.frames():
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
        except (asyncio.CancelledError, ConnectionResetError):
            raise
        except XmeyeError as err:
            _LOGGER.debug("Multiplexed channel %s stopped: %s", channel, err)
        finally:
            await stream.close()


class XmeyeMultiplexView(HomeAssistantView):
    """Every requested channel over a single HTTP response.

    A browser allows six connections per host on HTTP/1.1 — the limit is a
    constant in Chromium's socket pool — so a wall of sixteen cameras opened as
    sixteen streams leaves ten of them queued forever. The frames are ours to
    frame, so they can share one response and one connection instead, with the
    channel named in each record.

    The cost is a shared pipe: if the browser reads slowly every tile slows
    together, where separate connections would stall one at a time. For a wall
    that is the better failure — even degradation beats six alive and ten dead.

    The first record names a session id, which the companion control endpoint
    uses to edit the channel set while the response keeps running.
    """

    url = "/api/xmeye/native/{entry_id}"
    name = "api:xmeye:native:mux"
    requires_auth = True

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass

    async def get(self, request: web.Request, entry_id: str) -> web.StreamResponse:
        coordinator = self.hass.data.get(DOMAIN, {}).get(entry_id)
        if coordinator is None:
            return web.Response(status=HTTPStatus.NOT_FOUND, text="Recorder not found")

        try:
            channels = _parse_channels(request.query.get("channels", ""))
        except ValueError:
            return web.Response(status=HTTPStatus.BAD_REQUEST, text="Invalid channels")
        if not channels:
            return web.Response(status=HTTPStatus.BAD_REQUEST, text="No channels requested")

        wanted = request.query.get("stream", "sub")
        stream_type = StreamType.MAIN if wanted == STREAM_MAIN else StreamType.EXTRA1

        response = web.StreamResponse(
            status=HTTPStatus.OK,
            headers={
                "Content-Type": "application/octet-stream",
                "Cache-Control": "no-store",
                "X-Accel-Buffering": "no",
            },
        )
        await response.prepare(request)

        queue: asyncio.Queue[tuple[int, int, int, float, bytes]] = asyncio.Queue(MUX_QUEUE)
        session = _MuxSession(coordinator.config_entry, stream_type, queue)
        token = secrets.token_urlsafe(12)
        self.hass.data.setdefault(MUX_SESSIONS, {})[token] = session
        sent = 0

        try:
            hello = json.dumps({"session": token}).encode()
            await response.write(_MUX_HEADER.pack(MUX_HELLO, 0, 0, len(hello), 0.0) + hello)
            session.set_channels(channels)
            while True:
                kind, channel, flags, stamp, payload = await queue.get()
                await response.write(
                    _MUX_HEADER.pack(kind, channel, flags, len(payload), stamp) + payload
                )
                sent += 1
        except (asyncio.CancelledError, ConnectionResetError):
            _LOGGER.debug("Multiplexed stream for %s closed by the client", entry_id)
        finally:
            self.hass.data.get(MUX_SESSIONS, {}).pop(token, None)
            await session.close()
            _LOGGER.debug("Multiplexed stream for %s: %d records", entry_id, sent)

        return response


class XmeyeMultiplexControlView(HomeAssistantView):
    """Edit the channel set of a running multiplexed response.

    A browser cannot write to a request whose response it is already reading,
    so the change arrives on its own short request naming the session — the same
    split the vendor app uses. What comes back is the set the session now holds.
    """

    url = "/api/xmeye/native/{entry_id}/mux"
    name = "api:xmeye:native:mux:control"
    requires_auth = True

    async def post(self, request: web.Request, entry_id: str) -> web.Response:
        try:
            body = await request.json()
        except ValueError:
            return web.json_response({"error": "Invalid body"}, status=HTTPStatus.BAD_REQUEST)

        session = request.app["hass"].data.get(MUX_SESSIONS, {}).get(body.get("session"))
        if session is None:
            # The response it belonged to is gone; the client reopens instead.
            return web.json_response({"error": "Unknown session"}, status=HTTPStatus.NOT_FOUND)

        try:
            channels = _parse_channels(body.get("channels", ""))
        except (ValueError, TypeError):
            return web.json_response({"error": "Invalid channels"}, status=HTTPStatus.BAD_REQUEST)
        if not channels:
            return web.json_response({"error": "No channels"}, status=HTTPStatus.BAD_REQUEST)

        session.set_channels(channels)
        return web.json_response({"channels": sorted(session.channels)})


def _parse_channels(raw) -> list[int]:
    """Channel numbers from a comma-separated string or a list, in order."""
    parts = raw.split(",") if isinstance(raw, str) else raw
    seen: list[int] = []
    for part in parts:
        if part == "":
            continue
        index = int(part)
        if index not in seen:
            seen.append(index)
    return seen


def async_register_http(hass: HomeAssistant) -> None:
    """Register the endpoints once for the whole domain."""
    if hass.data.get(f"{DOMAIN}_http_registered"):
        return
    hass.data[f"{DOMAIN}_http_registered"] = True
    hass.http.register_view(XmeyeNativeStreamView(hass))
    hass.http.register_view(XmeyePlaybackView(hass))
    hass.http.register_view(XmeyeMultiplexView(hass))
    hass.http.register_view(XmeyeMultiplexControlView())
