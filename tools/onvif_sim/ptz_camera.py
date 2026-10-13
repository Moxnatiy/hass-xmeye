#!/usr/bin/env python3
"""A virtual ONVIF PTZ camera with sound, for testing the recorder's PTZ path.

    tools/onvif_sim/run.sh

There is no PTZ camera, and no camera with a microphone, to develop against, so
this is one. It is meant to be added to the recorder as an IP channel like any
other camera, so that the integration can be built and tested against the real
path — Home Assistant → recorder → camera — rather than against a stub.

The ONVIF side (device, media, PTZ services and WS-Discovery) is IPyCam
(github.com/olkham/IPyCam, MIT). Its own PTZ is digital: it crops the frame it
is given, so at the widest zoom the crop is the whole frame and panning moves
nothing. That would make a pan test look broken. So the cropping is switched
off and IPyCam is used only for the protocol and for keeping the PTZ position;
this script draws what a real pan-tilt head would see: a window into a scene
much wider than the view, which pans and tilts at any zoom.

The scene is a labelled grid with compass marks along the horizon and a car
driving across it, so that a pan, a tilt and a zoom are each unmistakable, and
the position is printed on the picture the way a real camera's OSD would. The
sound — a tone with a beep every second — is mixed in by go2rtc; see
go2rtc.yaml beside this file.
"""

from __future__ import annotations

import argparse
import logging
import re
import signal
import socket
import time

import cv2
import numpy as np
from ipycam import CameraConfig, IPCamera

#: The scene the camera looks into. Three views wide at the widest zoom, so a
#: pan has somewhere to go before it is zoomed at all.
WORLD_W, WORLD_H = 7680, 2880

#: How much of the scene the widest view takes, and how far the zoom goes.
#: Beyond four times the drawn scene runs out of detail and turns to blocks.
BASE_VIEW_W = 2560
MAX_ZOOM = 4.0

COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]

#: The audio the stream carries, as ONVIF describes it. go2rtc.yaml produces
#: exactly this: G.711 A-law, 8 kHz, mono, so 64 kbit/s.
AUDIO_SOURCE = """<tt:AudioSourceConfiguration token="ASC_1">
            <tt:Name>AudioSource_1</tt:Name>
            <tt:UseCount>2</tt:UseCount>
            <tt:SourceToken>AS_1</tt:SourceToken>
        </tt:AudioSourceConfiguration>"""

AUDIO_ENCODER = """<tt:AudioEncoderConfiguration token="AEC_1">
            <tt:Name>G711</tt:Name>
            <tt:UseCount>2</tt:UseCount>
            <tt:Encoding>G711</tt:Encoding>
            <tt:Bitrate>64</tt:Bitrate>
            <tt:SampleRate>8</tt:SampleRate>
            <tt:Multicast>
                <tt:Address><tt:Type>IPv4</tt:Type><tt:IPv4Address>0.0.0.0</tt:IPv4Address></tt:Address>
                <tt:Port>0</tt:Port>
                <tt:TTL>1</tt:TTL>
                <tt:AutoStart>false</tt:AutoStart>
            </tt:Multicast>
            <tt:SessionTimeout>PT60S</tt:SessionTimeout>
        </tt:AudioEncoderConfiguration>"""


def operation(action: str, body: str) -> str:
    """The ONVIF operation a request asks for, exactly.

    IPyCam takes it from the SOAPAction header, and without one searches the
    body for any of a fixed list of names. SOAP 1.2 — which is what recorders
    speak — carries no SOAPAction header at all, and the list leaves out
    GetProfile and every audio call, so those came back as unsupported. The
    operation is simply the first element inside the Body.
    """
    if action:
        return re.split(r"[/#]", action)[-1]
    found = re.search(r"<(?:\w+:)?Body[^>]*>\s*<(?:\w+:)?(\w+)", body)
    return found.group(1) if found else ""


#: PTZ requests written to the log as they arrive.
PTZ_LOGGED = {
    "ContinuousMove", "Stop", "AbsoluteMove", "RelativeMove",
    "GotoPreset", "SetPreset", "RemovePreset", "GotoHomePosition",
}

#: Prefixes IPyCam's PTZ replies use without declaring them.
PTZ_NAMESPACE = "http://www.onvif.org/ver20/ptz/wsdl"


