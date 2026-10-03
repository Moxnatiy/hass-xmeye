<div align="center">

# XMeye / Xiongmai NVR for Home Assistant

**A local integration for recorders running Xiongmai firmware —<br>
a live video wall, a scrubbable archive and the recorder's own settings,<br>
with no cloud account and no ONVIF.**

[![HACS][hacs-badge]][hacs]
[![Release][release-badge]][releases]
[![Tests][tests-badge]][tests]
[![License][license-badge]](LICENSE)
[![Ko-fi][kofi-badge]][kofi]

<img src="https://raw.githubusercontent.com/Moxnatiy/hass-xmeye/main/docs/images/wall.jpg"
     alt="The video wall: four cameras in a 2×2 layout, with the channel list beside it"
     width="800">

</div>

Xiongmai firmware sits inside a great many recorders sold under other names —
XMeye, NetSurveillance, and countless rebadges. Most have no ONVIF and expect
you to use a phone app through a vendor cloud. This integration talks to the
recorder directly instead, in its own **DVRIP** protocol ("Sofia", TCP 34567),
so everything stays on your network.

> Screenshots use placeholder imagery in place of camera video.

---

## Highlights

- **A video wall that holds up.** Every tile travels on **one WebSocket**, so a
  wall of sixteen cameras does not run into the browser's six-connections-per-host
  limit. Tiles are added, removed, reordered and switched between main and sub
  stream **without reconnecting the others**.
- **About a second of latency.** Frames go from the recorder straight into the
  browser's hardware decoder through WebCodecs — no segmenting, no repackaging,
  and no work for Home Assistant beyond moving bytes.
- **An archive you can actually aim at.** A day's recordings on a timeline that
  **zooms down to a minute** with the scroll wheel. A click starts playback **at
  that exact second**, ×1 to ×8, and the buttons **jump from one event to the
  next** — motion starting, motion ending.
- **The recorder's settings, as a form.** Motion, blind and video-loss detection
  per channel, overlays, disks, network time and more — typed fields instead of
  raw JSON, and the whole configuration tree when you do want the raw view.
- **Five languages.** English, Ukrainian, Spanish, French and German, following
  Home Assistant's language setting.
- **Works on a phone.** Home Assistant's own top bar and menu button, and a
  channel list that folds away so the wall gets the width.

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="https://raw.githubusercontent.com/Moxnatiy/hass-xmeye/main/docs/images/archive.jpg"
           alt="The archive: player, speed controls and a timeline zoomed to two hours">
      <p align="center"><sub><b>Archive</b> — two hours across the bar, playing at the second you clicked</sub></p>
    </td>
    <td width="50%" valign="top">
      <img src="https://raw.githubusercontent.com/Moxnatiy/hass-xmeye/main/docs/images/settings.jpg"
           alt="The settings editor showing motion detection for one channel">
      <p align="center"><sub><b>Settings</b> — the recorder's own configuration, per channel</sub></p>
    </td>
  </tr>
</table>

<p align="center">
  <img src="https://raw.githubusercontent.com/Moxnatiy/hass-xmeye/main/docs/images/mobile.jpg"
       alt="The panel on a phone, with Home Assistant's menu button and the channel list folded away"
       width="320"><br>
  <sub><b>On a phone</b> — the menu button, and the channel list put away behind <b>CH</b></sub>
</p>

---

## Compatibility

- **Verified on** an NBD8008R-U, firmware `V4.03.R11.061B0197`.
- **Home Assistant** 2024.12 or newer; developed on 2026.2.
- **Protocol:** DVRIP / Sofia on TCP 34567, plus RTSP on 554 for the camera entities.
- **Browser:** the native player needs WebCodecs with hardware H.264/H.265
  decoding — tested in Chrome and Safari. Anything else falls back to HLS.

Other Xiongmai-based recorders very likely work, since they share the protocol.
If yours does — or does not — please [open an issue][issues] with the model and
firmware; the **Report** tab collects exactly what is needed, with passwords,
serial numbers and addresses already removed.

