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

**Settings** — the recorder's own settings, grouped the way the vendor apps
present them, with typed fields and a save button. The groups are declared as
data (`SETTINGS_GROUPS`), so adding one is a schema change rather than new
markup, and each field states its type so the value written back keeps the shape
the firmware expects. A section is sent whole because the firmware replaces what
it is given and defaults anything left out, and what the recorder stored is read
back afterwards — it clamps values it dislikes without saying so.

Field keys are paths, so a flag one level down — `EventHandler.BeepEnable`,
`Server.Port` — is edited like any other, and the merge copies its way down
rather than mutating what was read.

Sections that hold one entry per channel — motion, blind and video-loss
detection, the channel overlays, PTZ — get a channel selector. The form edits
one element while the save still sends the whole array back, with only the
selected channel changed, because the firmware replaces a section whole.
Switching channel clears pending edits: carrying them over would write one
camera's values onto another. Verified on the device that a per-channel write
leaves the other channels, the detection zone and the schedule untouched.

A path step may be an array index (`RelativePos.0` is an overlay's x), so the
copy-on-write keeps an array an array — spreading one into an object turns
`[570, 7552]` into `{"0": 570, "1": 7552}`, which the firmware drops.

The network group carries a warning: changing a port drops the current
connection, and the integration then needs the new port. `HostIP`, `GateWay`
and `Submask` are deliberately absent — they are little-endian hex, and a wrong
value takes the recorder off the network with no way back through this panel.

**Configuration** — the recorder's whole configuration tree, read section by
section. This stays as the raw browser: it reaches every section the firmware
has, which is right for digging and wrong for changing a setting on purpose.

**Log** — the recorder's own system log.

## The video wall

Layouts follow what a recorder itself offers: 1, 2×2, 6 and 8 with a hero tile,
3×3 and 4×4. When there are more channels than tiles, the wall paginates.

Beside the wall is a channel picker, one compact row per channel. The marker on
the left carries two facts at once: filled means the channel is on the wall,
green means the recorder sees it — a click toggles it. Next to it is a grip for
dragging the row to a new position, and at the end a dropdown for that camera's
stream. The layout, the order, the selection and the per-channel stream are
stored per config entry in `localStorage` and survive a reload. Channels the
recorder gains later join the end of the list.

Only the grip starts a drag, since the row also holds a select and a row that is
draggable everywhere makes that awkward to use. Reordering by drag needs a
mouse: HTML5 drag and drop does not fire on touch.

Each tile is live video through WebCodecs, on the sub stream by default:
several 4K tiles at once overload both the browser and the recorder, which has
about ten connections to give in total. Changing one camera's stream restarts
that tile alone rather than the whole wall.

From three tiles the wall stops opening a stream per camera and shares a single
response instead. A browser allows six connections per host on HTTP/1.1 — the
number is a constant in Chromium's socket pool — and the rest of Home Assistant
needs some of those, so a wall of sixteen cameras opened separately leaves most
of them queued forever, retrying and never starting. One response carries every
tile, with the channel named in each record, and the players decode exactly as
before.

The trade is a shared pipe: if the browser falls behind, every tile slows
together rather than one at a time. For a wall that is the better failure.

The shared response carries one stream type, so a tile switched to the main
stream travels on its own connection — that tile only. The rest keep sharing,
and switching a tile either way moves just that channel: into the shared
response, or out of it onto a connection of its own.

Editing the wall does not disturb the cameras on it. Switching a channel off,
dragging a tile, turning the page or changing the layout used to stop every
player and dial the recorder again — as did every routine redraw, so a wall of
sixteen reconnected because a sensor reading changed. Now the cells are rebuilt
as markup and the canvases of the channels that stay are moved into them: a
canvas keeps its contents and its drawing context across a move, so its player
never learns anything happened. Only the difference is started or stopped, and
on the shared connection that difference is a short request naming the session
rather than a reconnection — the recorder adds or drops that one camera and
keeps feeding the rest.

A decoder that fails no longer blanks the tile. Writing a canvas dimension
clears it even when the value is unchanged, so every restart used to wipe a
picture that was perfectly good — most visibly in Safari, whose hardware HEVC
decoder accepts a keyframe, draws it, and then dies on the very next delta frame.
The canvas is now only resized when the size actually changes, so the last frame
stays up while the next configuration is found. The configuration that failed
within a second is also remembered, and tried last on the following load rather
than costing the same seconds again; a configuration that later runs for a
quarter of a minute is forgiven.

Corners and gaps are deliberately absent so the wall reads as one canvas.

A wall is meant to be left open, so a tile that stops is brought back rather
than left frozen: five attempts with a growing delay, and the error stays on
screen only once they are spent. Access tokens are refreshed before every
stream request — Home Assistant's expires after about half an hour, and a wall
left open overnight answers 401 the moment it reconnects with the old one.

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

Speed uses one mechanism at every rate: a frame stream paced by the player's own
clock. Up to ×2 the recorder sends the full stream. At ×4 and above the player
adds `fast=1`, which asks the recorder to thin the stream itself (OPPlayBack
`Value=2`) — the only server-side fast-forward the protocol offers, measured at
roughly sixty times coverage. Those thinned frames are still real and decodable,
so the same clock paces them to the exact requested rate; the player keeps all
of them rather than dropping to keyframes, since the recorder already did the
thinning. The actual speed reached is shown next to the requested one, because
the recorder's own limits still apply.

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