class OnvifFixes:
    """What IPyCam's ONVIF service needs before a recorder will accept it.

    Three things, each found by asking the simulator what a recorder asks:

    - **Audio.** The RTSP stream carries G.711 (see go2rtc.yaml), but a
      recorder learns that a camera has sound from the media profile, not from
      the stream: a profile without an audio source and encoder reads as a
      camera without a microphone. The profiles gain both, in the place the
      schema puts them — firmware parses these strictly, in order — and the
      calls that ask about audio get answers instead of faults.
    - **The operation name.** See ``operation``: without a SOAPAction header,
      GetProfile and the audio calls were never recognised.
    - **The PTZ namespace.** Every PTZ reply writes ``ptz:`` or ``tptz:``
      elements inside an envelope that declares neither, so none of them was
      well-formed XML. A lenient client reads past that; a recorder's parser
      need not. The declarations are added to the envelope.
    """

    def __init__(self, onvif) -> None:
        self.onvif = onvif
        self.original = onvif.handle_action
        onvif.handle_action = self.handle_action

    def handle_action(self, action: str, body: str):
        name = operation(action, body)
        answer = {
            "GetAudioSources": self._sources,
            "GetAudioSourceConfigurations": lambda: self._wrap(
                "GetAudioSourceConfigurationsResponse",
                AUDIO_SOURCE.replace("tt:AudioSourceConfiguration ", "trt:Configurations ", 1)
                .replace("</tt:AudioSourceConfiguration>", "</trt:Configurations>")),
            "GetAudioSourceConfiguration": lambda: self._wrap(
                "GetAudioSourceConfigurationResponse",
                AUDIO_SOURCE.replace("tt:AudioSourceConfiguration ", "trt:Configuration ", 1)
                .replace("</tt:AudioSourceConfiguration>", "</trt:Configuration>")),
            "GetAudioEncoderConfigurations": lambda: self._wrap(
                "GetAudioEncoderConfigurationsResponse",
                AUDIO_ENCODER.replace("tt:AudioEncoderConfiguration ", "trt:Configurations ", 1)
                .replace("</tt:AudioEncoderConfiguration>", "</trt:Configurations>")),
            "GetAudioEncoderConfiguration": lambda: self._wrap(
                "GetAudioEncoderConfigurationResponse",
                AUDIO_ENCODER.replace("tt:AudioEncoderConfiguration ", "trt:Configuration ", 1)
                .replace("</tt:AudioEncoderConfiguration>", "</trt:Configuration>")),
            "GetAudioEncoderConfigurationOptions": self._encoder_options,
            "GetProfile": lambda: self._profile(body),
        }.get(name)
        if answer is not None:
            return answer()
        if name in PTZ_LOGGED:
            # What the recorder actually asks of the camera, which is the only
            # way to see what it makes of the commands sent to it over DVRIP.
            detail = " ".join(
                f"{k}={v}" for k, v in re.findall(r'\b(x|y|space)="([^"]*)"', body)
                if k != "space"
            )
            timeout = re.search(r"<(?:\w+:)?Timeout>([^<]+)<", body)
            logging.getLogger("ptz").info(
                "%s %s%s", name, detail, f" timeout={timeout.group(1)}" if timeout else ""
            )
        response = self.original(name or action, body)
        if name == "GetProfiles" and response:
            response = self._with_audio(response)
        return self._declare_ptz(response) if response else response

    @staticmethod
    def _declare_ptz(xml: str) -> str:
        if "<ptz:" not in xml and "<tptz:" not in xml:
            return xml
        declarations = "".join(
            f' xmlns:{prefix}="{PTZ_NAMESPACE}"'
            for prefix in ("ptz", "tptz")
            if f"xmlns:{prefix}=" not in xml
        )
        return re.sub(r"<s:Envelope\b", "<s:Envelope" + declarations, xml, count=1)

    @staticmethod
    def _with_audio(xml: str) -> str:
        # Schema order: VideoSource, AudioSource, VideoEncoder, AudioEncoder, ..., PTZ.
        xml = xml.replace("</tt:VideoSourceConfiguration>",
                          "</tt:VideoSourceConfiguration>\n        " + AUDIO_SOURCE)
        return xml.replace("</tt:VideoEncoderConfiguration>",
                           "</tt:VideoEncoderConfiguration>\n        " + AUDIO_ENCODER)

    def _profile(self, body: str) -> str:
        token = re.search(r"<(?:\w+:)?ProfileToken>\s*([^<\s]+)", body)
        profiles = self._with_audio(self.original("GetProfiles", ""))
        wanted = token.group(1) if token else "Profile_Main"
        found = re.search(
            rf'<trt:Profiles token="{re.escape(wanted)}".*?</trt:Profiles>', profiles, re.S
        )
        if not found:
            return self.onvif.fault(f"No such profile: {wanted}")
        profile = found.group(0).replace("<trt:Profiles ", "<trt:Profile ", 1)
        profile = profile[: -len("</trt:Profiles>")] + "</trt:Profile>"
        return self._wrap("GetProfileResponse", profile)

    def _sources(self) -> str:
        return self._wrap(
            "GetAudioSourcesResponse",
            '<trt:AudioSources token="AS_1"><tt:Channels>1</tt:Channels></trt:AudioSources>',
        )

    def _encoder_options(self) -> str:
        return self._wrap(
            "GetAudioEncoderConfigurationOptionsResponse",
            "<trt:Options><tt:Options>"
            "<tt:Encoding>G711</tt:Encoding>"
            "<tt:BitrateList><tt:Items>64</tt:Items></tt:BitrateList>"
            "<tt:SampleRateList><tt:Items>8</tt:Items></tt:SampleRateList>"
            "</tt:Options></trt:Options>",
        )

    def _wrap(self, element: str, inner: str) -> str:
        return self.onvif._wrap_envelope(f"<trt:{element}>{inner}</trt:{element}>")


