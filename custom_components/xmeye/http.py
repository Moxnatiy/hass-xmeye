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
import struct
from datetime import datetime
from http import HTTPStatus

from aiohttp import web
from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant

from .const import DOMAIN, STREAM_MAIN
from .xmeyelib import ArchiveStream, LiveStream, StreamType, XmeyeError

_LOGGER = logging.getLogger(__name__)

_FRAME_HEADER = struct.Struct("<BId")

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
        archive = ArchiveStream(
            entry.data["host"],
            username=entry.data["username"],
            password=entry.data["password"],
            port=entry.data["port"],
            channel=channel_index,
        )
        # Scrub speed is bounded by how fast the recorder feeds the archive, and
        # the protocol has no fast-forward command of its own.
        archive.stream_index = 0 if request.query.get("stream", "main") == "main" else 1

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
        try:
            await archive.start()
            async for frame in archive.frames(
                "", begin=begin.replace(tzinfo=None), end=end.replace(tzinfo=None),
                by_time=True, timeout=25,
            ):
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

                stamp = (frame.timestamp or begin).timestamp() * 1000
                await response.write(
                    _FRAME_HEADER.pack(1 if frame.keyframe else 0, len(frame.payload), stamp)
                    + frame.payload
                )
                frames += 1
        except (asyncio.CancelledError, ConnectionResetError):
            _LOGGER.debug("Archive playback for channel %s stopped by the client", channel_index)
        except XmeyeError as err:
            _LOGGER.warning("Archive playback for channel %s dropped: %s", channel_index, err)
            if not sent_header:
                return web.Response(status=HTTPStatus.BAD_GATEWAY, text=str(err))
        finally:
            await archive.close()
            _LOGGER.debug(
                "Archive for channel %s: %d frames sent, %d service blocks dropped",
                channel_index,
                frames,
                skipped,
            )

        return response


def async_register_http(hass: HomeAssistant) -> None:
    """Register the endpoints once for the whole domain."""
    if hass.data.get(f"{DOMAIN}_http_registered"):
        return
    hass.data[f"{DOMAIN}_http_registered"] = True
    hass.http.register_view(XmeyeNativeStreamView(hass))
    hass.http.register_view(XmeyePlaybackView(hass))
