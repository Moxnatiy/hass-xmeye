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

//: Loaded eagerly, unlike the player: the very first render needs it, and a
//: panel that flashes English before settling into the user's language is worse
//: than one that waits a few milliseconds for a file it fetched alongside this.
const i18nModule = import(`./i18n.js${VERSION ? `?v=${VERSION}` : ""}`);
//: Replaced by the real translator as soon as that module lands. Until then the
//: source text stands, which is English and correct.
let t = (text, values) =>
  values ? text.replace(/\{(\w+)\}/g, (whole, name) =>
    Object.hasOwn(values, name) ? String(values[name]) : whole) : text;
let useLanguage = () => {};
i18nModule.then((module) => {
  t = module.t;
  useLanguage = module.useLanguage;
});

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

//: The side of a layout icon, in pixels. Matched to the fullscreen glyph beside
//: it so the toolbar reads as one row of buttons rather than two sizes.
const ICON = 16;

/**
 * A layout drawn as the grid it produces.
 *
 * "6" and "3×3" say the same thing twice and neither says which of them puts a
 * big tile in the corner. The picture does, and it is built from the same
 * numbers the wall is laid out from, so the two cannot drift apart.
 */
const layoutIcon = ({ columns, rows, hero = 0 }) => {
  const gap = 1.2;
  const width = (ICON - gap * (columns - 1)) / columns;
  const height = (ICON - gap * (rows - 1)) / rows;
  const cell = (column, row, span = 1) =>
    `<rect x="${((width + gap) * column).toFixed(2)}"` +
    ` y="${((height + gap) * row).toFixed(2)}"` +
    ` width="${(width * span + gap * (span - 1)).toFixed(2)}"` +
    ` height="${(height * span + gap * (span - 1)).toFixed(2)}" rx="0.7"/>`;

  const cells = hero ? [cell(0, 0, hero)] : [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      // The hero covers the top-left block; everything else fills the rest.
      if (hero && column < hero && row < hero) continue;
      cells.push(cell(column, row));
    }
  }
  return (
    `<svg viewBox="0 0 ${ICON} ${ICON}" width="${ICON}" height="${ICON}"` +
    ` fill="currentColor" aria-hidden="true">${cells.join("")}</svg>`
  );
};

/**
 * The fullscreen mark, drawn rather than typed.
 *
 * A glyph would be sized by font metrics, and the layout marks beside it are
 * sized in pixels; matching the two then depends on which CSS rule wins, which
 * is how they ended up 16 and 12. Both are SVG at the same box instead.
 */
const fullscreenIcon = () =>
  `<svg viewBox="0 0 ${ICON} ${ICON}" width="${ICON}" height="${ICON}" fill="none"` +
  ` stroke="currentColor" stroke-width="1.6" stroke-linecap="round"` +
  ` stroke-linejoin="round" aria-hidden="true">` +
  `<path d="M6 1.6H1.6V6"/><path d="M10 1.6h4.4V6"/>` +
  `<path d="M6 14.4H1.6V10"/><path d="M10 14.4h4.4V10"/></svg>`;

//: The tooltip on a layout button. Plural rules differ per language and this
//: one sentence is not worth a plural engine, so each language phrases the
//: whole line and the number goes in wherever its grammar wants it.
const channelCount = (count) => t("{count} channels", { count });

//: How hard to try to bring a wall tile back before leaving the error on
//: screen, and the base delay between attempts.
const WALL_RETRIES = 5;
const WALL_RETRY_DELAY = 5000;

//: Why a shared-connection channel is showing nothing. The server sends the
//: reason as a word; the sentence belongs here, where the language does.
//: How long the tile watcher samples the screen for, once the log is on. Long
//: enough to cover a wall coming up on a slow recorder, short enough that it
//: does not follow the page around all evening.
const TILE_WATCH = 30000;

//: Translated where they are used rather than here: this table is built once,
//: at load, and the language may not be known yet.
const WALL_TROUBLE = {
  silent: "the camera sends no video",
  ended: "the recorder cut the stream",
  failed: "connection to the recorder failed",
};

//: Stream choices offered per tile on the wall.
const WALL_STREAMS = [
  ["sub", "Sub"],
  ["main", "Main"],
];

//: Playback methods. Native gives the lowest latency, HLS the best
//: compatibility, and the snapshot stream always works but is never smooth.
const PLAYERS = [
  ["native", "Native (WebCodecs)"],
  ["hls", "HLS"],
  ["mjpeg", "Snapshots"],
];

//: Where a report goes when the user chooses to file it. Nothing is sent
//: automatically: this only opens a prefilled issue form for them to submit.
const ISSUE_URL = "https://github.com/Moxnatiy/hass-xmeye/issues/new";

//: Past roughly this, GitHub drops the querystring, so a long report has to
//: travel through the clipboard instead of the URL.
const ISSUE_URL_LIMIT = 6000;

//: Recorder settings, in the shape the vendor apps present them.
//:
//: Declared rather than hand-built: every field says what it is, so one renderer
//: covers all of them and adding a section is a data change, not new markup.
//:
//: Network sections are deliberately absent for now. A wrong value in
//: NetWork.NetCommon takes the recorder off the network, and that is not
//: something to ship before the safe sections have proven the write path.
const SETTINGS_GROUPS = [
  {
    id: "general",
    title: "General",
    section: "General.General",
    hint: "The device name, and what happens when the disk fills up.",
    fields: [
      { key: "MachineName", label: "Device name", type: "text" },
      {
        key: "OverWrite",
        label: "When the disk is full",
        type: "select",
        options: [
          ["OverWrite", "Overwrite the oldest"],
          ["StopRecord", "Stop recording"],
        ],
      },
      { key: "AutoLogout", label: "Log out of the menu after, min", type: "number", min: 0, max: 120,
        hint: "0 does not log out" },
      { key: "ScreenSaveTime", label: "Screensaver, min", type: "number", min: 0, max: 120 },
      { key: "BandWidthTips", label: "Bandwidth hint", type: "bool01" },
    ],
  },
  {
    id: "locale",
    title: "Time and language",
    section: "General.Location",
    hint: "Date and time format, and the language of the recorder's own menu.",
    fields: [
      {
        key: "Language",
        label: "Menu language",
        type: "select",
        options: [
          ["English", "English"],
          ["Russian", "Русский"],
          ["SimpChinese", "简体中文"],
        ],
      },
      {
        key: "DateFormat",
        label: "Date format",
        type: "select",
        options: [["YYMMDD", "YY-MM-DD"], ["MMDDYY", "MM-DD-YY"], ["DDMMYY", "DD-MM-YY"]],
      },
      {
        key: "DateSeparator",
        label: "Date separator",
        type: "select",
        options: [["-", "-"], ["/", "/"], [".", "."]],
      },
      {
        key: "TimeFormat",
        label: "Time format",
        type: "select",
        options: [["24", "24 hours"], ["12", "12 hours"]],
      },
      {
        key: "DSTRule",
        label: "Daylight saving",
        type: "select",
        options: [["Off", "Off"], ["On", "On"]],
      },
    ],
  },
  {
    id: "maintain",
    title: "Maintenance",
    section: "General.AutoMaintain",
    hint: "Scheduled reboot, and deleting old recordings automatically.",
    fields: [
      {
        key: "AutoRebootDay",
        label: "Reboot",
        type: "select",
        options: [
          ["Never", "Never"],
          ["Everyday", "Every day"],
          ["Sunday", "Every Sunday"],
          ["Monday", "Every Monday"],
        ],
      },
      { key: "AutoRebootHour", label: "Reboot hour", type: "number", min: 0, max: 23 },
      {
        key: "AutoDeleteFilesDays",
        label: "Delete recordings older than (days)",
        type: "number",
        min: 0,
        max: 365,
        hint: "0 does not delete by age",
      },
    ],
  },
  {
    id: "screen",
    title: "Screen and OSD",
    section: "fVideo.GUISet",
    hint: "What the recorder draws over the video on its own monitor.",
    fields: [
      { key: "ChannelTitleEnable", label: "Camera name", type: "bool" },
      { key: "TimeTitleEnable", label: "Time", type: "bool" },
      { key: "RecordStateEnable", label: "Recording mark", type: "bool" },
      { key: "AlarmStateEnable", label: "Alarm mark", type: "bool" },
      { key: "ChanStateBitRateEnable", label: "Channel bitrate", type: "bool" },
      { key: "ChanStateMtdEnable", label: "Motion mark", type: "bool" },
      { key: "ChanStateVlsEnable", label: "Video loss mark", type: "bool" },
      { key: "ChanWindowGridEnable", label: "Window grid", type: "bool" },
      { key: "QRcodeEnable", label: "QR code", type: "bool" },
      { key: "Deflick", label: "Flicker suppression", type: "bool" },
      { key: "WindowAlpha", label: "Overlay opacity", type: "number", min: 0, max: 255 },
    ],
  },
  {
    id: "disk-low",
    title: "Disk — low on space",
    section: "Storage.StorageLowSpace",
    hint: "What to do when little free space is left on the disk.",
    fields: [
      { key: "Enable", label: "Watch the free space", type: "bool" },
      { key: "LowerLimit", label: "Threshold, % free", type: "number", min: 1, max: 99 },
      { key: "EventHandler.MessageEnable", label: "Show a message", type: "bool" },
      { key: "EventHandler.BeepEnable", label: "Beep", type: "bool" },
      { key: "EventHandler.MailEnable", label: "Send mail", type: "bool" },
      { key: "EventHandler.LogEnable", label: "Write to the log", type: "bool" },
    ],
  },
  {
    id: "disk-fail",
    title: "Disk — failure",
    section: "Storage.StorageFailure",
    hint: "What to do when the disk fails.",
    fields: [
      { key: "Enable", label: "Watch for failures", type: "bool" },
      { key: "RebootEnable", label: "Reboot on failure", type: "bool" },
      { key: "EventHandler.MessageEnable", label: "Show a message", type: "bool" },
      { key: "EventHandler.BeepEnable", label: "Beep", type: "bool" },
      { key: "EventHandler.MailEnable", label: "Send mail", type: "bool" },
      { key: "EventHandler.LogEnable", label: "Write to the log", type: "bool" },
    ],
  },
  {
    id: "disk-none",
    title: "Disk — missing",
    section: "Storage.StorageNotExist",
    hint: "What to do when no disk is present.",
    fields: [
      { key: "Enable", label: "Watch", type: "bool" },
      { key: "EventHandler.MessageEnable", label: "Show a message", type: "bool" },
      { key: "EventHandler.BeepEnable", label: "Beep", type: "bool" },
      { key: "EventHandler.MailEnable", label: "Send mail", type: "bool" },
    ],
  },
  {
    id: "network",
    title: "Network",
    section: "NetWork.NetCommon",
    //: The address fields are not here on purpose. HostIP, GateWay and Submask
    //: are little-endian hex, and a wrong one takes the recorder off the network
    //: with no way back through this panel.
    warning:
      "Changing a port breaks the current connection: after saving, update the " +
      "port in the integration options. The address, gateway and mask are " +
      "deliberately not editable here.",
    fields: [
      { key: "HostName", label: "Network name", type: "text" },
      { key: "HttpPort", label: "HTTP port", type: "number", min: 1, max: 65535 },
      { key: "TCPPort", label: "DVRIP port", type: "number", min: 1, max: 65535,
        hint: "The port this integration uses" },
      { key: "UDPPort", label: "UDP port", type: "number", min: 1, max: 65535 },
      { key: "TCPMaxConn", label: "Max simultaneous connections", type: "number", min: 4, max: 32 },
      { key: "MaxBps", label: "Bandwidth cap, kbit/s", type: "number", min: 0, max: 100000,
        hint: "0 means no cap" },
      { key: "MonMode", label: "Live transport", type: "select",
        options: [["TCP", "TCP"], ["UDP", "UDP"]] },
      { key: "TransferPlan", label: "Transfer priority", type: "text",
        hint: "The same value as in the recorder's own menu" },
      { key: "UseHSDownLoad", label: "Fast download", type: "bool" },
    ],
  },
  {
    id: "ntp",
    title: "Network time (NTP)",
    section: "NetWork.NetNTP",
    hint: "Keeping the recorder's clock in step with a time server.",
    fields: [
      { key: "Enable", label: "Enable NTP", type: "bool" },
      { key: "Server.Name", label: "Server", type: "text" },
      { key: "Server.Port", label: "Port", type: "number", min: 1, max: 65535 },
      { key: "TimeZone", label: "Time zone (index)", type: "number", min: 0, max: 40 },
      { key: "UpdatePeriod", label: "Update period, min", type: "number", min: 1, max: 1440 },
    ],
  },
  {
    id: "motion",
    title: "Motion detection",
    section: "Detect.MotionDetect",
    perChannel: true,
    hint: "Sensitivity, and what happens on motion. The detection area is saved as it is — it is edited on a grid on the recorder itself.",
    fields: [
      { key: "Enable", label: "Enabled", type: "bool" },
      { key: "Level", label: "Sensitivity", type: "select",
        options: [[1, "1 — lowest"], [2, "2"], [3, "3"], [4, "4"], [5, "5"], [6, "6 — highest"]],
        numeric: true },
      { key: "EventHandler.RecordEnable", label: "Start recording", type: "bool" },
      { key: "EventHandler.RecordLatch", label: "Recording length, s", type: "number", min: 1, max: 600 },
      { key: "EventHandler.MessageEnable", label: "Message", type: "bool" },
      { key: "EventHandler.SnapEnable", label: "Snapshot", type: "bool" },
      { key: "EventHandler.BeepEnable", label: "Beep", type: "bool" },
      { key: "EventHandler.MailEnable", label: "Send mail", type: "bool" },
      { key: "EventHandler.FTPEnable", label: "Upload to FTP", type: "bool" },
      { key: "EventHandler.LogEnable", label: "Write to the log", type: "bool" },
    ],
  },
  {
    id: "blind",
    title: "Camera blinded",
    section: "Detect.BlindDetect",
    perChannel: true,
    hint: "What to do when a camera is covered or blinded.",
    fields: [
      { key: "Enable", label: "Enabled", type: "bool" },
      { key: "Level", label: "Sensitivity", type: "select",
        options: [[1, "1 — lowest"], [2, "2"], [3, "3"], [4, "4"], [5, "5"], [6, "6 — highest"]],
        numeric: true },
      { key: "EventHandler.RecordEnable", label: "Start recording", type: "bool" },
      { key: "EventHandler.RecordLatch", label: "Recording length, s", type: "number", min: 1, max: 600 },
      { key: "EventHandler.MessageEnable", label: "Message", type: "bool" },
      { key: "EventHandler.SnapEnable", label: "Snapshot", type: "bool" },
      { key: "EventHandler.BeepEnable", label: "Beep", type: "bool" },
      { key: "EventHandler.MailEnable", label: "Send mail", type: "bool" },
      { key: "EventHandler.FTPEnable", label: "Upload to FTP", type: "bool" },
      { key: "EventHandler.LogEnable", label: "Write to the log", type: "bool" },
    ],
  },
  {
    id: "loss",
    title: "Video loss",
    section: "Detect.LossDetect",
    perChannel: true,
    hint: "What to do when a camera stops sending a signal.",
    fields: [
      { key: "Enable", label: "Enabled", type: "bool" },
      { key: "EventHandler.RecordEnable", label: "Start recording", type: "bool" },
      { key: "EventHandler.RecordLatch", label: "Recording length, s", type: "number", min: 1, max: 600 },
      { key: "EventHandler.MessageEnable", label: "Message", type: "bool" },
      { key: "EventHandler.SnapEnable", label: "Snapshot", type: "bool" },
      { key: "EventHandler.BeepEnable", label: "Beep", type: "bool" },
      { key: "EventHandler.MailEnable", label: "Send mail", type: "bool" },
      { key: "EventHandler.FTPEnable", label: "Upload to FTP", type: "bool" },
      { key: "EventHandler.LogEnable", label: "Write to the log", type: "bool" },
    ],
  },
  {
    id: "widget",
    title: "Channel overlays",
    section: "AVEnc.VideoWidget",
    perChannel: true,
    hint: "The camera name and the time drawn over the picture. Coordinates are on a 0…8191 grid, independent of the resolution.",
    fields: [
      { key: "ChannelTitle.Name", label: "Camera name", type: "text" },
      { key: "ChannelTitleAttribute.PreviewBlend", label: "Name: show on the monitor", type: "bool" },
      { key: "ChannelTitleAttribute.EncodeBlend", label: "Name: burn into the stream", type: "bool" },
      { key: "ChannelTitleAttribute.RelativePos.0", label: "Name: X", type: "number", min: 0, max: 8191 },
      { key: "ChannelTitleAttribute.RelativePos.1", label: "Name: Y", type: "number", min: 0, max: 8191 },
      { key: "TimeTitleAttribute.PreviewBlend", label: "Time: show on the monitor", type: "bool" },
      { key: "TimeTitleAttribute.EncodeBlend", label: "Time: burn into the stream", type: "bool" },
      { key: "TimeTitleAttribute.RelativePos.0", label: "Time: X", type: "number", min: 0, max: 8191 },
      { key: "TimeTitleAttribute.RelativePos.1", label: "Time: Y", type: "number", min: 0, max: 8191 },
    ],
  },
  {
    id: "ptz",
    title: "PTZ",
    section: "Uart.PTZ",
    perChannel: true,
    hint: "Driving a pan-tilt-zoom camera over the serial port.",
    fields: [
      { key: "ProtocolName", label: "Protocol", type: "text",
        hint: "The same name as in the recorder's menu (PELCOD, for example)" },
      { key: "DeviceNo", label: "Device address", type: "number", min: 1, max: 255 },
      { key: "PortNo", label: "Port number", type: "number", min: 1, max: 8 },
      { key: "Attribute.0", label: "Speed, bit/s", type: "select", numeric: true,
        options: [[1200, "1200"], [2400, "2400"], [4800, "4800"], [9600, "9600"],
                  [19200, "19200"], [38400, "38400"], [57600, "57600"], [115200, "115200"]] },
      { key: "Attribute.1", label: "Parity", type: "text",
        hint: "The same value as in the recorder's menu (NONE, for example)" },
      { key: "Attribute.2", label: "Data bits", type: "number", min: 5, max: 8 },
      { key: "Attribute.3", label: "Stop bits", type: "number", min: 1, max: 2 },
    ],
  },
];

