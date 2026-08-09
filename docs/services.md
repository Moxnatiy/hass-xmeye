# Services

Every service takes `config_entry_id`, which identifies the recorder. In the
UI it is a picker; in YAML it is the config entry id, most conveniently kept in
`secrets.yaml`.

Channels count **from zero**, as in the protocol itself.

---

## `xmeye.ptz`

Move a PTZ camera, or send it to a preset.

| Field | Required | Default | Meaning |
|---|---|---|---|
| `direction` | yes | — | `up`, `down`, `left`, `right`, `up_left`, `up_right`, `down_left`, `down_right`, `zoom_in`, `zoom_out`, `focus_near`, `focus_far`, `iris_open`, `iris_close` |
| `channel` | no | 0 | Channel |
| `speed` | no | 5 | Step, 1–8 |
| `duration` | no | 0.5 | Seconds of movement, 0.1–10 |
| `preset` | no | — | When given, the camera goes to this preset and `direction` is ignored |

```yaml
action: xmeye.ptz
data:
  config_entry_id: !secret xmeye_entry
  channel: 0
  direction: left
  duration: 1.5
```

---

## `xmeye.search_recordings`

Search the archive. **Returns a response.**

| Field | Required | Default | Meaning |
|---|---|---|---|
| `channel` | no | 0 | Channel |
| `start` | no | 24 h before `end` | Beginning of the window |
| `end` | no | now | End of the window |
| `event` | no | `*` | `*` any, `M` motion, `A` alarm, `R` scheduled, `H` manual |

The response holds `count`, `total_bytes`, and a `recordings` list of
`{name, begin, end, seconds, size_bytes, event}`. `name` is what
`download_recording` needs.

```yaml
action: xmeye.search_recordings
data:
  config_entry_id: !secret xmeye_entry
  channel: 0
  event: "M"
response_variable: found
```

The recorder answers at most 64 records per query, so the client paginates and
de-duplicates; a wide window is fine but takes proportionally longer.

---

## `xmeye.download_recording`

Download one recording into `config/media/xmeye/`. **Returns a response.**

| Field | Required | Meaning |
|---|---|---|
| `filename` | yes | The `name` from `search_recordings` |
| `start` | yes | Beginning of the recording |
| `end` | yes | End of the recording |
| `channel` | no | Channel, default 0 |

The response holds `path`, `bytes`, `frames`, `resolution` and `codec`. The
file is a raw H.265/H.264 elementary stream, not MP4; remux it if you need one:

```bash
ffmpeg -f hevc -i ch0_20260808_213857.h265 -c copy -tag:v hvc1 out.mp4
```

---

## `xmeye.get_config`

Read one configuration section. **Returns a response** of `{section, value}`.

| Field | Required | Meaning |
|---|---|---|
| `section` | yes | For example `Detect.MotionDetect`, `Simplify.Encode`, `NetWork.NetCommon` |

The panel's configuration tab lists every section this recorder exposes, which
is the easiest way to find a name.

---

## `xmeye.set_config`

Write one configuration section.

| Field | Required | Meaning |
|---|---|---|
| `section` | yes | Section name |
| `value` | yes | The new value, as a mapping |

The firmware accepts **the whole section only**. Read it with `get_config`,
change what you need, and send everything back — sending a fragment replaces
the rest with defaults.

```yaml
action: xmeye.set_config
data:
  config_entry_id: !secret xmeye_entry
  section: General.Location
  value:
    DateFormat: YYMMDD
    Language: English
```

---

## `xmeye.talk`

Send an audio file to the recorder's speaker over the DVRIP backchannel.

| Field | Required | Meaning |
|---|---|---|
| `audio_file` | yes | Path to the file; must be inside an `allowlist_external_dirs` directory |

Audio is sent as G.711A. The device must report `TalkIn`/`TalkOut` support —
the `two-way audio` line in `tools/live_check.py` shows whether it does.

---

## Buttons instead of services

Rebooting and time synchronisation are `button` entities rather than services,
since they take no parameters: `button.<recorder>_reboot` and
`button.<recorder>_sync_time`.