def lan_address() -> str:
    """The address the recorder will reach this machine on.

    Picked by asking the kernel which interface would carry traffic outward,
    which avoids a VPN interface — a Tailscale address in a stream URI is one
    the recorder cannot open.
    """
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("192.168.0.1", 9))
        return probe.getsockname()[0]
    finally:
        probe.close()


def build_world() -> np.ndarray:
    """The scene, drawn once."""
    world = np.zeros((WORLD_H, WORLD_W, 3), np.uint8)
    horizon = int(WORLD_H * 0.55)

    # Sky and ground as gradients, so even a featureless patch shows which way
    # is up when zoomed in.
    sky = np.linspace(0, 1, horizon)[:, None]
    sky_bgr = np.stack([150 + 70 * sky, 90 + 60 * sky, 40 + 40 * sky], -1)
    world[:horizon] = sky_bgr.astype(np.uint8)
    ground = np.linspace(0, 1, WORLD_H - horizon)[:, None]
    ground_bgr = np.stack([40 + 20 * ground, 70 + 30 * ground, 50 + 20 * ground], -1)
    world[horizon:] = ground_bgr.astype(np.uint8)

    # A fine grid: the thing a zoom is judged by.
    for x in range(0, WORLD_W, 160):
        cv2.line(world, (x, 0), (x, WORLD_H), (255, 255, 255), 1)
    for y in range(0, WORLD_H, 160):
        cv2.line(world, (0, y), (WORLD_W, y), (255, 255, 255), 1)
    world[:] = cv2.addWeighted(world, 0.85, np.zeros_like(world), 0.15, 0)

    # Buildings along the horizon, deterministic so a restart looks the same.
    rng = np.random.default_rng(7)
    x = 0
    while x < WORLD_W:
        width = int(rng.integers(140, 420))
        height = int(rng.integers(200, 700))
        colour = tuple(int(c) for c in rng.integers(60, 200, 3))
        cv2.rectangle(world, (x, horizon - height), (x + width, horizon), colour, -1)
        for wy in range(horizon - height + 30, horizon - 30, 60):
            for wx in range(x + 20, x + width - 30, 50):
                if rng.random() > 0.35:
                    cv2.rectangle(world, (wx, wy), (wx + 22, wy + 30), (90, 220, 250), -1)
        x += width + int(rng.integers(20, 120))
    cv2.line(world, (0, horizon), (WORLD_W, horizon), (230, 230, 230), 4)

    # Cells labelled like a map, so a position can be read off the picture.
    font = cv2.FONT_HERSHEY_DUPLEX
    for col in range(12):
        for row in range(4):
            label = f"{chr(ord('A') + col)}{row + 1}"
            cx, cy = col * 640 + 320, row * 720 + 360
            at = (cx - 110, cy + 50)
            cv2.putText(world, label, at, font, 5.0, (0, 0, 0), 22, cv2.LINE_AA)
            cv2.putText(world, label, at, font, 5.0, (255, 255, 255), 8, cv2.LINE_AA)

    # Compass marks across the top: which way the head is pointing.
    for index, mark in enumerate(COMPASS):
        cx = int((index + 0.5) * WORLD_W / len(COMPASS))
        cv2.putText(world, mark, (cx - 80, 230), font, 6.0, (20, 20, 120), 26, cv2.LINE_AA)
        cv2.putText(world, mark, (cx - 80, 230), font, 6.0, (60, 200, 255), 10, cv2.LINE_AA)
    return world