//: Thumbnail width in the channel grid. Home Assistant scales the frame itself.
const THUMB_WIDTH = 480;

//: How long to wait for HLS playback to begin before calling it a failure.
//: Home Assistant needs about thirteen seconds to bring up a stream from this
//: recorder (measured: master_playlist waited 13.25 s), so allow headroom.
const HLS_TIMEOUT = 35000;

//: How often to refresh the grid thumbnails.
const THUMB_INTERVAL = 10000;

//: English here and translated where used, like the other tables built at load.
const EVENT_LABELS = {
  schedule: "On schedule",
  motion: "Motion",
  alarm: "Alarm",
  manual: "Manual",
};

const EVENT_COLORS = {
  schedule: "var(--info-color, #2196f3)",
  motion: "var(--warning-color, #ff9800)",
  alarm: "var(--error-color, #f44336)",
  manual: "var(--success-color, #4caf50)",
};

const fmtBytes = (n) => {
  if (!n) return "—";
  const units = [t("B"), t("KB"), t("MB"), t("GB"), t("TB")];
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
  if (d) return t("{days}d {hours}h", { days: d, hours: h });
  if (h) return t("{hours}h {minutes}m", { hours: h, minutes: m });
  return t("{minutes}m", { minutes: m });
};

//: Fixed-width bitrate: without it the line under the video twitches every
//: second as the number moves between three and four digits.
const fmtBitrate = (kbps) => {
  if (!kbps && kbps !== 0) return "—";
  return t("{value} Mbit/s", { value: (kbps / 1000).toFixed(3).padStart(7, " ") });
};

//: The height alone, the way cameras, players and everyone talking about video
//: name a format: 640x480 is 480p whatever the aspect. The width is still there
//: to be read off the picture, and one number leaves room for the rest of the
//: line on a small tile.
const fmtHeight = (resolution) => {
  const found = /\d+\s*[x×]\s*(\d+)/.exec(resolution || "");
  return found ? `${found[1]}p` : "—";
};

