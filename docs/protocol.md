# The DVRIP ("Sofia") protocol, as measured

Everything below was verified live against an NBD8008R-U running firmware
`V4.03.R11.061B0197`. Where a claim comes from documentation rather than
measurement, it says so.

Addresses, serial numbers and credentials in the examples are placeholders.

## 1. What these devices do and do not speak

| Interface | State |
|---|---|
| DVRIP, TCP 34567 | The real interface. Everything below uses it. |
| RTSP, 554 | Works, and is enough for video on its own. |
| HTTP, 80 | `NETSurveillance WEB`, an IE + ActiveX page. Useless to a client. |
| ONVIF | **Absent.** Port 8899 is closed and `POST /onvif/device_service` returns 404, even though `SystemFunction` advertises `NetRTSP`. |
| HTTP snapshot CGI | Does not exist. `/cgi-bin/snapshot.cgi`, `/webcapture.jpg`, `/snap.cgi` and friends are all missing. |
| `OPSNAP` (msgid 1560) | Answers `None`. Snapshots must come from the video stream. |

The web server answers **HTTP 200 to any URL**, with about forty bytes of
filler. Any probing built on "did the request succeed" will find endpoints that
are not there.

### RTSP

```
rtsp://HOST:554/user=USER&password=PASS&channel=1&stream=0.sdp?real_stream
```

Channels count **from one** in RTSP; `stream=0` is the main stream and
`stream=1` the sub stream. Requesting a channel that does not exist simply
hangs with no error, so a client needs its own timeout.

The Dahua-style form `/cam/realmonitor?channel=N&subtype=M` is accepted, but
`subtype` is **silently ignored** and the main stream comes back regardless.
On a 4K main stream that costs about a third of the frames in a browser. Use
the native form.

## 2. Packet format

Twenty bytes of header, little-endian throughout.

```
offset  size  field
0       1     0xFF (magic)
1       1     version (0)
2       2     reserved
4       4     SessionID
8       4     sequence number
12      1     total packets
13      1     current packet
14      2     message id
16      4     payload length
20      N     payload: JSON followed by "\n\x00"
```

## 3. Login

The password hash, eight characters, folded pairwise from an MD5 digest:

```python
CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

def sofia_hash(password: str) -> str:
    digest = hashlib.md5(password.encode()).digest()
    return "".join(CHARS[(digest[i] + digest[i + 1]) % 62] for i in range(0, 16, 2))
```

The login payload:

```json
{"EncryptType": "MD5", "LoginType": "DVRIP-Web", "PassWord": "<hash>", "UserName": "admin"}
```

A successful reply looks like:

```json
{"AliveInterval": 21, "ChannelNum": 32, "DataUseAES": false,
 "DeviceType ": "HVR", "ExtraChannel": 1, "Ret": 100, "SessionID": "0x00000051"}
```

`AliveInterval: 21` means KeepAlive (msgid 1006) must be sent about every 20
seconds or the session drops. `DataUseAES: false` means **no AES or RSA key
exchange is involved** — implementations that build one are solving a problem
this firmware does not have.

The hash is password-equivalent: anything holding it can log in. Treat it as a
secret, and redact it from diagnostics.

## 4. Message ids

| Id | Purpose |
|---|---|
| 1000 / 1001 | Login / login reply |
| 1006 | KeepAlive |
| 1020 | `SystemInfo`, `StorageInfo`, `WorkState` (channel state, bitrate, recording) |
| 1040 / 1042 | Config set / get (current values) |
| 1044 | Config get (default) — also returns working values |
| 1048 | `ChannelTitle` |
| 1360 | `SystemFunction` (capabilities), `EncodeCapability` |
| 1400 | `OPPTZControl` |
| 1413 / 1410 | `OPMonitor` claim / start (live video) |
| 1420 / 1424 | `OPPlayBack` start / claim (archive and download) |
| 1434 / 1430 / 1432 | `OPTalk` claim / start / data (two-way audio) |
| 1440 | `OPFileQuery` (recording search) |
| 1450 / 1452 | `OPMachine` (reboot) / `OPTimeQuery` |
| 1470–1488 | Users, groups, authority list, password change |
| 1500 / 1504 / 1506 | AlarmSet / AlarmInfo / OPNetAlarm |
| 1560 | `OPSNAP` — does not work on the verified firmware |