## Installation

### HACS

[![Open in HACS][my-hacs-badge]][my-hacs]

Or by hand: in HACS, open the menu → **Custom repositories**, add
`https://github.com/Moxnatiy/hass-xmeye` as an **Integration**, install it and
restart Home Assistant.

### Manually

Copy `custom_components/xmeye` into your `config/custom_components` directory
and restart Home Assistant.

### Then

**Settings → Devices & services → Add integration → XMeye**, and give it the
recorder's address, a user and its password. The DVRIP (34567) and RTSP (554)
ports can be changed if yours are not the standard ones.

## Options

| Option | What it does |
|---|---|
| **Channels to expose** | Which cameras get entities. A camera added to the recorder later raises a repair notice naming it. |
| **Camera stream** | Sub by default: the main stream is often 4K and expensive to transcode for HLS. |
| **Snapshot stream** | Which stream camera snapshots are taken from. |
| **Panel player** | Native (WebCodecs), HLS or snapshots. Native has by far the lowest latency. |
| **Panel live stream** | Which stream the panel's viewer opens with; it can be switched on the fly. |
| **Update interval** | How often the recorder's state is polled. |
| **Max device connections** | The recorder's `TCPMaxConn`, written back to it. About ten on most firmware. |
| **Use RTSP for live video** | Leave on unless RTSP is disabled on the recorder. |
| **Show the sidebar panel** | The full-page panel described below. |

## The panel

A full-page panel in the sidebar, in the spirit of the Energy dashboard.

| Tab | What it shows |
|---|---|
| **Overview** | The video wall. Layouts as a recorder offers them — 1, 2×2, 6 and 8 with a large tile, 3×3, 4×4 — a channel list beside it for choosing and ordering cameras, a per-camera stream, and fullscreen. All of it remembered. |
| **Channels** | Every channel at a glance: state, resolution, bitrate, recording, motion. |
| **Archive** | A day's recordings coloured by event, the player, and the list of files. |
| **Configuration** | The recorder's entire configuration tree, section by section, for digging. |
| **Settings** | The parts of that tree you actually change, as forms with typed fields. |
| **Log** | The recorder's own system log. |
| **Report** | A developer report for bug reports, and a shared debug log that the browser and the server write into together. |

### Three ways to play

Switchable inside the viewer, with a line under the picture giving the codec,
resolution, frame rate, bitrate, dropped frames and latency.

| Method | Latency | Notes |
|---|---|---|
| **Native** (WebCodecs) | about a second | Frames go from the recorder to the hardware decoder untouched. Reads the codec profile from the stream itself, because Safari refuses a decoder whose claimed profile is wrong. |
| **HLS** | about 15 s | Home Assistant's stock path. Works everywhere; drops frames on a 4K stream. |
| **Snapshots** | — | The fallback. Never smooth, always available. |

When the native decoder cannot start, the player falls back to the smaller stream
and then to snapshots rather than leaving a black tile.

### How the archive keeps time

The recorder stamps only keyframes, and only to the second — two dozen frames in
every twenty-five carry no time at all. The integration builds the timeline
itself, which is what makes smooth playback, exact seeking and honest speeds
possible. Speeds are paced by the player against what the recorder can actually
deliver — about seven times real time — and the speed reached is shown beside the
one asked for. The details are in [docs/panel.md](docs/panel.md).

## Entities

| Platform | What |
|---|---|
| `camera` | Live video per channel over RTSP, two per channel (main and sub), plus snapshots over DVRIP |
| `sensor` | Uptime, total bitrate, channels online, recording channels, disk used and free, archive start and end, recorder time, per-channel bitrate |
| `binary_sensor` | Recording and motion (overall and per channel), channel connected, video loss, camera blinded, disk problem, alarm input |
| `switch` | Motion, blind and video-loss detection, per channel |
| `button` | Reboot, sync time |

## Services

