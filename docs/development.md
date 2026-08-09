# Development

## Layout

```
src/xmeye/                     the protocol library, the source of truth
custom_components/xmeye/       the Home Assistant integration
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
| `tools/read_capture.py` | Reads DVRIP out of a `tcpdump` pcap — the only reliable way to learn the parts of the protocol no document describes |
| `tools/sync_lib.py` | Syncs the vendored library copy |
| `tools/ha_restart.sh` | Restarts a development Home Assistant, forcing the port free instead of waiting out the database shutdown |

All of them take the device from the environment:

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

## Conventions

- Comments and docstrings are English. The panel's user-facing strings are
  Ukrainian; Home Assistant strings are translated through
  `custom_components/xmeye/translations/`.
- Comments explain why, not what. A comment that restates the code is noise.
- Every claim about the device in the documentation should be measurable, and
  `docs/protocol.md` says where a claim was measured rather than assumed.