Return codes: `100` OK, `515` operation succeeded, `203` wrong password, `607`
no such configuration, `102` unsupported, `107` access denied.

## 5. Live video over DVRIP

```json
{"Name": "OPMonitor", "SessionID": "0x...",
 "OPMonitor": {"Action": "Claim",
   "Parameter": {"Channel": 0, "CombinMode": "NONE",
                 "StreamType": "Main", "TransMode": "TCP"}}}
```

Send it as 1413 (claim) and then 1410 (start), with the same payload. **In
DVRIP channels count from zero**; `StreamType` is `Main` or `Extra1`.

## 6. The frame container

The same format serves the live monitor and the archive. Every frame begins
with `00 00 01 <type>`:

| Type | Meaning | Header | Length field |
|---|---|---|---|
| `0xFC`, `0xFE` | keyframe | 16 bytes | LE32 at offset 12 |
| `0xFD` | delta frame | 8 bytes | LE32 at offset 4 |
| `0xFA` | audio | 8 bytes | LE16 at offset 6 |
| `0xF9` | info | 8 bytes | LE16 at offset 6 |

The keyframe header, per the official `码流帧格式文档.pdf`:

| Offset | Field |
|---|---|
| 4 | `T` — bits 0-3 the codec (`0x1` MPEG4, `0x2` H.264, `0x3` H.265), **bits 4-5 the high bits of the width, bits 6-7 the high bits of the height** |
| 5 | `F` — frame rate (bits 0-4) |
| 6 | `W` — low 8 bits of the width divided by 8 |
| 7 | `H` — low 8 bits of the height divided by 8 |
| 8 | date and time packed into 32 bits |
| 12 | payload length (LE32), excluding the header |

**The size extension in byte `T` is the detail no open-source implementation
gets right** (go2rtc has it commented out as broken). Without the high bits, 4K
parses as 1792×112. Verified on a real frame: `T=0x53` gives codec `0x3`
(H.265), width `(1 << 8 | 0xE0) * 8 = 3840`, height `(1 << 8 | 0x0E) * 8 = 2160`.

The timestamp is a bit field from the low end: 6 bits seconds, 6 minutes,
5 hours, 5 day, 4 month, 6 year (from 2000). Verified against a file name:
a header decoded to `2026-08-08 21:38:57` and the recording was
`21.38.57-21.39.10[M]...`. **Every keyframe carries its own time to the
second**, in the archive and in the live stream alike.

Audio frames: the low nibble of byte 4 is the codec (`0x0E` = G.711A), byte 5
is an index into the sample-rate table `4000, 8000, 11025, 16000, 20000, 22050,
32000, 44100, 48000` counted from one, and the length field is **16 bits**.

With the headers removed, the payload is a clean **Annex-B elementary stream**
with four-byte start codes. One DVRIP packet is not one frame: a frame arrives
across several packets, and one packet may hold several frames.

## 7. Service blocks in the 4K stream

The recorder mixes blocks into the main stream that are marked as ordinary
delta frames (`0xFD`) but hold no video. Measured:

| Property | Value |
|---|---|
| Size | always exactly 127 bytes |
| Content | constant, byte for byte; 30 non-zero bytes out of 127 |
| Period | exactly 2.0 s, on its own timer |
| Tie to the group of pictures | none — the position after a keyframe cycles 19, 9, 24, 14, 4 |
| Where | main stream only; never in the sub stream |
| In the archive | yes, the recorder writes them to disk |
| Share | about 2% of frames (7 of 304 over 15 s) |

The start of a block:

