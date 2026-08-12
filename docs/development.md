# Development

## Layout

```
src/xmeye/                     the protocol library, the source of truth
custom_components/xmeye/       the Home Assistant integration
  brand/                       icon.png and icon@2x.png, served by HA itself
  panel/                       the panel (plain ES modules, no build step)
  xmeyelib/                    a vendored copy of src/xmeye, kept in sync
docs/                          this documentation
tests/                         offline tests against a fake device
tests_ha/                      tests against a real recorder inside Home Assistant
tools/                         diagnostic and research scripts
```

The library is not on PyPI, and HACS installs dependencies only from there, so
a copy ships inside the integration. Keep it in sync:

```bash
python tools/sync_lib.py          # copy src/xmeye -> custom_components/xmeye/xmeyelib
python tools/sync_lib.py --check  # report drift without changing anything
```

## Setting up

```bash
python -m venv venv
venv/bin/pip install -e ".[dev]"
```

For the Home Assistant suite a separate environment is easier, since it pulls
in Home Assistant itself:

```bash
python -m venv .ha-venv
.ha-venv/bin/pip install pytest-homeassistant-custom-component
```

## Tests

The default suite is offline. It runs against a fake DVRIP server and real
captured frame headers, so it needs no device:

```bash
venv/bin/python -m pytest
```

It covers the transport (correlation, desync, reconnection, media routing), the
response models, the frame demuxer including the 4K size extension and the
service-block filter, and a set of static checks over the panel JavaScript.

Those static checks exist because the costliest mistake in this project was
structural, not logical: an edit removed a method and left its call behind, and
the branch never ran in Chromium, so it only surfaced in someone else's Safari.
The checks catch calls to methods that do not exist, methods defined twice,
fields used as both a flag and an object, `dataset` reads with no matching
attribute, and syntax errors (through `node --check`, skipped when node is
absent).

The live suite talks to a real recorder and is skipped without credentials:

```bash
XMEYE_HOST=192.168.1.10 XMEYE_PASS=secret \
  .ha-venv/bin/python -m pytest -c tests_ha/pytest.ini -s
```

It brings up a real Home Assistant, sets the integration up against the device,
and checks entities, services, the panel registration and the native endpoint.
`test_performance.py` prints figures rather than only asserting, so an
optimisation can be checked instead of taken on trust.

## Tools

All of them read only; none change anything on the device.

| Tool | What it does |
|---|---|
| `tools/live_check.py` | Walks the library's control API against a real recorder and prints a pass/fail summary, including a KeepAlive survival check |
| `tools/live_media.py` | Live stream, sub stream, snapshot and archive download, each validated with `ffprobe` so that "works" means "ffmpeg opens it" |
| `tools/discover.py` | Walks every known configuration section and command and writes a JSON capability map for one firmware |
| `tools/dvrip_probe.py` | A dependency-free raw-protocol probe, for when the question is whether the device or the library is at fault |
| `tools/probe_playback_speed.py` | Tests whether the recorder acts on the archive speed and pause actions, with a control run that sends nothing — without one, the bursty stream makes any action look like it worked |
| `tools/analyse_service_blocks.py` | Collects the 127-byte service blocks and checks whether their content changes while something moves in view |
| `tools/probe_playback_value.py` | Maps OPPlayBack `Parameter.Value`; on this firmware `Value=2` is a decodable server-side fast-scan |
| `tools/read_capture.py` | Reads DVRIP out of a `tcpdump` pcap — the only reliable way to learn the parts of the protocol no document describes |
| `tools/probe_multiplex.py` | Reads the panel's own video endpoints without a browser and reports, per channel, when the stream was announced and when its first keyframe arrived — the number that says whether a late tile is the server's doing or the client's. `--split` runs the same measurement over one connection per channel as a control |
| `tools/sync_lib.py` | Syncs the vendored library copy |
| `tools/ha_restart.sh` | Restarts a development Home Assistant, forcing the port free instead of waiting out the database shutdown |

### The joint log

The panel and the server write into one file, `xmeye-debug.log`, beside the Home
Assistant configuration. Turn it on in the panel's **Звіт** tab; it is off by
default and nothing leaves the machine.

