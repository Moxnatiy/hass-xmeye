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

//: The record schedule's grid arithmetic. Pure functions, in a module of
//: their own so the tests can run them; see schedule.js.
let Schedule = null;
import(`./schedule.js${VERSION ? `?v=${VERSION}` : ""}`).then((module) => {
  Schedule = module;
});

let NativePlayer = null;
let nativeSupported = typeof VideoDecoder !== "undefined";
//: The volume control's curve; see native-player.js. A plain line until the
//: module arrives, which is long before anyone can press a sound button.
let volumeGain = (position) => position / 50;
let VOLUME_DEFAULT = 50;
nativeModule.then((module) => {
  NativePlayer = module.NativePlayer;
  nativeSupported = module.nativePlayerSupported();
  volumeGain = module.volumeGain;
  VOLUME_DEFAULT = module.VOLUME_DEFAULT;
});

/** A volume position as the viewer reads it: off, or decibels from as-is. */
const volumeLabel = (position) => {
  const gain = volumeGain(position);
  if (gain <= 0) return t("Muted");
  const db = Math.round(20 * Math.log10(gain));
  return `${db > 0 ? "+" : db < 0 ? "−" : ""}${Math.abs(db)} dB`;
};

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

/**
 * The rest of the marks, at the same box as the two above.
 *
 * The archive controls were typed characters — ▶ ⏸ ⏪ ⏩ ✕ — and a typed
 * character is sized by whichever font happens to answer for it. Five buttons
 * in one row came out five heights, and no CSS fixes that without fighting the
 * font. Drawn, they are all one 16px box and inherit the text colour, so the
 * bar reads as a bar.
 *
 * ``filled`` shapes are solid (play, pause); the rest are strokes, which is
 * what makes them sit beside the fullscreen mark without looking heavier.
 */
const mark = (body, { filled = false } = {}) =>
  `<svg viewBox="0 0 ${ICON} ${ICON}" width="${ICON}" height="${ICON}" ` +
  (filled
    ? 'fill="currentColor"'
    : 'fill="none" stroke="currentColor" stroke-width="1.6"' +
      ' stroke-linecap="round" stroke-linejoin="round"') +
  ` aria-hidden="true">${body}</svg>`;

const playIcon = () => mark('<path d="M4.2 2.4 13 8l-8.8 5.6z"/>', { filled: true });

const pauseIcon = () =>
  mark(
    '<rect x="4" y="2.6" width="2.9" height="10.8" rx="1"/>' +
      '<rect x="9.1" y="2.6" width="2.9" height="10.8" rx="1"/>',
    { filled: true }
  );

//: Jump to the event before or after: a chevron against a bar, the mark every
//: player uses for "skip to". A plain double chevron would read as winding,
//: which is what these buttons stopped doing.
const eventIcon = (back) =>
  mark(
    back
      ? '<path d="M11.6 3.6 6.1 8l5.5 4.4"/><path d="M3.9 3.6v8.8"/>'
      : '<path d="M4.4 3.6 9.9 8l-5.5 4.4"/><path d="M12.1 3.6v8.8"/>'
  );

const closeIcon = () => mark('<path d="M4 4l8 8"/><path d="M12 4l-8 8"/>');

//: Back to the whole day: arrows pushing out to both edges of a line.
const fitIcon = () =>
  mark('<path d="M1.8 8h12.4"/><path d="M4.6 5.2 1.8 8l2.8 2.8"/>' +
       '<path d="M11.4 5.2 14.2 8l-2.8 2.8"/>');

//: The device details behind the title: an "i" in a ring, the mark every
//: system screen uses for "there is more here if you want it".
const infoIcon = () =>
  mark('<circle cx="8" cy="8" r="6.4"/><path d="M8 7.3v4"/><path d="M8 4.7v.01"/>');

//: The channel list. Lettered rather than drawn, because the user asked for
//: exactly that and because no picture of "a list of cameras" says it faster
//: than CH does. The letters sit in a frame so the mark has the same weight as
//: the solid layout grids beside it; bare letters would read as a label.
const channelsIcon = () =>
  `<svg viewBox="0 0 ${ICON} ${ICON}" width="${ICON}" height="${ICON}" aria-hidden="true">` +
  `<rect x="0.8" y="2.3" width="14.4" height="11.4" rx="2" fill="none"` +
  ` stroke="currentColor" stroke-width="1.4"/>` +
  `<text x="8" y="11.05" text-anchor="middle" fill="currentColor" font-size="8"` +
  ` font-weight="700" letter-spacing="-0.2"` +
  ` font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif">CH</text></svg>`;

//: Preset slots on the pad. The recorder takes up to 255; eight is what fits a
//: quarter tile and what a camera watching one yard actually needs.
const PTZ_PRESETS = 8;

//: The shortest movement, in milliseconds: what one click on an arrow turns.
const PTZ_NUDGE = 400;

const prevIcon = () => mark('<path d="M10 3.4 5.4 8l4.6 4.6"/>');

const nextIcon = () => mark('<path d="M6 3.4 10.6 8 6 12.6"/>');

//: Pan, tilt and zoom: four arrowheads around a centre, the mark a PTZ
//: joystick wears.
const ptzIcon = () =>
  mark(
    '<path d="M8 1.6v12.8M1.6 8h12.8"/>' +
      '<path d="M6 3.6 8 1.6l2 2M6 12.4l2 2 2-2M3.6 6 1.6 8l2 2M12.4 6l2 2-2 2"/>'
  );

//: One chevron per direction of the pad, rotated rather than drawn eight times.
const PTZ_ANGLES = {
  up: 0, up_right: 45, right: 90, down_right: 135,
  down: 180, down_left: 225, left: 270, up_left: 315,
};
const ptzArrow = (direction) =>
  mark(
    `<path d="M4.2 10 8 6.2l3.8 3.8" transform="rotate(${PTZ_ANGLES[direction]} 8 8)"/>`
  );

const zoomIcon = (closer) =>
  mark(
    '<circle cx="7" cy="7" r="4.6"/><path d="M10.4 10.4 14 14"/><path d="M4.9 7h4.2"/>' +
      (closer ? '<path d="M7 4.9v4.2"/>' : "")
  );

//: Sound: a speaker, with waves when it plays and a cross when it does not.
const soundIcon = (on) =>
  mark(
    '<path d="M2.4 6h2.4L8.4 3v10L4.8 10H2.4z"/>' +
      (on
        ? '<path d="M10.6 5.6a3.4 3.4 0 0 1 0 4.8"/><path d="M12.4 3.8a6 6 0 0 1 0 8.4"/>'
        : '<path d="M10.8 6.2l3.6 3.6"/><path d="M14.4 6.2l-3.6 3.6"/>')
  );

//: Copy: two sheets, one over the other.
const copyIcon = () =>
  mark('<rect x="5.4" y="5.4" width="8.2" height="8.2" rx="1.6"/>' +
       '<path d="M10.6 3.4V3.6a1.2 1.2 0 0 0-1.2-1.2H3.6a1.2 1.2 0 0 0-1.2 1.2v5.8a1.2 1.2 0 0 0 1.2 1.2h.2"/>');

//: Presets: a bookmark, the mark for "a place kept to come back to".
const presetIcon = () => mark('<path d="M4.4 2.2h7.2v11.6L8 10.9l-3.6 2.9z"/>');

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

//: Recorder settings, laid out the way VMS lays out a recorder's: a few
//: sections, each a short list of pages, each page one configuration section
//: of the recorder, its fields grouped into cards.
//:
//: Declared rather than hand-built: every field says what it is, so one renderer
//: covers all of them and adding a page is a data change, not new markup.
//:
//: Field types:
//:   toggle    a real boolean on the device
//:   toggle01  the same, stored as 0 or 1
//:   number    an integer, with an optional unit after it
//:   select    one of `options`, [value, label]; `numeric` when the device
//:             stores the value as a number
//:   level     a 1…N scale with a word for every step (sensitivity)
//:   range     a slider over min…max, shown with `display`
//:   text      free text
//: `when` names a toggle on the same page that the field only matters under;
//: while it is off the field is greyed out rather than hidden, so the page does
//: not jump about as switches are flipped.
//:
//: The address fields of the network are absent on purpose. HostIP, GateWay and
//: Submask are little-endian hex, and a wrong one takes the recorder off the
//: network with no way back through this panel.

//: What a recorder does when a detector fires. Motion, blinding and video loss
//: share one EventHandler shape, so the reactions are written down once.
const EVENT_REACTIONS = [
  { key: "EventHandler.RecordEnable", label: "Record", type: "toggle" },
  { key: "EventHandler.RecordLatch", label: "Keep recording after it ends", type: "number",
    min: 10, max: 300, unit: "s", when: "EventHandler.RecordEnable" },
  { key: "EventHandler.SnapEnable", label: "Take a snapshot", type: "toggle" },
  { key: "EventHandler.MessageEnable", label: "Show on the recorder's screen", type: "toggle" },
  { key: "EventHandler.BeepEnable", label: "Beep", type: "toggle" },
  { key: "EventHandler.MailEnable", label: "Send an email", type: "toggle" },
  { key: "EventHandler.FTPEnable", label: "Upload to FTP", type: "toggle" },
  { key: "EventHandler.LogEnable", label: "Write to the log", type: "toggle" },
];

//: The reactions a storage or network event can have: no recording, no FTP —
//: there is nothing to record and possibly nowhere to upload.
const NOTICE_REACTIONS = [
  { key: "EventHandler.MessageEnable", label: "Show on the recorder's screen", type: "toggle" },
  { key: "EventHandler.BeepEnable", label: "Beep", type: "toggle" },
  { key: "EventHandler.MailEnable", label: "Send an email", type: "toggle" },
  { key: "EventHandler.LogEnable", label: "Write to the log", type: "toggle" },
];

//: The NTP time zone is an index into this list, in exactly this order — east
//: of Greenwich first, then west. Read off VMS: CNetNTPConfig fills its combo
//: box in this order and hands the stored number straight to setCurrentIndex.
//: The order is not alphabetical by accident; it is the vendor's.
const TIME_ZONES = [
  "GMT+00:00", "GMT+01:00", "GMT+02:00", "GMT+03:00", "GMT+03:30", "GMT+04:00",
  "GMT+04:30", "GMT+05:00", "GMT+05:30", "GMT+05:45", "GMT+06:00", "GMT+06:30",
  "GMT+07:00", "GMT+08:00", "GMT+09:00", "GMT+09:30", "GMT+10:00", "GMT+11:00",
  "GMT+12:00", "GMT+13:00", "GMT-01:00", "GMT-02:00", "GMT-03:00", "GMT-03:30",
  "GMT-04:00", "GMT-05:00", "GMT-06:00", "GMT-07:00", "GMT-08:00", "GMT-09:00",
  "GMT-10:00", "GMT-11:00", "GMT-12:00",
];

//: The hours of a day as select options, for "at what hour".
const HOURS = Array.from({ length: 24 }, (_, h) => [h, `${String(h).padStart(2, "0")}:00`]);

//: Paint brushes for the record schedule: what a slot records, by mask.
const RECORD_BRUSHES = [
  { mask: 7, label: "Continuous", kind: "always" },
  { mask: 2, label: "Motion", kind: "motion" },
  { mask: 4, label: "Alarm input", kind: "alarm" },
  { mask: 6, label: "Motion or alarm", kind: "event" },
  { mask: 0, label: "Nothing", kind: "none" },
];