```
00 00 00 01 11 01 78 00 00 00 00 00 00 00 01 07
d1 00 01 00 00 00 00 00 00 00 01 00 00 00 01 00
00 00 01 02 f1 02 0e 25 d1 02 0e 25 d1 26 1f 02
f1 26 1f 00 ... then almost all zeroes ...
```

This is **not Annex-B**: the header of the first unit yields
`nuh_layer_id = 32`, impossible in a single-layer stream, and start codes follow
one another with no data between them. The `00 00 00 01` sequences here are
just 32-bit ones inside a binary structure.

**Why it matters.** Decoders differ: Chromium skips units it does not
understand, while WebCodecs in Safari treats the frame as corrupt and stops with
a decoder failure — roughly once every two seconds, exactly the period at which
these blocks appear. So frames are checked before being sent on
(`MediaFrame.has_valid_nal`), and unusable ones never enter the stream.

**What is still unknown.** The purpose of the block. The official
`码流帧格式文档.pdf` documents only the `0xF9` info frame for transport
telemetry, and this is not that. The likeliest explanation is an analytics
insert — the firmware advertises `HumanDectionNVRNew`, `FaceDetect` and
`NewVideoAnalyze_digit`, and constant content would match an empty result. It
could not be confirmed: nothing moved in view during the observations. The tool
for checking is [`tools/analyse_service_blocks.py`](../tools/analyse_service_blocks.py).

## 8. Three traps that cost the most

**1. There is no correlation identifier.** The sequence number in the header is
each side's own counter. The two agree while every request gets exactly one
reply, and diverge on `OPMonitor` (sending `seq=1` returned `seq=2`). So replies
can be matched by `msgid` only, and after a timeout the connection must be
rebuilt: otherwise a late reply passes for the answer to the next request.

**2. Media cannot be told from JSON by payload content.** The continuation of a
large keyframe starts with arbitrary compressed bytes, among which `{` and `[`
occur (2 of 256, about 0.8% per packet). Such a chunk would be routed into the
JSON parser and vanish, and the demuxer would lose sync and swallow the frames
that follow. Over eight seconds of a 4K stream that is around 110 packets —
a failure in roughly every second run. Route by **msgid only**: `1412` monitor,
`1422`/`1426` playback, `1432` audio.

**3. A live stream starts mid-group.** The first packets are the tail of the
current frame, so a decoder trips over delta frames with no reference
(`Could not find ref with POC N`). Skip frames until the first keyframe.

## 9. The archive

`OPFileQuery` (1440) returns real recordings:

```json
{"Name": "OPFileQuery",
 "OPFileQuery": {"BeginTime": "2026-08-02 15:21:14", "Channel": 0,
   "DriverTypeMask": "0x0000FFFF", "EndTime": "...", "Event": "*",
   "StreamType": "0x00000000", "Type": "h264"}}
```

- Thirty days returned 8407 files; seven days 4592; one day 762.
- `Type: "h264"` must be sent even for an H.265 stream — it is only an extension
  label.
- One query returns at most 64 records and then answers `Ret 100`, so the search
  has to be paginated by advancing `BeginTime` and de-duplicating.
- The file name encodes the event: `15.46.44-16.11.35[R][@b78][0].h264` —
  `[R]` scheduled, `[M]` motion, `[@hex]` an internal id, `[0]` the stream type.
- Downloading: `OPPlayBack` claim (1424), then `DownloadStart` (1420), then the
  data, then `DownloadStop`. The format is not MP4 but the same raw frame
  container as section 6, so a client must demux and remux it.
- The recorder feeds the archive **at ×1.0** and ignores `StreamType` in a
  playback request. Measured properly: with nothing throttling the reader, 45
  seconds of wall time delivered 46 seconds of archive.

### How the vendor app drives playback: two sockets, one session

Captured from the app itself (`tools/read_capture.py` reads the pcap), and then
reproduced against the device:

**A login is per session, not per socket.** The app logs in once, then opens
further TCP connections that never log in at all and simply carry the same
`SessionID`. The device accepts them.

