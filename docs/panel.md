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

The whole wall travels on one WebSocket, whatever it holds. A browser allows six
connections per host on HTTP/1.1 — the number is a constant in Chromium's socket
pool — and the rest of Home Assistant needs some of those, so a wall of sixteen
cameras opened separately leaves most of them queued forever, retrying and never
starting. Sockets are counted against a limit of 255 instead, and one carries
every tile: the channel is named in each record, and the players decode exactly
as before.

A socket can be written to from both ends, which is why it is a socket. Changing
which channels the wall carries is a message on the connection it is about,
where a streamed response needed a second request to say the same thing — a
browser cannot write into a request whose response it is still reading. Message
boundaries are preserved too, so each record arrives whole and nothing is
reassembled.

Each channel names its own stream in that message, so a tile switched to the
main stream travels with the rest rather than costing a connection of its own,
and switching it back is the same message again. The server drops that one
channel's task and dials it on the other stream; the other tiles never notice.

A browser cannot put an authorization header on a WebSocket, so the address
carries the permission instead: Home Assistant signs the path against the
caller's own refresh token, and it expires in minutes. The channel list is not
part of the address — signing covers the query too, and the socket can simply be
told what to carry once it is open.

The single-camera view uses the same socket carrying one channel. Nothing about
one stream needs a second kind of transport, and one fewer of them is one fewer
to keep working.

The trade is a shared pipe: if the browser falls behind, every tile slows
together rather than one at a time. For a wall that is the better failure.

Editing the wall does not disturb the cameras on it. Switching a channel off,
dragging a tile, turning the page or changing the layout used to stop every
player and dial the recorder again — as did every routine redraw, so a wall of
sixteen reconnected because a sensor reading changed. Now the cells are rebuilt
as markup and the canvases of the channels that stay are moved into them: a
canvas keeps its contents and its drawing context across a move, so its player
never learns anything happened. Only the difference is started or stopped, and
that difference is a message on the socket rather than a reconnection — the
server adds or drops that one camera and keeps feeding the rest.

A decoder that fails no longer blanks the tile. Writing a canvas dimension
clears it even when the value is unchanged, so every restart used to wipe a
picture that was perfectly good — most visibly in Safari, whose hardware HEVC
decoder accepts a keyframe, draws it, and then dies on the very next delta frame.
The canvas is now only resized when the size actually changes, so the last frame
stays up while the next configuration is found. The configuration that failed
within a second is also remembered, and tried last on the following load rather
than costing the same seconds again; a configuration that later runs for a
quarter of a minute is forgiven.

The ⛶ button gives the wall the whole screen with nothing else on it. What goes
fullscreen is the element already on the page, not a copy drawn somewhere else,
so the canvases never move and every camera plays straight through the switch and
back; the channel picker is hidden by CSS rather than removed, for the same
reason. The grid keeps its aspect ratio and is centred — stretching 4:3 cameras
onto a 16:9 screen is worse than a black margin. Esc returns.

The panel speaks English, Ukrainian, Spanish, French and German, following
whatever language Home Assistant is set to — a change there reaches the panel on
its next redraw. The English text is the key, so the code reads as what it will
show and a missing translation falls back to something correct rather than to an
identifier; tests check both directions, that every dictionary key still exists
in the source and that every string the panel can show has a translation in
every language.

What the machine writes is never translated: the diagnostics log, the developer
report and the shared log file are English wherever they are read, because they
are read by whoever is fixing the thing. The exception proves the rule — the
tile watcher quotes the caption verbatim, since that line records what the
viewer saw.

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
currently on screen. There is pause, ±10 s stepping, and speeds from ×1 to ×8.

### The bar zooms

A day across a bar is about a minute per pixel, and recordings here are often
twenty seconds long: at that scale the recording you want is thinner than the
pointer, and clicking it is guesswork. So the bar zooms — the wheel about the
pointer, keeping the moment under it in place, down to a minute across the
width. Dragging moves the view, and a press is told from a drag by whether the
pointer travelled: a bar that pans on every press cannot be clicked, and one
that cannot be panned is useless once it is zoomed past a screenful.

The ruler follows, choosing the largest step that still leaves about a dozen
marks — six hours down to one second — so the labels stay equally dense however
far in the view is. The right-hand edge of a whole-day view is named 24:00
rather than 00:00, which would read as the day starting over.

The bar is redrawn rather than transformed. A CSS scale would stretch the cursor
and the hairline of a short recording along with everything else, would leave
the ruler to be recomputed anyway, and would keep seven hundred elements in the
document when forty are on screen. Only what falls inside the window is built,
so zooming in makes the redraw cheaper rather than dearer — and it is the bar
that is redrawn, not the page, because rebuilding the tab would replace the
canvas the player is drawing into and restart playback on every wheel notch.

While playing, the window follows the cursor: at any zoom past the whole day
playback would otherwise run off the right-hand edge within seconds.

The controls are drawn marks in the same 16 px box as the wall's layout icons.
They were typed characters — ▶ ⏸ ⏪ ⏩ ✕ — and a typed character is sized by
whichever font answers for it, so five buttons in a row came out five heights.
The speeds are one joined control rather than four separate buttons, and the day
picker is one frame holding the date between a previous and a next day.

### Time, which the recorder mostly does not send

The recorder stamps keyframes only, and only to the second. Twenty-four frames
in every twenty-five arrive with no time at all, and giving those the
recording's start time — the obvious fallback — describes a timeline that runs
backwards on every frame. A player pacing itself by that lets a whole group of
pictures fall due at once and then nothing until the next keyframe: data keeps
arriving and the picture moves once a second, which is what it did.

So the timeline is built rather than read. It advances one frame period per
frame, at the frame rate the recorder measures per keyframe, and follows a
keyframe only when its stamp is later than the clock — truncation can only make
a stamp early, so an early one is the rounding and a late one means the clock
has fallen behind. Across three consecutive recordings that gives 171.3 s of
timeline for 171 s of recording with no step backwards anywhere, and crossing
into the next recording is just another keyframe the clock follows.

### Speed

One mechanism at every rate: the whole stream, paced by the player's own clock.
The recorder hands an archive over at about seven times real time — 192 s of
recording in 27.7 s, measured on the device — and that bandwidth, not any device
command, is what the speeds are built on. Nothing is re-requested when the speed
changes, so the picture does not blink.

Which frames survive is decided by measurement rather than by rate. While the
player keeps up it shows every frame; once it falls more than 300 ms behind its
own clock it steps to the next group of pictures, because a delta frame cannot
be dropped on its own without breaking the decoder's chain. That tunes itself to
the stream and the machine, where a fixed threshold cannot: a 4K main stream at
×4 is eighty frames a second to decode, a 720p sub stream at ×8 a quarter of
that. Measured on channel 0's 4K H.265: ×1, ×2 and ×4 reached exactly, every
frame decoded, and ×8 reached by stepping groups.

The speed actually reached is shown next to the one asked for, because the link
decides it in the end.

The recorder's own fast-scan is deliberately not used. `OPPlayBack Value=2` does
thin the stream, but only in `ByTime` mode — and playback has to go by name,
since `ByTime` ignores the channel. Played by name it is indistinguishable from
`Value=0`, so the panel spent every speed above ×4 telling the browser a full
stream was already thinned, which switched off the thinning that would have
worked. See [the protocol notes](protocol.md).

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
