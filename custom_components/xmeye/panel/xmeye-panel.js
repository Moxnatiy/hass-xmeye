/**
 * XMeye panel: a full-page view in the spirit of the Energy dashboard.
 *
 * No external dependencies and no build step: a plain web component that Home
 * Assistant loads as an ES module.
 *
 * Live video can be watched three ways, switchable on the fly: the native
 * WebCodecs player (lowest latency, frames arrive from the recorder without
 * repackaging), the stock `ha-camera-stream` over HLS (best compatibility), and
 * a snapshot stream as the fallback.
 */

//: Version stamp taken from this module's own URL. It is passed on to sibling
//: modules, otherwise the browser would serve their cached copies.
const VERSION = new URL(import.meta.url).searchParams.get("v") || "";
const nativeModule = import(`./native-player.js${VERSION ? `?v=${VERSION}` : ""}`);

let NativePlayer = null;
let nativeSupported = typeof VideoDecoder !== "undefined";
nativeModule.then((module) => {
  NativePlayer = module.NativePlayer;
  nativeSupported = module.nativePlayerSupported();
});

const nativePlayerSupported = () => nativeSupported;

//: Wall layouts as found on ordinary recorders. Six and eight are the classic
//: hero arrangements: one large tile with smaller ones around it.
const LAYOUTS = [
  { id: 1, label: "1", columns: 1, rows: 1 },
  { id: 4, label: "2×2", columns: 2, rows: 2 },
  { id: 6, label: "6", columns: 3, rows: 3, hero: 2 },
  { id: 8, label: "8", columns: 4, rows: 4, hero: 3 },
  { id: 9, label: "3×3", columns: 3, rows: 3 },
  { id: 16, label: "4×4", columns: 4, rows: 4 },
];

//: Stream choices offered per tile on the wall.
const WALL_STREAMS = [
  ["sub", "Дод."],
  ["main", "Осн."],
];

//: Playback methods. Native gives the lowest latency, HLS the best
//: compatibility, and the snapshot stream always works but is never smooth.
const PLAYERS = [
  ["native", "Нативний (WebCodecs)"],
  ["hls", "HLS"],
  ["mjpeg", "Стоп-кадри"],
];

//: Thumbnail width in the channel grid. Home Assistant scales the frame itself.
const THUMB_WIDTH = 480;

//: The speed at which playback switches from smooth to seek-based scrubbing.
//: The recorder feeds the archive strictly in real time — measured — so there
//: is simply nothing to spin the stream faster with.
const SCRUB_RATE = 4;

//: How much time to request per seek, and how long to wait for its frame.
const SCRUB_WINDOW = 4000;
const SCRUB_TIMEOUT = 6000;

//: How long to wait for HLS playback to begin before calling it a failure.
//: Home Assistant needs about thirteen seconds to bring up a stream from this
//: recorder (measured: master_playlist waited 13.25 s), so allow headroom.
const HLS_TIMEOUT = 35000;

//: How often to refresh the grid thumbnails.
const THUMB_INTERVAL = 10000;

const EVENT_LABELS = {
  schedule: "За розкладом",
  motion: "Рух",
  alarm: "Тривога",
  manual: "Вручну",
};

const EVENT_COLORS = {
  schedule: "var(--info-color, #2196f3)",
  motion: "var(--warning-color, #ff9800)",
  alarm: "var(--error-color, #f44336)",
  manual: "var(--success-color, #4caf50)",
};

const fmtBytes = (n) => {
  if (!n) return "—";
  const units = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
};

const fmtDuration = (seconds) => {
  if (!seconds && seconds !== 0) return "—";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return `${d} дн ${h} год`;
  if (h) return `${h} год ${m} хв`;
  return `${m} хв`;
};

//: Fixed-width bitrate: without it the line under the video twitches every
//: second as the number moves between three and four digits.
const fmtBitrate = (kbps) => {
  if (!kbps && kbps !== 0) return "—";
  return `${(kbps / 1000).toFixed(3).padStart(7, " ")} Мбіт/с`;
};

const fmtTime = (iso) => (iso ? iso.replace("T", " ").slice(0, 19) : "—");
const fmtDay = (iso) => (iso ? iso.slice(0, 10) : "—");
const fmtClockFull = (iso) => (iso ? iso.replace("T", " ").slice(11, 19) : "—");

//: The recorder lives in local time without zones, so the request matches.
const toLocalIso = (date) => {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
};
const fmtClock = (iso) => (iso ? iso.slice(11, 16) : "");

class XmeyePanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._devices = [];
    this._entryId = null;
    this._detail = null;
    this._tab = "overview";
    this._selectedChannel = 0;
    this._live = null;
    this._player = nativePlayerSupported() ? "native" : "hls";
    this._liveStream = "sub";
    this._native = null;
    this._osd = null;
    this._osdTimer = null;
    //: The diagnostics log lives on the panel rather than the player: the most
    //: interesting part is what happened while switching stream or player, and
    //: a log owned by the player would vanish along with it.
    this._diagLog = [];
    //: Experiment modes for the native player. They narrow down a failure by
    //: halving the search space instead of guessing again.
    this._lab = { keyOnly: false, noPaint: false };
    //: Wall players on the overview, one per channel.
    this._wall = new Map();
    //: The chosen wall layout and page number when channels outnumber it.
    this._layout = Number(localStorage.getItem("xmeye-layout")) || 4;
    this._wallPage = 0;
    //: Archive playback state. The player object is deliberately NOT `_player`:
    //: that field holds the live playback method, and one field serving both
    //: meanings let `_stopPlayback()` wipe the method and drop the viewer to
    //: snapshots.
    this._playback = null;
    this._archivePlayer = null;
    this._recordings = null;
    this._recordingsDay = new Date().toISOString().slice(0, 10);
    this._configTree = null;
    this._configSection = null;
    this._configValue = null;
    this._log = null;
    this._error = null;
    this._loading = true;
    this._timer = null;
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) this._bootstrap();
    else if (this._detail) this._renderIfIdle();
  }

  set narrow(value) {
    this._narrow = value;
  }

  connectedCallback() {
    // Figures change often, frames do not: the recorder emits a keyframe every
    // one to two seconds, so refreshing thumbnails faster buys nothing.
    this._timer = setInterval(() => this._refresh(), 15000);
    this._thumbTimer = setInterval(() => {
      if (this._live === null && this._tab === "channels") this._refreshThumbnails();
    }, THUMB_INTERVAL);
  }

  disconnectedCallback() {
    clearInterval(this._timer);
    clearInterval(this._thumbTimer);
    this._stopWall();
    this._stopPlayback();
  }

  async _ws(message) {
    return this._hass.callWS(message);
  }

  async _bootstrap() {
    try {
      const { devices } = await this._ws({ type: "xmeye/devices" });
      this._devices = devices;
      if (!devices.length) {
        this._error = "Жодного реєстратора не налаштовано.";
        this._loading = false;
        return this._render();
      }
      this._entryId = devices[0].entry_id;
      await this._loadDetail();
    } catch (err) {
      this._error = String(err.message || err);
      this._loading = false;
      this._render();
    }
  }

  async _loadDetail() {
    this._loading = true;
    this._render();
    try {
      this._detail = await this._ws({ type: "xmeye/device", entry_id: this._entryId });
      this._error = null;
      const enabled = this._detail.channels.filter((c) => c.enabled);
      if (enabled.length && !enabled.some((c) => c.index === this._selectedChannel)) {
        this._selectedChannel = enabled[0].index;
      }
    } catch (err) {
      this._error = err.message || String(err);
    }
    this._loading = false;
    this._render();
  }

  async _refresh() {
    if (!this._entryId || this._loading) return;
    try {
      this._detail = await this._ws({ type: "xmeye/device", entry_id: this._entryId });
      this._renderIfIdle();
    } catch (err) {
      /* a transient outage; it will show on the next cycle */
    }
  }

  /**
   * Update only what changed.
   *
   * A full redraw every fifteen seconds would tear down the wall and archive
   * players, so only values marked with data-field are touched.
   */
  _patch() {
    if (!this._detail) return;
    const d = this._detail;
    const root = this.shadowRoot;
    const set = (field, value) => {
      const el = root.querySelector(`[data-field="${field}"]`);
      if (el && el.textContent !== String(value)) el.textContent = value;
    };
    const disk = d.storage[0] && d.storage[0].partitions[0];

    set("facts_channels", `${d.channels.filter((c) => c.online).length} / ${d.device.channels}`);
    set("facts_channels_hint", `запис: ${d.totals.recording}`);
    set("facts_bitrate", fmtBitrate(d.totals.bitrate));
    set("facts_disk", disk ? `${disk.used_percent}%` : "—");
    set("facts_archive", fmtDay(d.archive.from));
    set("facts_archive_hint", `по ${fmtDay(d.archive.to)}`);
    set("facts_uptime", fmtDuration(d.device.uptime_seconds));
    set("facts_uptime_hint", fmtClockFull(d.device.device_time));

    d.channels.forEach((channel) => {
      const cell = root.querySelector(`.cell[data-channel="${channel.index}"]`);
      if (cell) {
        cell.classList.toggle("offline", !channel.online);
        const badges = cell.querySelector(".badges");
        if (badges) badges.innerHTML = this._badges(channel);
      }
    });
  }

  _renderIfIdle() {
    // While the live overlay is open the structure stays put: rebuilding the
    // DOM would interrupt playback.
    if (this._live !== null) return;
    this._patch();
  }

  async _loadRecordings() {
    const day = this._recordingsDay;
    this._recordings = { loading: true };
    this._render();
    try {
      this._recordings = await this._ws({
        type: "xmeye/recordings",
        entry_id: this._entryId,
        channel: this._selectedChannel,
        start: `${day}T00:00:00`,
        end: `${day}T23:59:59`,
      });
    } catch (err) {
      this._recordings = { error: err.message || String(err) };
    }
    this._render();
  }

  async _loadConfigTree() {
    this._configTree = { loading: true };
    this._render();
    try {
      this._configTree = await this._ws({
        type: "xmeye/config_tree",
        entry_id: this._entryId,
      });
    } catch (err) {
      this._configTree = { error: err.message || String(err) };
    }
    this._render();
  }

  async _loadConfigSection(section) {
    this._configSection = section;
    this._configValue = { loading: true };
    this._render();
    try {
      const res = await this._ws({
        type: "xmeye/config",
        entry_id: this._entryId,
        section,
      });
      this._configValue = res.value;
    } catch (err) {
      this._configValue = { error: err.message || String(err) };
    }
    this._render();
  }

  async _loadLog() {
    this._log = { loading: true };
    this._render();
    try {
      this._log = await this._ws({ type: "xmeye/log", entry_id: this._entryId, hours: 24 });
    } catch (err) {
      this._log = { error: err.message || String(err) };
    }
    this._render();
  }

  _pictureUrl(entityId, width) {
    const state = this._hass.states[entityId];
    const picture = state && state.attributes.entity_picture;
    if (!picture) return null;
    // The recorder serves 4K, which a thumbnail has no use for, and Home
    // Assistant can scale it server-side, saving both bandwidth and encoding.
    return width ? `${picture}&width=${width}` : picture;
  }

  /**
   * Refresh thumbnails without flicker.
   *
   * Changing src directly leaves the card blank while it loads, so the new
   * frame is fetched into memory first and swapped in once ready.
   */
  _refreshThumbnails() {
    this.shadowRoot.querySelectorAll("img[data-entity]").forEach((img) => {
      const url = this._pictureUrl(img.dataset.entity, THUMB_WIDTH);
      if (!url) return;
      const next = `${url}&_=${Date.now()}`;
      const preload = new Image();
      preload.onload = () => {
        img.src = next;
        img.classList.add("ready");
      };
      preload.src = next;
    });
  }

  /**
   * Bring up the chosen player.
   *
   * The native path gives the lowest latency, HLS the best compatibility, and
   * the snapshot stream remains the fallback that works anywhere.
   */
  /** The camera entity matching the selected stream. */
  _entityForStream(channel) {
    if (!channel) return null;
    return (channel.entity_ids && channel.entity_ids[this._liveStream]) || channel.entity_id;
  }

  async _mountLiveCard(entityId) {
    const holder = this.shadowRoot.getElementById("livecard");
    if (!holder) return;

    this._teardownPlayer();
    clearInterval(this._osdTimer);
    this._osd = null;
    this._videoStatsPrev = null;

    if (this._player === "native") {
      const canvas = document.createElement("canvas");
      canvas.className = "live";
      holder.replaceChildren(canvas);

      const { NativePlayer: Player } = await nativeModule;
      const player = new Player(
        canvas,
        (stats) => {
          this._osd = stats;
          this._updateOsd();
        },
        (reason) => this._fallbackFromNative(reason),
        this._diagLog,
        { ...this._lab }
      );
      this._native = player;
      const url =
        `/api/xmeye/native/${this._entryId}/${this._live}` +
        `?stream=${this._liveStream}`;
      player.start(url, this._hass.auth.accessToken).catch((err) => {
        this._osd = { player: "native", error: String(err.message || err) };
        this._updateOsd();
      });
      return;
    }

    if (this._player === "hls" && entityId) {
      // show a frame right away so there is no gap while the player loads
      this._startSnapshotLoop(entityId, holder);
      await customElements.whenDefined("ha-camera-stream");
      if (this._live === null || !holder.isConnected) return;
      const stateObj = this._hass.states[entityId];
      if (!stateObj) return;
      this._stopSnapshotLoop();
      const player = document.createElement("ha-camera-stream");
      player.hass = this._hass;
      player.stateObj = stateObj;
      player.controls = true;
      player.muted = true;
      holder.replaceChildren(player);
      this._liveCard = player;
      this._hlsSince = performance.now();
      this._osdTimer = setInterval(() => this._collectVideoStats(), 1000);
      return;
    }

    if (!entityId) {
      holder.replaceChildren();
      return;
    }
    this._startSnapshotLoop(entityId, holder);
    this._osdTimer = setInterval(() => this._collectVideoStats(), 1000);
  }

  /**
   * Show a channel as a sequence of individual frames.
   *
   * The stock `/api/camera_proxy_stream` serves a multipart stream that Safari
   * cannot hold through the Home Assistant service worker: the request aborts
   * with "Load failed". Plain frames are short ordinary requests and work in
   * any browser. Each new frame is swapped in already loaded, so nothing blinks.
   */
  _startSnapshotLoop(entityId, holder) {
    this._stopSnapshotLoop();
    const img = document.createElement("img");
    img.className = "live";
    holder.replaceChildren(img);
    this._snapshots = { loaded: 0, errors: 0, since: performance.now() };

    const tick = () => {
      const url = this._pictureUrl(entityId, null);
      if (!url) return;
      const preload = new Image();
      preload.onload = () => {
        if (!img.isConnected) return;
        img.src = preload.src;
        this._snapshots.loaded += 1;
      };
      preload.onerror = () => {
        this._snapshots.errors += 1;
      };
      preload.src = `${url}&_=${Date.now()}`;
    };

    tick();
    this._snapTimer = setInterval(tick, 1000);
  }

  _stopSnapshotLoop() {
    clearInterval(this._snapTimer);
    this._snapTimer = null;
  }

  /**
   * Fall back when the native decoder cannot cope.
   *
   * Rather than a black screen with a warning, switch to something that surely
   * works: the smaller stream first, and snapshots if that fails too.
   */
  _fallbackFromNative(reason) {
    if (this._live === null || this._player !== "native") return;
    this._noteDiag("відступ", reason);
    if (this._liveStream === "main") {
      this._liveStream = "sub";
      this._fallbackNote = `${reason}. Перейшов на додатковий потік.`;
    } else {
      this._player = "mjpeg";
      this._fallbackNote = `${reason}. Перейшов на стоп-кадри.`;
    }
    this._remountLive();
  }

  _teardownPlayer() {
    if (this._native) {
      this._native.stop();
      this._native = null;
    }
    this._stopSnapshotLoop();
    this._hlsSince = null;
    this._liveCard = null;
  }

  _openLive(channel) {
    this._live = channel;
    this._render();
    const item = this._detail.channels.find((c) => c.index === channel);
    if (item) this._mountLiveCard(this._entityForStream(item));
  }

  _closeLive() {
    // Stop the player first: otherwise the request to the recorder stays open,
    // and it only has a handful of connections to give.
    this._teardownPlayer();
    clearInterval(this._osdTimer);
    this._osdTimer = null;
    this._live = null;
    this._osd = null;
    this._render();
  }

  /** Rebuild the player after the playback method or stream changes. */
  _remountLive() {
    const channel = this._detail.channels.find((c) => c.index === this._live);
    this._noteDiag("перемикання", `плеєр ${this._player}, потік ${this._liveStream}`);
    this._render();
    if (channel) this._mountLiveCard(this._entityForStream(channel));
  }

  /** Append an event to the shared diagnostics log. */
  _noteDiag(event, detail) {
    const at = new Date().toTimeString().slice(0, 8);
    this._diagLog.push({ at, event, ...(detail ? { detail } : {}) });
    if (this._diagLog.length > 300) this._diagLog.shift();
  }

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------

  _render() {
    // The wall holds connections to the recorder, so it must stop before a
    // redraw; otherwise every render would leak one player per channel.
    this._stopWall();
    this.shadowRoot.innerHTML = `<style>${STYLES}</style>${this._template()}`;
    this._bind();
    if (this._tab === "overview" && this._detail && this._live === null) {
      this._startWall();
    }
  }

  _template() {
    if (this._loading && !this._detail) return this._shell(`<div class="empty">Завантаження…</div>`);
    if (this._error && !this._detail)
      return this._shell(`<div class="empty error">${this._error}</div>`);
    if (!this._detail) return this._shell(`<div class="empty">Немає даних</div>`);

    const tabs = {
      overview: this._overview(),
      channels: this._channels(),
      archive: this._archive(),
      config: this._config(),
      log: this._logView(),
    };
    return this._shell(tabs[this._tab] || tabs.overview);
  }

  _shell(body) {
    const d = this._detail;
    const tabs = [
      ["overview", "Огляд"],
      ["channels", "Канали"],
      ["archive", "Архів"],
      ["config", "Конфігурація"],
      ["log", "Журнал"],
    ];
    const picker =
      this._devices.length > 1
        ? `<select id="device">${this._devices
            .map(
              (dev) =>
                `<option value="${dev.entry_id}" ${
                  dev.entry_id === this._entryId ? "selected" : ""
                }>${dev.title}</option>`
            )
            .join("")}</select>`
        : "";

    return `
      <div class="page">
        <header>
          <div class="ident">
            <h1>${d ? d.device.model || d.title : "XMeye"}</h1>
            <div class="sub">${d ? `${d.host} · ${d.device.firmware}` : ""}</div>
          </div>
          ${d ? this._headerFacts(d) : ""}
          ${picker}
        </header>
        <nav>
          ${tabs
            .map(
              ([key, label]) =>
                `<button class="tab ${this._tab === key ? "active" : ""}" data-tab="${key}">${label}</button>`
            )
            .join("")}
        </nav>
        <main>${body}</main>
        ${this._live !== null ? this._liveOverlay() : ""}
      </div>`;
  }

  /**
   * Recorder facts in the header.
   *
   * This used to take six cards and half the screen, repeating the model that
   * the title already shows. Here the same numbers sit side by side and leave
   * the room to what matters: the channel wall.
   */
  _headerFacts(d) {
    const disk = d.storage[0] && d.storage[0].partitions[0];
    const facts = [
      ["Канали", `${d.channels.filter((c) => c.online).length} / ${d.device.channels}`,
       `запис: ${d.totals.recording}`, "facts_channels"],
      ["Потік", fmtBitrate(d.totals.bitrate), "", "facts_bitrate"],
      ["Диск", disk ? `${disk.used_percent}%` : "—",
       disk ? `${(disk.total_mb / 1024).toFixed(0)} ГБ` : "", "facts_disk"],
      ["Архів", fmtDay(d.archive.from), `по ${fmtDay(d.archive.to)}`, "facts_archive"],
      ["Працює", fmtDuration(d.device.uptime_seconds), fmtClockFull(d.device.device_time),
       "facts_uptime"],
    ];
    return `
      <div class="facts">
        ${facts
          .map(
            ([label, value, hint, field]) => `
          <div class="fact">
            <div class="fact-label">${label}</div>
            <div class="fact-value" data-field="${field}">${value}</div>
            <div class="fact-hint" data-field="${field}_hint">${hint}</div>
          </div>`
          )
          .join("")}
      </div>`;
  }

  /**
   * Overview: a wall of channels laid out like a recorder's.
   *
   * Each tile shows live video through WebCodecs on the sub stream, which is
   * light enough that several channels together overload neither the browser
   * nor the device. Rounded corners and gaps are left out on purpose so the
   * wall reads as one canvas.
   */
  _overview() {
    const enabled = this._detail.channels.filter((c) => c.enabled);
    const sequence = this._wallSequence(enabled);
    const channels = this._wallVisible(enabled);
    const layout = LAYOUTS.find((l) => l.id === this._layout) || LAYOUTS[1];
    const pages = Math.max(1, Math.ceil(channels.length / layout.id));
    this._wallPage = Math.min(this._wallPage, pages - 1);

    const shown = channels.slice(this._wallPage * layout.id, (this._wallPage + 1) * layout.id);
    // Empty slots stay visible so the wall does not jump when a channel appears.
    const cells = [
      ...shown.map((c, i) => this._wallTile(c, layout, i)),
      ...Array.from({ length: layout.id - shown.length }, (_, i) =>
        this._emptyCell(layout, shown.length + i)
      ),
    ];

    return `
      <div class="toolbar wall-bar">
        <div class="layouts">
          ${LAYOUTS.map(
            (l) =>
              `<button class="ghost layout ${l.id === this._layout ? "active" : ""}"
                       data-layout="${l.id}" title="${l.id} каналів">${l.label}</button>`
          ).join("")}
        </div>
        ${
          pages > 1
            ? `<div class="pager">
                 <button class="ghost" id="wallprev">‹</button>
                 <span>${this._wallPage + 1} / ${pages}</span>
                 <button class="ghost" id="wallnext">›</button>
               </div>`
            : ""
        }
        <div class="hint">${channels.length} з ${this._detail.device.channels} каналів на стіні</div>
      </div>
      <div class="wall-layout">
        ${this._wallPicker(sequence)}
        <div class="wall" style="--columns:${layout.columns};--rows:${layout.rows}">
          ${cells.join("")}
        </div>
      </div>`;
  }

  /**
   * The channel picker beside the wall.
   *
   * A recorder lets the operator choose which cameras go on the wall and in
   * what order, so the same is possible here: a click on the marker takes a
   * channel off the wall, and the arrows move it between the tiles.
   */
  _wallPicker(sequence) {
    const hidden = this._loadWallPrefs().hidden;
    const rows = sequence.map((channel, position) => {
      const shown = !hidden.includes(channel.index);
      return `
        <li class="pick ${shown ? "on" : "off"}">
          <button class="pick-eye" data-pick="${channel.index}"
                  title="${shown ? "Прибрати зі стіни" : "Показати на стіні"}">
            ${shown ? "◉" : "○"}
          </button>
          <span class="pick-num">${channel.index + 1}</span>
          <span class="pick-name" title="${channel.name}">${channel.name}</span>
          <span class="pick-dot ${channel.online ? "online" : ""}"></span>
          <select class="pick-stream" data-stream="${channel.index}"
                  title="Потік цієї камери на стіні">
            ${WALL_STREAMS.map(
              ([id, label]) =>
                `<option value="${id}" ${
                  id === this._wallStream(channel.index) ? "selected" : ""
                }>${label}</option>`
            ).join("")}
          </select>
          <span class="pick-move">
            <button class="ghost" data-move-up="${position}"
                    ${position === 0 ? "disabled" : ""} title="Вище">▴</button>
            <button class="ghost" data-move-down="${position}"
                    ${position === sequence.length - 1 ? "disabled" : ""} title="Нижче">▾</button>
          </span>
        </li>`;
    });
    return `
      <aside class="picker">
        <div class="picker-head">Канали стіни</div>
        <ul class="pick-list">${rows.join("")}</ul>
      </aside>`;
  }

  /**
   * Which channels the wall shows and in what order.
   *
   * The choice belongs to the recorder rather than the browser session, so it
   * is kept per config entry and survives a reload.
   */
  _loadWallPrefs() {
    if (this._wallPrefs && this._wallPrefs.entry === this._entryId) return this._wallPrefs;
    let stored = {};
    try {
      stored = JSON.parse(localStorage.getItem(`xmeye-wall-${this._entryId}`)) || {};
    } catch (err) {
      stored = {};
    }
    this._wallPrefs = {
      entry: this._entryId,
      order: Array.isArray(stored.order) ? stored.order.map(Number) : [],
      hidden: Array.isArray(stored.hidden) ? stored.hidden.map(Number) : [],
      //: Per-channel stream choice, keyed by channel index.
      streams: stored.streams && typeof stored.streams === "object" ? stored.streams : {},
    };
    return this._wallPrefs;
  }

  _saveWallPrefs() {
    const { order, hidden, streams } = this._loadWallPrefs();
    localStorage.setItem(
      `xmeye-wall-${this._entryId}`,
      JSON.stringify({ order, hidden, streams })
    );
  }

  /** Which stream a wall tile shows. Sub by default: several 4K tiles at once
   *  overload both the browser and the recorder. */
  _wallStream(index) {
    const chosen = this._loadWallPrefs().streams[index];
    return chosen === "main" ? "main" : "sub";
  }

  _setWallStream(index, stream) {
    this._loadWallPrefs().streams[index] = stream;
    this._saveWallPrefs();
    // Only this tile is restarted: a full redraw would reconnect every channel,
    // and the recorder has about ten connections to give in total.
    this._restartWallTile(index);
  }

  /** Enabled channels in the chosen order; ones the recorder gains join at the end. */
  _wallSequence(channels) {
    const prefs = this._loadWallPrefs();
    const known = new Map(channels.map((c) => [c.index, c]));
    const chosen = prefs.order.map((index) => known.get(index)).filter(Boolean);
    const fresh = channels.filter((c) => !prefs.order.includes(c.index));
    const sequence = [...chosen, ...fresh];
    // Drop channels that are gone, so the stored order does not grow forever.
    prefs.order = sequence.map((c) => c.index);
    return sequence;
  }

  /** The part of the sequence that actually goes on the wall. */
  _wallVisible(channels) {
    const { hidden } = this._loadWallPrefs();
    return this._wallSequence(channels).filter((c) => !hidden.includes(c.index));
  }

  _toggleWallChannel(index) {
    const { hidden } = this._loadWallPrefs();
    const at = hidden.indexOf(index);
    if (at === -1) hidden.push(index);
    else hidden.splice(at, 1);
    this._wallPage = 0;
    this._saveWallPrefs();
    this._render();
  }

  _moveWallChannel(position, step) {
    const enabled = this._detail.channels.filter((c) => c.enabled);
    const order = this._wallSequence(enabled).map((c) => c.index);
    const target = position + step;
    if (target < 0 || target >= order.length) return;
    [order[position], order[target]] = [order[target], order[position]];
    this._loadWallPrefs().order = order;
    this._saveWallPrefs();
    this._render();
  }

  /** Tile style: in hero layouts the first tile spans a larger block. */
  _cellSpan(layout, position) {
    if (!layout.hero || position !== 0) return "";
    return `grid-column: span ${layout.hero}; grid-row: span ${layout.hero};`;
  }

  _emptyCell(layout, position) {
    return `<div class="cell empty-cell" style="${this._cellSpan(layout, position)}"></div>`;
  }

  _wallTile(channel, layout, position) {
    return `
      <div class="cell ${channel.online ? "" : "offline"}" data-channel="${channel.index}"
           style="${this._cellSpan(layout, position)}">
        <canvas data-wall="${channel.index}"></canvas>
        <div class="cell-overlay">
          <div class="cell-name">${channel.index + 1}. ${channel.name}</div>
          <div class="badges">${this._badges(channel)}</div>
        </div>
        <div class="cell-foot" data-field="wall${channel.index}">
          ${channel.online ? "підключення…" : "офлайн"}
        </div>
      </div>`;
  }

  /** Start wall players for every enabled channel. */
  async _startWall() {
    this._stopWall();
    const { nativePlayerSupported: supported } = await nativeModule;
    if (!supported()) return;

    for (const canvas of this.shadowRoot.querySelectorAll("canvas[data-wall]")) {
      await this._startWallTile(canvas);
    }
  }

  /** Bring up one tile on the stream chosen for its channel. */
  async _startWallTile(canvas) {
    const { NativePlayer: Player } = await nativeModule;
    const index = Number(canvas.dataset.wall);
    const player = new Player(
      canvas,
      (stats) => this._updateWallCell(index, stats),
      () => this._updateWallCell(index, { error: "не вдалося декодувати" }),
      this._diagLog
    );
    this._wall.set(index, player);
    player
      .start(
        `/api/xmeye/native/${this._entryId}/${index}?stream=${this._wallStream(index)}`,
        this._hass.auth.accessToken
      )
      .catch((err) => this._updateWallCell(index, { error: String(err.message || err) }));
  }

  async _restartWallTile(index) {
    const running = this._wall.get(index);
    if (running) {
      // Stop before anything is awaited, so the old connection is gone before
      // the new one asks the recorder for the same channel.
      running.stop();
      this._wall.delete(index);
    }
    const canvas = this.shadowRoot.querySelector(`canvas[data-wall="${index}"]`);
    if (!canvas) return;
    this._updateWallCell(index, { connecting: true });
    await this._startWallTile(canvas);
  }

  _stopWall() {
    this._wall.forEach((player) => player.stop());
    this._wall.clear();
  }

  _updateWallCell(index, stats) {
    const foot = this.shadowRoot.querySelector(`[data-field="wall${index}"]`);
    if (!foot) return;
    if (stats.error) {
      foot.textContent = `⚠ ${stats.error}`;
    } else if (stats.connecting) {
      foot.textContent = "підключення…";
    } else {
      foot.textContent =
        `${stats.resolution || "—"} · ${stats.fps || 0} к/с · ${fmtBitrate(stats.bitrate)}`;
    }
  }

  _badges(channel) {
    return [
      channel.recording ? `<span class="badge rec">запис</span>` : "",
      channel.motion ? `<span class="badge motion">рух</span>` : "",
      channel.video_loss ? `<span class="badge loss">немає сигналу</span>` : "",
    ].join("");
  }

  _channelTile(channel) {
    const picture = channel.entity_id
      ? this._pictureUrl(channel.entity_id, THUMB_WIDTH)
      : null;

    return `
      <div class="card tile ${channel.online ? "" : "offline"}" data-channel="${channel.index}">
        <div class="thumb">
          ${
            picture
              ? `<img src="${picture}" data-entity="${channel.entity_id}"
                      alt="${channel.name}" loading="lazy">`
              : `<div class="noimage">${channel.online ? "Немає кадру" : "Офлайн"}</div>`
          }
          <div class="badges">${this._badges(channel)}</div>
        </div>
        <div class="tile-body">
          <div class="tile-name">${channel.name}</div>
          <div class="tile-meta" data-field="meta">${
            channel.resolution || channel.status
          } · ${channel.bitrate} кбіт/с</div>
        </div>
      </div>`;
  }

  _channels() {
    const d = this._detail;
    return `
      <table class="data">
        <thead>
          <tr><th>#</th><th>Назва</th><th>Стан</th><th>Роздільність</th>
              <th>Бітрейт</th><th>Запис</th><th>Рух</th></tr>
        </thead>
        <tbody>
          ${d.channels
            .map(
              (c) => `
            <tr class="${c.online ? "" : "dim"}">
              <td>${c.index + 1}</td>
              <td>${c.name}</td>
              <td>${c.online ? "Підключено" : c.status}</td>
              <td>${c.resolution || "—"}</td>
              <td>${c.bitrate || 0}</td>
              <td>${c.recording ? "так" : "—"}</td>
              <td>${c.motion ? "так" : "—"}</td>
            </tr>`
            )
            .join("")}
        </tbody>
      </table>`;
  }

  _archive() {
    const d = this._detail;
    const enabled = d.channels.filter((c) => c.enabled);
    const rec = this._recordings;

    let body = `<div class="empty">Оберіть день і натисніть «Показати».</div>`;
    if (rec && rec.loading) body = `<div class="empty">Шукаю записи…</div>`;
    else if (rec && rec.error) body = `<div class="empty error">${rec.error}</div>`;
    else if (rec && rec.recordings) body = this._timeline(rec);

    return `
      <div class="toolbar">
        <select id="channel">
          ${enabled
            .map(
              (c) =>
                `<option value="${c.index}" ${
                  c.index === this._selectedChannel ? "selected" : ""
                }>${c.index + 1}. ${c.name}</option>`
            )
            .join("")}
        </select>
        <input type="date" id="day" value="${this._recordingsDay}">
        <button class="primary" id="search">Показати</button>
      </div>
      ${this._playback ? this._playbackView() : ""}
      ${body}`;
  }

  /**
   * Archive player.
   *
   * Frames travel the same path as live ones, only bounded by a time range.
   * Speed is set by the player's own clock rather than the recorder, so
   * scrubbing needs neither a device command nor a fresh query.
   */
  _playbackView() {
    const p = this._playback;
    const rates = [1, 2, 4, 8, 16];
    return `
      <div class="player">
        <div class="player-head">
          <span>${fmtClockFull(p.start)} — канал ${this._selectedChannel + 1}</span>
          <button class="ghost" id="closeplay">✕</button>
        </div>
        <div class="player-screen"><canvas id="playcanvas"></canvas></div>
        <div class="player-bar">
          <button class="ghost" id="playpause">${p.paused ? "▶" : "⏸"}</button>
          <button class="ghost" id="stepback" title="назад на 10 с">⏪</button>
          <button class="ghost" id="stepfwd" title="вперед на 10 с">⏩</button>
          <div class="rates">
            ${rates
              .map(
                (r) =>
                  `<button class="ghost rate ${p.rate === r ? "active" : ""}" data-rate="${r}">×${r}</button>`
              )
              .join("")}
          </div>
          <div class="player-time" id="playtime">${fmtClockFull(p.position || p.start)}</div>
        </div>
      </div>`;
  }

  /**
   * Fast scrubbing by seeking.
   *
   * The recorder feeds the archive strictly in real time and has no
   * fast-forward command — measured: both the main and the sub stream run at
   * exactly 1.0x. So at high speeds playback is not accelerated but stepped:
   * one frame is taken from points spaced by the desired stride. The result is
   * what scrubbing is expected to look like, without dragging the whole stream.
   */
  async _scrubLoop() {
    const { NativePlayer: Player } = await nativeModule;
    while (this._playback && this._playback.rate >= SCRUB_RATE && !this._playback.paused) {
      const from = new Date(this._playback.position || this._playback.start);
      const started = performance.now();

      const canvas = this.shadowRoot.getElementById("playcanvas");
      if (!canvas) return;
      const shot = new Player(canvas, () => {}, () => {}, this._diagLog, {});
      this._archivePlayer = shot;
      const params = new URLSearchParams({
        start: toLocalIso(from),
        end: toLocalIso(new Date(from.getTime() + SCRUB_WINDOW)),
      });
      shot
        .start(
          `/api/xmeye/playback/${this._entryId}/${this._selectedChannel}?${params}`,
          this._hass.auth.accessToken
        )
        .catch(() => {});

      // Wait for the first drawn frame, or give up if this spot is empty.
      const deadline = performance.now() + SCRUB_TIMEOUT;
      while (shot.stats.decoded === 0 && performance.now() < deadline) {
        if (!this._playback || this._playback.rate < SCRUB_RATE) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      shot.stop();
      if (!this._playback || this._playback.rate < SCRUB_RATE) return;

      const spent = (performance.now() - started) / 1000;
      const advance = Math.max(this._playback.rate * spent, this._playback.rate);
      this._playback.position = new Date(from.getTime() + advance * 1000).toISOString();
      this._playback.actual = advance / spent;
      this._updateScrubLabels();

      // Reached the end of the day; stop.
      if (new Date(this._playback.position) >= new Date(this._playback.end)) return;
    }
  }

  _updateScrubLabels() {
    const label = this.shadowRoot.getElementById("playtime");
    if (label) {
      label.textContent =
        fmtClockFull(this._playback.position) +
        (this._playback.actual ? `  (фактично ×${this._playback.actual.toFixed(1)})` : "");
    }
    const cursor = this.shadowRoot.getElementById("cursor");
    if (cursor) cursor.style.left = `${this._cursorShare()}%`;
  }

  /** Start playback from a given moment. */
  async _startPlayback(when) {
    this._stopPlayback();
    const day = this._recordingsDay;
    const start = when instanceof Date ? when : new Date(`${day}T00:00:00`);
    const end = new Date(`${day}T23:59:59`);
    this._playback = {
      start: start.toISOString(),
      end: end.toISOString(),
      rate: this._playback ? this._playback.rate : 1,
      paused: false,
      position: null,
    };
    this._render();

    if (this._playback.rate >= SCRUB_RATE) {
      this._playback.position = start.toISOString();
      this._scrubLoop();
      return;
    }

    const canvas = this.shadowRoot.getElementById("playcanvas");
    if (!canvas) return;
    const { NativePlayer: Player } = await nativeModule;
    const player = new Player(
      canvas,
      (stats) => this._updatePlaybackTime(stats),
      (reason) => {
        this._playback.error = reason;
        this._render();
      },
      this._diagLog,
      {},
      { rate: this._playback.rate }
    );
    this._archivePlayer = player;

    const params = new URLSearchParams({
      start: toLocalIso(start),
      end: toLocalIso(end),
    });
    player
      .start(
        `/api/xmeye/playback/${this._entryId}/${this._selectedChannel}?${params}`,
        this._hass.auth.accessToken
      )
      .catch((err) => {
        this._playback.error = String(err.message || err);
        this._render();
      });
  }

  _cursorShare() {
    if (!this._playback || !this._playback.position) return 0;
    const dayStart = new Date(`${this._recordingsDay}T00:00:00`).getTime();
    const at = new Date(this._playback.position).getTime();
    return Math.max(0, Math.min(100, ((at - dayStart) / 86400000) * 100));
  }

  _stopPlayback() {
    if (this._archivePlayer) {
      this._archivePlayer.stop();
      this._archivePlayer = null;
    }
  }

  _closePlayback() {
    this._stopPlayback();
    this._playback = null;
    this._render();
  }

  /** Update the time and cursor without redrawing the player. */
  _updatePlaybackTime(stats) {
    if (!this._playback || !stats.position) return;
    const previous = this._playback.position;
    this._playback.position = new Date(stats.position).toISOString();

    // The recorder feeds the archive at its own pace and may not reach the
    // requested 8x, so the measured speed is shown next to the requested one.
    const now = performance.now();
    if (previous && this._playback.measuredAt) {
      const media = (new Date(this._playback.position) - new Date(previous)) / 1000;
      const wall = (now - this._playback.measuredAt) / 1000;
      if (wall > 0.5) this._playback.actual = media / wall;
    }
    this._playback.measuredAt = now;

    const label = this.shadowRoot.getElementById("playtime");
    if (label) {
      const actual = this._playback.actual;
      label.textContent =
        fmtClockFull(this._playback.position) +
        (actual ? `  (фактично ×${actual.toFixed(1)})` : "");
    }

    const cursor = this.shadowRoot.getElementById("cursor");
    if (cursor) {
      const dayStart = new Date(`${this._recordingsDay}T00:00:00`).getTime();
      const share = ((stats.position - dayStart) / 86400000) * 100;
      cursor.style.left = `${Math.max(0, Math.min(100, share))}%`;
    }
  }

  _timeline(rec) {
    if (!rec.recordings.length)
      return `<div class="empty">За ${this._recordingsDay} записів немає.</div>`;

    const dayStart = new Date(`${this._recordingsDay}T00:00:00`).getTime();
    const dayMs = 86400000;
    const blocks = rec.recordings
      .map((r) => {
        const begin = new Date(r.begin).getTime();
        const end = new Date(r.end || r.begin).getTime();
        const left = ((begin - dayStart) / dayMs) * 100;
        const width = Math.max(((end - begin) / dayMs) * 100, 0.15);
        const color = EVENT_COLORS[r.event] || "var(--primary-color)";
        return `<div class="block" style="left:${left}%;width:${width}%;background:${color}"
                     title="${fmtTime(r.begin)} → ${fmtTime(r.end)} · ${
          EVENT_LABELS[r.event] || r.event
        } · ${fmtBytes(r.size)}"></div>`;
      })
      .join("");

    const hours = Array.from({ length: 25 }, (_, h) =>
      h % 3 === 0 ? `<span style="left:${(h / 24) * 100}%">${String(h).padStart(2, "0")}</span>` : ""
    ).join("");

    const byEvent = {};
    rec.recordings.forEach((r) => {
      byEvent[r.event] = (byEvent[r.event] || 0) + 1;
    });

    return `
      <div class="card">
        <div class="timeline">
          <div class="track" id="track">
            ${blocks}
            <div class="cursor" id="cursor" style="left:${this._cursorShare()}%"></div>
          </div>
          <div class="hours">${hours}</div>
        </div>
        <div class="hint">Клацніть по шкалі, щоб почати відтворення з цього моменту.</div>
        <div class="legend">
          ${Object.entries(byEvent)
            .map(
              ([event, count]) =>
                `<span class="chip"><i style="background:${
                  EVENT_COLORS[event] || "var(--primary-color)"
                }"></i>${EVENT_LABELS[event] || event}: ${count}</span>`
            )
            .join("")}
          <span class="chip">Усього: ${rec.count} · ${fmtBytes(rec.total_bytes)}</span>
        </div>
      </div>
      <table class="data">
        <thead><tr><th>Початок</th><th>Кінець</th><th>Подія</th><th>Розмір</th><th>Файл</th></tr></thead>
        <tbody>
          ${rec.recordings
            .slice(0, 300)
            .map(
              (r) => `
            <tr>
              <td>${fmtClock(r.begin)}</td>
              <td>${fmtClock(r.end)}</td>
              <td><span class="chip small"><i style="background:${
                EVENT_COLORS[r.event] || "var(--primary-color)"
              }"></i>${EVENT_LABELS[r.event] || r.event}</span></td>
              <td>${fmtBytes(r.size)}</td>
              <td class="mono">${r.name.split("/").pop()}</td>
            </tr>`
            )
            .join("")}
        </tbody>
      </table>
      ${
        rec.recordings.length > 300
          ? `<div class="hint pad">Показано перші 300 із ${rec.recordings.length}.</div>`
          : ""
      }`;
  }

  _config() {
    const tree = this._configTree;
    if (!tree) return `<div class="empty"><button class="primary" id="loadconfig">Прочитати конфігурацію</button></div>`;
    if (tree.loading) return `<div class="empty">Читаю дерево конфігурації…</div>`;
    if (tree.error) return `<div class="empty error">${tree.error}</div>`;

    const roots = Object.entries(tree.roots)
      .map(
        ([root, leaves]) => `
        <div class="root">
          <div class="root-name">${root} <span class="hint">${leaves.length}</span></div>
          <div class="leaves">
            ${leaves
              .map(
                (leaf) =>
                  `<button class="leaf ${
                    this._configSection === `${root}.${leaf}` ? "active" : ""
                  }" data-section="${root}.${leaf}">${leaf}</button>`
              )
              .join("")}
          </div>
        </div>`
      )
      .join("");

    let viewer = `<div class="empty">Оберіть секцію ліворуч.</div>`;
    if (this._configValue) {
      if (this._configValue.loading) viewer = `<div class="empty">Читаю…</div>`;
      else if (this._configValue.error)
        viewer = `<div class="empty error">${this._configValue.error}</div>`;
      else
        viewer = `<pre class="json">${escapeHtml(
          JSON.stringify(this._configValue, null, 2)
        )}</pre>`;
    }

    return `
      <div class="split">
        <aside class="tree">${roots}</aside>
        <section class="viewer">
          <div class="viewer-head">${this._configSection || "Конфігурація"}</div>
          ${viewer}
        </section>
      </div>`;
  }

  _logView() {
    const log = this._log;
    if (!log) return `<div class="empty"><button class="primary" id="loadlog">Прочитати журнал</button></div>`;
    if (log.loading) return `<div class="empty">Читаю журнал…</div>`;
    if (log.error) return `<div class="empty error">${log.error}</div>`;
    if (!log.entries.length) return `<div class="empty">Журнал порожній.</div>`;

    return `
      <table class="data">
        <thead><tr><th>Час</th><th>Подія</th><th>Користувач</th><th>Деталі</th></tr></thead>
        <tbody>
          ${log.entries
            .map(
              (e) => `
            <tr>
              <td class="mono">${fmtTime(e.time)}</td>
              <td>${e.type}</td>
              <td>${e.user || "—"}</td>
              <td class="mono">${escapeHtml(e.data || "")}</td>
            </tr>`
            )
            .join("")}
        </tbody>
      </table>`;
  }

  _liveOverlay() {
    const channel = this._detail.channels.find((c) => c.index === this._live);
    if (!channel) return "";

    const players = PLAYERS.filter(([id]) => id !== "native" || nativePlayerSupported());
    return `
      <div class="overlay" id="overlay">
        <div class="overlay-box">
          <div class="overlay-head">
            <span>${channel.name}</span>
            <div class="overlay-controls">
              <select id="player" title="Спосіб програвання">
                ${players
                  .map(
                    ([id, label]) =>
                      `<option value="${id}" ${
                        id === this._player ? "selected" : ""
                      }>${label}</option>`
                  )
                  .join("")}
              </select>
              <select id="livestream" title="Потік реєстратора">
                <option value="sub" ${this._liveStream === "sub" ? "selected" : ""}>Додатковий</option>
                <option value="main" ${this._liveStream === "main" ? "selected" : ""}>Основний</option>
              </select>
              <button class="ghost" id="diag" title="Діагностика програвача">🛈</button>
              <button class="close" id="closelive">✕</button>
            </div>
          </div>
          ${
            channel.entity_id || this._player === "native"
              ? `<div id="livecard" class="livecard"><div class="empty">Готую відео…</div></div>`
              : `<div class="empty">Немає сутності камери для цього каналу.</div>`
          }
          <div class="osd" id="osd">${this._osdText(channel)
            .map((line) => `<div>${escapeHtml(line)}</div>`)
            .join("")}</div>
          ${
            this._showDiag
              ? `<div class="diag">
                   <div class="diag-head">
                     <span>Діагностика</span>
                     <div class="diag-actions">
                       <label class="toggle">
                         <input type="checkbox" id="labkey" ${this._lab.keyOnly ? "checked" : ""}>
                         лише ключові кадри
                       </label>
                       <label class="toggle">
                         <input type="checkbox" id="labpaint" ${this._lab.noPaint ? "checked" : ""}>
                         не малювати
                       </label>
                       <button class="ghost" id="copydiag">Скопіювати</button>
                     </div>
                   </div>
                   <pre id="diagtext">${escapeHtml(this._diagText())}</pre>
                 </div>`
              : ""
          }
        </div>
      </div>`;
  }

  /**
   * The technical line under the picture.
   *
   * It shows what tells "the camera is lagging" apart from "the browser cannot
   * keep up": frames decoded, frames dropped, the real bitrate and how far the
   * picture trails live.
   */
  _osdText(channel) {
    const osd = this._osd;
    if (!osd) return ["вимірюю…", `канал ${channel.index + 1}`];

    // First line: what is playing and how. Second line: how well it goes.
    // The split is fixed so the line does not reflow as numbers change.
    const what = [PLAYERS.find(([id]) => id === osd.player)?.[1] || osd.player];
    if (osd.codec) what.push(osd.codec.toUpperCase());
    if (osd.codecString) what.push(osd.codecString);
    if (osd.hardware && osd.hardware !== "no-preference") what.push(osd.hardware);
    if (osd.resolution) what.push(osd.resolution);
    what.push(osd.fps ? `${String(osd.fps).padStart(2, " ")} к/с` : "— к/с");

    // A video element does not report bitrate, so for HLS and snapshots the
    // value comes from the recorder itself.
    const how = [fmtBitrate(osd.bitrate || channel.bitrate)];
    if (osd.decoded !== undefined) {
      const total = osd.decoded + osd.dropped;
      const share = total ? ((osd.dropped / total) * 100).toFixed(1) : "0.0";
      how.push(`втрачено ${String(osd.dropped).padStart(3, " ")} (${share.padStart(4, " ")}%)`);
    }
    if (osd.latency !== null && osd.latency !== undefined) {
      how.push(`затримка ${(osd.latency / 1000).toFixed(1).padStart(5, " ")} с`);
    }
    if (osd.buffer !== undefined) how.push(`буфер ${osd.buffer.toFixed(1)} с`);
    if (osd.queue) how.push(`у декодері ${osd.queue}`);
    if (osd.backlog) how.push(`в черзі ${osd.backlog}`);
    if (osd.restarts) how.push(`перезапусків ${osd.restarts}`);
    how.push(`канал ${channel.index + 1}`);
    if (channel.recording) how.push("запис");
    if (osd.error) how.push(`⚠ ${osd.error}`);
    if (this._fallbackNote) how.push(`↩ ${this._fallbackNote}`);

    return [what.join(" · "), how.join(" · ")];
  }

  /**
   * What is actually happening during playback.
   *
   * WebCodecs and HLS behave noticeably differently across browsers, and
   * someone else's browser cannot be reproduced. So the player keeps its own
   * log, which can be copied whole and sent instead of guessing from symptoms.
   */
  _diagText() {
    const lines = [];
    const channel = this._detail?.channels.find((c) => c.index === this._live);

    lines.push(`програвач: ${this._player}, потік: ${this._liveStream}`);
    if (channel) {
      lines.push(`канал ${channel.index + 1} (${channel.name}), ${channel.resolution}`);
      lines.push(`сутності: ${JSON.stringify(channel.entity_ids)}`);
    }
    lines.push(
      `WebCodecs: ${typeof VideoDecoder !== "undefined" ? "є" : "немає"}, ` +
        `MediaSource HEVC: ${
          window.MediaSource
            ? MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L120.90"')
            : "невідомо"
        }`
    );

    if (this._native) {
      lines.push("", this._native.report());
    } else if (true) {
      lines.push("", `браузер: ${navigator.userAgent}`);
      const video = this._findVideo();
      if (video) {
        const q = video.getVideoPlaybackQuality
          ? video.getVideoPlaybackQuality()
          : null;
        lines.push(
          `<video> ${video.videoWidth}x${video.videoHeight}, стан ${video.readyState}, ` +
            `помилка ${video.error ? video.error.code : "немає"}, ` +
            `буфер ${
              video.buffered.length
                ? (video.buffered.end(video.buffered.length - 1) - video.currentTime).toFixed(1)
                : 0
            }с` + (q ? `, кадрів ${q.totalVideoFrames}, втрачено ${q.droppedVideoFrames}` : "")
        );
      } else if (this._snapshots) {
        lines.push(
          `стоп-кадри: завантажено ${this._snapshots.loaded}, помилок ${this._snapshots.errors}`
        );
      } else {
        lines.push("програвач ще не створив жодного елемента");
      }
      if (this._hlsSince) {
        lines.push(`HLS вантажиться ${((performance.now() - this._hlsSince) / 1000).toFixed(1)}с`);
      }
    }
    if (this._fallbackNote) lines.push("", `відступ: ${this._fallbackNote}`);

    // The log is always shown in full: it accumulates from the moment the view
    // opens and survives every switch.
    if (!this._native && this._diagLog.length) {
      lines.push("", "── журнал ──");
      lines.push(
        ...this._diagLog.map(
          (l) => `${(l.at || "").padStart(8)}  ${l.event}${l.detail ? "  " + l.detail : ""}`
        )
      );
    }
    return lines.join("\n");
  }

  _findVideo() {
    const holder = this.shadowRoot.getElementById("livecard");
    if (!holder) return null;
    let video = null;
    const walk = (root) =>
      root.querySelectorAll("*").forEach((el) => {
        if (el.tagName === "VIDEO") video = el;
        if (el.shadowRoot) walk(el.shadowRoot);
      });
    walk(holder);
    return video;
  }

  _updateOsd() {
    const el = this.shadowRoot.getElementById("osd");
    const channel = this._detail?.channels.find((c) => c.index === this._live);
    if (!el || !channel) return;
    const [what, how] = this._osdText(channel);
    el.innerHTML = `<div>${escapeHtml(what)}</div><div>${escapeHtml(how)}</div>`;

    const diag = this.shadowRoot.getElementById("diagtext");
    if (diag) diag.textContent = this._diagText();
  }

  /** Collect figures from <video> when HLS or the snapshot stream is playing. */
  _collectVideoStats() {
    const holder = this.shadowRoot.getElementById("livecard");
    if (!holder) return;

    const video = this._findVideo();

    if (!video) {
      const snaps = this._snapshots;
      const seconds = snaps ? (performance.now() - snaps.since) / 1000 : 0;
      // HLS in Home Assistant sometimes fails to start; in Safari that shows
      // as "Load failed" from the service worker. The cause is outside this
      // code, so fall back to something that works instead of a black box.
      const stalled =
        this._player === "hls" &&
        this._hlsSince &&
        performance.now() - this._hlsSince > HLS_TIMEOUT;
      if (stalled) {
        this._hlsSince = null;
        this._player = "mjpeg";
        this._fallbackNote = "HLS не запустився. Перейшов на стоп-кадри.";
        this._remountLive();
        return;
      }
      this._osd = {
        player: this._player,
        resolution: "—",
        fps: snaps && seconds > 0 ? Math.round(snaps.loaded / seconds) : 0,
        decoded: snaps ? snaps.loaded : 0,
        dropped: snaps ? snaps.errors : 0,
        error: null,
      };
      return this._updateOsd();
    }

    const quality = video.getVideoPlaybackQuality
      ? video.getVideoPlaybackQuality()
      : { totalVideoFrames: 0, droppedVideoFrames: 0 };
    const previous = this._videoStatsPrev || { total: 0, at: performance.now() };
    const seconds = Math.max((performance.now() - previous.at) / 1000, 0.001);

    this._osd = {
      player: this._player,
      codec: "",
      resolution: `${video.videoWidth}x${video.videoHeight}`,
      fps: Math.round((quality.totalVideoFrames - previous.total) / seconds),
      decoded: quality.totalVideoFrames,
      dropped: quality.droppedVideoFrames,
      bitrate: 0,
      latency: null,
      buffer: video.buffered.length
        ? video.buffered.end(video.buffered.length - 1) - video.currentTime
        : 0,
    };
    this._videoStatsPrev = { total: quality.totalVideoFrames, at: performance.now() };
    // video appeared, so the warning about HLS not starting is no longer needed
    this._hlsSince = null;
    this._updateOsd();
  }

  _bind() {
    const root = this.shadowRoot;
    root.querySelectorAll(".tab").forEach((el) =>
      el.addEventListener("click", () => {
        this._tab = el.dataset.tab;
        this._render();
      })
    );
    root.querySelectorAll(".tile").forEach((el) =>
      el.addEventListener("click", () => this._openLive(Number(el.dataset.channel)))
    );

    const device = root.getElementById("device");
    if (device)
      device.addEventListener("change", () => {
        this._entryId = device.value;
        this._recordings = null;
        this._configTree = null;
        this._log = null;
        this._loadDetail();
      });

    const channel = root.getElementById("channel");
    if (channel)
      channel.addEventListener("change", () => {
        this._selectedChannel = Number(channel.value);
      });

    const day = root.getElementById("day");
    if (day) day.addEventListener("change", () => (this._recordingsDay = day.value));

    const search = root.getElementById("search");
    if (search) search.addEventListener("click", () => this._loadRecordings());

    root.querySelectorAll(".layout").forEach((button) =>
      button.addEventListener("click", () => {
        this._layout = Number(button.dataset.layout);
        this._wallPage = 0;
        localStorage.setItem("xmeye-layout", String(this._layout));
        this._render();
      })
    );

    root.querySelectorAll("[data-pick]").forEach((button) =>
      button.addEventListener("click", () =>
        this._toggleWallChannel(Number(button.dataset.pick))
      )
    );

    root.querySelectorAll("[data-stream]").forEach((select) =>
      select.addEventListener("change", () =>
        this._setWallStream(Number(select.dataset.stream), select.value)
      )
    );

    root.querySelectorAll("[data-move-up]").forEach((button) =>
      button.addEventListener("click", () =>
        this._moveWallChannel(Number(button.dataset.moveUp), -1)
      )
    );
    root.querySelectorAll("[data-move-down]").forEach((button) =>
      button.addEventListener("click", () =>
        this._moveWallChannel(Number(button.dataset.moveDown), 1)
      )
    );

    const prev = root.getElementById("wallprev");
    if (prev)
      prev.addEventListener("click", () => {
        this._wallPage = Math.max(0, this._wallPage - 1);
        this._render();
      });
    const next = root.getElementById("wallnext");
    if (next)
      next.addEventListener("click", () => {
        this._wallPage += 1;
        this._render();
      });

    root.querySelectorAll(".cell[data-channel]").forEach((cell) =>
      cell.addEventListener("click", () => this._openLive(Number(cell.dataset.channel)))
    );

    const track = root.getElementById("track");
    if (track)
      track.addEventListener("click", (event) => {
        // A click on the timeline seeks to that moment of the day.
        const box = track.getBoundingClientRect();
        const share = (event.clientX - box.left) / box.width;
        const when = new Date(
          new Date(`${this._recordingsDay}T00:00:00`).getTime() + share * 86400000
        );
        this._startPlayback(when);
      });

    const playPause = root.getElementById("playpause");
    if (playPause)
      playPause.addEventListener("click", () => {
        if (!this._archivePlayer) return;
        if (this._archivePlayer.paused) {
          this._archivePlayer.resume();
          this._playback.paused = false;
          playPause.textContent = "⏸";
        } else {
          this._archivePlayer.pause();
          this._playback.paused = true;
          playPause.textContent = "▶";
        }
      });

    root.querySelectorAll(".rate").forEach((button) =>
      button.addEventListener("click", () => {
        const rate = Number(button.dataset.rate);
        const wasScrub = this._playback.rate >= SCRUB_RATE;
        const from = new Date(this._playback.position || this._playback.start);
        this._playback.rate = rate;
        root.querySelectorAll(".rate").forEach((b) => b.classList.toggle("active", b === button));
        if (wasScrub || rate >= SCRUB_RATE) {
          // Smooth playback and scrubbing use different mechanisms; restart.
          this._startPlayback(from);
        } else if (this._archivePlayer) {
          this._archivePlayer.setRate(rate);
        }
      })
    );

    const step = (seconds) => {
      const from = this._playback?.position || this._playback?.start;
      if (!from) return;
      this._startPlayback(new Date(new Date(from).getTime() + seconds * 1000));
    };
    const back = root.getElementById("stepback");
    if (back) back.addEventListener("click", () => step(-10));
    const forward = root.getElementById("stepfwd");
    if (forward) forward.addEventListener("click", () => step(10));

    const closePlay = root.getElementById("closeplay");
    if (closePlay) closePlay.addEventListener("click", () => this._closePlayback());

    const loadConfig = root.getElementById("loadconfig");
    if (loadConfig) loadConfig.addEventListener("click", () => this._loadConfigTree());

    root.querySelectorAll(".leaf").forEach((el) =>
      el.addEventListener("click", () => this._loadConfigSection(el.dataset.section))
    );

    const loadLog = root.getElementById("loadlog");
    if (loadLog) loadLog.addEventListener("click", () => this._loadLog());

    const player = root.getElementById("player");
    if (player)
      player.addEventListener("change", () => {
        this._player = player.value;
        this._remountLive();
      });

    const livestream = root.getElementById("livestream");
    if (livestream)
      livestream.addEventListener("change", () => {
        this._liveStream = livestream.value;
        this._remountLive();
      });

    const diag = root.getElementById("diag");
    if (diag)
      diag.addEventListener("click", () => {
        this._showDiag = !this._showDiag;
        this._remountLive();
      });

    const labKey = root.getElementById("labkey");
    if (labKey)
      labKey.addEventListener("change", () => {
        this._lab.keyOnly = labKey.checked;
        this._noteDiag("дослід", `лише ключові кадри: ${labKey.checked ? "так" : "ні"}`);
        this._remountLive();
      });

    const labPaint = root.getElementById("labpaint");
    if (labPaint)
      labPaint.addEventListener("change", () => {
        this._lab.noPaint = labPaint.checked;
        this._noteDiag("дослід", `не малювати: ${labPaint.checked ? "так" : "ні"}`);
        this._remountLive();
      });

    const copyDiag = root.getElementById("copydiag");
    if (copyDiag)
      copyDiag.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(this._diagText());
          copyDiag.textContent = "Скопійовано";
          setTimeout(() => (copyDiag.textContent = "Скопіювати"), 2000);
        } catch (err) {
          copyDiag.textContent = "Не вдалося";
        }
      });

    const close = root.getElementById("closelive");
    if (close) close.addEventListener("click", () => this._closeLive());
    const overlay = root.getElementById("overlay");
    if (overlay)
      overlay.addEventListener("click", (event) => {
        if (event.target === overlay) this._closeLive();
      });
  }
}

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);

const STYLES = `
  :host { display:block; background: var(--primary-background-color); min-height:100vh; }
  .page { padding: 16px 24px 48px; max-width: 1600px; margin: 0 auto;
          color: var(--primary-text-color);
          font-family: var(--paper-font-body1_-_font-family, Roboto, sans-serif); }
  header { display:flex; align-items:center; gap:24px; flex-wrap:wrap;
           padding: 10px 0 14px; }
  .ident h1 { margin:0; }
  /* Facts beside the title: the same numbers the six cards carried, without
     half a screen spent on them and without repeating the model. */
  .facts { display:flex; gap:28px; flex-wrap:wrap; margin-left:auto; }
  .fact-label { font-size:11px; text-transform:uppercase; letter-spacing:.5px;
    color: var(--secondary-text-color); }
  .fact-value { font-size:17px; margin-top:2px; }
  .fact-hint { font-size:12px; color: var(--secondary-text-color); }
  h1 { margin:0; font-size:26px; font-weight:400; }
  h2 { margin: 28px 0 12px; font-size:18px; font-weight:500; }
  .sub { color: var(--secondary-text-color); font-size:14px; margin-top:4px; }
  nav { display:flex; gap:4px; border-bottom:1px solid var(--divider-color); margin-bottom:20px;
        overflow-x:auto; }
  .tab { background:none; border:none; padding:12px 18px; cursor:pointer; font-size:15px;
         color: var(--secondary-text-color); border-bottom:2px solid transparent;
         white-space:nowrap; font-family:inherit; }
  .tab:hover { color: var(--primary-text-color); }
  .tab.active { color: var(--primary-color); border-bottom-color: var(--primary-color); }

  .card { background: var(--card-background-color); border-radius: var(--ha-card-border-radius, 12px);
          box-shadow: var(--ha-card-box-shadow, 0 2px 4px rgba(0,0,0,.08)); padding:16px; }
  .grid { display:grid; gap:16px; }
  .stats { grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); }
  .stat .label { color: var(--secondary-text-color); font-size:13px; text-transform:uppercase;
                 letter-spacing:.4px; }
  .stat .value { font-size:24px; margin:6px 0 2px; }
  .hint { color: var(--secondary-text-color); font-size:13px; }
  .hint.pad { padding:12px 0; }

  .tiles { grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); }

  /* Video wall: a solid grid without rounded corners or gaps so the channels
     read as a single canvas. */
  .wall { display:grid; grid-template-columns: repeat(var(--columns), 1fr);
    grid-auto-rows: 1fr; gap:2px; background: var(--divider-color);
    border:2px solid var(--divider-color);
    aspect-ratio: calc(var(--columns) * 16) / calc(var(--rows) * 9); }
  .wall-layout { display:flex; align-items:flex-start; gap:12px; }
  .wall-layout .wall { flex:1; min-width:0; }
  .wall-bar { justify-content:flex-start; }

  /* Channel picker: which cameras go on the wall and in what order. */
  .picker { width:248px; flex:none; background: var(--card-background-color);
    border-radius: var(--ha-card-border-radius, 12px); overflow:hidden;
    box-shadow: var(--ha-card-box-shadow, 0 2px 4px rgba(0,0,0,.08)); }
  .picker-head { padding:10px 12px; font-size:12px; text-transform:uppercase;
    letter-spacing:.4px; color: var(--secondary-text-color);
    border-bottom:1px solid var(--divider-color); }
  .pick-list { list-style:none; margin:0; padding:4px 0; max-height:70vh; overflow:auto; }
  .pick { display:flex; align-items:center; gap:6px; padding:2px 8px; font-size:13px; }
  .pick.off { opacity:.5; }
  .pick-eye { background:none; border:none; padding:2px; cursor:pointer; font-size:14px;
    color: var(--primary-color); }
  .pick.off .pick-eye { color: var(--secondary-text-color); }
  .pick-num { width:18px; text-align:right; color: var(--secondary-text-color);
    font-variant-numeric: tabular-nums; }
  .pick-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .pick-dot { width:6px; height:6px; border-radius:50%; flex:none;
    background: var(--divider-color); }
  .pick-dot.online { background: var(--success-color, #4caf50); }
  .pick-stream { font-size:11px; padding:1px 2px; max-width:56px;
    background: var(--card-background-color); color: var(--primary-text-color);
    border:1px solid var(--divider-color); border-radius:4px; }
  .pick.off .pick-stream { pointer-events:none; opacity:.6; }
  .pick-move { display:flex; gap:2px; }
  .pick-move button { padding:0 5px; font-size:11px; line-height:1.5; }
  .pick-move button[disabled] { opacity:.3; cursor:default; }
  @media (max-width: 900px) {
    .wall-layout { flex-direction:column; }
    .picker { width:100%; }
    .pick-list { max-height:none; }
  }
  .layouts { display:flex; gap:4px; }
  .layout.active { background: var(--primary-color); color: var(--text-primary-color,#fff);
    border-color: var(--primary-color); }
  .pager { display:flex; align-items:center; gap:8px; font-size:13px;
    color: var(--secondary-text-color); }
  .cell { position:relative; background:#000; overflow:hidden; cursor:pointer;
    min-height:0; }
  .empty-cell { cursor:default; background: #0a0a0a; }
  .cell.offline { opacity:.45; }
  .cell canvas { width:100%; height:100%; display:block; object-fit:contain; }
  .cell-overlay { position:absolute; top:0; left:0; right:0; display:flex;
    justify-content:space-between; align-items:flex-start; gap:8px; padding:8px;
    background: linear-gradient(rgba(0,0,0,.55), transparent); pointer-events:none; }
  .cell-name { color:#fff; font-size:13px; text-shadow:0 1px 2px rgba(0,0,0,.8); }
  .cell-foot { position:absolute; left:0; right:0; bottom:0; padding:6px 8px;
    font-size:11px; color:#ddd; background: linear-gradient(transparent, rgba(0,0,0,.6));
    font-family: ui-monospace, "SF Mono", Menlo, monospace; pointer-events:none; }

  /* Archive player */
  .player { background:#000; border-radius:12px; overflow:hidden; margin-bottom:16px;
    box-shadow: var(--ha-card-box-shadow, 0 2px 4px rgba(0,0,0,.08)); }
  .player-head { display:flex; justify-content:space-between; align-items:center;
    padding:10px 14px; background: var(--card-background-color); font-size:14px; }
  .player-screen { background:#000; display:flex; align-items:center;
    justify-content:center; max-height:60vh; }
  .player-screen canvas { max-width:100%; max-height:60vh; display:block; }
  .player-bar { display:flex; align-items:center; gap:8px; padding:10px 14px;
    background: var(--card-background-color); flex-wrap:wrap; }
  .rates { display:flex; gap:4px; margin-left:8px; }
  .rate.active { background: var(--primary-color); color: var(--text-primary-color,#fff);
    border-color: var(--primary-color); }
  .player-time { margin-left:auto; font-family: ui-monospace, Menlo, monospace;
    font-size:13px; color: var(--secondary-text-color); }

  /* Timeline cursor */
  .cursor { position:absolute; top:-3px; bottom:-3px; width:2px; z-index:2;
    background: var(--primary-text-color); box-shadow:0 0 0 1px rgba(0,0,0,.4); }
  .cursor::before { content:""; position:absolute; top:-4px; left:-4px;
    border:5px solid transparent; border-top-color: var(--primary-text-color); }
  .track { cursor: crosshair; }
  .tile { padding:0; overflow:hidden; cursor:pointer; transition: transform .12s ease; }
  .tile:hover { transform: translateY(-2px); }
  .tile.offline { opacity:.55; }
  .thumb { position:relative; aspect-ratio:16/9; background:#000; }
  .thumb img { width:100%; height:100%; object-fit:cover; display:block; }
  .noimage { display:flex; align-items:center; justify-content:center; height:100%;
             color:#888; font-size:14px; }
  .badges { position:absolute; top:8px; left:8px; display:flex; gap:6px; }
  .badge { font-size:11px; padding:2px 8px; border-radius:10px; color:#fff;
           background: rgba(0,0,0,.6); }
  .badge.rec { background: var(--error-color, #f44336); }
  .badge.motion { background: var(--warning-color, #ff9800); }
  .badge.loss { background: #555; }
  .tile-body { padding:12px 14px; }
  .tile-name { font-size:15px; }
  .tile-meta { color: var(--secondary-text-color); font-size:13px; margin-top:2px; }

  .toolbar { display:flex; gap:10px; align-items:center; margin-bottom:16px; flex-wrap:wrap; }
  select, input[type=date] { padding:8px 10px; border-radius:8px; font-size:14px;
    border:1px solid var(--divider-color); background: var(--card-background-color);
    color: var(--primary-text-color); font-family:inherit; }
  button.primary { background: var(--primary-color); color: var(--text-primary-color, #fff);
    border:none; border-radius:8px; padding:9px 18px; cursor:pointer; font-size:14px;
    font-family:inherit; }
  button.primary:hover { opacity:.9; }

  table.data { width:100%; border-collapse:collapse; background: var(--card-background-color);
    border-radius: var(--ha-card-border-radius, 12px); overflow:hidden;
    box-shadow: var(--ha-card-box-shadow, 0 2px 4px rgba(0,0,0,.08)); }
  table.data th { text-align:left; font-weight:500; font-size:13px; padding:12px 14px;
    color: var(--secondary-text-color); border-bottom:1px solid var(--divider-color); }
  table.data td { padding:10px 14px; font-size:14px;
    border-bottom:1px solid var(--divider-color); }
  table.data tr:last-child td { border-bottom:none; }
  tr.dim { opacity:.5; }
  .mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size:12px; }

  .timeline { position:relative; padding-bottom:22px; }
  .track { position:relative; height:44px; background: var(--secondary-background-color);
    border-radius:6px; overflow:hidden; }
  .block { position:absolute; top:0; height:100%; min-width:1px; }
  .hours { position:relative; height:16px; margin-top:4px; }
  .hours span { position:absolute; transform:translateX(-50%); font-size:11px;
    color: var(--secondary-text-color); }
  .legend { display:flex; gap:14px; flex-wrap:wrap; margin-top:14px; }
  .chip { display:inline-flex; align-items:center; gap:6px; font-size:13px;
    color: var(--secondary-text-color); }
  .chip.small { font-size:12px; }
  .chip i { width:10px; height:10px; border-radius:2px; display:inline-block; }

  .split { display:grid; grid-template-columns: 300px 1fr; gap:16px; align-items:start; }
  .tree { background: var(--card-background-color); border-radius:12px; padding:12px;
    max-height:72vh; overflow:auto;
    box-shadow: var(--ha-card-box-shadow, 0 2px 4px rgba(0,0,0,.08)); }
  .root { margin-bottom:12px; }
  .root-name { font-size:13px; text-transform:uppercase; letter-spacing:.4px;
    color: var(--secondary-text-color); margin-bottom:6px; }
  .leaves { display:flex; flex-direction:column; }
  .leaf { text-align:left; background:none; border:none; padding:5px 8px; cursor:pointer;
    border-radius:6px; font-size:13px; color: var(--primary-text-color); font-family:inherit; }
  .leaf:hover { background: var(--secondary-background-color); }
  .leaf.active { background: var(--primary-color); color: var(--text-primary-color,#fff); }
  .viewer { background: var(--card-background-color); border-radius:12px; overflow:hidden;
    box-shadow: var(--ha-card-box-shadow, 0 2px 4px rgba(0,0,0,.08)); }
  .viewer-head { padding:12px 16px; border-bottom:1px solid var(--divider-color); font-size:14px; }
  pre.json { margin:0; padding:16px; overflow:auto; max-height:66vh; font-size:12px;
    font-family: ui-monospace, "SF Mono", Menlo, monospace; line-height:1.5; }

  .empty { padding:48px 16px; text-align:center; color: var(--secondary-text-color); }
  .empty.error { color: var(--error-color, #f44336); }

  .overlay { position:fixed; inset:0; background: rgba(0,0,0,.72); display:flex;
    align-items:center; justify-content:center; z-index:10; padding:16px; }
  /* The height is bounded by the window rather than the frame ratio: otherwise a
     4:3 picture on a wide screen grows past the viewport and drags the header
     with its controls out of reach. */
  /* The height is explicit rather than derived from content: the children of
     the picture area are absolutely positioned and have no height of their own,
     so the box would collapse to its header. The frame is letterboxed to fit. */
  .overlay-box { background: var(--card-background-color); border-radius:12px;
    overflow:hidden; max-width:min(1600px, 96vw); width:100%;
    height: calc(100vh - 32px); display:flex; flex-direction:column; }
  .overlay-head { display:flex; justify-content:space-between; align-items:center;
    gap:12px; flex-wrap:wrap; flex:0 0 auto;
    padding:12px 16px; border-bottom:1px solid var(--divider-color); }
  .close { background:none; border:none; font-size:18px; cursor:pointer;
    color: var(--primary-text-color); }
  /* The picture area takes the remaining height and the frame fits inside it.
     Content is absolutely positioned: a percentage max-height inside a flex
     container is unreliable — the browser does not always treat its height as
     definite, and a 4:3 frame grew taller than its slot. Absolute edges settle
     the question. */
  .livecard { background:#000; flex:1 1 auto; min-height:0; position:relative;
    overflow:hidden; }
  .livecard > * { position:absolute; inset:0; width:100%; height:100%; }
  img.live, canvas.live { display:block; object-fit:contain; }
  .livecard ha-camera-stream, .livecard ha-card { box-shadow:none; border-radius:0;
    display:flex; align-items:center; justify-content:center; }
  .livecard .empty { position:absolute; inset:0; display:flex;
    align-items:center; justify-content:center; }
  .thumb img { transition: opacity .18s ease; }
  .diag { flex:0 0 auto; max-height:32vh; overflow:auto;
    border-top:1px solid var(--divider-color); background: var(--secondary-background-color); }
  .diag-head { display:flex; justify-content:space-between; align-items:center;
    gap:12px; flex-wrap:wrap;
    padding:8px 16px; font-size:13px; position:sticky; top:0;
    background: var(--secondary-background-color); }
  .diag-actions { display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
  .toggle { display:inline-flex; gap:5px; align-items:center; font-size:12px;
    color: var(--secondary-text-color); cursor:pointer; }
  .diag pre { margin:0; padding:0 16px 12px; font-size:11px; line-height:1.5;
    font-family: ui-monospace, "SF Mono", Menlo, monospace; white-space:pre-wrap;
    word-break:break-word; }
  button.ghost { background:none; border:1px solid var(--divider-color); border-radius:6px;
    padding:3px 10px; cursor:pointer; color: var(--primary-text-color); font-size:12px;
    font-family:inherit; }
  button.ghost:hover { background: var(--divider-color); }
  .osd { padding:8px 16px; color: var(--secondary-text-color); font-size:12px;
    font-family: ui-monospace, "SF Mono", Menlo, monospace; line-height:1.6;
    border-top:1px solid var(--divider-color); white-space:pre; flex:0 0 auto;
    overflow-x:auto; }
  .overlay-controls { display:flex; gap:8px; align-items:center; }
  .overlay-controls select { padding:4px 8px; font-size:12px; }
  canvas.live { width:100%; display:block; background:#000; }

  @media (max-width: 870px) {
    .page { padding:12px; }
    .split { grid-template-columns: 1fr; }
    .tree { max-height:none; }
  }
`;

customElements.define("xmeye-panel", XmeyePanel);