```
socket A   login  ->  SessionID 0x000004df        (control, long-lived)
socket B   msgid 1424  OPPlayBack Action=Claim, SessionID 0x000004df
socket A   msgid 1420  OPPlayBack Action=Start,  SessionID 0x000004df
socket B   msgid 1422  <- the frames arrive here
```

The claim on the data socket is answered `Ret 100` but nothing flows until the
start goes out **on the control socket**. That split is the whole point: the
control channel stays free to steer a stream it is not carrying.

The claim carries a real recording path even in `ByTime` mode:

```json
{"Name": "OPPlayBack", "SessionID": "0x00000004df", "OPPlayBack": {
  "Action": "Claim",
  "Parameter": {"PlayMode": "ByTime", "Channel": 0, "StreamType": 0, "Value": 0,
                "TransMode": "TCP",
                "FileName": "/idea0/2026-08-10/001/00.00.00-00.00.05[R][@4b0d][0].h264"},
  "StartTime": "2026-08-10 00:00:00", "EndTime": "2026-08-10 23:59:59"}}
```

`Start` and `DownloadStart` behave differently and the difference matters:
`Start` is **paced** — measured at a steady 0.96x with a flat 160 KB/s — while
`DownloadStart` bursts, which is what makes short-window measurements of a
download session meaningless.

The app's `OPMonitor` claim carries `"Action1": "Start"`, doing claim and start
in one message rather than two.

### The speed actions, and why measuring them is a trap

The vendor SDK carries a full action vocabulary for `OPPlayBack`:

| Group | Actions |
|---|---|
| Session | `Claim`, `DownloadStart`, `DownloadStop`, `DownloadStartCollection`, `DownloadStopCollection`, `AcrossStart`, `AcrossStop` |
| Speed | `Fast`, `Slow` |
| Position | `Seek`, `Locate` |
| Pause | `DownloadPause`, `DownloadContinue`; a streaming session uses `Pause`, `Continue` |
| Other | `ForceIframe`, `OpenSound`, `CloseSound`, `VDResume` |

The `Parameter` block holds more than the library sends:

```json
{"FileName": "", "PlayMode": "ByTime", "StreamType": 0, "Value": 0,
 "TransMode": "TCP", "IntelligentPlayBackEvent": "ALL",
 "IntelligentPlayBackSpeed": 0}
```

`IntelligentPlayBackEvent` and `IntelligentPlayBackSpeed` belong to a separate
feature: playing back only the intervals that hold events.

On the NBD8008R-U none of `Fast`, `Slow` or `DownloadPause` changed the delivery
rate. That claim needs a caveat about *how* it was tested, because the obvious
test lies. An archive session arrives in bursts, so a ten-second window measures
whichever burst it caught. A control run that sends **nothing at all** wanders

    1.11x  1.11x  2.03x  1.03x  1.36x  0.72x

across six consecutive windows — including a clean-looking 2.0x. Send `Fast`
between windows and that same 2.0x reads as proof the command worked. It is not.
Only the long average, or a control run beside the measurement, settles it.

The device does advertise the capabilities:

```
OtherFunction.SupportPlaybackLocate      True
OtherFunction.SupportPlayBackExactSeek   True
OtherFunction.SupportMaxPlayback         True
```

and the SDK branches on `SupportPlaybackLocate`: with it the app sends a seek
into the running session, without it the app tears the session down and opens a
new one (`SeekTime,Not found,New NetFileSender`).

**The device can play the archive fast — that part is settled.** Measured from
the app's own traffic, frame timestamps against packet capture times:

```
 10.9..19.0s   00:00:00 -> 00:00:15    1.85x
 19.4..27.5s   00:00:16 -> 00:00:58    5.20x
```

