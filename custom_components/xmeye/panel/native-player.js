/**
 * The native XMeye player, built on WebCodecs.
 *
 * Frames arrive from the recorder exactly as it sent them and go straight into
 * the browser's hardware decoder. No segmentation, no MP4 repackaging, so
 * latency stays around a second where HLS in Home Assistant costs about fifteen.
 *
 * The price: no seeking, no bitrate adaptation, and a browser with WebCodecs is
 * required. For watching a camera that is a good trade.
 */

//: How many frames may pile up in the decoder queue before it counts as behind.
//: Derived from the frame rate: roughly one second of slack. Too strict a limit
//: hurts, because exceeding it means skipping to the next keyframe and losing a
//: whole group of pictures to save fractions of a second.
const queueLimit = (fps) => Math.max(8, Math.round(fps || 25));

//: How many frames to keep inside the decoder at once. Data arrives in bursts,
//: one per group of pictures, and handing a burst over whole gives the decoder
//: tens of megabytes in an instant. Keep a small backlog and top it up as the
//: decoder frees space.
const IN_FLIGHT = 3;

//: How many frames may wait in our own queue while the decoder is busy. More
//: than this and latency becomes noticeable, so skipping a group is better.
const BACKLOG = 90;

//: How many frames to keep ready during archive playback.
const READ_AHEAD = 45;

//: The speed above which only keyframes are shown. Beyond it decoding every
//: frame is pointless: the screen cannot change fast enough anyway.
const KEYFRAME_ONLY_RATE = 4;

//: The window over which rates are averaged. Data arrives in bursts, one per
//: group of pictures, so a one-second window would swing the figure from zero
//: to triple and back.
const RATE_WINDOW = 5;

//: Restart attempts allowed after a failure in a stream that was already playing.
const MAX_RESTARTS = 5;

//: Attempts allowed when no frame ever decoded. This is not bad luck but a
//: browser that cannot handle the stream, so trying longer only means a longer
//: black screen.
const FUTILE_RESTARTS = 1;

//: Largest canvas width. A 4K frame takes about twelve megabytes in memory and
//: drawing it one to one is pointless: it is scaled down on screen anyway. A
//: smaller canvas means less work per frame and less memory held.
const MAX_CANVAS_WIDTH = 1920;

//: How many configurations to try before declaring the stream unplayable. Each
//: failed attempt costs a second or two of flicker, so walking two dozen
//: variants is worse than falling back to a lighter stream in time. Eight
//: covers every meaningful combination of codec string, acceleration and
//: latency mode.
const MAX_CYCLE = 8;

//: How long a configuration must survive to count as usable. A decoder that
//: dies after a second or two still emits frames, so frame counts cannot tell
//: it apart from real work. Only elapsed time can.
const STABLE_AFTER = 15000;


/**
 * Read the codec string from the parameter sets inside the stream itself.
 *
 * Guessing from the resolution works in Chromium, but Safari checks the claimed
 * profile and level against the real ones and refuses when they disagree. Built
 * from the SPS, the string always matches the stream.
 *
 * @param {Uint8Array} data an Annex-B frame
 * @returns {string|null} for example "hvc1.1.6.L150.90"
 */
export function parseHevcCodec(data) {
  const sps = findNal(data, 33);
  if (!sps) return null;

  // Strip emulation prevention bytes, or the bit reader drifts.
  const rbsp = stripEmulation(sps.subarray(2));
  const bits = new BitReader(rbsp);

  bits.read(4); // sps_video_parameter_set_id
  const maxSubLayersMinus1 = bits.read(3);
  bits.read(1); // sps_temporal_id_nesting_flag

  const profileSpace = bits.read(2);
  const tierFlag = bits.read(1);
  const profileIdc = bits.read(5);

  let compatibility = 0;
  for (let i = 0; i < 32; i += 1) {
    compatibility = (compatibility << 1) | bits.read(1);
  }

  // 48 bits of constraint flags, which later become bytes of the codec string
  const constraints = [];
  for (let i = 0; i < 6; i += 1) constraints.push(bits.read(8));

  // sub-layer levels are skipped: the codec string only needs the general one
  const subLayerProfile = [];
  const subLayerLevel = [];
  for (let i = 0; i < maxSubLayersMinus1; i += 1) {
    subLayerProfile.push(bits.read(1));
    subLayerLevel.push(bits.read(1));
  }
  if (maxSubLayersMinus1 > 0) {
    for (let i = maxSubLayersMinus1; i < 8; i += 1) bits.read(2);
  }
  for (let i = 0; i < maxSubLayersMinus1; i += 1) {
    if (subLayerProfile[i]) bits.read(88);
    if (subLayerLevel[i]) bits.read(8);
  }
  const levelIdc = bits.read(8);

  // Compatibility flags are written in reverse bit order.
  let reversed = 0;
  for (let i = 0; i < 32; i += 1) {
    reversed = (reversed >>> 0) | (((compatibility >>> i) & 1) << (31 - i));
  }

  const space = ["", "A", "B", "C"][profileSpace] || "";
  const parts = [
    `${space}${profileIdc}`,
    (reversed >>> 0).toString(16),
    `${tierFlag ? "H" : "L"}${levelIdc}`,
  ];
  // Trailing zero constraint bytes are left out of the string.
  const tail = [...constraints];
  while (tail.length && tail[tail.length - 1] === 0) tail.pop();
  tail.forEach((byte) => parts.push(byte.toString(16).padStart(2, "0")));

  return parts.join(".");
}