const SETTINGS_TREE = [
  {
    id: "recording",
    title: "Recording",
    pages: [
      {
        id: "record",
        title: "Schedule",
        section: "Record",
        perChannel: true,
        // The week lives in these two, edited by the grid rather than as fields.
        extraKeys: ["TimeSection", "Mask"],
        hint: "When each camera records, and what makes it record. Paint the week with the kind you pick; a day holds at most six periods.",
        cards: [
          {
            title: "Recording",
            fields: [
              { key: "RecordMode", label: "Record", type: "select",
                options: [["ConfigRecord", "On the schedule below"], ["ManualRecord", "All the time"],
                          ["ClosedRecord", "Never"]] },
              { key: "PreRecord", label: "Pre-record", type: "number", min: 0, max: 30, unit: "s",
                hint: "Kept from before motion or an alarm starts" },
              { key: "PacketLength", label: "File length", type: "number", min: 1, max: 120, unit: "min" },
              { key: "Redundancy", label: "Also write to the redundant disk", type: "toggle",
                hint: "Only matters with a disk set as redundant" },
            ],
          },
          { title: "Week", schedule: true },
        ],
      },
    ],
  },
  {
    id: "system",
    title: "System",
    pages: [
      {
        id: "general",
        title: "General",
        section: "General.General",
        hint: "The recorder's name, and how its own monitor behaves.",
        cards: [
          {
            title: "Device",
            fields: [{ key: "MachineName", label: "Device name", type: "text" }],
          },
          {
            title: "Recorder's monitor",
            fields: [
              { key: "AutoLogout", label: "Log out of the menu after", type: "number",
                min: 0, max: 120, unit: "min", hint: "0 never logs out" },
              { key: "ScreenSaveTime", label: "Screensaver after", type: "number",
                min: 0, max: 120, unit: "min", hint: "0 turns it off" },
              { key: "BandWidthTips", label: "Warn when bandwidth runs short", type: "toggle01" },
            ],
          },
        ],
      },
      {
        id: "locale",
        title: "Date and language",
        section: "General.Location",
        hint: "How the recorder writes dates and times, and the language of its own menu.",
        cards: [
          {
            title: "Menu",
            fields: [
              { key: "Language", label: "Menu language", type: "select",
                // The firmware knows many more; it does not say which this one
                // carries, so the common ones are offered and whatever is set
                // already is kept as an option of its own.
                options: [["English", "English"], ["Ukrainian", "Українська"],
                          ["Russian", "Русский"], ["Polish", "Polski"],
                          ["German", "Deutsch"], ["SimpChinese", "简体中文"]] },
            ],
          },
          {
            title: "Date and time",
            fields: [
              { key: "DateFormat", label: "Date order", type: "select",
                options: [["YYMMDD", "Year, month, day"], ["MMDDYY", "Month, day, year"],
                          ["DDMMYY", "Day, month, year"]] },
              { key: "DateSeparator", label: "Date separator", type: "select",
                options: [["-", "2026-10-17"], ["/", "2026/10/17"], [".", "2026.10.17"]] },
              { key: "TimeFormat", label: "Clock", type: "select",
                options: [["24", "24-hour"], ["12", "12-hour"]] },
              { key: "DSTRule", label: "Daylight saving time", type: "select",
                options: [["Off", "Off"], ["On", "On"]] },
            ],
          },
        ],
      },
      {
        id: "maintain",
        title: "Maintenance",
        section: "General.AutoMaintain",
        hint: "A scheduled reboot, and clearing out old recordings.",
        cards: [
          {
            title: "Scheduled reboot",
            fields: [
              { key: "AutoRebootDay", label: "Reboot", type: "select",
                options: [["Never", "Never"], ["Everyday", "Every day"],
                          ["Monday", "Every Monday"], ["Tuesday", "Every Tuesday"],
                          ["Wednesday", "Every Wednesday"], ["Thursday", "Every Thursday"],
                          ["Friday", "Every Friday"], ["Saturday", "Every Saturday"],
                          ["Sunday", "Every Sunday"]] },
              { key: "AutoRebootHour", label: "At", type: "select", numeric: true,
                options: HOURS },
            ],
          },
          {
            title: "Old recordings",
            fields: [
              { key: "AutoDeleteFilesDays", label: "Delete recordings older than", type: "number",
                min: 0, max: 365, unit: "days",
                hint: "0 keeps them until the disk is full" },
            ],
          },
        ],
      },
      {
        id: "screen",
        title: "Recorder's monitor",
        section: "fVideo.GUISet",
        hint: "What the recorder draws over the video on the monitor plugged into it. The streams are not affected.",
        cards: [
          {
            title: "Over each camera",
            fields: [
              { key: "ChannelTitleEnable", label: "Camera name", type: "toggle" },
              { key: "TimeTitleEnable", label: "Date and time", type: "toggle" },
              { key: "RecordStateEnable", label: "Recording mark", type: "toggle" },
              { key: "AlarmStateEnable", label: "Alarm mark", type: "toggle" },
              { key: "ChanStateMtdEnable", label: "Motion mark", type: "toggle" },
              { key: "ChanStateVlsEnable", label: "Video loss mark", type: "toggle" },
              { key: "ChanStateBitRateEnable", label: "Bitrate", type: "toggle" },
            ],
          },
          {
            title: "Interface",
            fields: [
              { key: "ChanWindowGridEnable", label: "Grid between cameras", type: "toggle" },
              { key: "QRcodeEnable", label: "QR code for the app", type: "toggle" },
              { key: "Deflick", label: "Flicker filter", type: "toggle" },
              { key: "WindowAlpha", label: "Menu transparency", type: "range",
                min: 0, max: 255, display: "percent" },
            ],
          },
        ],
      },
    ],
  },
  {
    id: "detection",
    title: "Detection",
    pages: [
      {
        id: "motion",
        title: "Motion",
        section: "Detect.MotionDetect",
        perChannel: true,
        hint: "Motion in the picture, and what the recorder does about it. The detection area is kept as it is; it is drawn on a grid in the recorder's own menu.",
        cards: [
          {
            title: "Detector",
            fields: [
              { key: "Enable", label: "Detect motion", type: "toggle" },
              { key: "Level", label: "Sensitivity", type: "level", min: 1, max: 6,
                labels: ["Lowest", "Lower", "Medium", "Higher", "Very high", "Highest"],
                when: "Enable" },
            ],
          },
          { title: "When it detects motion", fields: EVENT_REACTIONS },
        ],
      },
      {
        id: "blind",
        title: "Camera covered",
        section: "Detect.BlindDetect",
        perChannel: true,
        hint: "A camera that is covered, sprayed or turned to the wall.",
        cards: [
          {
            title: "Detector",
            fields: [
              { key: "Enable", label: "Detect a covered camera", type: "toggle" },
              { key: "Level", label: "Sensitivity", type: "level", min: 1, max: 6,
                labels: ["Lowest", "Lower", "Medium", "Higher", "Very high", "Highest"],
                when: "Enable" },
            ],
          },
          { title: "When a camera is covered", fields: EVENT_REACTIONS },
        ],
      },
      {
        id: "loss",
        title: "Video loss",
        section: "Detect.LossDetect",
        perChannel: true,
        hint: "A camera that stops sending a picture: unplugged, powered off, or gone from the network.",
        cards: [
          {
            title: "Detector",
            fields: [{ key: "Enable", label: "Detect video loss", type: "toggle" }],
          },
          { title: "When the picture is lost", fields: EVENT_REACTIONS },
        ],
      },
    ],
  },
  {
    id: "channels",
    title: "Channels",
    pages: [
      {
        id: "overlays",
        title: "Name and time on the picture",
        section: "AVEnc.VideoWidget",
        perChannel: true,
        hint: "The camera's name and the clock, drawn over its picture by the recorder. Positions are on a 0–8191 grid, whatever the resolution.",
        cards: [
          {
            title: "Camera name",
            fields: [
              { key: "ChannelTitle.Name", label: "Name", type: "text" },
              { key: "ChannelTitleAttribute.PreviewBlend", label: "Show on the recorder's monitor", type: "toggle" },
              { key: "ChannelTitleAttribute.EncodeBlend", label: "Burn into the recording", type: "toggle" },
              { key: "ChannelTitleAttribute.RelativePos.0", label: "From the left", type: "number", min: 0, max: 8191 },
              { key: "ChannelTitleAttribute.RelativePos.1", label: "From the top", type: "number", min: 0, max: 8191 },
            ],
          },
          {
            title: "Date and time",
            fields: [
              { key: "TimeTitleAttribute.PreviewBlend", label: "Show on the recorder's monitor", type: "toggle" },
              { key: "TimeTitleAttribute.EncodeBlend", label: "Burn into the recording", type: "toggle" },
              { key: "TimeTitleAttribute.RelativePos.0", label: "From the left", type: "number", min: 0, max: 8191 },
              { key: "TimeTitleAttribute.RelativePos.1", label: "From the top", type: "number", min: 0, max: 8191 },
            ],
          },
        ],
      },
      {
        id: "serial-ptz",
        title: "PTZ over RS-485",
        section: "Uart.PTZ",
        perChannel: true,
        hint: "Only for an analogue PTZ camera wired to the recorder's RS-485 port. A network camera is turned over the network and needs nothing here.",
        cards: [
          {
            title: "Protocol",
            fields: [
              { key: "ProtocolName", label: "Protocol", type: "select",
                options: [["PELCOD", "Pelco-D"], ["PELCOP", "Pelco-P"], ["NONE", "None"]] },
              { key: "DeviceNo", label: "Camera address", type: "number", min: 1, max: 255 },
              { key: "PortNo", label: "Port", type: "number", min: 1, max: 8 },
            ],
          },
          {
            title: "Serial line",
            fields: [
              { key: "Attribute.0", label: "Baud rate", type: "select", numeric: true,
                options: [[1200, "1200"], [2400, "2400"], [4800, "4800"], [9600, "9600"],
                          [19200, "19200"], [38400, "38400"], [57600, "57600"], [115200, "115200"]] },
              { key: "Attribute.2", label: "Data bits", type: "select", numeric: true,
                options: [[5, "5"], [6, "6"], [7, "7"], [8, "8"]] },
              { key: "Attribute.1", label: "Parity", type: "select",
                options: [["NONE", "None"], ["ODD", "Odd"], ["EVEN", "Even"], ["MARK", "Mark"],
                          ["SPACE", "Space"]] },
              { key: "Attribute.3", label: "Stop bits", type: "select", numeric: true,
                options: [[1, "1"], [2, "2"]] },
            ],
          },
        ],
      },
    ],
  },
  {
    id: "storage",
    title: "Storage",
    pages: [
      {
        id: "disk-full",
        title: "When the disk is full",
        section: "General.General",
        hint: "What the recorder does once there is no room left for new recordings.",
        cards: [
          {
            title: "Full disk",
            fields: [
              { key: "OverWrite", label: "When the disk is full", type: "select",
                options: [["OverWrite", "Overwrite the oldest recordings"],
                          ["StopRecord", "Stop recording"]] },
            ],
          },
        ],
      },
      {
        id: "disk-low",
        title: "Low on space",
        section: "Storage.StorageLowSpace",
        hint: "A warning before the disk fills up.",
        cards: [
          {
            title: "Watch",
            fields: [
              { key: "Enable", label: "Warn when space runs low", type: "toggle" },
              { key: "LowerLimit", label: "Below", type: "number", min: 1, max: 99, unit: "%",
                hint: "of the disk free", when: "Enable" },
            ],
          },
          { title: "Then", fields: NOTICE_REACTIONS },
        ],
      },
      {
        id: "disk-fail",
        title: "Disk failure",
        section: "Storage.StorageFailure",
        hint: "A disk that cannot be read or written.",
        cards: [
          {
            title: "Watch",
            fields: [
              { key: "Enable", label: "Watch for disk errors", type: "toggle" },
              { key: "RebootEnable", label: "Reboot the recorder", type: "toggle", when: "Enable" },
            ],
          },
          { title: "Then", fields: NOTICE_REACTIONS },
        ],
      },
      {
        id: "disk-none",
        title: "No disk",
        section: "Storage.StorageNotExist",
        hint: "The recorder started without a disk, or lost the one it had.",
        cards: [
          {
            title: "Watch",
            fields: [{ key: "Enable", label: "Warn when there is no disk", type: "toggle" }],
          },
          { title: "Then", fields: NOTICE_REACTIONS.filter((f) => !f.key.endsWith("LogEnable")) },
        ],
      },
    ],
  },
  {
    id: "network",
    title: "Network",
    pages: [
      {
        id: "ports",
        title: "Ports and traffic",
        section: "NetWork.NetCommon",
        warning:
          "Changing a port breaks the connection this page is using: after saving, " +
          "set the new port in the integration's options. The address, gateway and " +
          "mask are deliberately not editable here.",
        cards: [
          {
            title: "Name",
            fields: [{ key: "HostName", label: "Network name", type: "text" }],
          },
          {
            title: "Ports",
            fields: [
              { key: "TCPPort", label: "Media port", type: "number", min: 1, max: 65535,
                hint: "The port this integration talks to" },
              { key: "HttpPort", label: "Web port", type: "number", min: 1, max: 65535 },
              { key: "UDPPort", label: "UDP port", type: "number", min: 1, max: 65535 },
            ],
          },
          {
            title: "Traffic",
            fields: [
              { key: "TCPMaxConn", label: "Connections at once", type: "number", min: 4, max: 32,
                hint: "Every wall tile and archive player takes one" },
              { key: "MaxBps", label: "Upload limit", type: "number", min: 0, max: 100000,
                unit: "kbit/s", hint: "0 means no limit" },
              { key: "TransferPlan", label: "When the network is slow", type: "select",
                options: [["AutoAdapt", "Adapt automatically"], ["Quality", "Keep the quality"],
                          ["Fluency", "Keep it smooth"], ["Transmission", "Favour throughput"]] },
              { key: "MonMode", label: "Live video over", type: "select",
                options: [["TCP", "TCP"], ["UDP", "UDP"]] },
              { key: "UseHSDownLoad", label: "Fast download", type: "toggle" },
            ],
          },
        ],
      },
      {
        id: "ntp",
        title: "Time server",
        section: "NetWork.NetNTP",
        hint: "Keeping the recorder's clock right by asking a time server.",
        cards: [
          {
            title: "Time server",
            fields: [
              { key: "Enable", label: "Set the clock from a time server", type: "toggle" },
              { key: "Server.Name", label: "Server", type: "text", when: "Enable",
                hint: "pool.ntp.org, for example" },
              { key: "Server.Port", label: "Port", type: "number", min: 1, max: 65535, when: "Enable" },
              { key: "TimeZone", label: "Time zone", type: "select", numeric: true,
                options: TIME_ZONES.map((zone, index) => [index, zone]), when: "Enable" },
              { key: "UpdatePeriod", label: "Check every", type: "number", min: 1, max: 1440,
                unit: "min", when: "Enable" },
            ],
          },
        ],
      },
    ],
  },
];

//: Every page with its section beside it, for finding one by id.
const SETTINGS_PAGES = SETTINGS_TREE.flatMap((group) =>
  group.pages.map((page) => ({ ...page, group: group.id }))
);

//: Thumbnail width in the channel grid. Home Assistant scales the frame itself.
const THUMB_WIDTH = 480;

const DAY_MS = 86400000;

//: How far the archive timeline zooms in: a day divided by this is what fits
//: across the bar, so 1440 leaves one minute on screen. A day at full width is
//: about a minute per pixel, where a recording is often twenty seconds long —
//: at that scale clicking the one you want is guesswork, which is the whole
//: reason this exists. A minute across the bar is a second every few pixels.
const MAX_ZOOM = 1440;

//: Ruler steps in seconds, coarse enough to read and fine enough to land on.
//: The largest step that still leaves enough marks across the window wins, so
//: the labels stay about as dense however far in the view is.
const RULER_STEPS = [
  1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600,
];

//: How far the pointer must travel before a press on the timeline counts as a
//: drag rather than a click. Without it every seek nudges the view, because a
//: mouse never presses and releases at exactly the same pixel.
const DRAG_SLOP = 4;

//: Room one ruler mark needs, in pixels: "00:00" at the ruler's size, and a gap
//: wide enough to read it as a separate number. A fixed dozen marks fit a
//: desktop and ran together into one line of digits on a phone.
const RULER_MARK_PX = 56;
const RULER_MARKS_MAX = 12;

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

/**
 * A moment of archive playback, on the clock the recorder keeps.
 *
 * The recorder's times are naive local ones, and the timeline is drawn from
 * them with ``getHours``. Playback times used to be stored as ISO strings and
 * read back by slicing out the time — which is the *UTC* part of an ISO string.
 * In any browser east or west of Greenwich the picture's clock and the bar
 * under it then disagreed by the offset: three hours apart in Kyiv. Playback
 * carries plain epoch milliseconds now, and this is the one place they are
 * turned into something to read.
 */
const fmtStamp = (ms) => {
  if (ms == null) return "—";
  const at = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
};

/**
 * A moment on the timeline's ruler, in as much detail as the step needs.
 *
 * Hours on a whole-day view, seconds when the window is a minute wide. Printing
 * seconds at every scale makes the ruler a wall of digits; printing hours at
 * every scale makes it read 13:00 six times over.
 */