| Service | What it does |
|---|---|
| `xmeye.search_recordings` | Find recordings in a time range, by channel and event. Returns a response. |
| `xmeye.download_recording` | Save a recording into the media folder, as an elementary stream. |
| `xmeye.get_config` | Read any configuration section. Returns a response. |
| `xmeye.set_config` | Write a configuration section. |
| `xmeye.ptz` | Move a PTZ camera, or jump to a preset. |
| `xmeye.talk` | Send G.711 audio to the recorder's speaker. |

Full reference with examples: [docs/services.md](docs/services.md).

```yaml
automation:
  - alias: Note motion recordings after dark
    triggers:
      - trigger: state
        entity_id: binary_sensor.front_gate_motion
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

## Good to know

- **Connections are limited.** A recorder accepts about ten at once
  (`TCPMaxConn`). The integration holds one control session; each camera on the
  wall costs one more, for every browser that has the wall open; snapshots and
  the archive need their own. Several open walls, or a very short update
  interval, can exhaust them.
- **Snapshots are expensive.** These recorders have no HTTP snapshot endpoint, so
  a frame is taken from the video stream — a connection, a wait for a keyframe,
  and a transcode. The result is cached for ten seconds.
- **Channels count from zero** in services and entities, as in the protocol. RTSP
  URLs count from one; the integration converts for you.
- **Use the native Xiongmai RTSP URL.** The common Dahua-style form is accepted
  but its `subtype` is silently ignored, so the 4K main stream always comes back.
- **The password stays in Home Assistant.** It is part of the cameras' RTSP URLs,
  as with any RTSP integration, but the panel never sees it: video reaches the
  browser through Home Assistant, which signs each connection for a few minutes.
- **The shared debug log is off by default**, and nothing in it leaves the
  machine. Turn it on from the **Report** tab when chasing a problem.

## The repository

| Path | What it is |
|---|---|
| [`custom_components/xmeye/`](custom_components/xmeye) | The Home Assistant integration and its panel — plain web components, no build step |
| [`src/xmeye/`](src/xmeye) | A dependency-free async Python client for DVRIP, usable on its own |
| [`docs/`](docs) | How it all works, measured on a real device |

| Document | About |
|---|---|
| [docs/protocol.md](docs/protocol.md) | The DVRIP protocol as it actually behaves: packet format, message ids, the frame container, and the traps |
| [docs/panel.md](docs/panel.md) | The panel: the wall, the players, the archive, and why each works the way it does |
| [docs/services.md](docs/services.md) | Service reference with examples |
| [docs/development.md](docs/development.md) | Setting up, the test suites, and the probing tools |

## Support

If this saved you an evening, you can [buy me a coffee][kofi]. Bug reports, and
reports from other Xiongmai models, are just as welcome.

## License

MIT — see [LICENSE](LICENSE).

Not affiliated with Hangzhou Xiongmai Technology. XMeye and NetSurveillance are
trademarks of their respective owners.

[hacs]: https://github.com/hacs/integration
[hacs-badge]: https://img.shields.io/badge/HACS-custom-41BDF5.svg
[release-badge]: https://img.shields.io/github/v/release/Moxnatiy/hass-xmeye
[releases]: https://github.com/Moxnatiy/hass-xmeye/releases
[tests-badge]: https://github.com/Moxnatiy/hass-xmeye/actions/workflows/tests.yml/badge.svg
[tests]: https://github.com/Moxnatiy/hass-xmeye/actions/workflows/tests.yml
[license-badge]: https://img.shields.io/badge/license-MIT-blue.svg
[kofi]: https://ko-fi.com/shnal
[kofi-badge]: https://img.shields.io/badge/Ko--fi-support-FF5E5B.svg
[issues]: https://github.com/Moxnatiy/hass-xmeye/issues
[my-hacs]: https://my.home-assistant.io/redirect/hacs_repository/?owner=Moxnatiy&repository=hass-xmeye&category=integration
[my-hacs-badge]: https://my.home-assistant.io/badges/hacs_repository.svg
