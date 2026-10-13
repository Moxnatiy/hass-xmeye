# A virtual PTZ camera with sound

A camera to develop the integration's PTZ and audio against, when no real one
has either. It speaks ONVIF, so the recorder adds it as an IP channel like any
other camera, and every command then travels the real path: Home Assistant →
recorder → camera.

What it offers:

- **Pan, tilt and zoom you can see.** The picture is a window into a scene
  three views wide — a labelled grid, buildings on a horizon, compass marks and
  a car driving across — so a pan, a tilt and a zoom are each unmistakable, and
  the position is printed on the picture the way a camera's OSD would.
- **The ONVIF PTZ operations** a recorder uses: continuous move and stop,
  absolute and relative moves, presets, home position, status.
- **Sound.** G.711 A-law, 8 kHz: a 440 Hz tone with a higher beep once a
  second, so whether audio arrives — and whether it keeps in step with the
  picture — is easy to judge.
- **Discovery.** It answers WS-Discovery, so the recorder's search finds it.

Two streams, as a camera has: main at 1920×1080 and sub at 640×360, both H.264,
both with the audio track.

## How it is built

[IPyCam](https://github.com/olkham/IPyCam) (MIT) provides the ONVIF device,
media and PTZ services and WS-Discovery. Its own PTZ is digital — it crops the
frame it is given, so at the widest zoom panning moves nothing — so that is
switched off and `ptz_camera.py` draws the view from IPyCam's PTZ position
instead, as a real pan-tilt head would see it.

[go2rtc](https://github.com/AlexxIT/go2rtc) is the RTSP server. IPyCam pushes
the video into it, and `go2rtc.yaml` adds the audio as a second source of each
stream.

`ptz_camera.py` also fixes three things in IPyCam's ONVIF replies that a
recorder would trip over, each found by testing: the media profiles had no
audio configuration, GetProfile and the audio calls were not recognised without
a SOAPAction header — which SOAP 1.2 clients do not send — and no PTZ reply was
well-formed XML, because its namespace prefix was never declared. See the
`OnvifFixes` docstring.

## Setting up

Everything goes under `.local/onvif-sim/`, which git ignores.

```bash
mkdir -p .local/onvif-sim/bin
gh release download v1.9.14 --repo AlexxIT/go2rtc --pattern go2rtc_mac_arm64.zip --dir .local/onvif-sim
unzip -o .local/onvif-sim/go2rtc_mac_arm64.zip -d .local/onvif-sim/bin && rm .local/onvif-sim/go2rtc_mac_arm64.zip

# IPyCam from a reviewed commit, not from PyPI
git clone https://github.com/olkham/IPyCam.git .local/onvif-sim/IPyCam
git -C .local/onvif-sim/IPyCam checkout 0fce877
python3.13 -m venv .local/onvif-sim/venv
.local/onvif-sim/venv/bin/pip install .local/onvif-sim/IPyCam
```

## Running

```bash
tools/onvif_sim/run.sh
```

It advertises the machine's LAN address; `--ip` overrides it. The camera logs
to the terminal, go2rtc to `.local/onvif-sim/go2rtc.log`, and presets saved
through ONVIF are kept in `.local/onvif-sim/ptz_presets.json`.

| Port | What |
|---|---|
| 8080 | ONVIF (`/onvif/device_service`) and a small web UI |
| 8554 | RTSP: `video_main`, `video_sub` |
| 3702/udp | WS-Discovery |
| 1984, 1935 | go2rtc's API, and the RTMP push from IPyCam |

There is no login: it is a test device, and whatever user and password the
recorder sends are accepted.

## Adding it to the recorder

In the recorder's channel setup, search for ONVIF devices; the simulator shows
up as **PTZ Simulator** at the machine's address, port 8080. Add it with the
ONVIF protocol. Then tick the new channel in the integration's options — a
camera added to the recorder later is not picked up by itself.