const fmtRuler = (ms, step) => {
  const at = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  if (step >= 3600) return `${pad(at.getHours())}:00`;
  if (step >= 60) return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
};

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
    //: channel → the held pan, tilt or zoom key and its repeat timer
    this._ptzHeld = new Map();
    //: channel → the timer that ends a tap's step
    this._ptzNudges = new Map();
    //: The wall tile being heard, if any. One at a time: two cameras talking
    //: over each other help nobody.
    this._soundChannel = null;
    //: Whether the single-camera view is heard.
    this._liveSound = false;
    //: The one AudioContext, made on the first press of a sound button —
    //: browsers start one only in answer to a click.
    this._audio = null;
    //: The chosen wall layout and page number when channels outnumber it.
    this._layout = Number(localStorage.getItem("xmeye-layout")) || 4;
    //: Whether the channel list sits beside the wall. Shown unless someone has
    //: put it away: a first visit with no list would leave no way to see which
    //: cameras the wall can hold.
    this._pickerShown = (() => {
      try {
        return localStorage.getItem("xmeye-picker") !== "0";
      } catch (err) {
        return true;
      }
    })();
    this._wallPage = 0;
    //: Archive playback state. The player object is deliberately NOT `_player`:
    //: that field holds the live playback method, and one field serving both
    //: meanings let `_stopPlayback()` wipe the method and drop the viewer to
    //: snapshots.
    this._playback = null;
    this._archivePlayer = null;
    this._recordings = null;
    //: What stretch of the day the timeline shows: `scale` 1 is the whole day,
    //: `start` is the left edge as a fraction of it. Kept as state rather than
    //: read off the DOM so a redraw cannot lose the reader's place.
    this._span = { scale: 1, start: 0 };
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
    //: Recorder settings: which page is open, what was read, and what the user
    //: has edited but not yet written.
    this._settingsGroup = SETTINGS_PAGES[0].id;
    this._settings = null;
    this._settingsEdits = {};
    //: Fields whose last save the recorder did not take, by key.
    this._settingsRejected = {};
    //: The record schedule being painted, and the kind of recording painted.
    this._sched = null;
    this._schedBrush = 7;
    //: Cameras a per-camera page is also written to on Save, and whether the
    //: list of them is open.
    this._settingsCopyTo = new Set();
    this._settingsCopyOpen = false;
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
    if (this._menuButton) this._menuButton.hass = hass;
  }

  set narrow(value) {
    this._narrow = value;
    this._mountMenuButton();
  }

  /**
   * Home Assistant's own menu button, in the bar at the top.
   *
   * Its element, not a lookalike: it decides for itself when to show — on a
   * phone, in a narrow window, or when the sidebar is set to hide — and opens
   * the sidebar the same way every other panel's does. Created once and moved
   * back into each redraw, because the redraw replaces the markup wholesale and
   * a fresh element each time would lose the state Home Assistant keeps on it.
   */
  _mountMenuButton() {
    const slot = this.shadowRoot && this.shadowRoot.getElementById("menuslot");
    if (!slot) return;
    if (!this._menuButton) this._menuButton = document.createElement("ha-menu-button");
    this._menuButton.hass = this._hass;
    this._menuButton.narrow = this._narrow;
    if (this._menuButton.parentNode !== slot) slot.appendChild(this._menuButton);
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
    // Every match, not the first: on a phone the facts are drawn a second time
    // inside the "i", and the copy there went stale while the hidden one ticked.
    const set = (field, value) => {
      root.querySelectorAll(`[data-field="${field}"]`).forEach((el) => {
        if (el.textContent !== String(value)) el.textContent = value;
      });
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
    // A new day or camera is a new bar; keeping yesterday's zoom would open it
    // somewhere in the middle for no reason the reader could see.
    this._span = { scale: 1, start: 0 };
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
      if (this._liveSound && this._audio) player.setSound(this._audio, this._gain(channel));

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
    // Sound is switched on for a camera, not for the view: the next one opened
    // starts quiet, as a camera opened unexpectedly loud is a bad surprise.
    this._liveSound = false;
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

    const toggle = root.getElementById("pickertoggle");
    if (toggle) toggle.addEventListener("click", () => this._togglePicker());

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
    this._mountMenuButton();

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

    // The bar every system screen has: Home Assistant's menu button, then the
    // title. Without it a phone or a narrow window has no way back to the
    // sidebar at all — Home Assistant hides the sidebar there and expects the
    // panel to offer the button, which this one never did.
    //
    // The address and firmware go behind an "i" next to the title. They are
    // read once, when filing a bug, and they were a long grey line under the
    // name on every visit. On a phone the recorder's figures join them there:
    // two rows of them pushed the wall below the fold, and a phone is opened
    // to look at the cameras.
    const details = d
      ? `<span class="info">
           <button class="ghost icon" aria-describedby="devicetip"
                   aria-label="${t("Device details")}">${infoIcon()}</button>
           <span class="tip" id="devicetip" role="tooltip">
             <span class="tip-row">${escapeHtml(d.host)}</span>
             <span class="tip-row mono">${escapeHtml(d.device.firmware || "")}</span>
             <span class="tip-facts">${this._headerFacts(d)}</span>
           </span>
         </span>`
      : "";

    return `
      <div class="appbar">
        <span class="menu-slot" id="menuslot"></span>
        <h1 class="title">${escapeHtml(d ? d.device.model || d.title : "XMeye")}</h1>
        ${details}
        <span class="appbar-end">${picker}</span>
      </div>
      <div class="page">
        ${d ? `<header>${this._headerFacts(d)}</header>` : ""}
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
      <div class="wall-layout ${this._pickerShown ? "" : "picker-hidden"}">
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
          <button class="ghost picker-toggle ${this._pickerShown ? "active" : ""}"
                  id="pickertoggle" aria-pressed="${this._pickerShown}"
                  title="${t("Wall channels")}">${channelsIcon()}</button>
          <span class="bar-gap"></span>
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
   * Show or hide the channel list beside the wall.
   *
   * A class on the container, not a redraw: the same reason fullscreen hides
   * the list by CSS. Taking it out of the markup would rebuild the cells, and
   * while the canvases survive a rebuild, there is no reason to put them
   * through one for something this small. The wall simply takes the width.
   */
  _togglePicker() {
    this._pickerShown = !this._pickerShown;
    try {
      localStorage.setItem("xmeye-picker", this._pickerShown ? "1" : "0");
    } catch (err) {
      /* a private window may refuse; the choice then lasts the visit */
    }
    const root = this.shadowRoot;
    const layout = root.querySelector(".wall-layout");
    if (layout) layout.classList.toggle("picker-hidden", !this._pickerShown);
    const toggle = root.getElementById("pickertoggle");
    if (toggle) {
      toggle.classList.toggle("active", this._pickerShown);
      toggle.setAttribute("aria-pressed", String(this._pickerShown));
    }
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
      //: Tiles with the pan, tilt and zoom pad switched on.
      ptz: Array.isArray(stored.ptz) ? stored.ptz.map(Number) : [],
    };
    return this._wallPrefs;
  }

  _saveWallPrefs() {
    const { order, hidden, streams, ptz } = this._loadWallPrefs();
    localStorage.setItem(
      `xmeye-wall-${this._entryId}`,
      JSON.stringify({ order, hidden, streams, ptz })
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
        ${channel.online ? this._ptzControls(channel.index) : ""}
      </div>`;
  }

  /**
   * Pan, tilt and zoom over a wall tile, shown while the pointer is on it.
   *
   * The recorder cannot say which of its cameras turn — an ONVIF camera's PTZ
   * is the camera's business — so every tile offers the switch, and a tile
   * switched on keeps its pad, per recorder, across reloads. A camera that
   * cannot turn simply ignores the commands; nothing breaks.
   */
  _ptzControls(index) {
    const on = this._loadWallPrefs().ptz.includes(index);
    const heard = index === this._soundChannel;
    const dirs = ["up_left", "up", "up_right", "left", null, "right", "down_left", "down", "down_right"];
    const pad = dirs
      .map((direction) =>
        direction
          ? `<button class="ptz-key" data-move="${direction}" title="${t("Hold to turn")}">${ptzArrow(direction)}</button>`
          : `<button class="ptz-key ptz-centre" data-presets title="${t("Presets")}">${presetIcon()}</button>`
      )
      .join("");
    const numbers = Array.from({ length: PTZ_PRESETS }, (_, i) =>
      `<button class="ptz-num" data-preset="${i + 1}">${i + 1}</button>`
    ).join("");
    return `
      <div class="ptz ${on ? "on" : ""}" data-ptz="${index}">
        <div class="tile-audio ${heard ? "on" : ""}">
          <div class="tile-volume">
            <input type="range" min="0" max="100" step="1" data-volume
                   value="${this._volume(index)}" aria-label="${t("Volume")}"
                   title="${t("Volume")}: ${volumeLabel(this._volume(index))}">
          </div>
          <button class="tile-sound ${heard ? "on" : ""}" data-sound
                  title="${heard ? t("Sound off") : t("Sound")}">${soundIcon(heard)}</button>
        </div>
        <button class="ptz-toggle" data-ptz-toggle
                title="${on ? t("Hide pan, tilt and zoom") : t("Pan, tilt and zoom")}">${ptzIcon()}</button>
        <div class="ptz-pad">
          <div class="ptz-dirs">${pad}</div>
          <div class="ptz-zoom">
            <button class="ptz-key" data-move="zoom_in" title="${t("Zoom in")}">${zoomIcon(true)}</button>
            <button class="ptz-key" data-move="zoom_out" title="${t("Zoom out")}">${zoomIcon(false)}</button>
          </div>
        </div>
        <div class="ptz-presets" hidden>
          <div class="ptz-nums">${numbers}</div>
          <button class="ptz-save" data-save title="${t("Save the current view as a preset")}">${t("Save")}</button>
        </div>
      </div>`;
  }

  /** Wire the pads on every tile under `root`. */
  _bindPtz(root) {
    root.querySelectorAll(".ptz[data-ptz]").forEach((box) => {
      const channel = Number(box.dataset.ptz);
      // Everything inside belongs to the pad: a press that reached the tile
      // would open the camera full screen in the middle of turning it.
      box.addEventListener("click", (event) => event.stopPropagation());
      box.querySelector("[data-sound]").addEventListener("click", () =>
        this._toggleWallSound(channel)
      );
      const volume = box.querySelector("[data-volume]");
      volume.addEventListener("input", () => {
        this._setVolume(channel, volume.value);
        volume.title = `${t("Volume")}: ${volumeLabel(volume.value)}`;
      });

      box.querySelector("[data-ptz-toggle]").addEventListener("click", () => {
        const prefs = this._loadWallPrefs();
        const on = !prefs.ptz.includes(channel);
        prefs.ptz = on ? [...prefs.ptz, channel] : prefs.ptz.filter((c) => c !== channel);
        this._saveWallPrefs();
        box.classList.toggle("on", on);
        box.querySelector("[data-ptz-toggle]").title = on
          ? t("Hide pan, tilt and zoom")
          : t("Pan, tilt and zoom");
        if (!on) {
          this._ptzRelease(channel);
          box.querySelector(".ptz-presets").hidden = true;
        }
      });

      box.querySelectorAll("[data-move]").forEach((key) => {
        key.addEventListener("pointerdown", (event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          // Captured, so letting go anywhere — even off the tile — still stops.
          key.setPointerCapture(event.pointerId);
          key.classList.add("held");
          this._ptzHold(channel, key.dataset.move, key);
        });
        const release = () => {
          if (!key.classList.contains("held")) return;
          key.classList.remove("held");
          this._ptzRelease(channel);
        };
        key.addEventListener("pointerup", release);
        key.addEventListener("pointercancel", release);
        key.addEventListener("lostpointercapture", release);
        // A long press on a phone would otherwise bring up the context menu.
        key.addEventListener("contextmenu", (event) => event.preventDefault());
      });

      const presets = box.querySelector(".ptz-presets");
      const save = presets.querySelector("[data-save]");
      box.querySelector("[data-presets]").addEventListener("click", () => {
        presets.hidden = !presets.hidden;
        save.classList.remove("active");
      });
      save.addEventListener("click", () => save.classList.toggle("active"));
      presets.querySelectorAll("[data-preset]").forEach((button) =>
        button.addEventListener("click", async () => {
          const saving = save.classList.contains("active");
          save.classList.remove("active");
          const ok = await this._ptzSend(channel, {
            action: saving ? "set" : "goto",
            preset: Number(button.dataset.preset),
          });
          if (ok) this._flash(button);
          if (ok && !saving) presets.hidden = true;
        })
      );
    });
  }

  /**
   * Start turning, and keep saying so while the key is held.
   *
   * The server stops the camera by itself when the repeats stop arriving, so a
   * tab closed mid-press cannot leave a camera turning into its end stop.
   */
  _ptzHold(channel, direction, key) {
    this._ptzRelease(channel, { quiet: true });
    // A new press takes over from a tap still running out its nudge.
    clearTimeout(this._ptzNudges.get(channel));
    this._ptzNudges.delete(channel);
    const send = () => {
      // A redraw can take the key away mid-press, and a removed element does
      // not reliably hear that its pointer was let go. Gone means let go.
      if (!key.isConnected) {
        this._ptzRelease(channel);
        return Promise.resolve(null);
      }
      return this._ptzSend(channel, { action: "move", direction });
    };
    const held = { timer: null, since: performance.now() };
    this._ptzHeld.set(channel, held);
    send().then((reply) => {
      if (this._ptzHeld.get(channel) !== held) return;
      const every = ((reply && reply.hold_repeat) || 0.5) * 1000;
      held.timer = setInterval(send, every);
    });
  }

  /**
   * Let go: stop the repeats and the camera.
   *
   * Not before PTZ_NUDGE has passed, though. The camera starts about 0.3 s
   * after the command, so a click — down and up in a few dozen milliseconds —
   * sent its stop before anything moved and did nothing at all. Held to the
   * minimum, a click is a small step, which is what a click on an arrow means.
   */
  _ptzRelease(channel, { quiet = false } = {}) {
    const held = this._ptzHeld.get(channel);
    if (!held) return;
    clearInterval(held.timer);
    this._ptzHeld.delete(channel);
    if (quiet) return;
    const stop = () => {
      this._ptzNudges.delete(channel);
      this._ptzSend(channel, { action: "stop" });
    };
    const left = PTZ_NUDGE - (performance.now() - held.since);
    if (left > 0) this._ptzNudges.set(channel, setTimeout(stop, left));
    else stop();
  }

  /** Every held key, let go — when the wall goes away under a press. */
  _ptzReleaseAll() {
    [...this._ptzHeld.keys()].forEach((channel) => this._ptzRelease(channel));
  }

  async _ptzSend(channel, body) {
    try {
      return await this._ws({ type: "xmeye/ptz", entry_id: this._entryId, channel, ...body });
    } catch (err) {
      this._noteDiag("ptz", `channel ${channel} ${body.action}: ${err.message || err.code || err}`);
      const box = this.shadowRoot.querySelector(`.ptz[data-ptz="${channel}"]`);
      if (box) this._flash(box, "failed");
      return null;
    }
  }

  /** A moment of colour on an element, to say a press was heard (or not). */
  _flash(element, name = "done") {
    element.classList.add(name);
    setTimeout(() => element.classList.remove(name), 700);
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
    if (index === this._soundChannel && this._audio) player.setSound(this._audio, this._gain(index));
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
    this._bindPtz(wall);

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
    this._ptzReleaseAll();
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
    // A camera that sends no sound says so on its button, once enough of the
    // stream has gone by for the absence to mean something.
    const button = this.shadowRoot.querySelector(`.ptz[data-ptz="${index}"] [data-sound]`);
    if (button && index === this._soundChannel && stats.decoded > 45) {
      button.classList.toggle("silent", !stats.sound);
      button.title = stats.sound ? t("Sound off") : t("No sound from this camera");
    }
  }

  /**
   * The volume control's position for a channel, 0 to 100.
   *
   * Per channel and per recorder, and shared between the tile and the single
   * view: it is the camera's microphone that is quiet or loud, not the view.
   */
  _volume(index) {
    try {
      const stored = JSON.parse(localStorage.getItem(`xmeye-volume-${this._entryId}`)) || {};
      const value = Number(stored[index]);
      return Number.isFinite(value) && index in stored ? value : VOLUME_DEFAULT;
    } catch (err) {
      return VOLUME_DEFAULT;
    }
  }

  _gain(index) {
    return volumeGain(this._volume(index));
  }

  /** Set a channel's volume, and let whatever is playing it hear at once. */
  _setVolume(index, position) {
    const key = `xmeye-volume-${this._entryId}`;
    try {
      const stored = JSON.parse(localStorage.getItem(key)) || {};
      stored[index] = Number(position);
      localStorage.setItem(key, JSON.stringify(stored));
    } catch (err) {
      /* storage refused: the change still applies to what is playing */
    }
    const gain = volumeGain(position);
    const tile = this._wall.get(index);
    if (tile && index === this._soundChannel) tile.setGain(gain);
    if (this._native && this._live === index && this._liveSound) this._native.setGain(gain);
  }

  /** The AudioContext, made or woken inside the click that asked for sound. */
  _audioContext() {
    if (!this._audio) {
      const Context = window.AudioContext || window.webkitAudioContext;
      if (!Context) return null;
      this._audio = new Context();
    }
    if (this._audio.state === "suspended") this._audio.resume();
    return this._audio;
  }

  /**
   * Hear a wall tile, or stop hearing it.
   *
   * The tile stays on the stream it is on. It used to move to main for its
   * sound, on the belief that recorders send sound with main only; that was
   * the simulator's main stream failing to start its tone, and recorders send
   * the sound with every stream. Moving only reloaded the tile. A stream with
   * no sound says so on the button instead.
   */
  _toggleWallSound(index) {
    const before = this._soundChannel;
    const context = index === before ? null : this._audioContext();
    if (index !== before && !context) {
      this._noteDiag("sound", `ch${index}: this browser has no Web Audio`);
      return;
    }
    const touched = [before, index].filter((c, i, all) => c !== null && all.indexOf(c) === i);
    this._soundChannel = context ? index : null;
    const heardPlayer = context && this._wall.get(index);
    this._noteDiag(
      "sound",
      context
        ? `ch${index} on, ${this._wallStream(index)} stream ` +
            `${heardPlayer && heardPlayer.stats.sound
              ? `carries ${heardPlayer.stats.sound}`
              : "has brought no sound so far"}; ` +
            `audio context ${context.state}, ${context.sampleRate} Hz`
        : `ch${index} off`
    );

    for (const channel of touched) {
      const heard = channel === this._soundChannel;
      const player = this._wall.get(channel);
      if (player) player.setSound(heard ? context : null, this._gain(channel));
      const audio = this.shadowRoot.querySelector(`.ptz[data-ptz="${channel}"] .tile-audio`);
      const button = audio && audio.querySelector("[data-sound]");
      if (button) {
        audio.classList.toggle("on", heard);
        button.classList.toggle("on", heard);
        button.classList.remove("silent");
        button.innerHTML = soundIcon(heard);
        button.title = heard ? t("Sound off") : t("Sound");
      }
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

    // Yesterday and tomorrow are one button each, because stepping a day is
    // what this control is used for and typing a date is not.
    return `
      <div class="toolbar archive-bar">
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
        <div class="daypick">
          <button class="ghost step" id="prevday"
                  title="${t("Previous day")}">${prevIcon()}</button>
          <input type="date" id="day" value="${this._recordingsDay}">
          <button class="ghost step" id="nextday"
                  title="${t("Next day")}">${nextIcon()}</button>
        </div>
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
          <span id="playhead">${fmtStamp(p.start)} — ${t("channel {channel}", { channel: this._selectedChannel + 1 })}</span>
          <button class="ghost icon" id="closeplay"
                  title="${t("Close")}">${closeIcon()}</button>
        </div>
        <div class="player-screen"><canvas id="playcanvas"></canvas></div>
        <div class="player-error" id="playerror" ${p.error ? "" : "hidden"}>${
          p.error ? escapeHtml(p.error) : ""
        }</div>
        <div class="player-bar">
          <button class="ghost icon" id="prevevent"
                  title="${t("Previous event")}">${eventIcon(true)}</button>
          <button class="ghost icon" id="playpause"
                  title="${p.paused ? t("Play") : t("Pause")}">${
                    p.paused ? playIcon() : pauseIcon()
                  }</button>
          <button class="ghost icon" id="nextevent"
                  title="${t("Next event")}">${eventIcon(false)}</button>
          <div class="rates">
            ${rates
              .map(
                (r) =>
                  `<button class="ghost rate ${p.rate === r ? "active" : ""}" data-rate="${r}">×${r}</button>`
              )
              .join("")}
          </div>
          <div class="player-time" id="playtime">${fmtStamp(p.position ?? p.start)}</div>
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
    // Seeking inside a player that is already up keeps its canvas, and a canvas
    // keeps its picture: where we were stays on screen until the first frame of
    // where we are going arrives. Rendering the tab again would put an empty
    // canvas in its place, which reads as the page reloading — a black gap, and
    // everything below it jumping as the element is replaced.
    const inPlace =
      Boolean(this._playback) && Boolean(this.shadowRoot.getElementById("playcanvas"));
    this._stopPlayback();
    const day = this._recordingsDay;
    const start = when instanceof Date ? when : new Date(`${day}T00:00:00`);
    const end = new Date(`${day}T23:59:59`);
    this._playback = {
      start: start.getTime(),
      end: end.getTime(),
      rate: this._playback ? this._playback.rate : 1,
      paused: false,
      position: start.getTime(),
    };
    if (inPlace) this._refreshPlayer();
    else this._render();

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
        this._failPlayback(reason);
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
        this._failPlayback(String(err.message || err));
      });
  }

  /**
   * Bring the player's chrome up to date without touching its canvas.
   *
   * Everything here is what a redraw of the tab would have done anyway; the
   * canvas is the one thing that must survive, because it is holding the last
   * frame of the previous position while the new one is dialled.
   */
  _refreshPlayer() {
    const root = this.shadowRoot;
    const p = this._playback;
    const head = root.getElementById("playhead");
    if (head)
      head.textContent = `${fmtStamp(p.start)} — ${t("channel {channel}", {
        channel: this._selectedChannel + 1,
      })}`;
    const time = root.getElementById("playtime");
    if (time) time.textContent = fmtStamp(p.start);
    const playPause = root.getElementById("playpause");
    if (playPause) {
      playPause.innerHTML = pauseIcon();
      playPause.title = t("Pause");
    }
    const failure = root.getElementById("playerror");
    if (failure) {
      failure.textContent = "";
      failure.hidden = true;
    }
    this._drawTrack();
  }

  /**
   * Say that playback failed.
   *
   * Worth its own method now the picture no longer goes black on a failure: a
   * seek that never arrives leaves the previous frame sitting there, and
   * without this it would look like a stream playing perfectly still. The
   * reason used to be stored and never shown by anything.
   */
  _failPlayback(reason) {
    if (!this._playback) return;
    this._playback.error = reason;
    const failure = this.shadowRoot.getElementById("playerror");
    if (!failure) {
      this._render();
      return;
    }
    failure.textContent = reason;
    failure.hidden = false;
  }

  /**
   * The moments worth jumping between: where the recording changes kind.
   *
   * Stepping ten seconds was arbitrary — ten seconds of an empty yard is the
   * same empty yard. What is worth landing on is where something changed:
   * motion starting, and the recorder falling back to its schedule when it
   * stops. Every recording start is not that. Continuous recording splits into
   * a file every minute or so, and hopping between those is stepping by an
   * arbitrary amount again, only less predictably: 664 of them in this day.
   */
  _eventMarks() {
    const rec = this._recordings;
    if (!rec || !rec.recordings) return [];
    const ordered = [...rec.recordings].sort((a, b) => (a.begin < b.begin ? -1 : 1));
    const marks = [];
    let previous = null;
    for (const record of ordered) {
      if (record.event !== previous) {
        marks.push(new Date(record.begin).getTime());
        previous = record.event;
      }
    }
    return marks;
  }

  _jumpEvent(forward) {
    const marks = this._eventMarks();
    if (!marks.length) return;
    const from = this._playback
      ? this._playback.position ?? this._playback.start
      : this._dayStart();
    // A second of slack, or the mark just landed on is found again at once and
    // the button does nothing.
    const next = forward
      ? marks.find((mark) => mark > from + 1000)
      : marks.filter((mark) => mark < from - 1000).pop();
    if (next === undefined) return;
    this._startPlayback(new Date(next));
  }

  /**
   * The timeline: seek, zoom and pan on one bar.
   *
   * A press seeks and a drag pans, told apart by whether the pointer travelled.
   * Both are needed and neither can be given up: a bar that pans on every press
   * cannot be clicked, and one that cannot be panned is useless the moment it
   * is zoomed past a screenful.
   */
  _bindTimeline(root) {
    const timeline = root.getElementById("timeline");
    const track = root.getElementById("track");
    if (!timeline || !track) return;

    const fractionAt = (event) => {
      const box = track.getBoundingClientRect();
      return Math.min(Math.max((event.clientX - box.left) / box.width, 0), 1);
    };

    timeline.addEventListener(
      "wheel",
      (event) => {
        // The page must not scroll under a wheel meant for the bar.
        event.preventDefault();
        this._zoomTimeline(fractionAt(event), Math.exp(-event.deltaY * 0.0025));
      },
      { passive: false }
    );

    // A second finger joining turns the gesture into a pinch: panning stops
    // and the two touches' spread drives the same zoom the wheel uses. One
    // finger lifting out of a pinch resumes panning from that finger's
    // current spot, rather than the stale place it went down.
    let press = null;
    const pointers = new Map();
    let pinch = null;
    const pinchSpread = () => {
      const [a, b] = [...pointers.values()];
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    const startPress = (pointerId) => {
      const p = pointers.get(pointerId);
      press = { x: p.x, fraction: fractionAt({ clientX: p.x }), moved: false };
    };

    track.addEventListener("pointerdown", (event) => {
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      track.setPointerCapture(event.pointerId);
      if (pointers.size >= 2) {
        press = null;
        pinch = { distance: pinchSpread() };
      } else {
        startPress(event.pointerId);
      }
    });
    track.addEventListener("pointermove", (event) => {
      if (!pointers.has(event.pointerId)) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

      if (pointers.size >= 2 && pinch) {
        const [a, b] = [...pointers.values()];
        const distance = pinchSpread();
        if (distance > 0 && pinch.distance > 0) {
          this._zoomTimeline(fractionAt({ clientX: (a.x + b.x) / 2 }), distance / pinch.distance);
        }
        pinch.distance = distance;
        return;
      }

      if (!press) return;
      if (!press.moved && Math.abs(event.clientX - press.x) < DRAG_SLOP) return;
      press.moved = true;
      this._panTimeline((event.clientX - press.x) / track.getBoundingClientRect().width);
      press.x = event.clientX;
    });
    const lift = (event) => {
      const had = pointers.delete(event.pointerId);
      if (track.hasPointerCapture(event.pointerId))
        track.releasePointerCapture(event.pointerId);
      if (!had) return;

      if (pointers.size >= 2) {
        pinch = { distance: pinchSpread() };
        return;
      }
      pinch = null;

      if (pointers.size === 1) {
        startPress(pointers.keys().next().value);
        // Still the same gesture. The finger left over from a pinch may pan,
        // but lifting it is not a tap — counted as one, every pinch that ended
        // with the fingers simply lifted started playback wherever the last
        // finger happened to rest.
        press.moved = true;
        return;
      }

      if (press && !press.moved) {
        const { fraction } = press;
        const { from, span } = this._timeSpan();
        this._startPlayback(new Date(from + fraction * span));
      }
      press = null;
    };
    track.addEventListener("pointerup", lift);
    track.addEventListener("pointercancel", () => {
      pointers.clear();
      pinch = null;
      press = null;
    });

    const fit = root.getElementById("zoomfit");
    if (fit)
      fit.addEventListener("click", () => {
        this._span = { scale: 1, start: 0 };
        this._drawTrack();
      });

    this._drawTrack();
  }

  _dayStart() {
    return new Date(`${this._recordingsDay}T00:00:00`).getTime();
  }

  /** The stretch of the day the timeline is showing. */
  _timeSpan() {
    const span = DAY_MS / this._span.scale;
    const from = this._dayStart() + this._span.start * DAY_MS;
    return { from, to: from + span, span };
  }

  /** Keep the left edge inside the day, whatever the scale. */
  _clampSpan(scale, start) {
    return { scale, start: Math.min(Math.max(start, 0), 1 - 1 / scale) };
  }

  /**
   * Zoom about a point of the bar, keeping the moment under it in place.
   *
   * Zooming about the centre instead would throw away the one thing the reader
   * has told us — where they are looking — and every step in would have to be
   * followed by hunting for the place again.
   */
  _zoomTimeline(fraction, factor) {
    const { scale: was, start } = this._span;
    const scale = Math.min(MAX_ZOOM, Math.max(1, was * factor));
    if (scale === was) return;
    const at = start + fraction / was;
    this._span = this._clampSpan(scale, at - fraction / scale);
    this._drawTrack();
  }

  _panTimeline(fraction) {
    const { scale, start } = this._span;
    this._span = this._clampSpan(scale, start - fraction / scale);
    this._drawTrack();
  }

  /**
   * Draw the bar for the stretch currently in view.
   *
   * Redrawn rather than transformed. A CSS scale would stretch the cursor and
   * the hairline of a short recording along with everything else, and would
   * still leave the ruler to be recomputed; and it would keep seven hundred
   * elements in the document when forty are on screen. Only what falls inside
   * the window is built, so zooming in makes this cheaper, not dearer.
   */
  _drawTrack() {
    const root = this.shadowRoot;
    const rec = this._recordings;
    const blocks = root.getElementById("blocks");
    if (!blocks || !rec || !rec.recordings) return;

    const { from, to, span } = this._timeSpan();
    const place = (ms) => ((ms - from) / span) * 100;

    const drawn = [];
    for (const record of rec.recordings) {
      const begin = new Date(record.begin).getTime();
      const end = new Date(record.end || record.begin).getTime();
      if (end < from || begin > to) continue;
      const left = place(begin);
      // A recording of a few seconds is thinner than a pixel across a day, and
      // an invisible block cannot be aimed at.
      const width = Math.max(place(end) - left, 0.08);
      const color = EVENT_COLORS[record.event] || "var(--primary-color)";
      drawn.push(
        `<div class="block" style="left:${left.toFixed(4)}%;` +
          `width:${width.toFixed(4)}%;background:${color}" title="${fmtTime(
            record.begin
          )} → ${fmtTime(record.end)} · ${t(
            EVENT_LABELS[record.event] || record.event
          )} · ${fmtBytes(record.size)}"></div>`
      );
    }
    blocks.innerHTML = drawn.join("");

    const ruler = root.getElementById("ruler");
    const marks = Math.max(
      2,
      Math.min(RULER_MARKS_MAX, Math.floor((ruler.clientWidth || 720) / RULER_MARK_PX))
    );
    const step = RULER_STEPS.find((seconds) => span / 1000 / seconds <= marks) || 21600;
    const stepMs = step * 1000;
    // Marks are aligned to the day rather than to the epoch, or a timezone off
    // a whole hour would put every label on a half-hour.
    const dayStart = this._dayStart();
    const first = dayStart + Math.ceil((from - dayStart) / stepMs) * stepMs;
    // The far edge of a whole-day view is midnight again, and a right-hand mark
    // reading 00:00 looks like the day starting over. It is 24:00.
    const name = (at) =>
      at - dayStart >= DAY_MS && step >= 60 ? "24:00" : fmtRuler(at, step);
    const ticks = [];
    for (let at = first; at <= to; at += stepMs) {
      const share = place(at);
      // Marks are centred on their tick, so the two at the ends would hang half
      // outside the bar. They are pushed in instead of being dropped.
      const align =
        share < 0.5 ? "none" : share > 99.5 ? "translateX(-100%)" : "translateX(-50%)";
      ticks.push(
        `<span style="left:${share.toFixed(4)}%;transform:${align}">${name(at)}</span>`
      );
    }
    ruler.innerHTML = ticks.join("");

    const label = root.getElementById("zoomspan");
    if (label) label.textContent = `${name(from)} – ${name(to)}`;

    this._placeCursor(from, span);
  }

  /** Put the cursor where the frame on screen belongs, or hide it. */
  _placeCursor(from, span) {
    const cursor = this.shadowRoot.getElementById("cursor");
    if (!cursor) return;
    const at = this._playback ? this._playback.position ?? null : null;
    const inside = at !== null && at >= from && at <= from + span;
    cursor.style.display = inside ? "" : "none";
    if (inside) cursor.style.left = `${((at - from) / span) * 100}%`;
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
    this._playback.position = stats.position;

    // The recorder feeds the archive at its own pace and may not reach the
    // requested 8x, so the measured speed is shown next to the requested one.
    const now = performance.now();
    if (previous && this._playback.measuredAt) {
      const media = (this._playback.position - previous) / 1000;
      const wall = (now - this._playback.measuredAt) / 1000;
      if (wall > 0.5) this._playback.actual = media / wall;
    }
    this._playback.measuredAt = now;

    const label = this.shadowRoot.getElementById("playtime");
    if (label) {
      const actual = this._playback.actual;
      label.textContent =
        fmtStamp(this._playback.position) +
        (actual ? t("  (really ×{rate})", { rate: actual.toFixed(1) }) : "");
    }

    const { from, to, span } = this._timeSpan();
    // Zoomed in, playback runs off the right-hand edge in seconds. Rather than
    // leave the reader chasing it, the window follows: when the cursor reaches
    // the last sixth it is put back near the start of the view, so the picture
    // and the bar stay describing the same moment.
    if (this._span.scale > 1 && (stats.position > to - span * 0.15 || stats.position < from)) {
      this._span = this._clampSpan(
        this._span.scale,
        (stats.position - this._dayStart() - span * 0.15) / DAY_MS
      );
      this._drawTrack();
      return;
    }
    this._placeCursor(from, span);
  }

  _timeline(rec) {
    if (!rec.recordings.length)
      return `<div class="empty">${t("Nothing recorded on {day}.", { day: this._recordingsDay })}</div>`;

    const byEvent = {};
    rec.recordings.forEach((r) => {
      byEvent[r.event] = (byEvent[r.event] || 0) + 1;
    });

    return `
      <div class="card">
        <div class="timeline" id="timeline">
          <div class="track" id="track">
            <div class="blocks" id="blocks"></div>
            <div class="cursor" id="cursor"></div>
          </div>
          <div class="ruler" id="ruler"></div>
        </div>
        <div class="timeline-foot">
          <div class="hint">${t(
            "Click to play from that moment. Scroll to zoom, drag to move."
          )}</div>
          <div class="zoom">
            <span class="zoom-span mono" id="zoomspan"></span>
            <button class="ghost icon" id="zoomfit"
                    title="${t("Fit the whole day")}">${fitIcon()}</button>
          </div>
        </div>
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
    const page = this._settingsPage();

    // The pages, grouped under their sections. On a narrow screen the same list
    // is a select instead: a column of links beside the form leaves the form no
    // room on a phone.
    const nav = SETTINGS_TREE.map(
      (group) => `
        <div class="cfg-group">
          <div class="cfg-group-title">${t(group.title)}</div>
          ${group.pages
            .map(
              (p) =>
                `<button class="cfg-link ${p.id === page.id ? "active" : ""}" data-page="${p.id}">${t(p.title)}</button>`
            )
            .join("")}
        </div>`
    ).join("");
    const picker = `
      <select class="cfg-picker" id="cfgpage" aria-label="${t("Settings page")}">
        ${SETTINGS_TREE.map(
          (group) =>
            `<optgroup label="${escapeHtml(t(group.title))}">${group.pages
              .map(
                (p) =>
                  `<option value="${p.id}" ${p.id === page.id ? "selected" : ""}>${escapeHtml(t(p.title))}</option>`
              )
              .join("")}</optgroup>`
        ).join("")}
      </select>`;

    let body;
    // Still reading counts as not read: drawn from an empty value, the form
    // showed defaults for a moment, and the schedule kept the empty week it
    // was first built from.
    if (!this._settings || this._settings.section !== page.section || this._settings.loading) {
      body = `<div class="empty">${t("Reading the settings…")}</div>`;
    } else if (this._settings.error) {
      body = `<div class="empty error">${escapeHtml(this._settings.error)}</div>`;
    } else {
      const value = this._settingsValue(page);
      const cards = page.cards
        .map(
          (card) => `
            <section class="cfg-card">
              ${card.title ? `<h3>${t(card.title)}</h3>` : ""}
              ${
                card.schedule
                  ? this._scheduleBody(value)
                  : card.fields.map((field) => this._settingRow(page, field, value)).join("")
              }
            </section>`
        )
        .join("");
      body = `
        ${page.warning ? `<p class="warn">${t(page.warning)}</p>` : ""}
        ${page.perChannel ? this._settingsChannelPicker() : ""}
        <div class="cfg-cards">${cards}</div>
        ${this._settingsBar()}`;
    }

    return `
      <div class="cfg">
        <nav class="cfg-nav" aria-label="${t("Settings")}">${nav}</nav>
        <section class="cfg-page">
          ${picker}
          <header class="cfg-head">
            <h2>${t(page.title)}</h2>
            ${page.hint ? `<p>${t(page.hint)}</p>` : ""}
          </header>
          ${body}
        </section>
      </div>`;
  }

  /** The page open now, by id, falling back to the first. */
  _settingsPage() {
    return SETTINGS_PAGES.find((p) => p.id === this._settingsGroup) || SETTINGS_PAGES[0];
  }

  /** What the recorder holds for this page — one channel's entry, when per channel. */
  _settingsValue(page) {
    const raw = this._settings && this._settings.value;
    return (page.perChannel && Array.isArray(raw) ? raw[this._settingsChannel] : raw) || {};
  }

  /** A field's value as the form should show it: the edit if there is one. */
  _settingCurrent(field, value) {
    return field.key in this._settingsEdits
      ? this._settingsEdits[field.key]
      : this._settingRead(value, field.key);
  }

  /** One labelled row: the words on the left, the control on the right. */
  _settingRow(page, field, value) {
    const current = this._settingCurrent(field, value);
    const id = `set-${field.key.replace(/\./g, "-")}`;
    const changed = field.key in this._settingsEdits;
    const rejected = field.key in this._settingsRejected;
    const off = this._settingDisabled(page, field, value);
    return `
      <div class="cfg-row ${changed ? "changed" : ""} ${rejected ? "rejected" : ""} ${off ? "off" : ""}"
           data-row="${field.key}">
        <label for="${id}">
          <span>${t(field.label)}</span>
          ${field.hint ? `<small>${t(field.hint)}</small>` : ""}
          ${rejected ? `<small class="cfg-rejected">${t("The recorder did not accept this value")}</small>` : ""}
        </label>
        <div class="cfg-control">${this._settingInput(field, current, id, off)}</div>
      </div>`;
  }

  /** Whether a field is greyed out because the toggle it depends on is off. */
  _settingDisabled(page, field, value) {
    if (!field.when) return false;
    const master = page.cards.flatMap((c) => c.fields || []).find((f) => f.key === field.when);
    const on = master ? this._settingCurrent(master, value) : true;
    return master && master.type === "toggle01" ? Number(on) !== 1 : on !== true;
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

  /** One control, chosen by the field's declared type. */
  _settingInput(field, current, id, off) {
    const common = `id="${id}" data-setting="${field.key}" ${off ? "disabled" : ""}`;
    if (field.type === "toggle" || field.type === "toggle01") {
      // Some flags are real booleans, others are 0/1 integers; the type says
      // which, so the value written back keeps the shape the firmware expects.
      const on = field.type === "toggle" ? current === true : Number(current) === 1;
      return `
        <span class="switch">
          <input type="checkbox" role="switch" ${common} ${on ? "checked" : ""}>
          <span class="switch-track" aria-hidden="true"></span>
        </span>`;
    }
    if (field.type === "select") {
      const known = field.options.some(([key]) => String(key) === String(current));
      // A value the schema does not list — set from the recorder's own menu, or
      // by a firmware with more choices — stays selectable as itself, rather than
      // the form quietly showing the first option and saving that instead.
      const options = [
        ...field.options,
        ...(known || current == null || current === "" ? [] : [[current, String(current)]]),
      ]
        .map(
          ([key, label]) =>
            `<option value="${escapeHtml(String(key))}" ${
              String(current) === String(key) ? "selected" : ""
            }>${escapeHtml(t(label))}</option>`
        )
        .join("");
      return `<select ${common}>${options}</select>`;
    }
    if (field.type === "number") {
      return `
        <span class="cfg-number">
          <input type="number" inputmode="numeric" ${common}
                 min="${field.min ?? 0}" max="${field.max ?? 99999}" value="${current ?? 0}">
          ${field.unit ? `<span class="cfg-unit">${t(field.unit)}</span>` : ""}
        </span>`;
    }
    if (field.type === "level") {
      const step = Math.min(field.max, Math.max(field.min, Number(current) || field.min));
      return `
        <span class="cfg-level">
          <input type="range" ${common} min="${field.min}" max="${field.max}" step="1" value="${step}">
          <output for="${id}">${t(field.labels[step - field.min])}</output>
        </span>`;
    }
    if (field.type === "range") {
      const v = Number(current) || 0;
      return `
        <span class="cfg-level">
          <input type="range" ${common} min="${field.min}" max="${field.max}" step="1" value="${v}">
          <output for="${id}">${this._settingRangeText(field, v)}</output>
        </span>`;
    }
    return `<input type="text" ${common} value="${escapeHtml(String(current ?? ""))}">`;
  }

  /** The words beside a range slider. */
  _settingRangeText(field, value) {
    if (field.display === "percent") {
      return `${Math.round(((value - field.min) / (field.max - field.min)) * 100)}%`;
    }
    return String(value);
  }

  /** The save bar's buttons; called again whenever the bar is redrawn. */
  _bindSettingsBar() {
    const root = this.shadowRoot;
    const save = root.getElementById("savesettings");
    if (save) save.addEventListener("click", () => this._saveSettings());
    const reset = root.getElementById("resetsettings");
    if (reset)
      reset.addEventListener("click", () => {
        this._settingsEdits = {};
        this._settingsRejected = {};
        this._settingsNote = null;
        this._sched = null;
        this._settingsCopyTo.clear();
        this._render();
      });
  }

  /** Every field of the open page. */
  _settingFields() {
    return this._settingsPage().cards.flatMap((card) => card.fields || []);
  }

  /**
   * The save bar, kept at the foot of the page while it scrolls.
   *
   * It says what is pending, and after a save what the recorder made of it.
   */
  _settingsBar() {
    const copies = this._settingsCopyTo.size;
    const dirty = Object.keys(this._settingsEdits).length + (copies ? 1 : 0);
    const blocked = Boolean(this._sched && this._sched.invalid.size);
    const saving = this._settingsSaving;
    const status = saving
      ? t("Saving…")
      : blocked
        ? t("A day can hold at most six periods")
        : dirty
          ? [
              Object.keys(this._settingsEdits).length
                ? t("{count} unsaved changes", { count: Object.keys(this._settingsEdits).length })
                : "",
              copies ? t("will be copied to {count} cameras", { count: copies }) : "",
            ].filter(Boolean).join(" · ")
          : this._settingsNote || t("No changes");
    return `
      <div class="cfg-bar ${dirty ? "dirty" : ""}">
        <span class="cfg-status" id="settingsstatus">${escapeHtml(status)}</span>
        <button class="ghost" id="resetsettings" ${(dirty || blocked) && !saving ? "" : "disabled"}>${t("Discard")}</button>
        <button class="primary" id="savesettings" ${dirty && !saving && !blocked ? "" : "disabled"}>${t("Save")}</button>
      </div>`;
  }

  /** Update the bar and the greyed-out rows without redrawing under the cursor. */
  _refreshSettingsToolbar() {
    const bar = this.shadowRoot.querySelector(".cfg-bar");
    if (bar) {
      const fresh = document.createElement("div");
      fresh.innerHTML = this._settingsBar();
      bar.replaceWith(fresh.firstElementChild);
      this._bindSettingsBar();
    }
    const page = this._settingsPage();
    const value = this._settingsValue(page);
    for (const field of this._settingFields()) {
      const row = this.shadowRoot.querySelector(`[data-row="${field.key}"]`);
      if (!row) continue;
      row.classList.toggle("changed", field.key in this._settingsEdits);
      const off = this._settingDisabled(page, field, value);
      row.classList.toggle("off", off);
      const input = row.querySelector("[data-setting]");
      if (input) input.disabled = off;
    }
  }

  /**
   * The week of one camera, as half-hour slots the viewer paints.
   *
   * The slots live in memory while the page is open, so a stroke repaints
   * cells rather than the page; they turn back into the firmware's periods
   * when a stroke ends. Only the days painted are rebuilt — a day set to the
   * minute in the recorder's own menu is written back exactly as it was read.
   */
  _scheduleBody(value) {
    if (!Schedule) return `<div class="empty">${t("Reading the settings…")}</div>`;
    const state = this._scheduleState(value);
    const mode = this._settingCurrent({ key: "RecordMode" }, value);
    const off = mode !== "ConfigRecord";
    const locale = (this._hass && this._hass.locale && this._hass.locale.language) || undefined;
    // Monday first, as a week is read here; the firmware counts from Sunday.
    const order = [1, 2, 3, 4, 5, 6, 0];
    const dayName = (day) =>
      new Date(2026, 0, 4 + day).toLocaleDateString(locale, { weekday: "short" });
    const brushes = RECORD_BRUSHES.map(
      (b) => `
        <button class="sched-brush ${b.mask === this._schedBrush ? "active" : ""}" data-brush="${b.mask}"
                ${off ? "disabled" : ""}>
          <i class="k-${b.kind}"></i>${t(b.label)}
        </button>`
    ).join("");
    const hours = [0, 3, 6, 9, 12, 15, 18, 21, 24]
      .map((h) => `<span style="left:${(h / 24) * 100}%">${String(h).padStart(2, "0")}</span>`)
      .join("");
    const rows = order
      .map((day) => {
        const slots = state.slots[day];
        const cells = slots
          .map((mask, slot) => `<i class="k-${Schedule.maskKind(mask)}" data-slot="${slot}"></i>`)
          .join("");
        const tooMany = state.invalid.has(day);
        return `
          <div class="sched-row ${tooMany ? "too-many" : ""}" data-day="${day}">
            <span class="sched-day">${escapeHtml(dayName(day))}</span>
            <div class="sched-cells">${cells}</div>
            <button class="ghost icon sched-copy" data-copyday="${day}" ${off ? "disabled" : ""}
                    title="${t("Copy this day to every day")}"
                    aria-label="${t("Copy this day to every day")}">${copyIcon()}</button>
          </div>`;
      })
      .join("");
    const notes = [
      off ? t("The schedule is used only when Record is set to the schedule.") : "",
      state.invalid.size ? t("A day can hold at most six periods; simplify the marked days.") : "",
      state.rounded ? t("Some periods do not start on a half hour; they are shown rounded and kept exactly as they are unless their day is painted.") : "",
    ].filter(Boolean);
    return `
      <div class="sched ${off ? "off" : ""}">
        <div class="sched-brushes" role="radiogroup" aria-label="${t("Paint with")}">${brushes}</div>
        <div class="sched-grid">
          <div class="sched-hours"><span class="sched-day"></span><div>${hours}</div><span class="sched-pad"></span></div>
          ${rows}
        </div>
        <div class="sched-actions">
          <button class="ghost" id="schedfill" ${off ? "disabled" : ""}>${t("Fill the whole week")}</button>
          <button class="ghost" id="schedclear" ${off ? "disabled" : ""}>${t("Clear the week")}</button>
        </div>
        ${notes.map((note) => `<p class="hint sched-note">${note}</p>`).join("")}
      </div>`;
  }

  /** The slots being painted, built from what the recorder holds on first use. */
  _scheduleState(value) {
    const channel = this._settingsChannel;
    if (this._sched && this._sched.channel === channel && this._sched.section === "Record") {
      return this._sched;
    }
    const periods = this._settingCurrent({ key: "TimeSection" }, value) || [];
    const masks = this._settingCurrent({ key: "Mask" }, value) || [];
    const slots = [];
    let rounded = false;
    for (let day = 0; day < Schedule.DAYS; day++) {
      const p = periods[day] || [];
      const m = masks[day] || [];
      slots.push(Schedule.dayToSlots(p, m));
      if (!Schedule.dayIsAligned(p, m)) rounded = true;
    }
    this._sched = {
      channel,
      section: "Record",
      slots,
      painted: new Set(),
      invalid: new Set(),
      rounded,
    };
    return this._sched;
  }

  /**
   * Turn the painted days back into periods and record them as edits.
   *
   * A day that needs more than six periods cannot be written; it is marked,
   * and the save waits until it has been simplified.
   */
  _scheduleCommit() {
    const state = this._sched;
    if (!state) return;
    const value = this._settingsValue(this._settingsPage());
    const stored = { periods: this._settingRead(value, "TimeSection") || [],
                     masks: this._settingRead(value, "Mask") || [] };
    const periods = (this._settingCurrent({ key: "TimeSection" }, value) || stored.periods).map((d) => [...d]);
    const masks = (this._settingCurrent({ key: "Mask" }, value) || stored.masks).map((d) => [...d]);
    state.invalid.clear();
    for (const day of state.painted) {
      const encoded = Schedule.slotsToDay(state.slots[day]);
      if (!encoded) {
        state.invalid.add(day);
        continue;
      }
      periods[day] = encoded.periods;
      masks[day] = encoded.masks;
    }
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    if (same(periods, stored.periods)) delete this._settingsEdits.TimeSection;
    else this._settingsEdits.TimeSection = periods;
    if (same(masks, stored.masks)) delete this._settingsEdits.Mask;
    else this._settingsEdits.Mask = masks;
    this.shadowRoot.querySelectorAll(".sched-row").forEach((row) =>
      row.classList.toggle("too-many", state.invalid.has(Number(row.dataset.day)))
    );
    this._refreshSettingsToolbar();
  }

  /** Painting, brushes and the day and week buttons of the schedule card. */
  _bindSchedule() {
    const root = this.shadowRoot;
    const grid = root.querySelector(".sched-grid");
    if (!grid || !this._sched || root.querySelector(".sched.off")) return;
    const state = this._sched;

    root.querySelectorAll("[data-brush]").forEach((button) =>
      button.addEventListener("click", () => {
        this._schedBrush = Number(button.dataset.brush);
        root.querySelectorAll("[data-brush]").forEach((b) =>
          b.classList.toggle("active", b === button)
        );
      })
    );

    // A stroke follows the pointer across cells. The grid holds the capture, so
    // the cell under the pointer is found by position rather than by the event
    // target, which stays the grid for the whole stroke.
    let painting = false;
    let last = null;
    const paintSlot = (row, day, slot) => {
      if (state.slots[day][slot] === this._schedBrush) return;
      state.slots[day][slot] = this._schedBrush;
      state.painted.add(day);
      const cell = row.querySelector(`[data-slot="${slot}"]`);
      if (cell) cell.className = `k-${Schedule.maskKind(this._schedBrush)}`;
    };
    const paintAt = (x, y) => {
      const cell = root.elementFromPoint(x, y);
      if (!cell || cell.dataset.slot === undefined) return;
      const row = cell.closest("[data-day]");
      if (!row) return;
      const day = Number(row.dataset.day);
      const slot = Number(cell.dataset.slot);
      // Pointer events come far apart when the hand moves fast — a quick drag
      // across a day lands on a handful of cells. Along one day the stroke
      // fills everything between the last cell and this one.
      const from = last && last.day === day ? last.slot : slot;
      for (let s = Math.min(from, slot); s <= Math.max(from, slot); s++) paintSlot(row, day, s);
      last = { day, slot };
    };
    grid.addEventListener("pointerdown", (event) => {
      if (event.target.dataset.slot === undefined || event.button !== 0) return;
      event.preventDefault();
      painting = true;
      last = null;
      grid.setPointerCapture(event.pointerId);
      paintAt(event.clientX, event.clientY);
    });
    grid.addEventListener("pointermove", (event) => {
      if (painting) paintAt(event.clientX, event.clientY);
    });
    const finish = () => {
      if (!painting) return;
      painting = false;
      this._scheduleCommit();
    };
    grid.addEventListener("pointerup", finish);
    grid.addEventListener("pointercancel", finish);
    grid.addEventListener("lostpointercapture", finish);

    const repaintAll = (fill) => {
      for (let day = 0; day < Schedule.DAYS; day++) {
        state.slots[day] = fill(day);
        state.painted.add(day);
      }
      this._scheduleCommit();
      this._render();
    };
    root.querySelectorAll("[data-copyday]").forEach((button) =>
      button.addEventListener("click", () => {
        const source = state.slots[Number(button.dataset.copyday)];
        repaintAll(() => [...source]);
      })
    );
    const fill = root.getElementById("schedfill");
    if (fill)
      fill.addEventListener("click", () =>
        repaintAll(() => new Array(Schedule.SLOTS).fill(this._schedBrush))
      );
    const clear = root.getElementById("schedclear");
    if (clear)
      clear.addEventListener("click", () => repaintAll(() => new Array(Schedule.SLOTS).fill(0)));
  }

  /**
   * The cameras a per-camera page's values will also be written to.
   *
   * Setting up sixteen cameras one by one is the chore this saves: whatever the
   * open camera has — edited or not — goes to the ones ticked here, on Save.
   */
  _settingsCopyPanel() {
    if (!this._settingsCopyOpen) return "";
    const channels = ((this._detail && this._detail.channels) || []).filter(
      (c) => c.index !== this._settingsChannel
    );
    const ticked = this._settingsCopyTo;
    const boxes = channels
      .map(
        (c) => `
          <label class="cfg-copy-item">
            <input type="checkbox" data-copyto="${c.index}" ${ticked.has(c.index) ? "checked" : ""}>
            ${c.index + 1}. ${escapeHtml(c.name || "")}
          </label>`
      )
      .join("");
    return `
      <div class="cfg-copy">
        <div class="cfg-copy-head">
          <span>${t("Also write this camera's settings to:")}</span>
          <button class="ghost" id="copyall">${t("All")}</button>
          <button class="ghost" id="copynone">${t("None")}</button>
        </div>
        <div class="cfg-copy-list">${boxes || `<span class="hint">${t("No other cameras")}</span>`}</div>
      </div>`;
  }

  _bindCopyPanel() {
    const root = this.shadowRoot;
    const toggle = root.getElementById("copytoggle");
    if (toggle)
      toggle.addEventListener("click", () => {
        this._settingsCopyOpen = !this._settingsCopyOpen;
        this._render();
      });
    const sync = () => {
      root.querySelectorAll("[data-copyto]").forEach((box) => {
        box.checked = this._settingsCopyTo.has(Number(box.dataset.copyto));
      });
      const label = root.getElementById("copytoggle");
      if (label) label.textContent = this._copyToggleLabel();
      this._refreshSettingsToolbar();
    };
    root.querySelectorAll("[data-copyto]").forEach((box) =>
      box.addEventListener("change", () => {
        const index = Number(box.dataset.copyto);
        if (box.checked) this._settingsCopyTo.add(index);
        else this._settingsCopyTo.delete(index);
        sync();
      })
    );
    const all = root.getElementById("copyall");
    if (all)
      all.addEventListener("click", () => {
        root.querySelectorAll("[data-copyto]").forEach((box) =>
          this._settingsCopyTo.add(Number(box.dataset.copyto))
        );
        sync();
      });
    const none = root.getElementById("copynone");
    if (none)
      none.addEventListener("click", () => {
        this._settingsCopyTo.clear();
        sync();
      });
  }

  _copyToggleLabel() {
    const count = this._settingsCopyTo.size;
    return count ? t("Copy to {count} cameras", { count }) : t("Copy to other cameras…");
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
      <div class="cfg-channel">
        <label for="setchannel">${t("Camera")}</label>
        <select id="setchannel">${options}</select>
        <button class="ghost ${this._settingsCopyTo.size ? "active" : ""}" id="copytoggle"
                aria-expanded="${this._settingsCopyOpen ? "true" : "false"}">${this._copyToggleLabel()}</button>
      </div>
      ${this._settingsCopyPanel()}`;
  }

  /** Leave the page's edits behind, after asking if there are any. */
  _settingsMayLeave() {
    const dirty = Object.keys(this._settingsEdits).length + (this._settingsCopyTo.size ? 1 : 0);
    return !dirty || window.confirm(t("Discard {count} unsaved changes?", { count: dirty }));
  }

  async _loadSettings() {
    const page = this._settingsPage();
    this._settings = { section: page.section, loading: true };
    this._settingsEdits = {};
    this._settingsRejected = {};
    this._settingsNote = null;
    this._sched = null;
    this._settingsCopyTo.clear();
    this._settingsCopyOpen = false;
    this._render();
    try {
      const reply = await this._ws({
        type: "xmeye/config",
        entry_id: this._entryId,
        section: page.section,
      });
      this._settings = { section: page.section, value: reply.value };
    } catch (err) {
      this._settings = { section: page.section, error: err.message || String(err) };
    }
    this._render();
  }

  async _saveSettings() {
    const page = this._settingsPage();
    if (!this._settings || !this._settings.value) return;
    this._settingsSaving = true;
    this._refreshSettingsToolbar();

    // Send the section whole, with the edits merged in: the firmware replaces
    // whatever it is given and defaults the fields left out.
    const edits = { ...this._settingsEdits };
    let merged;
    if (page.perChannel && Array.isArray(this._settings.value)) {
      // Every channel is sent back, with only the edited one changed: the
      // firmware replaces the section whole and would default the rest.
      merged = this._settings.value.map((entry, index) =>
        index === this._settingsChannel ? { ...entry } : entry
      );
      for (const [path, value] of Object.entries(edits)) {
        this._settingWrite(merged[this._settingsChannel], path, value);
      }
      // The cameras ticked for copying get every value of the page as the open
      // camera has it now — not only the edits, or a camera copied to would
      // keep whatever of its own the open one had not changed.
      const source = merged[this._settingsChannel];
      const keys = [...this._settingFields().map((f) => f.key), ...(page.extraKeys || [])];
      for (const index of this._settingsCopyTo) {
        if (!merged[index]) continue;
        merged[index] = { ...merged[index] };
        for (const key of keys) {
          const v = this._settingRead(source, key);
          if (v !== undefined) this._settingWrite(merged[index], key, JSON.parse(JSON.stringify(v)));
        }
      }
    } else {
      merged = { ...this._settings.value };
      for (const [path, value] of Object.entries(edits)) {
        this._settingWrite(merged, path, value);
      }
    }
    try {
      const reply = await this._ws({
        type: "xmeye/config_set",
        entry_id: this._entryId,
        section: page.section,
        value: merged,
      });
      const copied = this._settingsCopyTo.size;
      this._settingsEdits = {};
      this._settingsRejected = {};
      this._sched = null;
      this._settingsCopyTo.clear();
      this._settingsCopyOpen = false;
      if (reply.restart) {
        // Taken, for after a restart: until then the recorder reads back the
        // old value, so what was written is what the form keeps showing.
        this._settings = { section: page.section, value: merged };
        this._settingsNote = t("Saved. It takes effect after the recorder restarts.");
      } else {
        // Show what the recorder stored, not what was asked for: it clamps or
        // ignores a value it dislikes without saying so. Every edit is checked
        // against what came back, and one that did not stick says so on its row.
        this._settings = { section: page.section, value: reply.value };
        const stored = this._settingsValue(page);
        for (const [path, value] of Object.entries(edits)) {
          if (String(this._settingRead(stored, path)) !== String(value)) {
            this._settingsRejected[path] = true;
          }
        }
        const kept = Object.keys(this._settingsRejected).length;
        this._settingsNote = kept
          ? t("Saved, but the recorder kept its own value for {count}", { count: kept })
          : copied
            ? t("Saved, and copied to {count} cameras", { count: copied })
            : t("Saved");
      }
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
              ${
                this._player === "native"
                  ? `<span class="live-audio ${this._liveSound ? "on" : ""}" id="liveaudio">
                       <button class="ghost icon ${this._liveSound ? "active" : ""}" id="livesound"
                         title="${this._liveSound ? t("Sound off") : t("Sound")}"
                         aria-label="${t("Sound")}">${soundIcon(this._liveSound)}</button>
                       <span class="live-volume">
                         <input type="range" id="livevolume" min="0" max="100" step="1"
                           value="${this._volume(channel.index)}" aria-label="${t("Volume")}"
                           title="${t("Volume")}: ${volumeLabel(this._volume(channel.index))}">
                       </span>
                     </span>`
                  : ""
              }
              <button class="ghost icon" id="diag" title="${t("Player diagnostics")}"
                      aria-label="${t("Player diagnostics")}">${infoIcon()}</button>
              <button class="close icon" id="closelive" title="${t("Close")}"
                      aria-label="${t("Close")}">${closeIcon()}</button>
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

    const stepDay = (days) => {
      const at = new Date(`${this._recordingsDay}T00:00:00`);
      at.setDate(at.getDate() + days);
      this._recordingsDay = toLocalIso(at).slice(0, 10);
      this._loadRecordings();
    };
    const previousDay = root.getElementById("prevday");
    if (previousDay) previousDay.addEventListener("click", () => stepDay(-1));
    const nextDay = root.getElementById("nextday");
    if (nextDay) nextDay.addEventListener("click", () => stepDay(1));

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
    this._bindPtz(root);

    this._bindTimeline(root);

    const playPause = root.getElementById("playpause");
    if (playPause)
      playPause.addEventListener("click", () => {
        if (!this._archivePlayer) return;
        if (this._archivePlayer.paused) {
          this._archivePlayer.resume();
          this._playback.paused = false;
          playPause.innerHTML = pauseIcon();
          playPause.title = t("Pause");
        } else {
          this._archivePlayer.pause();
          this._playback.paused = true;
          playPause.innerHTML = playIcon();
          playPause.title = t("Play");
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

    const back = root.getElementById("prevevent");
    if (back) back.addEventListener("click", () => this._jumpEvent(false));
    const forward = root.getElementById("nextevent");
    if (forward) forward.addEventListener("click", () => this._jumpEvent(true));

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

    const openPage = (id) => {
      if (id === this._settingsGroup || !this._settingsMayLeave()) {
        this._render();
        return;
      }
      this._settingsGroup = id;
      this._loadSettings();
    };
    root.querySelectorAll("[data-page]").forEach((button) =>
      button.addEventListener("click", () => openPage(button.dataset.page))
    );
    const pagePicker = root.getElementById("cfgpage");
    if (pagePicker) pagePicker.addEventListener("change", () => openPage(pagePicker.value));

    root.querySelectorAll("[data-setting]").forEach((input) => {
      const field = this._settingFields().find((f) => f.key === input.dataset.setting);
      if (!field) return;
      // A slider says where it is while it is dragged, not only once let go.
      if (input.type === "range") {
        input.addEventListener("input", () => {
          const output = input.parentElement.querySelector("output");
          if (!output) return;
          output.textContent =
            field.type === "level"
              ? t(field.labels[Number(input.value) - field.min])
              : this._settingRangeText(field, Number(input.value));
        });
      }
      input.addEventListener("change", () => {
        let value;
        if (input.type === "checkbox") {
          value = field.type === "toggle" ? input.checked : input.checked ? 1 : 0;
        } else if (input.type === "number") {
          // Clamped here: the firmware clamps silently, and the form should not
          // promise a value the recorder will not keep.
          const n = Math.round(Number(input.value) || 0);
          value = Math.min(field.max ?? Infinity, Math.max(field.min ?? -Infinity, n));
          input.value = value;
        } else if (input.type === "range" || field.numeric) {
          // The device stores these as numbers; a control hands back a string,
          // and the firmware ignores a field of the wrong type.
          value = Number(input.value);
        } else {
          value = input.value;
        }
        const stored = this._settingRead(this._settingsValue(this._settingsPage()), field.key);
        // Back to what the recorder holds is no change at all.
        if (String(stored) === String(value)) delete this._settingsEdits[field.key];
        else this._settingsEdits[field.key] = value;
        delete this._settingsRejected[field.key];
        // The schedule is greyed out or brought back by the record mode, which
        // takes a redraw; the painted slots live outside the page and survive it.
        if (field.key === "RecordMode") {
          this._render();
          return;
        }
        // Only the bar and the dependent rows change, so the form is left alone
        // and the field being edited keeps focus.
        this._refreshSettingsToolbar();
      });
    });

    const setChannel = root.getElementById("setchannel");
    if (setChannel)
      setChannel.addEventListener("change", () => {
        // Edits belong to the channel they were made on; carrying them over
        // would silently write one camera's values onto another.
        if (!this._settingsMayLeave()) {
          setChannel.value = String(this._settingsChannel);
          return;
        }
        this._settingsChannel = Number(setChannel.value);
        this._settingsEdits = {};
        this._settingsRejected = {};
        this._settingsNote = null;
        this._sched = null;
        this._settingsCopyTo.clear();
        this._render();
      });

    this._bindSettingsBar();
    this._bindSchedule();
    this._bindCopyPanel();

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

    const liveVolume = root.getElementById("livevolume");
    if (liveVolume)
      liveVolume.addEventListener("input", () => {
        this._setVolume(this._live, liveVolume.value);
        liveVolume.title = `${t("Volume")}: ${volumeLabel(liveVolume.value)}`;
      });

    const sound = root.getElementById("livesound");
    if (sound)
      sound.addEventListener("click", () => {
        const context = this._liveSound ? null : this._audioContext();
        if (!this._liveSound && !context) return;
        this._liveSound = !this._liveSound;
        // The view stays on its stream; see _toggleWallSound.
        const talking = this._native && this._native.stats.sound;
        this._noteDiag(
          "sound",
          `single view ${this._liveSound ? "on" : "off"}, ${this._liveStream} stream ` +
            `${talking ? `carries ${talking}` : "has brought no sound"}` +
            (context ? `; audio context ${context.state}` : "")
        );
        if (this._native) {
          this._native.setSound(this._liveSound ? context : null, this._gain(this._live));
        }
        const audio = root.getElementById("liveaudio");
        if (audio) audio.classList.toggle("on", this._liveSound);
        sound.classList.toggle("active", this._liveSound);
        sound.innerHTML = soundIcon(this._liveSound);
        sound.title = this._liveSound ? t("Sound off") : t("Sound");
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
  /* The bar every system screen has. Home Assistant's own variables, so it
     follows the theme the way the Energy and History screens do, and sticky so
     the menu stays in reach down a long archive list. */
  .appbar { display:flex; align-items:center; gap:2px; position:sticky; top:0; z-index:5;
    height: var(--header-height, 56px); box-sizing:border-box; padding:0 12px 0 4px;
    background: var(--app-header-background-color, var(--primary-background-color));
    color: var(--app-header-text-color, var(--primary-text-color));
    border-bottom: var(--app-header-border-bottom, 1px solid var(--divider-color));
    font-family: var(--paper-font-body1_-_font-family, Roboto, sans-serif); }
  /* Empty, and so taking no room, whenever Home Assistant decides the sidebar
     is already on screen; the title then lines up with the content below. */
  .menu-slot { display:flex; align-items:center; }
  .menu-slot:empty { width:12px; }
  .appbar .title { font-size:20px; font-weight:400; margin:0 4px 0 8px; white-space:nowrap;
    overflow:hidden; text-overflow:ellipsis; min-width:0; }
  .appbar-end { margin-left:auto; display:flex; align-items:center; }
  /* Borderless and round, like Home Assistant's own icon buttons in the same
     bar — a framed button there reads as a form control. */
  .appbar button.icon { color: inherit; opacity:.7; border:0; background:none;
    border-radius:50%; padding:9px; }
  .appbar button.icon:hover, .appbar button.icon:focus-visible { opacity:1;
    background: color-mix(in srgb, currentColor 10%, transparent); }

  /* The address and firmware, behind the "i". Shown on hover and on focus —
     focus because a phone has no hover, and a tap focuses the button. */
  .info { position:relative; display:inline-flex; }
  .info .tip { display:none; position:absolute; top:calc(100% + 6px); left:-4px; z-index:6;
    padding:8px 11px; border-radius:8px; font-size:13px; line-height:1.5;
    max-width: calc(100vw - 32px); white-space:nowrap;
    background: var(--card-background-color); color: var(--primary-text-color);
    border:1px solid var(--divider-color); box-shadow:0 4px 14px rgba(0,0,0,.25); }
  .info:hover .tip, .info:focus-within .tip { display:block; }
  .tip-row { display:block; overflow:hidden; text-overflow:ellipsis; }
  /* On a phone the "i" sits a third of the way across and the firmware string
     is longer than what is left, so the tip hung off the right-hand edge with
     the end of the version cut away — the part that differs between builds.
     There it spans the bar instead, and the version wraps rather than vanishes. */
  .tip-facts { display:none; }
  @media (max-width: 600px) {
    .info { position:static; }
    .info .tip { left:12px; right:12px; top:calc(100% - 2px); max-width:none;
      white-space:normal; }
    .tip-row { overflow:visible; overflow-wrap:anywhere; }
    /* The figures move into the "i" — see _shell. */
    .page > header { display:none; }
    .tip-facts { display:block; margin-top:8px; padding-top:10px;
      border-top:1px solid var(--divider-color); }
    .tip-facts .facts { gap:10px 22px; }
    .tip-facts .fact-value { font-size:15px; }
  }
  .tip-row.mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size:12px;
    color: var(--secondary-text-color); }

  header { display:flex; align-items:center; gap:24px; flex-wrap:wrap;
           padding: 4px 0 14px; }
  /* The recorder's figures, on their own row now that the title has moved up
     into the bar. */
  .facts { display:flex; gap:28px; flex-wrap:wrap; }
  .fact-label { font-size:11px; text-transform:uppercase; letter-spacing:.5px;
    color: var(--secondary-text-color); }
  .fact-value { font-size:17px; margin-top:2px; }
  .fact-hint { font-size:12px; color: var(--secondary-text-color); }
  h1 { margin:0; font-size:26px; font-weight:400; }
  h2 { margin: 28px 0 12px; font-size:18px; font-weight:500; }
  .sub { color: var(--secondary-text-color); font-size:14px; margin-top:4px; }
  /* Scrolls sideways when the tabs outrun the width, as Home Assistant's own
     do, without drawing a scrollbar track under them on every narrow screen. */
  nav { display:flex; gap:4px; border-bottom:1px solid var(--divider-color); margin-bottom:20px;
        overflow-x:auto; scrollbar-width:none; }
  nav::-webkit-scrollbar { display:none; }
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
  /* Recorder settings: sections down the side, the page beside them, its
     fields in cards of labelled rows — the words on the left, the control on
     the right, as Home Assistant's own settings are laid out. */
  .cfg { display:grid; grid-template-columns: 220px minmax(0, 1fr); gap:20px; align-items:start; }
  /* Held below the panel's own top bar, which is sticky too; at top:16px the
     first links slid under it as the page scrolled. */
  .cfg-nav { position:sticky; top:calc(var(--header-height, 56px) + 16px);
    display:flex; flex-direction:column; gap:14px; }
  .cfg-group { display:flex; flex-direction:column; gap:2px; }
  .cfg-group-title { font-size:11px; font-weight:600; letter-spacing:.06em;
    text-transform:uppercase; color: var(--secondary-text-color); padding:0 10px 4px; }
  .cfg-link { text-align:left; background:none; border:0; border-radius:8px; padding:8px 10px;
    font:inherit; font-size:14px; color: var(--primary-text-color); cursor:pointer; }
  .cfg-link:hover { background: var(--secondary-background-color); }
  .cfg-link.active { background: color-mix(in srgb, var(--primary-color) 16%, transparent);
    color: var(--primary-color); font-weight:500; }
  .cfg-picker { display:none; }
  .cfg-page { min-width:0; max-width:760px; }
  .cfg-head h2 { margin:0 0 4px; font-size:22px; font-weight:400; }
  .cfg-head p { margin:0 0 16px; color: var(--secondary-text-color); font-size:14px; line-height:1.45; }
  .cfg-channel { display:flex; align-items:center; gap:10px; margin:0 0 14px; }
  .cfg-channel label { font-size:14px; color: var(--secondary-text-color); }
  .cfg-cards { display:flex; flex-direction:column; gap:16px; }
  .cfg-card { background: var(--card-background-color); border-radius:12px; overflow:hidden;
    box-shadow: var(--ha-card-box-shadow, 0 2px 4px rgba(0,0,0,.08));
    border:1px solid var(--divider-color); }
  .cfg-card h3 { margin:0; padding:14px 16px 6px; font-size:15px; font-weight:500; }
  .cfg-row { display:flex; align-items:center; justify-content:space-between; gap:16px;
    min-height:52px; padding:8px 16px; border-top:1px solid var(--divider-color);
    position:relative; }
  .cfg-card h3 + .cfg-row { border-top:0; }
  .cfg-row label { display:flex; flex-direction:column; gap:2px; min-width:0; font-size:14px;
    cursor:pointer; }
  .cfg-row small { font-size:12px; color: var(--secondary-text-color); }
  .cfg-row .cfg-rejected { color: var(--error-color, #f44336); }
  /* An edit not yet saved is marked down the row's edge, so a long page shows at
     a glance what Save is about to send. */
  .cfg-row.changed::before { content:""; position:absolute; left:0; top:8px; bottom:8px;
    width:3px; border-radius:0 3px 3px 0; background: var(--primary-color); }
  .cfg-row.rejected::before { content:""; position:absolute; left:0; top:8px; bottom:8px;
    width:3px; border-radius:0 3px 3px 0; background: var(--error-color, #f44336); }
  .cfg-row.off label { opacity:.5; }
  .cfg-control { flex:none; display:flex; align-items:center; justify-content:flex-end;
    max-width:60%; }
  .cfg-control select, .cfg-control input[type=text], .cfg-control input[type=number] {
    font:inherit; font-size:14px; padding:7px 10px; border-radius:8px;
    border:1px solid var(--divider-color); background: var(--secondary-background-color);
    color: var(--primary-text-color); min-width:0; }
  .cfg-control select { max-width:100%; cursor:pointer; }
  .cfg-control input[type=text] { width:240px; max-width:100%; }
  .cfg-control :disabled { opacity:.5; cursor:not-allowed; }
  .cfg-number { display:inline-flex; align-items:center; gap:8px; }
  .cfg-number input { width:90px; text-align:right; }
  .cfg-unit { font-size:13px; color: var(--secondary-text-color); min-width:2.5em; }
  .cfg-level { display:inline-flex; align-items:center; gap:12px; }
  .cfg-level input { width:180px; accent-color: var(--primary-color); cursor:pointer; }
  .cfg-level output { min-width:6.5em; font-size:13px; color: var(--secondary-text-color); }
  /* A switch rather than a checkbox: on and off, the way Home Assistant asks. */
  .switch { position:relative; display:inline-flex; width:40px; height:22px; flex:none; }
  .switch input { position:absolute; inset:0; margin:0; opacity:0; cursor:pointer; z-index:1; }
  .switch-track { position:absolute; inset:0; border-radius:11px;
    background: var(--disabled-color, #bdbdbd); transition: background .15s ease; }
  .switch-track::after { content:""; position:absolute; top:3px; left:3px; width:16px; height:16px;
    border-radius:50%; background:#fff; box-shadow:0 1px 2px rgba(0,0,0,.3);
    transition: transform .15s ease; }
  .switch input:checked + .switch-track { background: var(--primary-color); }
  .switch input:checked + .switch-track::after { transform: translateX(18px); }
  .switch input:focus-visible + .switch-track { outline:2px solid var(--primary-color); outline-offset:2px; }
  .switch input:disabled + .switch-track { opacity:.45; }
  /* The bar stays at the foot of the screen while the page scrolls, so Save is
     never a scroll away from the field just changed. */
  .cfg-bar { position:sticky; bottom:0; z-index:4; display:flex; align-items:center; gap:10px;
    margin-top:16px; padding:12px 16px; border-radius:12px;
    background: var(--card-background-color); border:1px solid var(--divider-color);
    box-shadow:0 -2px 10px rgba(0,0,0,.12); }
  .cfg-bar.dirty { border-color: var(--primary-color); }
  .cfg-status { flex:1; font-size:13px; color: var(--secondary-text-color); }
  /* The status is put together from parts, and the first may be one that
     reads mid-sentence elsewhere ("will be copied to …"). */
  .cfg-status::first-letter { text-transform:uppercase; }
  .cfg-bar button { padding:8px 16px; font-size:14px; }
  .cfg-bar button:disabled { opacity:.45; cursor:default; }
  .cfg-channel button.active { border-color: var(--primary-color); color: var(--primary-color); }
  .cfg-copy { margin:-4px 0 14px; padding:12px 14px; border-radius:12px;
    background: var(--card-background-color); border:1px solid var(--divider-color); }
  .cfg-copy-head { display:flex; align-items:center; gap:8px; font-size:14px; margin-bottom:8px; }
  .cfg-copy-head span { flex:1; }
  .cfg-copy-list { display:grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
    gap:4px 12px; max-height:220px; overflow:auto; }
  .cfg-copy-item { display:flex; align-items:center; gap:6px; font-size:13px; cursor:pointer; }

  /* The record schedule: one row a day, 48 half hours across, coloured by what
     is recorded. The colours are the archive timeline's, so a week here reads
     the same as a day there. */
  .sched { padding:4px 16px 16px; }
  .sched.off .sched-grid { opacity:.45; pointer-events:none; }
  .sched-brushes { display:flex; flex-wrap:wrap; gap:6px; margin:4px 0 12px; }
  .sched-brush { display:inline-flex; align-items:center; gap:6px; font:inherit; font-size:13px;
    padding:5px 10px; border-radius:16px; border:1px solid var(--divider-color);
    background:none; color: var(--primary-text-color); cursor:pointer; }
  .sched-brush i { width:12px; height:12px; border-radius:3px; display:inline-block; }
  .sched-brush.active { border-color: var(--primary-color);
    background: color-mix(in srgb, var(--primary-color) 14%, transparent); }
  .sched-brush:disabled { opacity:.5; cursor:not-allowed; }
  .sched-grid { display:flex; flex-direction:column; gap:3px; touch-action:none; user-select:none;
    -webkit-user-select:none; }
  .sched-row, .sched-hours { display:grid; grid-template-columns: 38px minmax(0,1fr) 30px;
    align-items:center; gap:8px; }
  .sched-hours > div { position:relative; height:14px; }
  /* Only the hour marks are placed by hand; the empty cells either side keep
     the row on the same columns as the days under it. */
  .sched-hours > div > span { position:absolute; transform:translateX(-50%); font-size:10px;
    color: var(--secondary-text-color); font-variant-numeric: tabular-nums; }
  .sched-hours > div > span:first-child { transform:none; }
  .sched-hours > div > span:last-child { transform:translateX(-100%); }
  .sched-day { font-size:12px; color: var(--secondary-text-color); text-transform:capitalize; }
  .sched-cells { display:grid; grid-template-columns: repeat(48, minmax(0,1fr)); height:24px;
    border-radius:5px; overflow:hidden; background: var(--secondary-background-color);
    cursor:crosshair; }
  .sched-cells i { display:block; border-right:1px solid color-mix(in srgb, var(--card-background-color) 55%, transparent); }
  .sched-cells i:nth-child(2n) { border-right-color: color-mix(in srgb, var(--card-background-color) 25%, transparent); }
  .sched-cells i:last-child { border-right:0; }
  .sched-row.too-many .sched-cells { outline:2px solid var(--error-color, #f44336); outline-offset:1px; }
  .sched-copy { padding:4px; display:flex; align-items:center; justify-content:center; }
  .k-none { background:transparent; }
  .k-always { background: var(--info-color, #2196f3); }
  .k-motion { background: var(--warning-color, #ff9800); }
  .k-alarm { background: var(--error-color, #f44336); }
  .k-event { background: repeating-linear-gradient(135deg, var(--warning-color, #ff9800) 0 4px,
    var(--error-color, #f44336) 4px 8px); }
  .sched-brush i.k-none { border:1px dashed var(--secondary-text-color); }
  .sched-actions { display:flex; gap:8px; flex-wrap:wrap; margin-top:12px; }
  .sched-note { margin:8px 0 0; font-size:12px; }
  @media (max-width: 870px) {
    .cfg { grid-template-columns: 1fr; gap:12px; }
    .cfg-nav { display:none; }
    .cfg-picker { display:block; width:100%; margin-bottom:14px; font:inherit; font-size:15px;
      padding:10px 12px; border-radius:10px; border:1px solid var(--divider-color);
      background: var(--card-background-color); color: var(--primary-text-color); }
  }
  @media (max-width: 600px) {
    .cfg-row { flex-wrap:wrap; }
    /* Wrapped under its words, a control still keeps to the right edge, where
       the controls of the rows that did not wrap are. */
    .cfg-control { max-width:100%; margin-left:auto; }
    .cfg-level input { width:140px; }
  }
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
    /* Stretched, not packed to the start: a column packed to the start sizes
       the wall to its content, which is the full width of every canvas, and on
       a phone the right-hand tiles ran off the screen. */
    .wall-layout { flex-direction:column; align-items:stretch; }
    .wall-layout .wall { flex:none; }
    .picker { width:100%; }
    .pick-list { max-height:none; }
  }
  .layouts { display:flex; gap:4px; align-items:center; }
  /* The list toggle shares the layout buttons' box and active colour, and sits
     apart from them, because it changes what is beside the wall, not the wall. */
  button.picker-toggle { display:flex; align-items:center; line-height:1; }
  .picker-toggle svg { display:block; }
  .picker-toggle.active { background: var(--primary-color);
    color: var(--text-primary-color,#fff); border-color: var(--primary-color); }
  .bar-gap { width:1px; align-self:stretch; margin:3px 6px;
    background: var(--divider-color); }
  /* Hidden, not removed — see _togglePicker. */
  .wall-layout.picker-hidden .picker { display:none; }
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

  /* Pan, tilt and zoom over a tile. The keys scale with the tile — a quarter of
     a 4K wall and one of sixteen are very different sizes — between what a
     finger can hit and what still leaves the picture visible. */
  /* The layer is the container rather than the tile: a tile sized as a
     container loses its own size, and where the wall stacks under the channel
     list it took the whole wall down to nothing. The layer already spans the
     tile, so its size is the tile's. */
  .ptz { position:absolute; inset:0; pointer-events:none; container-type: size; }
  .ptz > * { --k: clamp(24px, 12cqmin, 40px); }
  .ptz button { pointer-events:auto; color:#fff; background: rgba(0,0,0,.45);
    border:1px solid rgba(255,255,255,.22); border-radius:8px; padding:0;
    display:flex; align-items:center; justify-content:center; cursor:pointer;
    backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px);
    touch-action:none; user-select:none; -webkit-user-select:none; }
  .ptz button:hover { background: rgba(0,0,0,.65); border-color: rgba(255,255,255,.5); }
  .ptz button svg { display:block; width:calc(var(--k) * .5); height:calc(var(--k) * .5); }
  .ptz-toggle { position:absolute; right:8px; bottom:28px; width:var(--k); height:var(--k);
    opacity:0; transition: opacity .15s ease; }
  .ptz.on .ptz-toggle { background: var(--primary-color); border-color: var(--primary-color); }
  /* Sound sits above the PTZ switch, the same size; shown on hover like it, and
     always while it is on, so a tile that is talking says which one it is. */
  /* The speaker and, above it, its volume — one block, so the pointer can go
     from the button up to the slider without leaving the thing it hovers. */
  .tile-audio { position:absolute; right:8px; bottom:calc(28px + var(--k) + 6px);
    display:flex; flex-direction:column; align-items:center; gap:4px;
    pointer-events:auto; }
  .tile-sound { width:var(--k); height:var(--k); opacity:0; transition: opacity .15s ease; }
  /* The volume stands above the speaker, upright, and only while the pointer
     is on one of them and the tile is being heard: a slider always on screen
     would cover the picture. Focus brings it up only from the keyboard, and on
     a touch screen — see below: a click leaves the button focused, and the
     slider then stayed up after the pointer had gone. */
  .tile-volume { display:none; pointer-events:auto; padding:6px 0; border-radius:8px;
    background: rgba(0,0,0,.45); border:1px solid rgba(255,255,255,.22);
    width:var(--k); justify-content:center;
    backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px); }
  .tile-volume input { writing-mode: vertical-lr; direction: rtl; margin:0;
    height:clamp(56px, 38cqh, 120px); width:calc(var(--k) * .6);
    accent-color: var(--primary-color); cursor:pointer; }
  .tile-audio.on:hover .tile-volume, .tile-audio.on:has(:focus-visible) .tile-volume { display:flex; }
  /* The single view's volume drops below its button — the header has nothing
     above it — upright like the tile's, and only while the pointer is on the
     button or the slider. The padding at its top is the bridge the pointer
     crosses, so moving down from the button does not lose the hover. */
  .live-audio { position:relative; display:inline-flex; }
  .live-volume { display:none; position:absolute; top:100%; left:50%;
    transform:translateX(-50%); padding-top:4px; z-index:5; }
  .live-volume input { writing-mode: vertical-lr; direction: rtl; height:120px; width:22px;
    margin:0; padding:8px 4px; box-sizing:content-box; border-radius:8px;
    background: var(--card-background-color); border:1px solid var(--divider-color);
    box-shadow:0 4px 14px rgba(0,0,0,.25); accent-color: var(--primary-color); cursor:pointer; }
  .live-audio.on:hover .live-volume, .live-audio.on:has(:focus-visible) .live-volume { display:block; }
  .tile-sound.on { opacity:1; background: var(--primary-color); border-color: var(--primary-color); }
  .tile-sound.on.silent { background: rgba(0,0,0,.45); border-color: var(--warning-color, #ff9800);
    color: var(--warning-color, #ff9800); }
  .ptz-pad { position:absolute; left:8px; bottom:28px; display:none; gap:6px;
    align-items:flex-end; }
  .ptz-dirs { display:grid; grid-template-columns: repeat(3, var(--k)); gap:3px; }
  .ptz-zoom { display:flex; flex-direction:column; gap:3px; }
  .ptz-key { width:var(--k); height:var(--k); }
  .ptz-key.held { background: var(--primary-color); border-color: var(--primary-color); }
  .ptz-centre { border-radius:50%; }
  .ptz-presets { position:absolute; left:calc(8px + var(--k) * 4 + 15px); bottom:28px;
    display:flex; flex-direction:column; gap:4px; padding:4px; border-radius:10px;
    background: rgba(0,0,0,.35); pointer-events:auto; }
  .ptz-presets[hidden] { display:none; }
  .ptz-nums { display:grid; grid-template-columns: repeat(4, var(--k)); gap:3px; }
  .ptz-num { height:var(--k); font-size:calc(var(--k) * .38); font-variant-numeric: tabular-nums; }
  .ptz-save { height:calc(var(--k) * .8); font-size:calc(var(--k) * .32); }
  .ptz-save.active { background: var(--warning-color, #ff9800); border-color: transparent; }
  .ptz .done { background: var(--success-color, #43a047); }
  .ptz.failed .ptz-pad button { border-color: var(--error-color, #f44336); }
  /* Shown while the pointer is on the tile, or a key in it has focus. */
  .cell:hover .ptz-toggle, .ptz:focus-within .ptz-toggle,
  .cell:hover .tile-sound, .ptz:focus-within .tile-sound { opacity:1; }
  .cell:hover .ptz.on .ptz-pad, .ptz.on:focus-within .ptz-pad { display:flex; }
  /* A touch screen has no hover: the switch stays in sight, and a tile switched
     on keeps its pad. */
  @media (hover: none) {
    .ptz-toggle, .tile-sound { opacity:.8; }
    /* No hover to show the volume by: a tap on the speaker focuses it, and the
       slider stays until a tap elsewhere takes the focus away. */
    .tile-audio.on:focus-within .tile-volume { display:flex; }
    .live-audio.on:focus-within .live-volume { display:block; }
    .ptz.on .ptz-pad { display:flex; }
  }

  /* Archive player */
  .player { background:#000; border-radius:12px; overflow:hidden; margin-bottom:16px;
    box-shadow: var(--ha-card-box-shadow, 0 2px 4px rgba(0,0,0,.08)); }
  .player-head { display:flex; justify-content:space-between; align-items:center;
    padding:10px 14px; background: var(--card-background-color); font-size:14px; }
  .player-screen { background:#000; display:flex; align-items:center;
    justify-content:center; max-height:60vh; }
  .player-screen canvas { max-width:100%; max-height:60vh; display:block; }
  .player-bar { display:flex; align-items:center; gap:6px; padding:10px 14px;
    background: var(--card-background-color); flex-wrap:wrap; }
  /* The picture no longer blanks when a stream fails, so the failure has to say
     so itself — otherwise a dead seek looks like a very still camera. */
  .player-error { padding:8px 14px; font-size:13px; color: var(--error-color,#f44336);
    background: var(--card-background-color); border-top:1px solid var(--divider-color); }
  /* Every mark in the bar is a 16px box, so the buttons are square and equal
     however wide the glyph inside happens to be. */
  button.icon { display:flex; align-items:center; justify-content:center;
    line-height:1; padding:7px; }
  button.icon svg { display:block; }
  /* The speeds are one control, not four buttons: joined, with only the seams
     between them, so the row reads left to right as a scale. */
  .rates { display:flex; margin-left:8px; border-radius:8px; overflow:hidden;
    border:1px solid var(--divider-color); }
  .rates .rate { border:0; border-radius:0; padding:7px 11px; font-size:13px;
    font-variant-numeric: tabular-nums; }
  .rates .rate + .rate { border-left:1px solid var(--divider-color); }
  .rate.active { background: var(--primary-color); color: var(--text-primary-color,#fff); }
  .player-time { margin-left:auto; font-family: ui-monospace, Menlo, monospace;
    font-size:13px; color: var(--secondary-text-color);
    font-variant-numeric: tabular-nums; }

  /* Timeline cursor */
  .cursor { position:absolute; top:-3px; bottom:-3px; width:2px; z-index:3;
    background: var(--primary-text-color); box-shadow:0 0 0 1px rgba(0,0,0,.4);
    pointer-events:none; }
  .cursor::before { content:""; position:absolute; top:-4px; left:-4px;
    border:5px solid transparent; border-top-color: var(--primary-text-color); }
  .tile { padding:0; overflow:hidden; cursor:pointer; transition: transform .12s ease; }
  .tile:hover { transform: translateY(-2px); }
  .tile.offline { opacity:.55; }
  .thumb { position:relative; aspect-ratio:16/9; background:#000; }
  .thumb img { width:100%; height:100%; object-fit:cover; display:block; }
  .noimage { display:flex; align-items:center; justify-content:center; height:100%;
             color:#888; font-size:14px; }
  .badges { position:absolute; top:8px; left:8px; display:flex; gap:6px; }
  /* That placement is for the channel cards, where the badges sit alone on the
     picture. A wall tile has its name in the same corner, and the badge was
     drawn straight over it — "recording" covering the camera it was about. In
     a tile the badges take their place in the overlay's row instead, at the
     far end from the name. */
  .cell .badges { position:static; flex:none; }
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

  /* The day and its two arrows are one control: a single frame with seams,
     rather than three loose boxes of three different heights. */
  .daypick { display:flex; align-items:stretch; border-radius:8px; overflow:hidden;
    border:1px solid var(--divider-color); background: var(--card-background-color); }
  .daypick input[type=date] { border:0; border-radius:0; background:transparent;
    padding:8px 6px; font-variant-numeric: tabular-nums; }
  .daypick .step { border:0; border-radius:0; padding:0 9px;
    color: var(--secondary-text-color); }
  .daypick .step:hover { color: var(--primary-text-color);
    background: var(--secondary-background-color); }
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

  .timeline { position:relative; }
  /* The bar takes the wheel, so the page must not also scroll under it. */
  .track { position:relative; height:52px; background: var(--secondary-background-color);
    border-radius:8px; overflow:hidden; touch-action:none; cursor:crosshair;
    user-select:none; }
  .track:active { cursor:grabbing; }
  .blocks { position:absolute; inset:0; }
  .block { position:absolute; top:0; height:100%; min-width:1px; }
  .ruler { position:relative; height:18px; margin-top:5px; }
  .ruler span { position:absolute; font-size:11px;
    color: var(--secondary-text-color); white-space:nowrap;
    font-variant-numeric: tabular-nums; }
  .timeline-foot { display:flex; align-items:center; gap:12px; margin-top:8px;
    flex-wrap:wrap; }
  .timeline-foot .hint { margin:0; }
  .zoom { margin-left:auto; display:flex; align-items:center; gap:6px; }
  .zoom-span { font-size:12px; color: var(--secondary-text-color);
    font-variant-numeric: tabular-nums; }
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
  .close.icon { display:flex; align-items:center; justify-content:center; padding:7px; }
  .overlay-controls button.icon { display:flex; align-items:center; justify-content:center;
    padding:5px 7px; }
  .overlay-controls button.active { background: var(--primary-color);
    color: var(--text-primary-color,#fff); border-color: var(--primary-color); }

  /* A phone: the camera takes the whole screen, as a phone's own camera view
     does. The two selects and two buttons are wider than the screen, and in one
     row the close button was squeezed to a sliver — the one control a viewer
     needs most. The controls take a row of their own and the selects share it;
     close goes to the corner, beside the name. The figures under the picture
     wrap instead of scrolling sideways. */
  @media (max-width: 600px) {
    .overlay { padding:0; }
    .overlay-box { max-width:none; height:100dvh; border-radius:0; }
    .overlay-head { position:relative; padding:10px 12px; gap:8px; }
    .overlay-head > span { padding-right:40px; }
    .overlay-controls { width:100%; }
    .overlay-controls select { flex:1 1 0; min-width:0; }
    .overlay-controls { flex-wrap:wrap; }
    .overlay-head .close { position:absolute; top:4px; right:6px; }
    .osd { white-space:pre-wrap; overflow-x:visible; padding:6px 12px; }
  }

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