and the jump follows a `msgid 1420` sent on the control socket. What that
message says is still unknown: the app's long-lived control connection encrypts
its payloads (base64 over AES-128-ECB — identical plaintext prefixes produce
identical ciphertext blocks), while every connection it opens afterwards stays
plaintext. The key is negotiated at login (`CommunicateKey` sits beside
`UserName` and `PassWord` in the SDK's login field list), and neither capture
caught a login, because the app kept its control connection alive across both.

Sending `Fast` and `Slow` in plaintext on the control socket, with the two-socket
architecture reproduced exactly, changed nothing: 0.96x, 0.96x, 0.97x, 0.96x. So
the difference is in what that encrypted message *says*, not in how the session
is built.

`tools/probe_playback_speed.py` runs the speed measurement with its control
case; `tools/read_capture.py` reads a pcap of the vendor app.

### Parameter.Value is a hidden fast-scan mode

The app always sent `"Value": 0`. Testing the field directly on the plaintext
protocol turned up a genuine server-side fast-forward — no encryption needed.
Measured by frames-per-second-of-recording (near 20 is the full stream, near 2
is decimated), each value averaged over 25 s:

| Value | fps-of-recording | Effect |
|---|---|---|
| 0 | 20.6 | full stream (normal) |
| 1 | — | returns nothing |
| **2** | **2.0** | **decimated fast-scan: ~10x fewer frames per recorded second, ~50x coverage, every frame decodable** |
| 3 | ~9 | mild decimation |
| 4 | — | returns nothing |
| 5, 6, 7, 8, 10, 16 | ~20.5 | full stream, same as 0 |

`Value=2` is reproducible across runs (52x, 43x, 55x, 58x on repeats) and is not
a burst artifact: it delivers the usual number of frames but spread across ten
to thirteen times more recording time, as short decodable bursts rather than
keyframes alone. So it is a usable fast-scan, though a single fixed one — `Value`
is a mode selector, not an adjustable multiplier, and only `2` (and weakly `3`)
triggers it. The app's smooth, adjustable ×2/×4 lives instead in the encrypted
control command, which is still unread.

`tools/probe_playback_value.py` maps the field.

### Cross-checked against the vendor SDK

The Xiongmai FunSDK demos (`github.com/xmeye-team`) ship the SDK headers, which
confirm the model:

- `setPlaySpeed` documents `speed 0/1/2 = 1x/2x/4x`, but that path is
  `CDecoder::OnSetSpeed` — **client-side decoder pacing**, not a device command.
  This is exactly what the panel does at ×1–×2, so no device round-trip is
  needed for modest speeds.
- Server-side fast playback is the "intelligent play" path
  (`Fun_MediaSetIntellPlay`), backed by the OPPlayBack `IntelligentPlayBackEvent`
  / `IntelligentPlayBackSpeed` fields. On the NBD8008R-U those fields are
  **ignored** (Event=Motion/ALL, Speed=8 all returned the plain 1x stream), so
  the only server-side acceleration this firmware honours is `Parameter.Value=2`.
- The wire `Value` field is **not** the clean `0/1/2 = 1x/2x/4x` enum: `Value=1`
  returns nothing on this firmware, only `Value=2` decimates. So `Value` is a
  coarse mode selector here, not the SDK's speed index.

The practical conclusion: the encrypted control channel hides nothing we need.
The vendor app sends the same plaintext OPPlayBack commands; adjustable speed is
client-side pacing, and the one server-side fast mode is the plaintext
`Value=2`. Both are already in the integration.

### Playback by time ignores the channel

`OPPlayBack` with `PlayMode: "ByTime"` always returns channel 0, whatever the
request says. Measured on the NBD8008R-U, every one of these came back as the
4K H.265 of channel 0 while asking for channel 1's 720p H.264:

| Attempt | Result |
|---|---|
| `Parameter.Channel = 1` | channel 0 |
| `OPPlayBack.Channel = 1` | channel 0 |
| `Parameter.ChannelNo = 1` | channel 0 |
| `Parameter.Channel = 2` (as a bitmask) | channel 0 |
| `ByTime` plus that channel's real `FileName` | channel 0 |
| **`PlayMode: "ByName"` with the recording's path** | **channel 1, correct** |

The channel lives in the recording's path — `/idea0/2026-08-11/001/…` is channel
1, `/002/` is channel 2 — and only a `ByName` request honours it. So archive
playback has to name a recording, and covering a stretch of the day means
walking the recordings in order rather than asking for a time range.

## 12. Connection limit and CombinMode

`NetWork.NetCommon.TCPMaxConn` caps how many TCP connections the recorder
accepts at once — 10 on the NBD8008R-U. That, not anything client-side, is the
ceiling on how many streams a panel can run together: each live view, snapshot
and archive download is its own connection, plus one control session.

The field **is writable** (verified: set to 20, read back 20, restored to 10),
and the integration exposes it in the options flow. Whether firmware honours a
value above 10 for actual simultaneous connections is not guaranteed and was not
provable here with a single camera online — the stored value changes, the
enforced limit may not.

`OPMonitor` accepts `CombinMode: "CONNECT_ALL"` (Ret 100) as well as the usual
`"NONE"`. In principle that is the way to carry several channels over one
connection and sidestep the limit. It could not be confirmed on this device: only
one channel (D01) is connected, so CONNECT_ALL returned just that one 704x576
stream, indistinguishable from a normal claim. Worth revisiting on a recorder
with several cameras online.

## 13. Optional payload encryption

The device speaks DVRIP in the clear — the login reply says `DataUseAES: false`,
and this whole client relies on it. The vendor app can *opt into* encrypting a
connection's payloads through the login handshake; the device does not require
it. Reverse-engineered from the app's SDK, for reference:

- Payloads become `base64(AES-128-CBC(payload))` with a zero IV and PKCS
  padding (`XAES::Encrypt128_Base64` in the SDK). CBC with a fixed zero IV still
  yields equal ciphertext prefixes for equal plaintext prefixes, which is what
  the capture showed.
- The SDK also derives some keys as `SHA1(SHA1(seed))[:16]` and carries a
  hardcoded cloud-token key (`"JAVA真好喝啊"`), but the device wire channel does
  not use either: its key is the raw 16-byte `CommunicateKey`.
- The handshake is a Diffie-Hellman-style exchange: the client's
  `OPMonitor Claim` carries `DHParameter.RandomStrA` in the clear, the device
  replies with `RandomStrB`, and the client sends a `CommunicateKey` (random,
  from `XAES::RandStr`) inside the encrypted login. The data channel then uses
  that CommunicateKey as its AES key — so it is per-session random, readable
  only from a decrypted login, not derivable from the password.

None of this is needed to talk to the recorder, and the library does not
implement it. It is documented only because the app's adjustable server-side
playback speed travels over that encrypted channel — the one piece of archive
control not reachable in plaintext. The plaintext fast-scan (`Value=2`) covers
the common case.

## 10. Prior art

| Project | Language | What it gives |
|---|---|---|
| [OpenIPC/python-dvr](https://github.com/OpenIPC/python-dvr) | Python | The most complete control implementation: login, config, users, PTZ, `OPFileQuery`, download, monitor, alarms, firmware |
| [AlexxIT/go2rtc](https://github.com/AlexxIT/go2rtc) (`pkg/dvrip`) | Go | The cleanest frame demuxer, plus a backchannel and a direct DVRIP→WebRTC/HLS bridge |
| [alexshpilkin/dvrip](https://github.com/alexshpilkin/dvrip) | Python | A strictly typed model of the protocol and network discovery |
| [667bdrm/sofiactl](https://gist.github.com/667bdrm/209bf33b2d04b08bb318) | Perl | Historical reference and a Wireshark dissector |

Xiongmai's own interface documents (`雄迈数字视频录像机接口协议`, the stream frame
format, and the configuration exchange format) circulate with the OpenIPC
project. They are not redistributed here.

Decompiling the XMeye app is unnecessary for a local client: the macOS VMS
client uses exactly this DVRIP on 34567 and nothing more. It would only be of
interest for the P2P cloud (`xmeye.net`, UDP hole punching).