Both sides are placed on the same clock — the browser stamps events with its own
wall time and says what time it thinks it is with every batch, so a panel open on
a phone with a skewed clock still lands in the right place, within a network hop.
Lines are appended as they arrive, so read the file through `sort -n` (the
panel's own viewer sorts it for you):

```
   1.643 back  channel 0    announced 704x576 h265 after 0.22s, 0 frames waiting for a key
   1.647 web   ch0 stream header {"channel":0,"codec":"h265",...}
   1.648 web   ch0 decoder configuration hev1.1.2.L153 / prefer-hardware
   1.656 web   ch0 first frame received 704x576
   2.746 back  channel 1    announced 640x480 h264 after 1.33s, 0 frames waiting
   2.757 web   ch1 first frame received 640x480
```

That is what settled why a wall comes up one tile at a time: thirteen
milliseconds from the server announcing a channel to the browser drawing it, and
a second and a half between the two channels. The delay is the recorder's.

While the file is being written, each tile is also sampled ten times a second
and every change of state recorded — picture or blank, what the caption reads,
the canvas size, whether it is still in the document. Everything else in the log
says what the code did; this says what the viewer saw, which is what a complaint
about blinking is actually about:

```
   1.503 web   стіна     старт, каналів 3
   1.604 web   плитка    ch0 порожньо · 300x150 · "підключення…"
   1.826 web   ch0 first frame received 704x576
   1.905 web   плитка    ch0 картинка · 704x576 · "576p 10fps 0.00 Mbps"
```

300x150 is a canvas with no size yet — the browser's default, before a decoder
configures it. A tile in that state for a moment after a reload is the page
starting, not a fault.

Note what the file does **not** measure. The panel's per-tile statistics are
published once a second, so anything derived from them is a second late — the
first version of this log said "first frame" from that tick and made the browser
look a full second slow. Player events now go into the file as they happen.

`probe_multiplex.py` talks to Home Assistant rather than to the recorder, so it
needs a long-lived access token (Profile -> Security) in `HA_TOKEN` or in
`.local/ha-token`, which is gitignored. It never prints the token.

```bash
HA_TOKEN=... python tools/probe_multiplex.py --channels 0,1,2 --seconds 20
```

Between it and the recorder-side logs, a staggered wall can be pinned down
without guessing. `homeassistant.components.xmeye` at debug level reports when a
multiplexed session gains or loses a channel and how long each channel took to
send something showable; the panel's own log records when each tile first
painted. If the three agree, the recorder is pacing the wall; if they disagree,
the disagreement names the layer.

The rest take the device from the environment:

```bash
export XMEYE_HOST=192.168.1.10
export XMEYE_USER=admin
export XMEYE_PASS=secret
```

`.env.example` lists the same variables.

`discover.py` redacts passwords, hashes, serial numbers and UUIDs from its
report. The Sofia hash is password-equivalent, so it is redacted too; do not
attach an unredacted capability dump to an issue.

## A development Home Assistant

`tools/ha_restart.sh` expects a config directory beside the checkout and a
Home Assistant in `.ha-venv`. Leave `recorder` and `history` out of that
configuration: without them a restart takes about eight seconds instead of
twenty-three, and a development instance has nothing worth keeping. On macOS,
prefer an explicit list of components to `default_config`, which pulls in
Bluetooth and crashes.

The panel is an ES module, and browsers cache it hard. The integration appends
a version stamp taken from the file's mtime to the module URL, and the module
passes it on to its siblings. If you edit the panel and see no change, check
that stamp before looking anywhere else.

## Brand images

`custom_components/xmeye/brand/` holds `icon.png` (256x256) and `icon@2x.png`
(512x512). Since Home Assistant 2026.3 a custom integration ships its own brand
images this way, and they take priority over the CDN — the
`home-assistant/brands` repository no longer accepts custom integrations. Dark
variants (`dark_icon.png`) and logos (`logo.png`) are supported by the same
mechanism if they are ever wanted. No manifest entry is needed.

## Conventions

- Comments and docstrings are English. The panel's user-facing strings are
  Ukrainian; Home Assistant strings are translated through
  `custom_components/xmeye/translations/`.
- Comments explain why, not what. A comment that restates the code is noise.
- Every claim about the device in the documentation should be measurable, and
  `docs/protocol.md` says where a claim was measured rather than assumed.