//: What a stream is doing, in one line: 480p 25fps 2.11 Mbps. The numbers keep
//: fixed columns, so the line stays still while they change every second.
const fmtQuality = (stats) =>
  [
    fmtHeight(stats.resolution),
    `${String(stats.fps || 0).padStart(2, " ")}fps`,
    `${((stats.bitrate || 0) / 1000).toFixed(2).padStart(4, " ")} Mbps`,
  ].join(" ");

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
    //: Whether the options-flow defaults for player/stream have been applied for
    //: the current device. Applied once so a manual switch is not undone.
    this._defaultsApplied = false;
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
    //: Wall players on the overview, one per channel, and how many times each
    //: has been brought back after a failure.
    this._wall = new Map();
    this._wallRetries = new Map();
    //: Set when the whole wall shares one connection.
    this._wallReader = null;
    //: The socket behind the single-camera view, when the native player is the
    //: one showing it.
    this._nativeSocket = null;
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
    //: The joint log file's contents, once fetched for viewing.
    this._logFile = null;
    //: The rendered developer report, once it has been gathered.
    this._report = null;
    //: Writing the panel's own events into the integration's log file. The
    //: setting is read before anything else happens, because the window worth
    //: recording is the one that opens as the page loads.
    this._t0 = performance.now();
    this._logToFile = localStorage.getItem("xmeye-log-file") === "1";
    //: Names this page in the shared log. Two browsers recording at once is the
    //: normal case when chasing a fault that happens in only one of them.
    this._clientId = Math.random().toString(36).slice(2, 6);
    this._logQueue = [];
    this._logTimer = null;
    this._watchTimer = null;
    //: Recorder settings: which group is open, what was read, and what the user
    //: has edited but not yet written.
    this._settingsGroup = SETTINGS_GROUPS[0].id;
    this._settings = null;
    this._settingsEdits = {};
    //: Which channel a per-channel section is showing.
    this._settingsChannel = 0;
    this._settingsSaving = false;
    this._settingsNote = null;
    this._error = null;
    this._loading = true;
    this._timer = null;
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    // Home Assistant knows what the user reads; a language change there takes
    // effect on the next redraw rather than needing the page reloaded.
    if (hass && hass.language !== this._language) {
      this._language = hass.language;
      i18nModule.then((module) => {
        module.useLanguage(this._language);
        if (this._detail) this._render();
      });
    }
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

    if (this._logToFile) this._beginLogging();
    // The switch belongs to the recorder, not to this browser: a fault that only
    // happens in one browser has to be recordable from that browser, and turning
    // it on there first defeats the point. Local storage is only a head start,
    // so nothing is missed while the server is asked.
    this._askIfLogging();
    // A refresh is exactly when the interesting events happen, and the last
    // couple of seconds of them would otherwise die with the page.
    this._unload = () => this._shipLog(true);
    window.addEventListener("pagehide", this._unload);
  }

  _beginLogging() {
    clearInterval(this._logTimer);
    this._logTimer = setInterval(() => this._shipLog(false), 2000);
    this._noteLoad();
  }

  async _askIfLogging() {
    try {
      const reply = await fetch("/api/xmeye/debug", {
        headers: { Authorization: `Bearer ${await this._token()}` },
      }).then((r) => r.json());
      if (reply.enabled === this._logToFile) return;
      this._logToFile = reply.enabled;
      localStorage.setItem("xmeye-log-file", reply.enabled ? "1" : "0");
      if (reply.enabled) {
        this._noteDiag("log", `switched on by the server · ${navigator.userAgent}`);
        this._beginLogging();
        this._watchTiles();
      } else {
        clearInterval(this._logTimer);
        this._logQueue = [];
      }
    } catch (err) {
      /* the panel works without the log; nothing here is worth a message */
    }
  }

  disconnectedCallback() {
    clearInterval(this._timer);
    clearInterval(this._thumbTimer);
    clearInterval(this._logTimer);
    clearInterval(this._watchTimer);
    window.removeEventListener("pagehide", this._unload);
    this._shipLog(true);
    this._stopWall();
    this._stopPlayback();
  }

  async _ws(message) {
    return this._hass.callWS(message);
  }

  /**
   * A token that is still valid.
   *
   * Home Assistant's access token expires after about half an hour, and
   * `hass.auth.accessToken` keeps handing out the expired one. A stream started
   * with it is answered with 401 — which is what a wall left open overnight
   * shows the moment it tries to reconnect.
   */
  async _token() {
    const auth = this._hass.auth;
    try {
      if (auth && auth.expired && typeof auth.refreshAccessToken === "function") {
        await auth.refreshAccessToken();
        this._noteDiag("token refreshed");
      }
    } catch (err) {
      // Not fatal on its own: the stale token may still be accepted, and the
      // request will say so plainly if it is not.
      this._noteDiag("token refresh failed", String(err.message || err));
    }
    return auth && auth.accessToken;
  }

  async _bootstrap() {
    try {
      const { devices } = await this._ws({ type: "xmeye/devices" });
      this._devices = devices;
      if (!devices.length) {
        this._error = t("No recorder is configured.");
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
    // The first of these draws the shell with no channels at all, so the wall it
    // paints is empty — the tiles arrive on the second one. That pair is worth
    // seeing in the log, because it is a redraw between a player starting and
    // its first frame.
    this._renderReason = "details loading";
    this._render();
    try {
      this._detail = await this._ws({ type: "xmeye/device", entry_id: this._entryId });
      this._error = null;
      // Apply the player/stream defaults from the options flow once, on the
      // first load of this device — not on every refresh, or a manual switch
      // would be undone each poll.
      if (!this._defaultsApplied) {
        const opts = this._detail.options || {};
        if (opts.default_player === "native" ? nativePlayerSupported() : opts.default_player) {
          this._player = opts.default_player;
        }
        if (opts.default_live_stream) this._liveStream = opts.default_live_stream;
        this._defaultsApplied = true;
      }
      const enabled = this._detail.channels.filter((c) => c.enabled);
      if (enabled.length && !enabled.some((c) => c.index === this._selectedChannel)) {
        this._selectedChannel = enabled[0].index;
      }
    } catch (err) {
      this._error = err.message || String(err);
    }
    this._loading = false;
    this._renderReason = "details arrived";
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
    set("facts_channels_hint", t("recording: {count}", { count: d.totals.recording }));
    set("facts_bitrate", fmtBitrate(d.totals.bitrate));
    set("facts_disk", disk ? `${disk.used_percent}%` : "—");
    set("facts_archive", fmtDay(d.archive.from));
    set("facts_archive_hint", t("to {day}", { day: fmtDay(d.archive.to) }));
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
    const channel = this._selectedChannel;
    this._recordings = { loading: true };
    this._stopPlayback();
    this._render();
    try {
      this._recordings = await this._ws({
        type: "xmeye/recordings",
        entry_id: this._entryId,
        channel,
        start: `${day}T00:00:00`,
        end: `${day}T23:59:59`,
      });
    } catch (err) {
      this._recordings = { error: err.message || String(err) };
    }
    this._render();
    // A query that came back while the user had already moved on belongs to
    // nothing on screen, so it must not seize the player.
    if (channel !== this._selectedChannel || day !== this._recordingsDay) return;
    this._playEarliestRecording();
  }

  /**
   * Open the day's first recording at once.
   *
   * A timeline with nothing playing asks the viewer to guess where the video is
   * before showing any — and on a day with three hundred fragments the guess is
   * usually a gap. Starting at the earliest one means the archive answers with
   * a picture, and the timeline is then for moving, not for finding.
   */
  _playEarliestRecording() {
    const list = this._recordings && this._recordings.recordings;
    if (!list || !list.length) return;
    const earliest = list.reduce((first, item) =>
      new Date(item.begin) < new Date(first.begin) ? item : first
    );
    this._startPlayback(new Date(earliest.begin));
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

      const { NativePlayer: Player, WallSocket } = await nativeModule;
      const channel = this._live;
      const player = new Player(
        canvas,
        (stats) => {
          this._osd = stats;
          this._updateOsd();
        },
        (reason) => this._fallbackFromNative(reason),
        this._playerLog,
        { ...this._lab }
      );
      this._native = player;

      // One camera over the same socket the wall uses, carrying one channel.
      // Nothing about a single stream needs a second kind of transport, and one
      // fewer of them is one fewer to keep working.
      const address = await this._socketAddress();
      if (!address) {
        this._osd = { player: "native", error: t("no address for the stream") };
        this._updateOsd();
        return;
      }
      const socket = new WallSocket(this._playerLog, (_channel, said) => {
        if (this._nativeSocket !== socket) return;
        this._osd = { player: "native", error: t(WALL_TROUBLE[said.reason] || said.reason) };
        this._updateOsd();
      });
      socket.add(channel, player);
      this._nativeSocket = socket;
      socket
        .start(address, [{ channel, stream: this._liveStream }])
        .catch((err) => {
          if (this._nativeSocket !== socket) return;
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
    this._noteDiag("falling back", reason);
    if (this._liveStream === "main") {
      this._liveStream = "sub";
      this._fallbackNote = t("{reason}. Switched to the sub stream.", { reason });
    } else {
      this._player = "mjpeg";
      this._fallbackNote = t("{reason}. Switched to snapshots.", { reason });
    }
    this._remountLive();
  }

  _teardownPlayer() {
    // The socket first: it owns the connection, and stopping it stops the player
    // it carries. Leaving it open would hold a recorder connection for a camera
    // nobody is looking at any more.
    if (this._nativeSocket) {
      this._nativeSocket.stop();
      this._nativeSocket = null;
    }
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
    this._noteDiag("switching", `player ${this._player}, stream ${this._liveStream}`);
    this._render();
    if (channel) this._mountLiveCard(this._entityForStream(channel));
  }

  /**
   * The canvas each tile should keep across a redraw.
   *
   * The player's own canvas, not whichever one the document happens to hold. A
   * player is built from a canvas found in the DOM, but a redraw can land
   * between finding it and using it — the token refresh in the middle of
   * starting the wall is enough — and then the player is drawing on a node no
   * longer in the page. Asking the players makes that self-correcting: the next
   * redraw puts their canvas back on screen. Asking the DOM instead orphans them
   * silently, and the tile stays black with the frames arriving.
   */
  _liveCanvases() {
    const canvases = new Map();
    this.shadowRoot.querySelectorAll("canvas[data-wall]").forEach((canvas) =>
      canvases.set(Number(canvas.dataset.wall), canvas)
    );
    const orphaned = [];
    this._wall.forEach((player, index) => {
      if (!player.canvas) return;
      if (!player.canvas.isConnected) orphaned.push(index);
      canvases.set(index, player.canvas);
    });
    // Worth a line in the log rather than a silent repair: if this appears
    // often, a redraw is landing in the middle of starting the wall.
    if (orphaned.length) this._noteDiag("wall", `canvas put back: ${orphaned}`);
    return canvases;
  }

  /** Handlers for the wall toolbar, which a reflow replaces on its own. */
  _bindWallBar(root) {
    root.querySelectorAll(".layout").forEach((button) =>
      button.addEventListener("click", () => {
        this._layout = Number(button.dataset.layout);
        this._wallPage = 0;
        localStorage.setItem("xmeye-layout", String(this._layout));
        // A different layout shows a different set of tiles, so this one goes
        // through a reflow too rather than reconnecting the cameras that stay.
        this._reflowWall();
      })
    );

    const full = root.getElementById("wallfull");
    if (full) full.addEventListener("click", () => this._toggleWallFullscreen());

    const prev = root.getElementById("wallprev");
    if (prev)
      prev.addEventListener("click", () => {
        this._wallPage = Math.max(0, this._wallPage - 1);
        this._reflowWall();
      });
    const next = root.getElementById("wallnext");
    if (next)
      next.addEventListener("click", () => {
        this._wallPage += 1;
        this._reflowWall();
      });
  }

  /** Append an event to the shared diagnostics log. */
  /**
   * A sink the players write their own events through.
   *
   * Passed instead of the log array so that a decoder configuration or a first
   * drawn frame reaches the shared file when it happens. Handed to the players
   * as a function, which is what tells them to call rather than append.
   */
  get _playerLog() {
    if (!this._playerSink) {
      this._playerSink = (entry) => {
        this._diagLog.push(entry);
        if (this._diagLog.length > 300) this._diagLog.shift();
        if (this._logToFile) {
          this._logQueue.push({
            epoch: Date.now(),
            event: entry.event,
            detail: entry.detail,
          });
        }
      };
    }
    return this._playerSink;
  }

  /** The same sink, with every line saying which channel it came from. */
  _channelLog(index) {
    return (entry) => this._playerLog({ ...entry, event: `ch${index} ${entry.event}` });
  }

  /** Whether anything has been drawn on a tile, judged from the pixels. */
  _tileHasPicture(canvas) {
    if (!canvas.width || !canvas.height) return false;
    try {
      const ctx = canvas.getContext("2d");
      // Five points rather than one: a night scene is mostly black, and a single
      // sample in a dark corner would report an empty tile for minutes.
      const spots = [
        [canvas.width >> 1, canvas.height >> 1],
        [canvas.width >> 2, canvas.height >> 2],
        [(canvas.width * 3) >> 2, canvas.height >> 2],
        [canvas.width >> 2, (canvas.height * 3) >> 2],
        [(canvas.width * 3) >> 2, (canvas.height * 3) >> 2],
      ];
      return spots.some(([x, y]) => {
        const [r, g, b, a] = ctx.getImageData(x, y, 1, 1).data;
        return a > 0 && r + g + b > 24;
      });
    } catch (err) {
      return false;
    }
  }

  /**
   * Watch what the tiles actually show, for as long as it takes to come up.
   *
   * The one thing the log could not see was the screen: every other line says
   * what the code did, and a blink is a statement about what the viewer saw. So
   * while the file is being written, each tile is sampled ten times a second and
   * every change of state is recorded — picture or blank, what the caption says,
   * how large the canvas is, whether it is still in the document. Only changes,
   * so a steady wall costs a handful of lines.
   */
  _watchTiles() {
    clearInterval(this._watchTimer);
    if (!this._logToFile) return;
    const seen = new Map();
    const until = performance.now() + TILE_WATCH;
    this._watchTimer = setInterval(() => {
      if (performance.now() > until) {
        clearInterval(this._watchTimer);
        this._noteDiag("tiles", "watch finished");
        return;
      }
      this.shadowRoot.querySelectorAll("canvas[data-wall]").forEach((canvas) => {
        const index = Number(canvas.dataset.wall);
        const foot = this.shadowRoot.querySelector(`[data-field="wall${index}"]`);
        const state = [
          this._tileHasPicture(canvas) ? "picture" : "blank",
          `${canvas.width}x${canvas.height}`,
          canvas.isConnected ? "" : "OUT OF DOM",
          `"${foot ? foot.textContent.trim().slice(0, 44) : "no caption"}"`,
        ]
          .filter(Boolean)
          .join(" · ");
        if (seen.get(index) === state) return;
        seen.set(index, state);
        this._noteDiag("tile", `ch${index} ${state}`);
      });
    }, 100);
  }

  /**
   * Record an event in the diagnostics log.
   *
   * English, always, whatever the panel is showing. This log is read by whoever
   * is fixing the thing — it goes into the shared file, into the developer
   * report, into an issue on GitHub — and a report nobody but its author can
   * read is worth less than no report. Everything the *viewer* reads is
   * translated; everything about the machine is not.
   */
  _noteDiag(event, detail) {
    const at = new Date().toTimeString().slice(0, 8);
    this._diagLog.push({ at, event, ...(detail ? { detail } : {}) });
    if (this._diagLog.length > 300) this._diagLog.shift();
    // Seconds since the panel loaded, which is what the shared file is keyed on.
    // A blink lasts a fraction of a second, and a clock printed to the second
    // cannot order anything inside one.
    // Wall time, not time since load: the file's clock is the server's, and the
    // panel may be open on another device entirely.
    if (this._logToFile) this._logQueue.push({ epoch: Date.now(), event, detail });
  }

  /**
   * Send what the panel has seen to the integration's own log.
   *
   * The file holds both sides on one clock, so the ordering of a blink can be
   * read off the page instead of aligned by eye across two logs. Batched every
   * couple of seconds rather than per event: the wall alone would otherwise post
   * several times a second.
   */
  async _shipLog(final) {
    if (!this._logToFile || !this._logQueue.length) return;
    const entries = this._logQueue.splice(0, this._logQueue.length);
    try {
      await fetch("/api/xmeye/debug", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${await this._token()}`,
          "Content-Type": "application/json",
        },
        // `now` lets the server line this batch up with its own clock, and
        // `client` tells one browser's lines from another's when two are open.
        body: JSON.stringify({ now: Date.now(), client: this._clientId, entries }),
        // The last batch is sent while the page is going away, and a plain
        // request would be cancelled with it.
        keepalive: Boolean(final),
      });
    } catch (err) {
      // Put them back, unless the page is closing and there is no next time.
      if (!final) this._logQueue.unshift(...entries);
    }
  }

  async _setLogToFile(on) {
    this._logToFile = on;
    localStorage.setItem("xmeye-log-file", on ? "1" : "0");
    clearInterval(this._logTimer);
    // The server keeps the switch too: it writes its own half of the file, and
    // a panel that is merely open should not make it write forever.
    const headers = { Authorization: `Bearer ${await this._token()}` };
    await fetch(`/api/xmeye/debug?on=${on ? 1 : 0}`, { headers });
    if (!on) {
      this._logQueue = [];
      return;
    }
    this._logTimer = setInterval(() => this._shipLog(false), 2000);
    this._noteDiag("log", "writing to file");
    this._noteLoad();
    this._render();
  }

  /**
   * How this page arrived: reload, back-forward cache, or a fresh visit.
   *
   * A restored page brings its old DOM with it and its scripts do not run
   * again, which behaves differently enough from a reload to be worth naming
   * before anything else in the file is read.
   */
  /** Which browser this is, in the two words that matter for a decoder fault. */
  _browserName() {
    const ua = navigator.userAgent;
    const version = (pattern) => (ua.match(pattern) || [])[1] || "?";
    if (/Firefox\//.test(ua)) return `Firefox ${version(/Firefox\/([\d.]+)/)}`;
    if (/Edg\//.test(ua)) return `Edge ${version(/Edg\/([\d.]+)/)}`;
    if (/Chrome\//.test(ua)) return `Chrome ${version(/Chrome\/([\d.]+)/)}`;
    if (/Safari\//.test(ua)) return `Safari ${version(/Version\/([\d.]+)/)}`;
    return ua.slice(0, 40);
  }

  _noteLoad() {
    const nav = performance.getEntriesByType("navigation")[0];
    const script = performance
      .getEntriesByType("resource")
      .find((entry) => entry.name.includes("xmeye-panel.js"));
    this._noteDiag(
      "page load",
      [
        // Named once per page, so the browser behind every later line is known
        // without repeating a user agent string on each of them.
        `${this._clientId} ${this._browserName()}`,
        `type ${nav ? nav.type : "?"}`,
        nav ? `ready in ${(nav.domContentLoadedEventEnd / 1000).toFixed(2)}s` : "",
        // A zero transfer size with a non-zero decoded size means the browser
        // served it from its own cache rather than from Home Assistant.
        script
          ? `panel ${script.transferSize === 0 ? "from cache" : `${script.transferSize} B`}`
          : "panel not among the resources",
      ]
        .filter(Boolean)
        .join(", ")
    );
  }

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------

  _render() {
    // Every recorder poll ends in a redraw, and a redraw used to stop the whole
    // wall and dial it again — sixteen cameras reconnecting because a
    // temperature reading changed. The canvases are taken out first and put back
    // into the new cells instead: a canvas survives a move with its contents and
    // its context, so the players carry on across the redraw and only genuine
    // differences are dialled.
    const canvases = this._liveCanvases();
    const why = this._renderReason || "";
    this._renderReason = null;

    this.shadowRoot.innerHTML = `<style>${STYLES}</style>${this._template()}`;
    this._bind();

    if (this._tab !== "overview" || !this._detail || this._live !== null) {
      this._noteDiag("redraw", `tab ${this._tab}${why ? `, ${why}` : ""}`);
      this._stopWall();
      return;
    }
    const adopted = [];
    for (const [index, canvas] of canvases) {
      const fresh = this.shadowRoot.querySelector(`canvas[data-wall="${index}"]`);
      if (!fresh) continue;
      fresh.replaceWith(canvas);
      adopted.push(index);
    }
    // A redraw is the one thing that can put a blank tile on screen while its
    // player is mid-stream, so every one of them says what it moved and why.
    this._noteDiag(
      "redraw",
      `wall, canvases ${adopted.length ? adopted.join(",") : "none"}${why ? `, ${why}` : ""}`
    );
    this._startWall();
  }

  _template() {
    if (this._loading && !this._detail) return this._shell(`<div class="empty">${t("Loading…")}</div>`);
    if (this._error && !this._detail)
      return this._shell(`<div class="empty error">${this._error}</div>`);
    if (!this._detail) return this._shell(`<div class="empty">${t("No data")}</div>`);

    const tabs = {
      overview: this._overview(),
      channels: this._channels(),
      archive: this._archive(),
      config: this._config(),
      log: this._logView(),
      settings: this._settingsView(),
      debug: this._debugView(),
    };
    return this._shell(tabs[this._tab] || tabs.overview);
  }

  _shell(body) {
    const d = this._detail;
    const tabs = [
      ["overview", t("Overview")],
      ["channels", t("Channels")],
      ["archive", t("Archive")],
      ["config", t("Configuration")],
      ["settings", t("Settings")],
      ["log", t("Log")],
      ["debug", t("Report")],
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
      [t("Channels"), `${d.channels.filter((c) => c.online).length} / ${d.device.channels}`,
       t("recording: {count}", { count: d.totals.recording }), "facts_channels"],
      [t("Stream"), fmtBitrate(d.totals.bitrate), "", "facts_bitrate"],
      [t("Disk"), disk ? `${disk.used_percent}%` : "—",
       disk ? `${(disk.total_mb / 1024).toFixed(0)} ${t("GB")}` : "", "facts_disk"],
      [t("Archive"), fmtDay(d.archive.from), t("to {day}", { day: fmtDay(d.archive.to) }),
       "facts_archive"],
      [t("Uptime"), fmtDuration(d.device.uptime_seconds), fmtClockFull(d.device.device_time),
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
    const plan = this._wallPlan();
    return `
      ${this._wallBar(plan)}
      <div class="wall-layout">
        ${this._wallPicker(plan.sequence)}
        <div class="wall" style="--columns:${plan.layout.columns};--rows:${plan.layout.rows}">
          ${this._wallCells(plan)}
        </div>
      </div>`;
  }

  /** What the wall shows right now: the order, the layout and the current page. */
  _wallPlan() {
    const enabled = this._detail.channels.filter((c) => c.enabled);
    const sequence = this._wallSequence(enabled);
    const channels = this._wallVisible(enabled);
    const layout = LAYOUTS.find((l) => l.id === this._layout) || LAYOUTS[1];
    const pages = Math.max(1, Math.ceil(channels.length / layout.id));
    this._wallPage = Math.min(this._wallPage, pages - 1);
    const shown = channels.slice(this._wallPage * layout.id, (this._wallPage + 1) * layout.id);
    return { sequence, channels, layout, pages, shown };
  }

  _wallCells({ layout, shown }) {
    // Empty slots stay visible so the wall does not jump when a channel appears.
    return [
      ...shown.map((c, i) => this._wallTile(c, layout, i)),
      ...Array.from({ length: layout.id - shown.length }, (_, i) =>
        this._emptyCell(layout, shown.length + i)
      ),
    ].join("");
  }

  _wallBar({ channels, pages }) {
    return `
      <div class="toolbar wall-bar">
        <div class="layouts">
          ${LAYOUTS.map(
            (l) =>
              `<button class="ghost layout ${l.id === this._layout ? "active" : ""}"
                       data-layout="${l.id}"
                       title="${channelCount(l.id)}">${layoutIcon(l)}</button>`
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
        <div class="hint">${t("{shown} of {total} channels on the wall", {
          shown: channels.length,
          total: this._detail.device.channels,
        })}</div>
        <button class="ghost wall-full" id="wallfull"
                title="${t("Fullscreen (Esc to leave)")}">${fullscreenIcon()}</button>
      </div>`;
  }

  /**
   * The wall alone, filling the screen.
   *
   * Fullscreen is asked of the element that is already on the page rather than
   * drawn again somewhere else: the canvases stay exactly where they are, so
   * every camera keeps playing through the switch and back. The picker is hidden
   * by CSS for the same reason — removing it from the DOM would move the tiles.
   */
  _toggleWallFullscreen() {
    const layout = this.shadowRoot.querySelector(".wall-layout");
    if (!layout) return;
    const open = document.fullscreenElement || document.webkitFullscreenElement;
    if (open) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      return;
    }
    const request = layout.requestFullscreen || layout.webkitRequestFullscreen;
    if (!request) {
      this._noteDiag("wall", "the browser offers no fullscreen");
      return;
    }
    // Safari resolves this rejection rather than throwing, so both are caught.
    Promise.resolve(request.call(layout)).catch((err) =>
      this._noteDiag("wall", `fullscreen refused: ${err.message || err}`)
    );
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
    const rows = sequence.map((channel) => {
      const shown = !hidden.includes(channel.index);
      // One control carries both facts: filled means the channel is on the wall,
      // green means the recorder sees it. Two separate marks said the same thing
      // twice and cost half the row.
      const state = shown
        ? channel.online
          ? t("On the wall, camera online")
          : t("On the wall, camera offline")
        : t("Not on the wall");
      return `
        <li class="pick ${shown ? "on" : "off"}" data-index="${channel.index}"
            title="${t("Drag the row to reorder")}">
          <button class="pick-dot ${shown ? "shown" : ""} ${channel.online ? "online" : ""}"
                  data-pick="${channel.index}" title="${state}"></button>
          <span class="pick-grip"></span>
          <span class="pick-num">${channel.index + 1}</span>
          <span class="pick-name" title="${channel.name}">${channel.name}</span>
          <select class="pick-stream" data-stream="${channel.index}"
                  title="${t("Stream of this camera on the wall")}">
            ${WALL_STREAMS.map(
              ([id, label]) =>
                `<option value="${id}" ${
                  id === this._wallStream(channel.index) ? "selected" : ""
                }>${t(label)}</option>`
            ).join("")}
          </select>
        </li>`;
    });
    return `
      <aside class="picker">
        <div class="picker-head">${t("Wall channels")}</div>
        <ul class="pick-list">${rows.join("")}</ul>
      </aside>`;
  }

  /**
   * Reordering by dragging a row.
   *
   * Only the grip starts a drag: the row also holds a select, and a row that is
   * draggable at every point makes that awkward to use.
   */
  _bindWallDrag(list) {
    let dragging = null;

    // The whole row starts a drag, not just the grip: the grip is four pixels
    // wide and missing it landed on the name, which selected the text instead of
    // moving anything. The two controls in the row are excluded, because a press
    // on them is a click.
    const arm = (event) => {
      const row = event.target.closest(".pick");
      if (!row || event.target.closest(".pick-dot, .pick-stream")) return;
      row.draggable = true;
    };
    list.addEventListener("mousedown", arm);
    list.addEventListener("touchstart", arm, { passive: true });

    // A press that never became a drag must disarm the row again, or it stays
    // draggable and the select inside it becomes hard to use.
    list.addEventListener("mouseup", () => {
      if (!dragging) list.querySelectorAll(".pick").forEach((row) => (row.draggable = false));
    });

    list.addEventListener("dragstart", (event) => {
      dragging = event.target.closest(".pick");
      if (!dragging) return;
      dragging.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
      // Firefox refuses to start a drag with no data attached.
      event.dataTransfer.setData("text/plain", dragging.dataset.index);
    });

    list.addEventListener("dragover", (event) => {
      if (!dragging) return;
      event.preventDefault();
      const over = event.target.closest(".pick");
      if (!over || over === dragging) return;
      // Past the midpoint the row belongs below the one under the cursor.
      const box = over.getBoundingClientRect();
      const below = event.clientY > box.top + box.height / 2;
      list.insertBefore(dragging, below ? over.nextSibling : over);
    });

    list.addEventListener("dragend", () => {
      if (!dragging) return;
      dragging.classList.remove("dragging");
      dragging.draggable = false;
      dragging = null;
      this._commitWallOrder(list);
    });
  }

  /** Take the order from the list as it now stands and redraw the wall. */
  _commitWallOrder(list) {
    const order = [...list.querySelectorAll(".pick")].map((row) => Number(row.dataset.index));
    const prefs = this._loadWallPrefs();
    if (order.join() === prefs.order.join()) return;
    prefs.order = order;
    this._saveWallPrefs();
    this._reflowWall();
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

    // The row itself only changes state, so it is repainted rather than rebuilt;
    // rebuilding the list would drop the drag bindings with it.
    const shown = !hidden.includes(index);
    const row = this.shadowRoot.querySelector(`.pick[data-index="${index}"]`);
    if (row) {
      row.classList.toggle("on", shown);
      row.classList.toggle("off", !shown);
      const dot = row.querySelector(".pick-dot");
      dot.classList.toggle("shown", shown);
      dot.title = shown
        ? dot.classList.contains("online")
          ? t("On the wall, camera online")
          : t("On the wall, camera offline")
        : t("Not on the wall");
    }
    this._reflowWall();
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
          ${channel.online ? t("connecting…") : t("offline")}
        </div>
      </div>`;
  }

  /**
   * Bring the wall up, or bring an already running one in line.
   *
   * Called after every redraw, so the common case is that nothing changed and
   * there is nothing to do. Only an empty wall is dialled from scratch.
   */
  async _startWall() {
    const { nativePlayerSupported: supported } = await nativeModule;
    if (!supported()) return;

    const canvases = [...this.shadowRoot.querySelectorAll("canvas[data-wall]")];
    if (!canvases.length) {
      this._stopWall();
      return;
    }
    if (this._wall.size) {
      await this._syncWallPlayers(canvases.map((canvas) => Number(canvas.dataset.wall)));
      return;
    }
    this._noteDiag("wall", `start, ${canvases.length} channels`);
    this._watchTiles();
    await this._openWallSocket(canvases);
  }

  /** A wall player for one channel, wired to that tile's cell and log. */
  async _makeWallPlayer(index, canvas) {
    const { NativePlayer: Player } = await nativeModule;
    const player = new Player(
      canvas,
      (stats) => this._updateWallCell(index, stats),
      () => this._updateWallCell(index, { error: t("could not decode") }),
      this._channelLog(index)
    );
    this._wall.set(index, player);
    return player;
  }

  /** What the socket should be carrying: every tile, on the stream it wants. */
  _wallWanted() {
    return [...this._wall.keys()].map((index) => ({
      channel: index,
      stream: this._wallStream(index),
    }));
  }

  /**
   * Every tile from one socket.
   *
   * The socket owns the connection and hands each record to the player that owns
   * that channel; the players do the same decoding and drawing as ever. Each
   * channel names its own stream, so a tile on the main stream travels with the
   * rest rather than costing a connection of its own.
   */
  async _openWallSocket(canvases) {
    const { WallSocket } = await nativeModule;
    const socket = new WallSocket(this._playerLog, null);
    socket.onChannelError = (channel, said) => {
      if (this._wallReader !== socket) return;
      const what = t(WALL_TROUBLE[said.reason] || said.reason);
      const next = said.attempt
        ? t("attempt {attempt} in {seconds}s", { attempt: said.attempt, seconds: said.retryIn })
        : t("could not be recovered");
      this._noteDiag("wall", `channel ${channel}: ${said.reason} ${said.detail || ""}`.trim());
      this._updateWallCell(channel, { error: `${what} · ${next}` });
    };

    const address = await this._socketAddress();
    if (!address) {
      canvases.forEach((canvas) =>
        this._updateWallCell(Number(canvas.dataset.wall), { error: t("no address for the stream") })
      );
      return;
    }
    this._wallReader = socket;

    // Looked up again after the await, not carried across it: a redraw in
    // between would have left every one of those nodes out of the document.
    for (const stale of canvases) {
      const index = Number(stale.dataset.wall);
      const canvas = this.shadowRoot.querySelector(`canvas[data-wall="${index}"]`) || stale;
      socket.add(index, await this._makeWallPlayer(index, canvas));
    }

    const channels = [...socket.players.keys()];
    socket.start(address, this._wallWanted()).catch((err) => {
      if (this._wallReader !== socket) return;
      this._noteDiag("wall", `socket failed: ${err.message || err}`);
      channels.forEach((index) => this._failWallTile(index, err));
    });
  }

  /**
   * A signed address for the video socket, or nothing if it cannot be had.
   *
   * A browser cannot put an authorization header on a WebSocket, so Home
   * Assistant signs the path against this user and the address itself is the
   * permission. It is asked for fresh each time: it expires in minutes, and a
   * wall may be opened hours after the page was.
   */
  async _socketAddress() {
    if (typeof WebSocket === "undefined") return null;
    try {
      const { path } = await this._ws({
        type: "xmeye/stream_url",
        entry_id: this._entryId,
      });
      const url = new URL(path, location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      return url.toString();
    } catch (err) {
      this._noteDiag("wall", `no signed address: ${err.message || err}`);
      return null;
    }
  }

  /**
   * A tile that stopped is brought back rather than left dead.
   *
   * A wall is meant to be left open, and over hours a connection does drop —
   * the recorder recycles it, the network blinks, a token expires. Without this
   * the tile simply stays frozen until someone reloads the page.
   */
  _failWallTile(index, err) {
    const message = String((err && err.message) || err);
    const attempt = (this._wallRetries.get(index) || 0) + 1;
    this._wallRetries.set(index, attempt);
    this._noteDiag("wall", `channel ${index} failed (${attempt}): ${message}`);

    if (attempt > WALL_RETRIES) {
      this._updateWallCell(index, { error: message });
      return;
    }
    // Back off a little each time, so a recorder that is genuinely out of
    // connections is not hammered.
    const delay = WALL_RETRY_DELAY * attempt;
    const next = t("attempt {attempt} in {seconds}s", { attempt, seconds: delay / 1000 });
    this._updateWallCell(index, { error: `${message} · ${next}` });
    setTimeout(() => {
      if (this._tab === "overview" && this._live === null) this._restartWallTile(index);
    }, delay);
  }

  /**
   * Bring one tile back, on the connection the whole wall uses.
   *
   * Every tile lives on the socket, so this is a removal and an addition in the
   * channel list rather than a connection of its own being dialled.
   */
  async _restartWallTile(index) {
    if (this._wallReader) this._wallReader.remove(index);
    this._wall.delete(index);

    const canvas = this.shadowRoot.querySelector(`canvas[data-wall="${index}"]`);
    if (!canvas || !this._wallReader) {
      await this._sendWallChannels();
      return;
    }
    this._updateWallCell(index, { connecting: true });
    this._wallReader.add(index, await this._makeWallPlayer(index, canvas));
    await this._sendWallChannels();
  }

  /**
   * Redraw the wall without disturbing the cameras that stay on it.
   *
   * Switching one channel off or dragging a tile changes what is on screen, not
   * what the other cameras are doing — yet a redraw stops every player and
   * reconnects, so a change touching one tile blacks out all of them for a
   * second or more. Here the cells are rebuilt as markup and the canvases of the
   * channels that remain are moved into them: a canvas keeps its contents and
   * its context across a move, so its player never learns anything happened.
   * Only the difference is then started or stopped.
   */
  async _reflowWall() {
    const root = this.shadowRoot;
    const wall = root.querySelector(".wall");
    if (!wall || this._tab !== "overview" || this._live !== null || !this._detail) {
      this._render();
      return;
    }
    const plan = this._wallPlan();

    // Carry over what the running tiles are showing, picture and caption both.
    const canvases = this._liveCanvases();
    const feet = new Map();
    wall.querySelectorAll(".cell-foot").forEach((f) => feet.set(f.dataset.field, f.innerHTML));

    wall.style.setProperty("--columns", plan.layout.columns);
    wall.style.setProperty("--rows", plan.layout.rows);
    wall.innerHTML = this._wallCells(plan);

    for (const [index, canvas] of canvases) {
      const fresh = wall.querySelector(`canvas[data-wall="${index}"]`);
      if (fresh) fresh.replaceWith(canvas);
    }
    wall.querySelectorAll(".cell-foot").forEach((foot) => {
      const kept = feet.get(foot.dataset.field);
      if (kept !== undefined && this._wall.has(Number(foot.dataset.field.slice(4)))) {
        foot.innerHTML = kept;
      }
    });
    wall.querySelectorAll(".cell[data-channel]").forEach((cell) =>
      cell.addEventListener("click", () => this._openLive(Number(cell.dataset.channel)))
    );

    // The pager and the count belong to the toolbar, which is cheap to replace.
    const bar = root.querySelector(".wall-bar");
    if (bar) {
      bar.outerHTML = this._wallBar(plan);
      this._bindWallBar(root);
    }

    await this._syncWallPlayers(plan.shown.map((c) => c.index));
  }

  /**
   * Bring the running players in line with the tiles now on the wall.
   *
   * This is a message rather than a reconnection: the server adds or drops that
   * camera on the connection everything else is still using.
   */
  async _syncWallPlayers(wanted) {
    const running = [...this._wall.keys()];
    const gone = running.filter((index) => !wanted.includes(index));
    const fresh = wanted.filter((index) => !this._wall.has(index));
    if (!gone.length && !fresh.length) return;
    this._noteDiag("wall", `reconciled: added ${fresh}, dropped ${gone}`);

    for (const index of gone) {
      if (this._wallReader) this._wallReader.remove(index);
      else {
        const player = this._wall.get(index);
        if (player) player.stop();
      }
      this._wall.delete(index);
      this._wallRetries.delete(index);
    }

    // A wall with no socket at all is one that never opened; bring it up whole
    // rather than adding channels to nothing.
    if (!this._wallReader) {
      this._stopWall();
      await this._startWall();
      return;
    }

    for (const index of fresh) {
      const canvas = this.shadowRoot.querySelector(`canvas[data-wall="${index}"]`);
      if (!canvas) continue;
      this._wallReader.add(index, await this._makeWallPlayer(index, canvas));
    }
    await this._sendWallChannels();
  }

  /**
   * Tell the socket which channels to carry, and on which streams.
   *
   * A message on the connection it is about — which is the whole reason the wall
   * moved to a socket. Before, this was a second request naming a session,
   * because a browser cannot write into a request whose response it is reading.
   */
  async _sendWallChannels() {
    const socket = this._wallReader;
    if (!socket) return;
    await socket.ready;
    if (this._wallReader !== socket) return;

    const wanted = this._wallWanted().filter(({ channel }) => socket.players.has(channel));
    if (!wanted.length) {
      // Nothing left to carry, and an idle connection would be held for nothing.
      this._noteDiag("wall", "socket no longer needed");
      socket.stop();
      this._wallReader = null;
      return;
    }
    socket.setChannels(wanted);
  }

  _stopWall() {
    if (this._wallReader) {
      this._wallReader.stop();
      this._wallReader = null;
    }
    this._wall.forEach((player) => player.stop());
    this._wall.clear();
    this._wallRetries.clear();
  }

  _updateWallCell(index, stats) {
    if (stats.fps) this._wallRetries.delete(index);
    const foot = this.shadowRoot.querySelector(`[data-field="wall${index}"]`);
    if (!foot) return;
    if (stats.error) {
      foot.textContent = `⚠ ${stats.error}`;
    } else if (stats.connecting) {
      foot.textContent = t("connecting…");
    } else {
      foot.textContent = fmtQuality(stats);
    }
  }

  _badges(channel) {
    return [
      channel.recording ? `<span class="badge rec">${t("recording")}</span>` : "",
      channel.motion ? `<span class="badge motion">${t("motion")}</span>` : "",
      channel.video_loss ? `<span class="badge loss">${t("no signal")}</span>` : "",
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
              : `<div class="noimage">${channel.online ? t("No frame") : t("Offline")}</div>`
          }
          <div class="badges">${this._badges(channel)}</div>
        </div>
        <div class="tile-body">
          <div class="tile-name">${channel.name}</div>
          <div class="tile-meta" data-field="meta">${
            channel.resolution || channel.status
          } · ${t("{kbps} kbit/s", { kbps: channel.bitrate })}</div>
        </div>
      </div>`;
  }

  _channels() {
    const d = this._detail;
    return `
      <table class="data">
        <thead>
          <tr><th>#</th><th>${t("Name")}</th><th>${t("State")}</th><th>${t("Resolution")}</th>
              <th>${t("Bitrate")}</th><th>${t("Recording")}</th><th>${t("Motion")}</th></tr>
        </thead>
        <tbody>
          ${d.channels
            .map(
              (c) => `
            <tr class="${c.online ? "" : "dim"}">
              <td>${c.index + 1}</td>
              <td>${c.name}</td>
              <td>${c.online ? t("Connected") : c.status}</td>
              <td>${c.resolution || "—"}</td>
              <td>${c.bitrate || 0}</td>
              <td>${c.recording ? t("yes") : "—"}</td>
              <td>${c.motion ? t("yes") : "—"}</td>
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

    let body = `<div class="empty">${t("Pick a day and press Show.")}</div>`;
    if (rec && rec.loading) body = `<div class="empty">${t("Looking for recordings…")}</div>`;
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
        <button class="primary" id="search">${t("Show")}</button>
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
    // The recorder hands an archive over at about seven times real time, so
    // ×16 could never be reached and only ever showed as a broken promise.
    const rates = [1, 2, 4, 8];
    return `
      <div class="player">
        <div class="player-head">
          <span>${fmtClockFull(p.start)} — ${t("channel {channel}", { channel: this._selectedChannel + 1 })}</span>
          <button class="ghost" id="closeplay">✕</button>
        </div>
        <div class="player-screen"><canvas id="playcanvas"></canvas></div>
        <div class="player-bar">
          <button class="ghost" id="playpause">${p.paused ? "▶" : "⏸"}</button>
          <button class="ghost" id="stepback" title="${t("back 10 s")}">⏪</button>
          <button class="ghost" id="stepfwd" title="${t("forward 10 s")}">⏩</button>
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
   * Start playback from a given moment.
   *
   * One mechanism at every speed: the whole stream, paced by the player's own
   * clock. The recorder hands an archive over at about seven times real time —
   * measured on the device — so ×1 to ×4 play every frame, and beyond that the
   * player thins what it cannot decode in time. The speed actually reached is
   * shown beside the one asked for, because the link, not the wish, decides it.
   */
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
      position: start.toISOString(),
    };
    this._render();

    const canvas = this.shadowRoot.getElementById("playcanvas");
    if (!canvas) return;
    const { NativePlayer: Player } = await nativeModule;
    // Stopping a player rejects the fetch it is waiting on, and that rejection
    // lands after the next one has already started. Reporting it against
    // whatever is current then paints the fresh stream as broken — which is
    // exactly what switching camera looked like: an error, and the previous
    // camera's last frame left on screen.
    const mine = () => this._archivePlayer === player;
    const player = new Player(
      canvas,
      (stats) => {
        if (mine()) this._updatePlaybackTime(stats);
      },
      (reason) => {
        if (!mine()) return;
        this._playback.error = reason;
        this._render();
      },
      this._playerLog,
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
        await this._token()
      )
      .catch((err) => {
        // A player that has been replaced is allowed to fail quietly.
        if (!mine()) return;
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
        (actual ? t("  (really ×{rate})", { rate: actual.toFixed(1) }) : "");
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
      return `<div class="empty">${t("Nothing recorded on {day}.", { day: this._recordingsDay })}</div>`;

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
          t(EVENT_LABELS[r.event] || r.event)
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
        <div class="hint">${t("Click the bar to play from that moment.")}</div>
        <div class="legend">
          ${Object.entries(byEvent)
            .map(
              ([event, count]) =>
                `<span class="chip"><i style="background:${
                  EVENT_COLORS[event] || "var(--primary-color)"
                }"></i>${t(EVENT_LABELS[event] || event)}: ${count}</span>`
            )
            .join("")}
          <span class="chip">${t("Total: {count}", { count: rec.count })} · ${fmtBytes(rec.total_bytes)}</span>
        </div>
      </div>
      <table class="data">
        <thead><tr><th>${t("Start")}</th><th>${t("End")}</th><th>${t("Event")}</th>
              <th>${t("Size")}</th><th>${t("File")}</th></tr></thead>
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
              }"></i>${t(EVENT_LABELS[r.event] || r.event)}</span></td>
              <td>${fmtBytes(r.size)}</td>
              <td class="mono">${r.name.split("/").pop()}</td>
            </tr>`
            )
            .join("")}
        </tbody>
      </table>
      ${
        rec.recordings.length > 300
          ? `<div class="hint pad">${t("Showing the first 300 of {count}.", { count: rec.recordings.length })}</div>`
          : ""
      }`;
  }

  _config() {
    const tree = this._configTree;
    if (!tree) return `<div class="empty"><button class="primary" id="loadconfig">${t("Read the configuration")}</button></div>`;
    if (tree.loading) return `<div class="empty">${t("Reading the configuration tree…")}</div>`;
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

    let viewer = `<div class="empty">${t("Pick a section on the left.")}</div>`;
    if (this._configValue) {
      if (this._configValue.loading) viewer = `<div class="empty">${t("Reading…")}</div>`;
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
          <div class="viewer-head">${this._configSection || t("Configuration")}</div>
          ${viewer}
        </section>
      </div>`;
  }

  /**
   * The developer report.
   *
   * These recorders differ from one another in ways no document lists, so a
   * report saying only "it does not work" costs several rounds of questions.
   * One button gathers the model, the firmware, the capability map that decides
   * what is supported at all, the encoder settings and what the browser's
   * decoder did, then hands it over as Markdown ready for an issue.
   *
   * Nothing leaves the browser by itself: the user copies, downloads, or opens
   * a prefilled issue. Secrets are stripped on the server before the report is
   * ever sent here.
   */
  /**
   * The joint log: both halves of the integration on one clock.
   *
   * Kept beside the report because it answers the other kind of question. The
   * report says what the recorder is; this says what just happened, in order.
   */
  _logFileCard() {
    const on = this._logToFile;
    return `
      <div class="card">
        <h2>${t("Shared log")}</h2>
        <p class="hint pad">
          ${t(
            "The panel and the server write into one file, {file}, beside the Home " +
              "Assistant configuration, on one clock counted from the page load. That " +
              "shows the order of events lasting fractions of a second — why a tile " +
              "blinked on refresh, for instance.",
            { file: "<code>xmeye-debug.log</code>" }
          )}
        </p>
        <p class="hint pad">
          ${t("Off by default, and nothing is sent anywhere.")}
          ${on ? t("Recording — reload the page to capture a start.") : ""}
        </p>
        <div class="toolbar">
          <button class="${on ? "ghost" : "primary"}" id="togglelog">
            ${on ? t("Stop recording") : t("Start recording")}
          </button>
          <button class="ghost" id="showlog">${t("Show the file")}</button>
        </div>
        ${this._logFile ? `<pre class="report">${escapeHtml(this._logFile)}</pre>` : ""}
      </div>`;
  }

  _debugView() {
    if (!this._report) {
      return `
        ${this._logFileCard()}
        <div class="card">
          <h2>${t("Developer report")}</h2>
          <p class="hint pad">
            ${t(
              "Collects the model, the firmware, what the recorder can do, the encoder " +
                "settings and the state of the player — what is needed to understand how " +
                "your particular device behaves."
            )}
          </p>
          <p class="hint pad">
            ${t(
              "Passwords, hashes, serial numbers, MAC and IP addresses are stripped " +
                "automatically. The report is not sent anywhere by itself — you copy it " +
                "or open an issue."
            )}
          </p>
          <button class="primary" id="buildreport">${t("Build the report")}</button>
        </div>`;
    }
    return `
      ${this._logFileCard()}
      <div class="card">
        <div class="toolbar">
          <button class="primary" id="copyreport">${t("Copy")}</button>
          <button class="ghost" id="downloadreport">${t("Download .md")}</button>
          <button class="ghost" id="issuereport">${t("Open an issue on GitHub")}</button>
          <button class="ghost" id="buildreport">${t("Refresh")}</button>
        </div>
        <pre class="report">${escapeHtml(this._report)}</pre>
      </div>`;
  }

  /** Gather the report: recorder facts from the server, player facts from here. */
  async _buildReport() {
    try {
      const reply = await this._ws({ type: "xmeye/report", entry_id: this._entryId });
      // The recorder side arrives ready-rendered; only what the browser knows
      // about its own decoder has to be appended here.
      this._report = [
        reply.markdown,
        "",
        "### Browser and player",
        "",
        "```",
        this._diagText(),
        "```",
      ].join("\n");
    } catch (err) {
      this._report = t("Could not build the report: {error}", { error: err.message || err });
    }
    this._render();
  }

  /**
   * Recorder settings, the way the vendor apps show them.
   *
   * The raw configuration browser stays where it is: it exposes every section
   * the firmware has, which is right for digging but wrong for changing a
   * setting on purpose. Here each field is declared with its type and its
   * allowed values, so what reaches the recorder is a value it recognises.
   *
   * The firmware only accepts a section as a whole, so editing merges into the
   * copy that was read and sends all of it back.
   */
  _settingsView() {
    const group =
      SETTINGS_GROUPS.find((g) => g.id === this._settingsGroup) || SETTINGS_GROUPS[0];

    const menu = SETTINGS_GROUPS.map(
      (g) =>
        `<button class="leaf ${g.id === group.id ? "active" : ""}" data-group="${g.id}">
           ${t(g.title)}
         </button>`
    ).join("");

    let body;
    if (!this._settings || this._settings.section !== group.section) {
      body = `<div class="empty">${t("Reading the settings…")}</div>`;
    } else if (this._settings.error) {
      body = `<div class="empty error">${escapeHtml(this._settings.error)}</div>`;
    } else {
      // A per-channel section is an array indexed by channel, so the form edits
      // one element while the save still sends the whole array back.
      const raw = this._settings.value;
      const value = (group.perChannel && Array.isArray(raw) ? raw[this._settingsChannel] : raw) || {};
      const rows = group.fields
        .map((field) => {
          const current =
            field.key in this._settingsEdits
              ? this._settingsEdits[field.key]
              : this._settingRead(value, field.key);
          return `
            <div class="setting">
              <label for="set-${field.key}">${t(field.label)}</label>
              ${this._settingInput(field, current)}
              ${field.hint ? `<div class="hint">${t(field.hint)}</div>` : ""}
            </div>`;
        })
        .join("");
      const dirty = Object.keys(this._settingsEdits).length;
      body = `
        ${group.warning ? `<p class="warn">${t(group.warning)}</p>` : ""}
        ${group.perChannel ? this._settingsChannelPicker() : ""}
        ${group.hint ? `<p class="hint pad">${t(group.hint)}</p>` : ""}
        <div class="settings-form">${rows}</div>
        <div class="toolbar">
          <button class="primary" id="savesettings" ${dirty && !this._settingsSaving ? "" : "disabled"}>
            ${this._settingsSaving ? t("Saving…") : dirty ? t("Save ({count})", { count: dirty }) : t("No changes")}
          </button>
          <button class="ghost" id="resetsettings" ${dirty ? "" : "disabled"}>${t("Reset")}</button>
          ${this._settingsNote ? `<span class="hint">${escapeHtml(this._settingsNote)}</span>` : ""}
        </div>`;
    }

    return `
      <div class="split">
        <aside class="tree">${menu}</aside>
        <section class="viewer">
          <div class="viewer-head">${t(group.title)} <span class="hint">${group.section}</span></div>
          <div class="viewer-body">${body}</div>
        </section>
      </div>`;
  }

  /**
   * Read a field that may live inside a nested object.
   *
   * Several sections keep the interesting flags one level down —
   * ``EventHandler.BeepEnable``, ``Server.Port`` — so a field key is a path
   * rather than a plain name.
   */
  _settingRead(source, path) {
    return path.split(".").reduce((node, part) => (node == null ? node : node[part]), source);
  }

  /**
   * Write a dotted path into a copy, leaving the rest of the section intact.
   *
   * A path step may be an array index — ``RelativePos.0`` is the x of an overlay
   * — so the copy has to keep an array an array. Spreading one into an object
   * would turn ``[570, 7552]`` into ``{"0": 570, "1": 7552}``, which the
   * firmware does not recognise and silently drops.
   */
  _settingWrite(target, path, value) {
    const parts = path.split(".");
    const last = parts.pop();
    let node = target;
    for (const part of parts) {
      // Copy on the way down: the section read from the recorder is the record
      // of what is actually stored and must not be mutated by editing.
      const child = node[part];
      node[part] = Array.isArray(child) ? [...child] : { ...(child || {}) };
      node = node[part];
    }
    node[last] = value;
    return target;
  }

  /** One input, chosen by the field's declared type. */
  _settingInput(field, current) {
    const id = `set-${field.key.replace(/\./g, "-")}`;
    if (field.type === "select") {
      const options = field.options
        .map(
          ([key, label]) =>
            `<option value="${escapeHtml(String(key))}" ${
              String(current) === String(key) ? "selected" : ""
            }>${escapeHtml(t(label))}</option>`
        )
        .join("");
      return `<select id="${id}" data-field="${field.key}">${options}</select>`;
    }
    if (field.type === "number") {
      return `<input type="number" id="${id}" data-field="${field.key}"
                     min="${field.min ?? 0}" max="${field.max ?? 9999}"
                     value="${current ?? 0}">`;
    }
    if (field.type === "bool01" || field.type === "bool") {
      // Some fields are real booleans, others are 0/1 integers; the type says
      // which, so the value written back keeps the shape the firmware expects.
      const on = field.type === "bool" ? current === true : Number(current) === 1;
      return `<input type="checkbox" id="${id}" data-field="${field.key}" ${on ? "checked" : ""}>`;
    }
    return `<input type="text" id="${id}" data-field="${field.key}"
                   value="${escapeHtml(String(current ?? ""))}">`;
  }

  /** Update the save button without redrawing the form under the cursor. */
  _refreshSettingsToolbar() {
    const save = this.shadowRoot.getElementById("savesettings");
    const reset = this.shadowRoot.getElementById("resetsettings");
    const dirty = Object.keys(this._settingsEdits).length;
    if (save) {
      save.disabled = !dirty || this._settingsSaving;
      save.textContent = dirty ? t("Save ({count})", { count: dirty }) : t("No changes");
    }
    if (reset) reset.disabled = !dirty;
  }

  /** Channel selector for the sections that hold one entry per channel. */
  _settingsChannelPicker() {
    const channels = (this._detail && this._detail.channels) || [];
    const options = (channels.length ? channels : [{ index: 0, name: t("Channel {number}", { number: 1 }) }])
      .map(
        (c) =>
          `<option value="${c.index}" ${c.index === this._settingsChannel ? "selected" : ""}>
             ${c.index + 1}. ${escapeHtml(c.name || "")}
           </option>`
      )
      .join("");
    return `
      <div class="toolbar">
        <label class="hint" for="setchannel">${t("Channel")}</label>
        <select id="setchannel">${options}</select>
      </div>`;
  }

  async _loadSettings() {
    const group =
      SETTINGS_GROUPS.find((g) => g.id === this._settingsGroup) || SETTINGS_GROUPS[0];
    this._settings = { section: group.section, loading: true };
    this._settingsEdits = {};
    this._settingsNote = null;
    this._render();
    try {
      const reply = await this._ws({
        type: "xmeye/config",
        entry_id: this._entryId,
        section: group.section,
      });
      this._settings = { section: group.section, value: reply.value };
    } catch (err) {
      this._settings = { section: group.section, error: err.message || String(err) };
    }
    this._render();
  }

  async _saveSettings() {
    const group =
      SETTINGS_GROUPS.find((g) => g.id === this._settingsGroup) || SETTINGS_GROUPS[0];
    if (!this._settings || !this._settings.value) return;
    this._settingsSaving = true;
    this._render();

    // Send the section whole, with the edits merged in: the firmware replaces
    // whatever it is given and defaults the fields left out.
    let merged;
    if (group.perChannel && Array.isArray(this._settings.value)) {
      // Every channel is sent back, with only the edited one changed: the
      // firmware replaces the section whole and would default the rest.
      merged = this._settings.value.map((entry, index) =>
        index === this._settingsChannel ? { ...entry } : entry
      );
      for (const [path, value] of Object.entries(this._settingsEdits)) {
        this._settingWrite(merged[this._settingsChannel], path, value);
      }
    } else {
      merged = { ...this._settings.value };
      for (const [path, value] of Object.entries(this._settingsEdits)) {
        this._settingWrite(merged, path, value);
      }
    }
    try {
      const reply = await this._ws({
        type: "xmeye/config_set",
        entry_id: this._entryId,
        section: group.section,
        value: merged,
      });
      // Show what the recorder stored, not what we asked for: it clamps values
      // it dislikes without saying so.
      this._settings = { section: group.section, value: reply.value };
      this._settingsEdits = {};
      this._settingsNote = t("Saved");
    } catch (err) {
      this._settingsNote = t("Could not save: {error}", { error: err.message || err });
    }
    this._settingsSaving = false;
    this._render();
  }

  _logView() {
    const log = this._log;
    if (!log) return `<div class="empty"><button class="primary" id="loadlog">${t("Read the log")}</button></div>`;
    if (log.loading) return `<div class="empty">${t("Reading the log…")}</div>`;
    if (log.error) return `<div class="empty error">${log.error}</div>`;
    if (!log.entries.length) return `<div class="empty">${t("The log is empty.")}</div>`;

    return `
      <table class="data">
        <thead><tr><th>${t("Time")}</th><th>${t("Event")}</th>
              <th>${t("User")}</th><th>${t("Details")}</th></tr></thead>
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
    // Hiding the native option with no explanation reads as a bug. When the
    // cause is the origin rather than the browser, say so: it is fixable.
    const insecure =
      !nativePlayerSupported() && typeof window !== "undefined" && !window.isSecureContext;
    return `
      <div class="overlay" id="overlay">
        <div class="overlay-box">
          <div class="overlay-head">
            <span>${channel.name}</span>
            <div class="overlay-controls">
              <select id="player" title="${
                insecure
                  ? t(
                      "The native player needs a secure context, and this page is " +
                        "plain http"
                    )
                  : t("Playback method")
              }">
                ${players
                  .map(
                    ([id, label]) =>
                      `<option value="${id}" ${
                        id === this._player ? "selected" : ""
                      }>${t(label)}</option>`
                  )
                  .join("")}
              </select>
              <select id="livestream" title="${t("Recorder stream")}">
                <option value="sub" ${this._liveStream === "sub" ? "selected" : ""}>${t("Extra")}</option>
                <option value="main" ${this._liveStream === "main" ? "selected" : ""}>${t("Main")}</option>
              </select>
              <button class="ghost" id="diag" title="${t("Player diagnostics")}">🛈</button>
              <button class="close" id="closelive">✕</button>
            </div>
          </div>
          ${
            insecure
              ? `<p class="warn">${t(
                    "The native player (WebCodecs) is unavailable: this page was opened " +
                      "over {http} at {host}, and browsers only enable WebCodecs in a " +
                      "secure context. Open Home Assistant over {https} or through " +
                      "{localhost} and the latency drops to its lowest. Safari is more " +
                      "lenient here, so what is missing in Chrome may work in it.",
                    {
                      http: "<b>http</b>",
                      https: "<b>https</b>",
                      localhost: "<b>localhost</b>",
                      host: escapeHtml(location.host),
                    }
                  )}</p>`
              : ""
          }
          ${
            channel.entity_id || this._player === "native"
              ? `<div id="livecard" class="livecard"><div class="empty">${t(
                  "Preparing the video…"
                )}</div></div>`
              : `<div class="empty">${t("No camera entity for this channel.")}</div>`
          }
          <div class="osd" id="osd">${this._osdText(channel)
            .map((line) => `<div>${escapeHtml(line)}</div>`)
            .join("")}</div>
          ${
            this._showDiag
              ? `<div class="diag">
                   <div class="diag-head">
                     <span>${t("Diagnostics")}</span>
                     <div class="diag-actions">
                       <label class="toggle">
                         <input type="checkbox" id="labkey" ${this._lab.keyOnly ? "checked" : ""}>
                         ${t("keyframes only")}
                       </label>
                       <label class="toggle">
                         <input type="checkbox" id="labpaint" ${this._lab.noPaint ? "checked" : ""}>
                         ${t("do not paint")}
                       </label>
                       <button class="ghost" id="copydiag">${t("Copy")}</button>
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
    if (!osd) return [t("measuring…"), t("channel {channel}", { channel: channel.index + 1 })];

    // First line: what is playing and how. Second line: how well it goes.
    // The split is fixed so the line does not reflow as numbers change.
    const what = [t(PLAYERS.find(([id]) => id === osd.player)?.[1] || osd.player)];
    if (osd.codec) what.push(osd.codec.toUpperCase());
    if (osd.codecString) what.push(osd.codecString);
    if (osd.hardware && osd.hardware !== "no-preference") what.push(osd.hardware);
    // The three that describe the picture stay together and read the same here
    // as under a wall tile. A video element does not report bitrate, so for HLS
    // and snapshots the value comes from the recorder itself.
    what.push(fmtQuality({ ...osd, bitrate: osd.bitrate || channel.bitrate }));

    const how = [];
    if (osd.decoded !== undefined) {
      const total = osd.decoded + osd.dropped;
      const share = total ? ((osd.dropped / total) * 100).toFixed(1) : "0.0";
      how.push(t("dropped {count} ({share}%)", {
        count: String(osd.dropped).padStart(3, " "),
        share: share.padStart(4, " "),
      }));
    }
    if (osd.latency !== null && osd.latency !== undefined) {
      how.push(t("latency {seconds} s", { seconds: (osd.latency / 1000).toFixed(1).padStart(5, " ") }));
    }
    if (osd.buffer !== undefined) how.push(t("buffer {seconds} s", { seconds: osd.buffer.toFixed(1) }));
    if (osd.queue) how.push(t("in the decoder {count}", { count: osd.queue }));
    if (osd.backlog) how.push(t("queued {count}", { count: osd.backlog }));
    if (osd.restarts) how.push(t("restarts {count}", { count: osd.restarts }));
    how.push(t("channel {channel}", { channel: channel.index + 1 }));
    if (channel.recording) how.push(t("recording"));
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

    lines.push(`player: ${this._player}, stream: ${this._liveStream}`);
    if (channel) {
      lines.push(`channel ${channel.index + 1} (${channel.name}), ${channel.resolution}`);
      lines.push(`entities: ${JSON.stringify(channel.entity_ids)}`);
    }
    // WebCodecs needs a secure context, so a recorder opened over plain http on
    // a LAN address has no VideoDecoder at all. That is the usual reason the
    // native player is missing, and without the origin in the report it looks
    // like a browser that simply cannot do it.
    lines.push(
      `origin: ${location.origin}, secure context: ${
        window.isSecureContext ? "yes" : "NO — the browser disables WebCodecs"
      }`
    );
    lines.push(
      `WebCodecs: ${typeof VideoDecoder !== "undefined" ? "yes" : "no"}, ` +
        `MediaSource HEVC: ${
          window.MediaSource
            ? MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L120.90"')
            : "unknown"
        }`
    );

    if (this._native) {
      lines.push("", this._native.report());
    } else if (true) {
      lines.push("", `browser: ${navigator.userAgent}`);
      const video = this._findVideo();
      if (video) {
        const q = video.getVideoPlaybackQuality
          ? video.getVideoPlaybackQuality()
          : null;
        lines.push(
          `<video> ${video.videoWidth}x${video.videoHeight}, state ${video.readyState}, ` +
            `error ${video.error ? video.error.code : "none"}, ` +
            `buffer ${
              video.buffered.length
                ? (video.buffered.end(video.buffered.length - 1) - video.currentTime).toFixed(1)
                : 0
            }s` + (q ? `, frames ${q.totalVideoFrames}, dropped ${q.droppedVideoFrames}` : "")
        );
      } else if (this._snapshots) {
        lines.push(
          `snapshots: loaded ${this._snapshots.loaded}, errors ${this._snapshots.errors}`
        );
      } else {
        lines.push("the player has created no element yet");
      }
      if (this._hlsSince) {
        lines.push(`HLS loading for ${((performance.now() - this._hlsSince) / 1000).toFixed(1)}s`);
      }
    }
    if (this._fallbackNote) lines.push("", `fallback: ${this._fallbackNote}`);

    // The log is always shown in full: it accumulates from the moment the view
    // opens and survives every switch.
    if (!this._native && this._diagLog.length) {
      lines.push("", "── log ──");
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
        this._fallbackNote = t("HLS did not start. Switched to snapshots.");
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
        // The settings form has nothing to show until the section is read, so
        // opening the tab starts that rather than waiting for another click.
        if (this._tab === "settings" && !this._settings) {
          this._loadSettings();
          return;
        }
        // Same for the archive: the timeline has nothing to show until the day
        // is queried, so opening the tab starts that.
        if (this._tab === "archive" && !this._recordings) {
          this._loadRecordings();
          return;
        }
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
        // A different recorder may have different defaults; let them apply again.
        this._defaultsApplied = false;
        this._loadDetail();
      });

    const channel = root.getElementById("channel");
    if (channel)
      channel.addEventListener("change", () => {
        this._selectedChannel = Number(channel.value);
        // The recordings on screen belong to the camera that was chosen before,
        // so the switch fetches this one's and plays them.
        this._loadRecordings();
      });

    const day = root.getElementById("day");
    if (day)
      day.addEventListener("change", () => {
        this._recordingsDay = day.value;
        this._loadRecordings();
      });

    const search = root.getElementById("search");
    if (search) search.addEventListener("click", () => this._loadRecordings());

    this._bindWallBar(root);

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

    const pickList = root.querySelector(".pick-list");
    if (pickList) this._bindWallDrag(pickList);

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
        this._playback.rate = rate;
        this._playback.actual = null;
        root.querySelectorAll(".rate").forEach((b) => b.classList.toggle("active", b === button));
        // Every speed reads the same stream, so changing one only re-paces the
        // clock. Nothing is re-requested and the picture does not blink.
        if (this._archivePlayer) this._archivePlayer.setRate(rate);
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
        this._noteDiag("experiment", `keyframes only: ${labKey.checked ? "on" : "off"}`);
        this._remountLive();
      });

    const labPaint = root.getElementById("labpaint");
    if (labPaint)
      labPaint.addEventListener("change", () => {
        this._lab.noPaint = labPaint.checked;
        this._noteDiag("experiment", `do not paint: ${labPaint.checked ? "on" : "off"}`);
        this._remountLive();
      });

    root.querySelectorAll("[data-group]").forEach((button) =>
      button.addEventListener("click", () => {
        this._settingsGroup = button.dataset.group;
        this._loadSettings();
      })
    );

    root.querySelectorAll("[data-field]").forEach((input) =>
      input.addEventListener("change", () => {
        const field = SETTINGS_GROUPS.flatMap((g) => g.fields).find(
          (f) => f.key === input.dataset.field
        );
        let value;
        if (input.type === "checkbox") {
          value = field && field.type === "bool" ? input.checked : input.checked ? 1 : 0;
        } else if (input.type === "number") {
          value = Number(input.value);
        } else if (field && field.numeric) {
          // The option values are numbers on the device; a select hands back a
          // string, and the firmware ignores a field of the wrong type.
          value = Number(input.value);
        } else {
          value = input.value;
        }
        this._settingsEdits[input.dataset.field] = value;
        // Only the toolbar changes, so the form is left alone and the field
        // being edited keeps focus.
        this._refreshSettingsToolbar();
      })
    );

    const setChannel = root.getElementById("setchannel");
    if (setChannel)
      setChannel.addEventListener("change", () => {
        this._settingsChannel = Number(setChannel.value);
        // Edits belong to the channel they were made on; carrying them over
        // would silently write one camera's values onto another.
        this._settingsEdits = {};
        this._settingsNote = null;
        this._render();
      });

    const saveSettings = root.getElementById("savesettings");
    if (saveSettings) saveSettings.addEventListener("click", () => this._saveSettings());

    const resetSettings = root.getElementById("resetsettings");
    if (resetSettings)
      resetSettings.addEventListener("click", () => {
        this._settingsEdits = {};
        this._settingsNote = null;
        this._render();
      });

    const toggleLog = root.getElementById("togglelog");
    if (toggleLog)
      toggleLog.addEventListener("click", () => this._setLogToFile(!this._logToFile));

    const showLog = root.getElementById("showlog");
    if (showLog)
      showLog.addEventListener("click", async () => {
        showLog.disabled = true;
        // Flush first, or the file is missing the seconds just spent looking at it.
        await this._shipLog(false);
        try {
          const reply = await fetch("/api/xmeye/debug", {
            headers: { Authorization: `Bearer ${await this._token()}` },
          }).then((r) => r.json());
          this._logFile = reply.text || t("The file is empty.");
        } catch (err) {
          this._logFile = t("Could not read it: {error}", { error: err.message || err });
        }
        this._render();
      });

    const buildReport = root.getElementById("buildreport");
    if (buildReport)
      buildReport.addEventListener("click", () => {
        buildReport.textContent = t("Building…");
        buildReport.disabled = true;
        this._buildReport();
      });

    const copyReport = root.getElementById("copyreport");
    if (copyReport)
      copyReport.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(this._report || "");
          copyReport.textContent = t("Copied");
          setTimeout(() => (copyReport.textContent = t("Copy")), 2000);
        } catch (err) {
          copyReport.textContent = t("Failed");
        }
      });

    const downloadReport = root.getElementById("downloadreport");
    if (downloadReport)
      downloadReport.addEventListener("click", () => {
        const blob = new Blob([this._report || ""], { type: "text/markdown" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
        link.href = url;
        link.download = `xmeye-report-${stamp}.md`;
        link.click();
        // Revoking at once can beat the download in some browsers.
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      });

    const issueReport = root.getElementById("issuereport");
    if (issueReport)
      issueReport.addEventListener("click", async () => {
        const report = this._report || "";
        const model =
          (this._detail && this._detail.device && this._detail.device.model) || "recorder";
        const base = `${ISSUE_URL}?title=${encodeURIComponent(`[${model}] `)}`;
        // GitHub truncates a long querystring, and a silently cut report is
        // worse than none: past the limit the body only asks for a paste and the
        // report travels through the clipboard instead.
        const withBody = `${base}&body=${encodeURIComponent(report)}`;
        if (withBody.length < ISSUE_URL_LIMIT) {
          window.open(withBody, "_blank", "noopener");
          return;
        }
        try {
          await navigator.clipboard.writeText(report);
        } catch (err) {
          /* the report stays on screen to copy by hand */
        }
        const hint = t("The report is on the clipboard — paste it here.");
        window.open(`${base}&body=${encodeURIComponent(hint)}`, "_blank", "noopener");
      });

    const copyDiag = root.getElementById("copydiag");
    if (copyDiag)
      copyDiag.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(this._diagText());
          copyDiag.textContent = t("Copied");
          setTimeout(() => (copyDiag.textContent = t("Copy")), 2000);
        } catch (err) {
          copyDiag.textContent = t("Failed");
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
  /* Pushed to the far end of the toolbar, away from the layout buttons. */
  button.wall-full { margin-left:auto; display:flex; align-items:center;
    line-height:1; }
  .wall-full svg { display:block; }

  /* Fullscreen: the wall and nothing else. The element already on the page is
     the one made fullscreen, so the canvases never move and the cameras play
     straight through it; the picker is hidden rather than removed for the same
     reason. The grid keeps its aspect ratio and is centred, because stretching
     4:3 cameras to a 16:9 screen is worse than a black margin. */
  .wall-layout:fullscreen { background:#000; gap:0; align-items:center;
    justify-content:center; }
  .wall-layout:fullscreen .picker { display:none; }
  .wall-layout:fullscreen .wall { flex:none; height:100vh; width:auto;
    max-width:100vw; max-height:100vh; border:none; }
  .wall-layout:-webkit-full-screen { background:#000; gap:0; align-items:center;
    justify-content:center; }
  .wall-layout:-webkit-full-screen .picker { display:none; }
  .wall-layout:-webkit-full-screen .wall { flex:none; height:100vh; width:auto;
    max-width:100vw; max-height:100vh; border:none; }

  /* Channel picker: which cameras go on the wall and in what order. */
  .picker { width:226px; flex:none; background: var(--card-background-color);
    border-radius: var(--ha-card-border-radius, 12px); overflow:hidden;
    box-shadow: var(--ha-card-box-shadow, 0 2px 4px rgba(0,0,0,.08)); }
  .picker-head { padding:7px 10px; font-size:11px; text-transform:uppercase;
    letter-spacing:.4px; color: var(--secondary-text-color);
    border-bottom:1px solid var(--divider-color); }
  .warn { margin:0 0 10px; padding:9px 12px; border-radius:8px; font-size:13px;
    color: var(--primary-text-color);
    background: color-mix(in srgb, var(--warning-color, #ff9800) 18%, transparent);
    border:1px solid var(--warning-color, #ff9800); }
  .settings-form { display:grid; gap:14px; padding:4px 0 12px; max-width:520px; }
  .setting { display:grid; gap:4px; }
  .setting label { font-size:13px; color: var(--secondary-text-color); }
  .setting input[type=text], .setting input[type=number], .setting select {
    padding:6px 8px; border-radius:6px; border:1px solid var(--divider-color);
    background: var(--card-background-color); color: var(--primary-text-color); }
  .setting input[type=checkbox] { width:18px; height:18px; }
  .viewer-body { padding:12px 14px; }
  .report { max-height:60vh; overflow:auto; white-space:pre-wrap; word-break:break-word;
    font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size:12px;
    background: var(--secondary-background-color); padding:12px; border-radius:8px; }
  .pick-list { list-style:none; margin:0; padding:3px 0; max-height:70vh; overflow:auto; }
  /* Half again as tall as the text needs. The row is a drag handle as much as a
     line of text, and a 22px one was a target you could miss between neighbours. */
  .pick { display:flex; align-items:center; gap:6px; padding:5px 8px; font-size:13px;
    line-height:1.8; cursor:grab; user-select:none; }
  .pick:active { cursor:grabbing; }
  /* The controls in the row keep their own pointer, or the whole row reads as
     one draggable thing and the marker stops looking clickable. */
  .pick-dot, .pick-stream { cursor:pointer; user-select:auto; }
  .pick.off { opacity:.55; }
  .pick.dragging { opacity:.4; background: var(--divider-color); }
  /* One mark, two facts: filled means "on the wall", green means "camera online". */
  .pick-dot { width:14px; height:14px; flex:none; padding:0; border-radius:50%;
    cursor:pointer; background:transparent;
    border:2px solid var(--secondary-text-color); }
  .pick-dot.online { border-color: var(--success-color, #4caf50); }
  .pick-dot.shown { background: var(--secondary-text-color); }
  .pick-dot.shown.online { background: var(--success-color, #4caf50); }
  /* The grip is drawn rather than typed: the braille glyph that reads as a grip
     sits in the upper half of its em box, so it never lines up with the text
     beside it, and how far off depends on the font. Six dots on a 4px grid in a
     box whose sides are exact multiples of it land dead centre in any font. The
     grid is kept small so the grip stays as quiet as the glyph looked. */
  .pick-grip { flex:none; width:8px; height:12px; user-select:none;
    color: var(--secondary-text-color);
    background-image: radial-gradient(currentColor 1px, transparent 1.5px);
    background-size: 4px 4px; background-position: center; }
  .pick-num { width:17px; text-align:right; color: var(--secondary-text-color);
    font-variant-numeric: tabular-nums; }
  .pick-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .pick-stream { font-size:12px; padding:1px 3px; max-width:60px; flex:none;
    background: var(--card-background-color); color: var(--primary-text-color);
    border:1px solid var(--divider-color); border-radius:4px; }
  .pick.off .pick-stream { pointer-events:none; opacity:.6; }
  @media (max-width: 900px) {
    .wall-layout { flex-direction:column; }
    .picker { width:100%; }
    .pick-list { max-height:none; }
  }
  .layouts { display:flex; gap:4px; }
  /* Same box as the fullscreen button beside them: a 16px mark inside the
     padding every ghost button has, so the toolbar is one row of one height. */
  button.layout { display:flex; align-items:center; line-height:1; }
  .layout svg { display:block; }
  /* The grid is drawn in the text colour, so the active state inverts with it. */
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

// The version stamp gives the module a new URL after every edit, so a page that
// has already loaded an older copy evaluates this file a second time — and the
// registry keeps the first definition forever. Defining again throws and takes
// the whole panel down, so the second evaluation must be a no-op.
if (!customElements.get("xmeye-panel")) {
  customElements.define("xmeye-panel", XmeyePanel);
}