class Scene:
    """What a pan-tilt head standing in the world would see."""

    def __init__(self, width: int, height: int) -> None:
        self.width, self.height = width, height
        self.world = build_world()
        self.started = time.monotonic()

    def view(self, pan: float, tilt: float, zoom: float) -> np.ndarray:
        factor = 1.0 + max(0.0, min(1.0, zoom)) * (MAX_ZOOM - 1.0)
        view_w = BASE_VIEW_W / factor
        view_h = view_w * self.height / self.width
        # Pan runs across the scene, tilt up and down it; +1 tilt is up.
        cx = view_w / 2 + (pan + 1) / 2 * (WORLD_W - view_w)
        cy = view_h / 2 + (1 - tilt) / 2 * (WORLD_H - view_h)
        x0, y0 = int(cx - view_w / 2), int(cy - view_h / 2)
        crop = self.world[y0 : y0 + int(view_h), x0 : x0 + int(view_w)].copy()
        self._draw_car(crop, x0, y0)
        frame = cv2.resize(crop, (self.width, self.height), interpolation=cv2.INTER_LINEAR)
        self._osd(frame, pan, tilt, factor)
        return frame

    def _draw_car(self, crop: np.ndarray, x0: int, y0: int) -> None:
        """Something that moves, so a frozen stream is told from a still scene."""
        t = time.monotonic() - self.started
        x = int((t * 400) % (WORLD_W + 400)) - 200
        y = int(WORLD_H * 0.55) + 260
        lx, ly = x - x0, y - y0
        cv2.rectangle(crop, (lx, ly), (lx + 260, ly + 90), (40, 40, 220), -1)
        cv2.rectangle(crop, (lx + 50, ly - 60), (lx + 200, ly), (40, 40, 200), -1)
        for wheel in (lx + 55, lx + 205):
            cv2.circle(crop, (wheel, ly + 90), 32, (20, 20, 20), -1)

    def _osd(self, frame: np.ndarray, pan: float, tilt: float, factor: float) -> None:
        font = cv2.FONT_HERSHEY_SIMPLEX
        line = f"P {pan:+.2f}  T {tilt:+.2f}  Z {factor:.1f}x"
        for text, origin in (("PTZ SIMULATOR", (24, 52)), (line, (24, self.height - 64))):
            cv2.putText(frame, text, origin, font, 1.3, (0, 0, 0), 6, cv2.LINE_AA)
            cv2.putText(frame, text, origin, font, 1.3, (255, 255, 255), 2, cv2.LINE_AA)


def slow_down(ptz: object, sweep: float) -> None:
    """Turn at the pace of a real head rather than IPyCam's.

    IPyCam moves one unit a second at full speed, and pan and tilt span two, so
    the view crossed the whole scene in two seconds. That is far faster than a
    real pan-tilt head, and too fast to test against: a watchdog that stops the
    camera after a second and a half could not be told apart from the end stop.
    Every continuous move is scaled so that full speed takes ``sweep`` seconds
    from one end to the other.
    """
    original = ptz.continuous_move
    scale = 2.0 / sweep

    def continuous_move(pan_speed: float = 0.0, tilt_speed: float = 0.0,
                        zoom_speed: float = 0.0) -> None:
        original(pan_speed * scale, tilt_speed * scale, zoom_speed * scale)

    ptz.continuous_move = continuous_move


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--ip", default=None, help="address to advertise (default: the LAN one)")
    parser.add_argument("--name", default="PTZ Simulator")
    parser.add_argument("--fps", type=int, default=15)
    parser.add_argument("--sweep", type=float, default=8.0,
                        help="seconds to pan end to end at full speed (default 8)")
    args = parser.parse_args()
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )

    config = CameraConfig(
        name=args.name,
        manufacturer="xmeyeDVR",
        model="PTZ-SIM-1",
        serial_number="SIM-0001",
        local_ip=args.ip or lan_address(),
        main_width=1920,
        main_height=1080,
        main_fps=args.fps,
        main_bitrate="4M",
        sub_width=640,
        sub_height=360,
        sub_fps=args.fps,
        sub_bitrate="768K",  # IPyCam reads only an upper-case K or M
        source_type="generated",
        source_info="pan-tilt scene",
    )
    camera = IPCamera(config)
    # IPyCam keeps the position and answers the protocol; the picture is drawn
    # here, from that position. See the module docstring for why.
    camera.ptz.enable_digital_ptz = False
    slow_down(camera.ptz, args.sweep)
    OnvifFixes(camera.onvif)

    scene = Scene(config.main_width, config.main_height)
    if not camera.start():
        logging.error("the camera did not start")
        return 1
    logging.info("ONVIF device service: http://%s:%s/onvif/device_service",
                 config.local_ip, config.onvif_port)

    stopping = False

    def stop(*_: object) -> None:
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)

    period = 1.0 / args.fps
    next_at = time.monotonic()
    try:
        while camera.is_running and not stopping:
            state = camera.ptz.state
            camera.stream(scene.view(state.pan, state.tilt, state.zoom))
            next_at += period
            time.sleep(max(0.0, next_at - time.monotonic()))
            if time.monotonic() - next_at > 1.0:      # fell behind: do not try to catch up
                next_at = time.monotonic()
    finally:
        camera.stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
