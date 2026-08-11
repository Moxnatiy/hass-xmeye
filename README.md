# XMeye / Xiongmai NVR for Home Assistant

[![hacs][hacs-badge]][hacs]
[![license][license-badge]](LICENSE)
[![ko-fi][kofi-badge]][kofi]

A local Home Assistant integration for recorders running Xiongmai firmware
(XMeye, NetSurveillance, and the many rebadges of it). It speaks DVRIP — the
"Sofia" protocol on TCP 34567 — directly, so it needs neither the `xmeye.net`
cloud nor ONVIF, which most of these devices do not have.

The repository holds two things that can be used separately:

| Path | What it is |
|---|---|
| [`src/xmeye/`](src/xmeye) | A dependency-free async Python client for the DVRIP protocol |
| [`custom_components/xmeye/`](custom_components/xmeye) | The Home Assistant integration, including its full-page panel |

Developed and verified against an **NBD8008R-U**, firmware
`V4.03.R11.061B0197`, on Home Assistant 2026.2.

---

## What it gives you

**A full-page panel** in the sidebar, in the spirit of the Energy dashboard: a
video wall, a channel grid with live thumbnails, an archive timeline for the
day broken down by event, the recorder's entire configuration tree, and its
system log.

**A video wall** with the layouts a recorder itself offers — 1, 2×2, 6 and 8
with a hero tile, 3×3, 4×4 — and a channel picker beside it for choosing which
cameras go up and in what order. Each tile is live video through WebCodecs on
the sub stream. The layout, the order and the selection are remembered.

**An archive player** with a timeline: click the scale to play from that
moment, the cursor follows the current frame, and there is pause, ±10 s
stepping and speeds from ×1 to ×16.

Up to ×2 the player paces the full stream on its own clock; at ×4 and above it
asks the recorder to thin the stream itself (a server-side fast-scan found by
probing the protocol) and paces that to the requested rate. The actual speed
reached is shown next to the requested one.

**Three ways to play**, switchable inside the viewer, with a technical line
under the picture (codec, resolution, frames per second, bitrate, dropped
frames, latency):

| Method | Latency | 4K H.265 | Note |
|---|---|---|---|
| Native (WebCodecs) | about a second | 20 fps, nothing lost | frames leave the recorder without repackaging |
| HLS | about 15 s | loses roughly a third of the frames | the stock Home Assistant path, works everywhere |
| Snapshots | — | — | the fallback; never smooth |

The stream (main or sub) switches on the fly in all three modes. To make that
possible each channel gets **two cameras**, one per stream; the one matching
the options stays primary and keeps its entity id.

The native player reads the codec profile and level **from the stream itself**
rather than guessing them from the resolution: Safari checks the claim against
reality and refuses to decode when they disagree. If the decoder still fails to
start, the player falls back to the smaller stream and then to snapshots
instead of showing a black screen.

### Entities

| Platform | What |
|---|---|
| `camera` | Live video per channel over RTSP, plus snapshots over DVRIP |
| `sensor` | Uptime, total bitrate, channels online, channels recording, disk used and free, archive bounds, recorder time, per-channel bitrate |
| `binary_sensor` | Recording, motion (overall and per channel), channel connected, video loss, blind, disk problem, alarm input |
| `switch` | Motion, blind and video-loss detection, per channel |
| `button` | Reboot, sync time |

### Services

`xmeye.ptz`, `xmeye.search_recordings`, `xmeye.download_recording`,
`xmeye.get_config`, `xmeye.set_config`, `xmeye.talk` — see
[docs/services.md](docs/services.md). `search_recordings` and `get_config`
return a response, which makes them convenient in templates and scripts.

---

## Installation

### HACS

Add this repository as a custom repository of type **Integration**, install it,
restart Home Assistant, then add the integration through
**Settings → Devices & services**.

### Manually

Copy `custom_components/xmeye` into your `config/custom_components` directory
and restart Home Assistant.

## Configuration

You need the recorder's address, a user and a password. The DVRIP (34567) and
RTSP (554) ports can be changed if yours are not standard.

The options flow selects the channels, the camera stream (**sub** by default,
since the main one is 4K and heavy to transcode), the snapshot stream, the
panel's default player and live stream, the polling interval, whether the panel
is shown, and the recorder's `TCPMaxConn` — the cap on how many streams run at
once (written back to the device; raising it above 10 is not honoured by every
firmware).

## Things worth knowing

- **Snapshots are expensive.** These recorders have no HTTP snapshot endpoint,
  and `OPSNAP` stays silent on the verified firmware, so a frame is taken from
  the video stream: a separate connection, a wait for a keyframe, and a
  transcode through ffmpeg. The result is cached for 10 seconds.
- **Connections are limited.** The recorder holds about ten at once
  (`TCPMaxConn`). There is one control session and every stream opens its own,
  so avoid a very short polling interval or a great many cameras on one page.
- **A camera added later does not appear by itself.** The channel list is chosen
  when the integration is set up, and a camera plugged into the recorder
  afterwards is not in it. Home Assistant raises a repair notice naming the new
  cameras; tick them in the integration options to get entities for them.
- **Channels count from zero** in services and entities, as in the protocol
  itself. RTSP URLs count from one, and the integration converts this for you.
- **The RTSP URL must be the native Xiongmai one.** The widespread Dahua-style
  form (`/cam/realmonitor?channel=N&subtype=M`) is accepted but its `subtype` is
  silently ignored, so the main 4K stream always comes back.
- **The password is stored in Home Assistant** and ends up in the camera's RTSP
  URL, as in any RTSP integration. The panel never sees it: video goes through
  the camera proxy.

## Example automation

```yaml
automation:
  - alias: Note motion recordings after dark
    triggers:
      - trigger: state
        entity_id: binary_sensor.d01_motion
        to: "on"
    conditions:
      - condition: sun
        after: sunset
    actions:
      - action: xmeye.search_recordings
        data:
          config_entry_id: !secret xmeye_entry
          channel: 0
          event: "M"
        response_variable: found
      - action: notify.persistent_notification
        data:
          message: "Motion recordings found: {{ found.count }}"
```

---

## Documentation

| Document | About |
|---|---|
| [docs/protocol.md](docs/protocol.md) | The DVRIP protocol as measured on a real device: packet format, message ids, frame container, and the traps |
| [docs/panel.md](docs/panel.md) | The panel: players, video wall, archive scrubbing, OSD and diagnostics |
| [docs/services.md](docs/services.md) | Service reference with examples |
| [docs/development.md](docs/development.md) | Development setup, the test suites, and the tools |

## Support

If this saved you an evening, you can [buy me a coffee][kofi]. Bug reports and
firmware reports from other Xiongmai models are just as welcome.

## License

MIT — see [LICENSE](LICENSE).

Not affiliated with Xiongmai. XMeye and NetSurveillance are trademarks of their
respective owners.

[hacs]: https://github.com/hacs/integration
[hacs-badge]: https://img.shields.io/badge/HACS-custom-41BDF5.svg
[license-badge]: https://img.shields.io/badge/license-MIT-blue.svg
[kofi]: https://ko-fi.com/shnal
[kofi-badge]: https://img.shields.io/badge/Ko--fi-support-FF5E5B.svg
