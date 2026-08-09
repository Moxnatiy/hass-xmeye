# The panel

The panel is a full-page view registered in the sidebar, in the spirit of the
Energy dashboard. It is a plain web component loaded as an ES module: no
external dependencies and no build step. The source lives in
[`custom_components/xmeye/panel/`](../custom_components/xmeye/panel).

It can be turned off in the integration options.

## Tabs

**Overview** — the video wall, plus the recorder's figures in the header.

**Channels** — a grid of cards with live thumbnails, refreshed every ten
seconds, and per-channel state. Clicking a card opens the viewer.

**Archive** — a day timeline with recordings coloured by event, and the archive
player.

**Configuration** — the recorder's whole configuration tree, read section by
section. Useful for finding a section name for `xmeye.get_config`.

**Log** — the recorder's own system log.

## The video wall

Layouts follow what a recorder itself offers: 1, 2×2, 6 and 8 with a hero tile,
3×3 and 4×4. When there are more channels than tiles, the wall paginates.

Beside the wall is a channel picker: the marker takes a channel off the wall or
puts it back, and the arrows move it between tiles. The layout, the order and
the selection are stored per config entry in `localStorage` and survive a
reload. Channels the recorder gains later join the end of the list.

Each tile is live video through WebCodecs on the sub stream, which is light
enough that several channels together overload neither the browser nor the
device. Corners and gaps are deliberately absent so the wall reads as one
canvas.

## Playback methods

Switchable inside the viewer, with a technical line under the picture.

| Method | Latency | Notes |
|---|---|---|
| Native (WebCodecs) | about a second | Frames leave the recorder and go straight into the browser's hardware decoder — no segmentation, no MP4 repackaging. No seeking and no bitrate adaptation. |
| HLS | about 15 s | The stock `ha-camera-stream`. Home Assistant needs around thirteen seconds to bring a stream up from this recorder, so the panel waits up to thirty-five before calling it a failure. |
| Snapshots | — | The fallback. Never smooth, but always available. |

The stream (main or sub) switches on the fly in every mode. That is why each
channel has **two camera entities**, one per stream; the one matching the
options stays primary and keeps its entity id.

### How the native player survives

The codec string is read from the SPS **inside the stream** rather than guessed
from the resolution. Some browsers accept any plausible string; Safari checks
the claimed profile and level against the real ones and refuses when they
disagree.

If a decoder configuration fails, the player walks a short list of candidates:
the parsed codec string against the guessed one, `hev1` against `hvc1`, and
hardware against software. The search is deliberately short — each failed
attempt costs a second or two of flicker — and a configuration must survive
fifteen seconds to count as usable, because a decoder that dies every second
still emits frames.

Frames are fed a few at a time rather than in the bursts the recorder sends: a
group of pictures handed over whole is tens of megabytes at once. At most one
decoded frame is held at a time and drawing happens once per screen refresh,
because `drawImage` from a `VideoFrame` does not release its buffer
immediately — at 4K that is twelve megabytes per frame.

When the decoder cannot be brought up at all, the player falls back to the
smaller stream and then to snapshots rather than showing a black screen.

## The archive player

Click the timeline to play from that moment. The cursor follows the frame
currently on screen. There is pause, ±10 s stepping, and speeds from ×1 to ×16.

The recorder feeds the archive strictly at ×1.0 and has no fast-forward
command — measured. Up to ×4 the player simply runs frames on its own clock.
From ×4 it switches to seek-based scrubbing: one frame from each point spaced
by the requested step. Above that only keyframes are decoded, since the screen
could not change faster anyway. The actual speed is shown next to the requested
one, because a seek costs what it costs.

## OSD and diagnostics

The line under the picture shows the codec, resolution, frames per second,
bitrate in Mbit/s at a fixed width, dropped frames and latency. Fixed width
matters: without it the text twitches every second as a number gains a digit.

The diagnostics log lives on the panel rather than on the player, so it
survives a stream or player switch — the switch itself is usually the
interesting part. It records decoder configuration attempts, failures with the
context of the last frame submitted, queue overflows and restarts, and can be
copied as text for a bug report. Two experiment modes narrow a failure down by
halving the search space rather than guessing: `keyOnly` feeds the decoder
keyframes only, and `noPaint` decodes without drawing.

## Endpoints the panel uses

| Endpoint | Purpose |
|---|---|
| `xmeye/devices`, `xmeye/detail`, … (WebSocket) | Recorder state, channels, recordings, configuration, log |
| `/api/xmeye/native/<entry>/<channel>?stream=…` | The native frame stream: a JSON header, then `flags, length, timestamp, payload` per frame |
| `/api/camera_proxy/…` | Snapshots and HLS, through Home Assistant's own camera plumbing |

The panel never receives the recorder password: video reaches it through the
camera proxy and the native endpoint, both authenticated by Home Assistant.