/** Find the first NAL of a given type in an Annex-B stream. */
function findNal(data, type) {
  for (let i = 0; i + 4 < data.length; i += 1) {
    if (data[i] !== 0 || data[i + 1] !== 0 || data[i + 2] !== 1) continue;
    const start = i + 3;
    if (((data[start] >> 1) & 0x3f) !== type) continue;
    let end = data.length;
    for (let j = start; j + 3 < data.length; j += 1) {
      if (data[j] === 0 && data[j + 1] === 0 && data[j + 2] === 1) {
        end = data[j - 1] === 0 ? j - 1 : j;
        break;
      }
    }
    return data.subarray(start, end);
  }
  return null;
}

function stripEmulation(data) {
  const out = new Uint8Array(data.length);
  let n = 0;
  for (let i = 0; i < data.length; i += 1) {
    if (i > 1 && data[i] === 3 && data[i - 1] === 0 && data[i - 2] === 0) continue;
    out[n++] = data[i];
  }
  return out.subarray(0, n);
}

class BitReader {
  constructor(data) {
    this.data = data;
    this.pos = 0;
  }

  read(count) {
    let value = 0;
    for (let i = 0; i < count; i += 1) {
      const byte = this.data[this.pos >> 3] || 0;
      value = (value << 1) | ((byte >> (7 - (this.pos & 7))) & 1);
      this.pos += 1;
    }
    return value >>> 0;
  }
}

export const nativePlayerSupported = () =>
  typeof VideoDecoder !== "undefined" && typeof ReadableStream !== "undefined";

export class NativePlayer {
  /**
   * @param {HTMLCanvasElement} canvas where to draw
   * @param {(stats: object) => void} onStats callback for the OSD
   */
  /**
   * @param {object} lab modes that narrow down a failure:
   *   `keyOnly` feeds the decoder keyframes only (far less data and no
   *   inter-frame dependencies);
   *   `noPaint` decodes without drawing (each frame is closed at once).
   */
  /**
   * @param {object} options `rate` is the archive speed multiplier: 0 means the
   *   live pace of "as it arrives", anything else plays on the player's clock.
   */
  constructor(canvas, onStats, onFatal, sharedLog, lab, options) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.onStats = onStats || (() => {});
    //: Called when the decoder finally fails, so the panel can fall back to a
    //: lighter stream instead of showing a black screen.
    this.onFatal = onFatal || (() => {});
    this.lab = lab || {};
    const settings = options || {};
    //: 0 means live viewing; anything else is the archive playback speed.
    this.rate = settings.rate || 0;
    //: True when the source is a server-side fast-scan, already thinned to a
    //: fraction of the frames. Every one of those frames counts, so the
    //: keyframe-only shortcut used for full streams at high speed must not fire.
    this.decimated = Boolean(settings.decimated);
    this.paused = false;
    //: Time of the frame currently on screen; the panel tracks its cursor by it.
    this.position = null;
    this._clockStart = null;
    this._mediaStart = null;
    this._ticker = null;
    this.controller = new AbortController();
    this.decoder = null;
    this.info = null;

    this.stats = {
      player: "native",
      codec: "",
      resolution: "",
      fps: 0,
      decoded: 0,
      dropped: 0,
      bitrate: 0,
      latency: null,
      queue: 0,
      restarts: 0,
      error: null,
    };
    this._bytes = 0;
    this._decodedSince = 0;
    this._since = performance.now();
    this._window = [];
    this._tick = null;
    //: After an overload or error the decoder must restart from a keyframe.
    this._needKey = true;
    this._restarting = false;
    //: Waiting for the first keyframe so the decoder can be configured from it.
    this._needsConfigure = false;
    //: The latest decoded frame that has not reached the screen yet.
    this._pendingFrame = null;
    //: Frames waiting to be fed to the decoder.
    this._backlog = [];
    this._feeding = false;
    //: Our own frame timeline in microseconds. The recorder stamps time to the
    //: second, so dozens of consecutive frames share a mark. Some decoders
    //: tolerate that; others do not.
    this._pts = 0;
    //: Maps our stamp to the real capture time, used for the latency figure.
    this._wall = new Map();
    //: Usable decoder configurations and the current one. If the decoder dies,
    //: the next is tried: a browser may report a configuration as supported and
    //: still fail to handle it in practice.
    this._configs = null;
    this._configIndex = 0;
    this._configStartedAt = 0;
    //: Decoder event log. WebCodecs behaves noticeably differently across
    //: browsers and someone else's browser cannot be reproduced, so let the
    //: player report what happened to it.
    // The log is shared with the panel: otherwise it would vanish on every
    // stream switch, and the switch itself is the interesting part.
    // Either an array to append to, or a function to call as events happen.
    // The panel passes a function so its file log is written in real order.
    this.sink = typeof sharedLog === "function" ? sharedLog : null;
    this.log = this.sink ? [] : sharedLog || [];
    this._t0 = performance.now();
  }

  /**
   * Run without owning a connection: frames arrive from a multiplexer.
   *
   * The wall shares one response across every tile, so the fetch belongs to the
   * reader rather than to each player. Everything after the bytes arrive — the
   * decoder search, the pacing, the drawing — is the same either way.
   */
  startFed(info) {
    this.info = info;
    this._needsConfigure = true;
    this.note("stream header", JSON.stringify(info));
    // The rate window opens now, not when the player was constructed: on a
    // shared connection a channel can be added minutes later, and the idle wait
    // would otherwise be averaged in as a stretch of no traffic.
    this._since = performance.now();
    this._tick = setInterval(() => this._publish(), 1000);
  }

  /** Hand one frame to a player that is being fed from outside. */
  async pushFrame(payload, keyframe, stamp) {
    if (this.controller.signal.aborted) return;
    // A player that fetches for itself weighs the stream as it reads it. A fed
    // one never reads, so its bytes are counted here instead — otherwise every
    // tile on the shared connection reports no bitrate at all.
    this._bytes += payload.length;
    if (this._needsConfigure) {
      // The decoder is configured from a keyframe, because that is what carries
      // the parameter sets the profile and level are read from.
      if (!keyframe) return;
      this._needsConfigure = false;
      this._first = payload;
      if (!(await this._configure(payload))) return;
    }
    this._enqueue(payload, keyframe, stamp);
  }

  /**
   * Record an event in the diagnostics log.
   *
   * The log may be a plain array or a function. A function is how the panel
   * takes these events as they happen — a decoder being configured, a first
   * frame drawn — so they reach the shared log file at the moment they occur
   * rather than at the next statistics tick a second later. Ordering is the
   * whole point of that file, and a second is an eternity in it.
   */
  note(event, detail) {
    const at = ((performance.now() - this._t0) / 1000).toFixed(2);
    const entry = { at: `${at}s`, event, ...(detail ? { detail } : {}) };
    this.log.push(entry);
    if (this.log.length > 200) this.log.shift();
    // The player keeps its own recent history for the report; the sink is a
    // live copy for whoever wants events as they happen.
    if (this.sink) this.sink(entry);
  }

  /** The log in a form suitable for pasting into a report. */
  report() {
    const lines = [
      `browser: ${navigator.userAgent}`,
      `stream: ${this.info ? JSON.stringify(this.info) : "unknown"}`,
      `string from SPS: ${this.stats.parsedCodec || "not parsed"}`,
      `configurations: ${(this._configs || [])
        .map(
          (c, i) =>
            `${i === this._configIndex ? "→" : " "} ${c.codec} / ${c.hardwareAcceleration}` +
            `${c.codedHeight ? ` / ${c.codedWidth}x${c.codedHeight}` : " / size from stream"}`
        )
        .join("; ") || "none"}`,
      `frames decoded: ${this.stats.decoded}, dropped before decoder: ${this.stats.dropped}, ` +
        `not shown: ${this.stats.skipped || 0}, restarts: ${this.stats.restarts}`,
      "",
      ...this.log.map((l) => `${l.at.padStart(7)}  ${l.event}${l.detail ? "  " + l.detail : ""}`),
    ];
    return lines.join("\n");
  }

  async start(url, token) {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: this.controller.signal,
    });
    this.note("stream request", url.replace(/\?.*/, ""));
    const modes = Object.entries(this.lab)
      .filter(([, on]) => on)
      .map(([name]) => name);
    if (modes.length) this.note("experiment modes", modes.join(", "));
    if (!response.ok) {
      this.note("server refused", String(response.status));
      throw new Error(`${response.status} ${await response.text()}`);
    }

    this._tick = setInterval(() => this._publish(), 1000);
    // In the archive frames are released on a clock, not as they arrive.
    if (this.rate) this._ticker = setInterval(() => this._feed(), 20);
    const reader = response.body.getReader();
    let buffer = new Uint8Array(0);

    const append = (chunk) => {
      const merged = new Uint8Array(buffer.length + chunk.length);
      merged.set(buffer);
      merged.set(chunk, buffer.length);
      buffer = merged;
    };

    try {
      while (true) {
        // Hold back reading until what we have is shown: the browser turns that
        // into backpressure, so the recorder does not push the archive faster
        // than we watch it.
        while (this.rate && this._backlog.length > READ_AHEAD) {
          if (this.controller.signal.aborted) return;
          await new Promise((r) => setTimeout(r, 20));
        }
        const { done, value } = await reader.read();
        if (done) break;
        this._bytes += value.length;
        append(value);

        // the stream header arrives once, first
        if (!this.info) {
          if (buffer.length < 4) continue;
          const size = new DataView(buffer.buffer, buffer.byteOffset).getUint32(0, true);
          if (buffer.length < 4 + size) continue;
          this.info = JSON.parse(new TextDecoder().decode(buffer.subarray(4, 4 + size)));
          buffer = buffer.subarray(4 + size);
          this._needsConfigure = true;
          this.note("stream header", JSON.stringify(this.info));
        }

        // Configure the decoder once a keyframe is in hand: the real profile
        // and level are read from it.
        if (this._needsConfigure) {
          if (buffer.length < 13) continue;
          const head = new DataView(buffer.buffer, buffer.byteOffset);
          const first = head.getUint32(1, true);
          if (buffer.length < 13 + first) continue;
          this._needsConfigure = false;
          this._first = buffer.subarray(13, 13 + first);
          if (!(await this._configure(this._first))) return;
        }

        // then frames: flags, length, timestamp, payload
        while (buffer.length >= 13) {
          const view = new DataView(buffer.buffer, buffer.byteOffset);
          const flags = view.getUint8(0);
          const length = view.getUint32(1, true);
          const stamp = view.getFloat64(5, true);
          if (buffer.length < 13 + length) break;
          this._enqueue(buffer.subarray(13, 13 + length).slice(), flags & 1, stamp);
          buffer = buffer.subarray(13 + length);
        }
      }
    } catch (err) {
      if (err.name !== "AbortError") this.stats.error = String(err.message || err);
    }
  }

  /**
   * The codec string for the decoder.
   *
   * The decoder refines the profile from the stream itself, since frames come in
   * Annex-B together with their parameter sets. The **level, however, must cover
   * the resolution**: at level 4.0 a decoder accepts 704x576 but refuses 4K with
   * a decoder failure.
   */
  _codecString() {
    const pixels = (this.info.width || 0) * (this.info.height || 0);
    if (this.info.codec === "h264") {
      return pixels > 1920 * 1080 ? "avc1.640033" : "avc1.640028";
    }
    return pixels > 1920 * 1080 ? "hev1.1.6.L153.B0" : "hev1.1.6.L120.B0";
  }

  /**
   * Bring up a decoder for this particular stream.
   *
   * Candidates are tried in order and the first one the browser reports as
   * supported wins. Some browsers accept almost any plausible codec string and
   * others do not, so the string read from the stream itself comes first.
   */
  async _configure(keyframe) {
    this.stats.codec = this.info.codec;
    this.stats.resolution = `${this.info.width}x${this.info.height}`;
    const scale = Math.min(1, MAX_CANVAS_WIDTH / Math.max(this.info.width, 1));
    this.canvas.width = Math.round(this.info.width * scale);
    this.canvas.height = Math.round(this.info.height * scale);

    if (!this._configs) {
      this._configs = await this._pickConfigs(keyframe);
      this._configIndex = 0;
      this.note(
        "usable configurations",
        this._configs
          .map(
            (c) =>
              `${c.codec}/${c.hardwareAcceleration}${c.codedHeight ? `/${c.codedHeight}` : "/auto"}`
          )
          .join(", ") || "none"
      );
    }
    const config = this._configs[this._configIndex];
    if (!config) {
      this.stats.error = "The browser does not support this codec";
      this.onFatal(this.stats.error);
      return false;
    }
    this.stats.codecString = config.codec;
    this.stats.hardware = config.hardwareAcceleration;
    this._configStartedAt = performance.now();
    this.note(
      "decoder configuration",
      `${config.codec} / ${config.hardwareAcceleration}` +
        `${config.codedHeight ? ` / ${config.codedWidth}x${config.codedHeight}` : " / size from stream"}`
    );

    this.decoder = new VideoDecoder({
      output: (frame) => this._draw(frame),
      error: (err) => {
        // After a failure the decoder enters the closed state and accepts
        // nothing more, so waiting for a keyframe is not enough: a new decoder
        // is required.
        this.stats.error = String(err.message || err);
        const last = this._last || {};
        this.note(
          "decoder failure",
          `${this.stats.error}; frames ${this.stats.decoded}; ` +
            `last submitted: ${last.keyframe ? "key" : "delta"}, ` +
            `${last.bytes}B, ${last.sinceKey} after the keyframe, ` +
            `keyframes this session ${last.keyframes}, queue ${last.queue}, ` +
            `largest frame ${this._maxFrame}B`
        );
        this._needKey = true;
        this._restartDecoder();
      },
    });
    try {
      this.decoder.configure(config);
    } catch (err) {
      this.stats.error = String(err.message || err);
      this.note("configure() threw", this.stats.error);
      this.onFatal(this.stats.error);
      return false;
    }
    return true;
  }

  async _pickConfigs(keyframe) {
    const pixels = (this.info.width || 0) * (this.info.height || 0);
    const candidates = [];

    if (this.info.codec !== "h264" && keyframe) {
      // The parser returns the tail of the string without a prefix: hvc1 and
      // hev1 differ only in how parameter sets are delivered, and browsers accept
      // different spellings, so both are tried.
      const parsed = parseHevcCodec(keyframe);
      this.stats.parsedCodec = parsed;
      // hev1 comes first on purpose. By MP4 convention `hvc1` means the parameter
      // sets live outside the frames and `hev1` means they are inside the
      // stream. Ours is Annex-B with sets in every keyframe, so hev1 it is.
      if (parsed) candidates.push(`hev1.${parsed}`, `hvc1.${parsed}`);
    }
    if (this.info.codec === "h264") {
      candidates.push(pixels > 1920 * 1080 ? "avc1.640033" : "avc1.640028");
    } else {
      const level = pixels > 1920 * 1080 ? 153 : 120;
      candidates.push(`hev1.1.6.L${level}.B0`, `hvc1.1.6.L${level}.B0`);
    }

    // The search must be short: every failed attempt costs a second or two of
    // flicker. So only the meaningful axes are used: the exact codec string
    // against the guessed one, hvc1 against hev1, and hardware against software.
    // `no-preference` leaves the choice to the browser and is supported
    // everywhere, whereas some browsers reject `prefer-software` at the check
    // stage; without it there would be nowhere to fall back to.
    // The size fields are optional: for Annex-B the decoder takes them from the
    // parameter sets inside the stream, where they are always right. HEVC codes
    // in blocks of up to 64x64, so the true coded height of 4K is 2176 and 2160
    // comes from the conformance window. Declaring 2160 can therefore disagree
    // with what the decoder actually produces, so omitting the fields is tried
    // first.
    const dimensionSets = [
      null,
      { codedWidth: this.info.width, codedHeight: this.info.height },
    ];

    const configs = [];
    const seen = new Set();
    for (const dims of dimensionSets) {
      for (const codec of candidates) {
        for (const acceleration of ["prefer-hardware", "no-preference", "prefer-software"]) {
          const key = `${codec}|${acceleration}|${dims ? "dims" : "auto"}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const config = {
            codec,
            ...(dims || {}),
            hardwareAcceleration: acceleration,
            optimizeForLatency: true,
          };
          try {
            const support = await VideoDecoder.isConfigSupported(config);
            if (support.supported) configs.push(support.config || config);
          } catch (err) {
            /* invalid string; move on to the next candidate */
          }
        }
      }
    }
    return configs;
  }

  /**
   * Bring the decoder back up after a failure.
   *
   * Once it errors the decoder is closed and accepts nothing more, so waiting
   * for a keyframe is not enough: a new instance is needed.
   *
   * If no frame ever decoded, the configuration is fundamentally unusable, and
   * trying five times only prolongs a black screen. Fall back sooner instead.
   */
  _restartDecoder() {
    if (this._restarting || !this.info) return;

    // If the configuration did not last long enough, take another next time:
    // the browser may call it supported on paper while the decoder dies every
    // second, and a handful of frames is not enough to call that working.
    const lived = (performance.now() - this._configStartedAt) / 1000;
    const stable = lived * 1000 > STABLE_AFTER;
    this.note("restart", `configuration lived ${lived.toFixed(1)}s`);
    if (!stable && this._configs && this._configIndex + 1 < this._configs.length) {
      this._configIndex += 1;
      this.stats.error = null;
      this.note("taking the next configuration", `#${this._configIndex + 1}`);
    }

    const neverWorked = this.stats.decoded === 0;
    const exhausted =
      !this._configs ||
      this._configIndex + 1 >= Math.min(this._configs.length, MAX_CYCLE);
    // While untried configurations remain, allow as many attempts as there are
    // left: otherwise the search breaks off halfway and never reaches the one
    // that might have worked.
    const limit = exhausted
      ? (neverWorked ? FUTILE_RESTARTS : MAX_RESTARTS)
      : Math.min(this._configs.length, MAX_CYCLE);
    if (this.stats.restarts >= limit) {
      this.stats.error = neverWorked
        ? "The browser cannot decode this stream"
        : `The decoder failed to start after ${limit} attempts`;
      this.note("giving up", this.stats.error);
      this.onFatal(this.stats.error);
      return;
    }

    this._restarting = true;
    this.stats.restarts += 1;

    try {
      if (this.decoder && this.decoder.state !== "closed") this.decoder.close();
    } catch (err) {
      /* the decoder may already have closed itself */
    }
    this.decoder = null;

    // A short pause so we do not spin if the stream really is unusable.
    setTimeout(async () => {
      if (this.controller.signal.aborted) return;
      // A new decoder means a new timeline; the old one cannot continue.
      this._pts = 0;
      this._wall.clear();
      this._backlog.length = 0;
      await this._configure(this._first);
      this._restarting = false;
    }, 300);
  }

  /**
   * Queue a frame for submission.
   *
   * Submitting immediately is wrong: the recorder sends a whole group of
   * pictures as one burst, and the decoder would receive all of it at once.
   */
  _enqueue(payload, keyframe, stamp) {
    if (this._backlog.length >= BACKLOG) {
      // We are hopelessly behind; only a fresh group of pictures makes sense.
      this._backlog.length = 0;
      this._needKey = true;
      this.stats.dropped += 1;
      this.note("feed queue overflow", `${BACKLOG} frames, waiting for a keyframe`);
    }
    this._backlog.push({ payload, keyframe, stamp });
    this._feed();
  }

  /**
   * Top the decoder up with frames.
   *
   * For live viewing, as soon as space frees up. For the archive, on our own
   * clock so playback runs at the chosen speed instead of all at once.
   */
  _feed() {
    if (this._feeding) return;
    this._feeding = true;
    try {
      const ready = () =>
        this.decoder &&
        this.decoder.state === "configured" &&
        this.decoder.decodeQueueSize < IN_FLIGHT;

      if (!this.rate) {
        while (this._backlog.length && ready()) {
          const item = this._backlog.shift();
          this._decode(item.payload, item.keyframe, item.stamp);
        }
        return;
      }

      if (this.paused) return;
      const now = performance.now();
      while (this._backlog.length) {
        const item = this._backlog[0];
        if (this._clockStart === null) {
          this._clockStart = now;
          this._mediaStart = item.stamp;
        }
        // At high speed only keyframes are shown: the rest could not reach the
        // screen anyway, and decoding them only loads the decoder. A fast-scan
        // is already thinned at the source, so this would leave a slideshow.
        if (!this.decimated && this.rate >= KEYFRAME_ONLY_RATE && !item.keyframe) {
          this._backlog.shift();
          continue;
        }
        const due = this._clockStart + (item.stamp - this._mediaStart) / this.rate;
        if (now < due) break;
        if (!ready()) break;
        this._backlog.shift();
        this.position = item.stamp;
        this._decode(item.payload, item.keyframe, item.stamp);
      }
    } finally {
      this._feeding = false;
    }
  }

  /** Pause playback, leaving the stream open. */
  pause() {
    if (this.paused) return;
    this.paused = true;
    this._pausedAt = performance.now();
  }

  /** Resume from the same point. */
  resume() {
    if (!this.paused) return;
    this.paused = false;
    // The clock must not notice the pause, or frames would pour out at once.
    if (this._pausedAt && this._clockStart !== null) {
      this._clockStart += performance.now() - this._pausedAt;
    }
    this._feed();
  }

  /** Change speed without interrupting the stream. */
  setRate(rate) {
    if (!this.rate || rate === this.rate) return;
    // Anchor the clock to the current point so the new speed counts from here
    // rather than from the start of playback.
    this._clockStart = performance.now();
    this._mediaStart = this.position ?? this._mediaStart;
    this.rate = rate;
    this.note("speed", `${rate}x`);
  }

  _decode(payload, keyframe, stamp) {
    if (!this.decoder || this.decoder.state !== "configured") return;

    // Experiment mode: keyframes only. This removes both the inter-frame
    // dependencies and most of the load, at the same resolution.
    if (this.lab.keyOnly && !keyframe) {
      this.stats.dropped += 1;
      return;
    }

    // A delta frame builds on its predecessors, so it cannot be dropped blindly:
    // the decoder would get a hole in the dependency chain and stop with an
    // error. On overload skip everything up to the next keyframe instead.
    if (this.decoder.decodeQueueSize > queueLimit(this.info.fps)) {
      this._needKey = true;
      this.note("queue overflow", `${this.decoder.decodeQueueSize} frames`);
    }
    if (this._needKey) {
      if (!keyframe) {
        this.stats.dropped += 1;
        return;
      }
      this._needKey = false;
      this.stats.error = null;
    }

    // Context of the last frame submitted: if the decoder dies at a particular
    // point in the group of pictures or on a particular size, it shows here.
    this._last = {
      keyframe: !!keyframe,
      bytes: payload.length,
      sinceKey: keyframe ? 0 : (this._last?.sinceKey ?? 0) + 1,
      keyframes: (this._last?.keyframes ?? 0) + (keyframe ? 1 : 0),
      queue: this.decoder.decodeQueueSize,
    };
    this._maxFrame = Math.max(this._maxFrame || 0, payload.length);

    const pts = this._pts;
    this._pts += Math.round(1e6 / Math.max(this.info.fps || 25, 1));
    // Keep only recent entries so the map does not grow without bound.
    this._wall.set(pts, stamp);
    if (this._wall.size > 120) {
      this._wall.delete(this._wall.keys().next().value);
    }

    try {
      this.decoder.decode(
        new EncodedVideoChunk({
          type: keyframe ? "key" : "delta",
          timestamp: pts,
          data: payload,
        })
      );
    } catch (err) {
      this.stats.error = String(err.message || err);
      this._needKey = true;
    }
  }

  /**
   * Accept a decoded frame.
   *
   * Drawing right here is wrong. `drawImage` from a VideoFrame does not release
   * its buffer at once — in some browsers it lives until the next page
   * composite — so calling `close()` straight after achieves nothing. At 4K
   * that is twelve megabytes per frame.
   *
   * So at most one frame is held: a new one closes its predecessor, and drawing
   * happens exactly once per screen refresh.
   */
  _draw(frame) {
    // The decoder freed space, so more frames can go in.
    queueMicrotask(() => this._feed());
    if (this.stats.decoded === 0) {
      this.note("first frame received", `${frame.displayWidth}x${frame.displayHeight}`);
    }
    this.stats.decoded += 1;
    this._decodedSince += 1;
    // A configuration that holds for a long time has proven itself, so the
    // attempt counter resets; otherwise stray failures would exhaust it.
    if (
      this.stats.restarts &&
      performance.now() - this._configStartedAt > STABLE_AFTER
    ) {
      this.stats.restarts = 0;
      this.stats.error = null;
    }

    // Experiment mode: do not draw. If the decoder survives without drawing,
    // the cause is frame retention on our side rather than the decoder.
    if (this.lab.noPaint) {
      const wall = this._wall.get(frame.timestamp);
      if (wall) {
        this.stats.latency = Date.now() - wall;
        this._wall.delete(frame.timestamp);
      }
      frame.close();
      return;
    }

    if (this._pendingFrame) {
      // The screen never showed the previous frame, so it is already stale.
      this._pendingFrame.close();
      this.stats.skipped = (this.stats.skipped || 0) + 1;
    }
    this._pendingFrame = frame;

    if (this._painting) return;
    this._painting = true;
    requestAnimationFrame(() => {
      this._painting = false;
      const next = this._pendingFrame;
      this._pendingFrame = null;
      if (!next) return;
      const wall = this._wall.get(next.timestamp);
      if (wall) {
        this.stats.latency = Date.now() - wall;
        this._wall.delete(next.timestamp);
      }
      try {
        this.ctx.drawImage(next, 0, 0, this.canvas.width, this.canvas.height);
      } finally {
        next.close();
      }
    });
  }

  _publish() {
    const now = performance.now();
    this._window.push({
      at: now,
      // Measure against elapsed time: browsers slow timers in a hidden tab, and
      // dividing by a nominal second would understate the rate.
      seconds: Math.max((now - this._since) / 1000, 0.001),
      bytes: this._bytes,
      frames: this._decodedSince,
    });
    while (this._window.length > 1 && now - this._window[0].at > RATE_WINDOW * 1000) {
      this._window.shift();
    }

    const totals = this._window.reduce(
      (acc, item) => ({
        seconds: acc.seconds + item.seconds,
        bytes: acc.bytes + item.bytes,
        frames: acc.frames + item.frames,
      }),
      { seconds: 0, bytes: 0, frames: 0 }
    );

    this.stats.fps = Math.round(totals.frames / Math.max(totals.seconds, 0.001));
    this.stats.bitrate = Math.round(
      (totals.bytes * 8) / 1000 / Math.max(totals.seconds, 0.001)
    );
    this.stats.queue = this.decoder ? this.decoder.decodeQueueSize : 0;
    this.stats.backlog = this._backlog.length;
    this.stats.position = this.position;
    this.stats.rate = this.rate;
    this.stats.paused = this.paused;

    this._decodedSince = 0;
    this._bytes = 0;
    this._since = now;
    this.onStats({ ...this.stats });
  }

  stop() {
    clearInterval(this._tick);
    clearInterval(this._ticker);
    this.controller.abort();
    if (this._pendingFrame) {
      this._pendingFrame.close();
      this._pendingFrame = null;
    }
    if (this.decoder && this.decoder.state !== "closed") {
      try {
        this.decoder.close();
      } catch (err) {
        /* the decoder may have closed itself after an error */
      }
    }
    this.decoder = null;
  }
}


//: Record layout of the multiplexed stream: kind, channel, flags, length,
//: timestamp. Sixteen bytes, matching _MUX_HEADER on the server.
const MUX_HEADER_BYTES = 16;
const MUX_INFO = 0;
const MUX_FRAME = 1;
const MUX_HELLO = 2;
const MUX_ERROR = 3;

/**
 * One connection carrying every tile of the wall.
 *
 * A browser allows six connections per host on HTTP/1.1, so sixteen cameras
 * opened separately leave ten of them queued forever. This reads a single
 * response and hands each record to the player that owns that channel.
 */
export class MultiplexReader {
  constructor(sharedLog, onChannelError) {
    this.players = new Map();
    //: Called when the server says a channel is in trouble, so the tile can say
    //: so instead of sitting on "connecting" for as long as the page is open.
    this.onChannelError = onChannelError || (() => {});
    // Either an array to append to, or a function to call as events happen.
    // The panel passes a function so its file log is written in real order.
    this.sink = typeof sharedLog === "function" ? sharedLog : null;
    this.log = this.sink ? [] : sharedLog || [];
    this.controller = new AbortController();
    this.bytes = 0;
    //: Named by the server in the first record, so the channel set of this
    //: response can be edited without reopening it.
    this.session = null;
    //: Settles once the session is known, or once the reader stops without
    //: ever learning it — a caller waiting on it is never left hanging.
    this.ready = new Promise((resolve) => (this._announce = resolve));
  }

  add(channel, player) {
    this.players.set(channel, player);
  }

  /** Drop one channel's player. Records for it are ignored from here on. */
  remove(channel) {
    const player = this.players.get(channel);
    if (!player) return;
    player.stop();
    this.players.delete(channel);
  }

  stop() {
    this._announce();
    this.controller.abort();
    this.players.forEach((player) => player.stop());
    this.players.clear();
  }

  async start(url, token) {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: this.controller.signal,
    });
    if (!response.ok) {
      this._announce();
      throw new Error(`${response.status} ${await response.text()}`);
    }

    const reader = response.body.getReader();
    let buffer = new Uint8Array(0);
    const append = (chunk) => {
      const merged = new Uint8Array(buffer.length + chunk.length);
      merged.set(buffer);
      merged.set(chunk, buffer.length);
      buffer = merged;
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.bytes += value.length;
        append(value);

        while (buffer.length >= MUX_HEADER_BYTES) {
          const view = new DataView(buffer.buffer, buffer.byteOffset);
          const kind = view.getUint8(0);
          const channel = view.getUint16(1, true);
          const flags = view.getUint8(3);
          const length = view.getUint32(4, true);
          const stamp = view.getFloat64(8, true);
          if (buffer.length < MUX_HEADER_BYTES + length) break;
          const payload = buffer.subarray(MUX_HEADER_BYTES, MUX_HEADER_BYTES + length);
          if (kind === MUX_HELLO) {
            this.session = JSON.parse(new TextDecoder().decode(payload)).session;
            this._announce(this.session);
          } else if (kind === MUX_ERROR) {
            const said = JSON.parse(new TextDecoder().decode(payload));
            this.onChannelError(said.channel, said);
          }
          const player = this.players.get(channel);
          if (player) {
            if (kind === MUX_INFO) {
              player.startFed(JSON.parse(new TextDecoder().decode(payload)));
            } else if (kind === MUX_FRAME) {
              // Copy: the buffer this points into is about to be advanced.
              player.pushFrame(payload.slice(), flags & 1, stamp);
            }
          }
          buffer = buffer.subarray(MUX_HEADER_BYTES + length);
        }
      }
    } catch (err) {
      if (err.name !== "AbortError") throw err;
    } finally {
      this._announce(this.session);
    }
  }
}
