/**
 * The recorder's weekly record schedule, as a grid of half hours.
 *
 * The firmware keeps a schedule as seven days (Sunday first) of six periods
 * each. A period is a string, "1 08:30:00-17:00:00" — enabled, from, to — and
 * beside it sits a mask of what to record in it: 1 continuously, 2 on motion,
 * 4 on an alarm input. The vendor's own app writes 7 for "always" and 6 for
 * "on alarm"; see FunSDK's RecordConfig demo.
 *
 * Six periods a day is awkward to edit and easy to paint, so the panel shows a
 * grid of half-hour slots and turns it back into periods on save. A day the
 * viewer did not touch is written back exactly as it was read, whatever its
 * times; only a painted day is rebuilt from its slots.
 */

//: Slots in a day: half hours. Finer would let a schedule outgrow its six
//: periods by accident; coarser would not hold a "08:30" anyone types into
//: the recorder's own menu.
export const SLOTS = 48;
export const SLOT_SECONDS = 86400 / SLOTS;

//: Periods the firmware keeps for one day.
export const PERIODS = 6;

export const DAYS = 7;

//: What to record, as the firmware's mask bits.
export const RECORD_CONTINUOUS = 1;
export const RECORD_MOTION = 2;
export const RECORD_ALARM = 4;

//: An unused period, as the firmware writes one.
const EMPTY_PERIOD = "0 00:00:00-00:00:00";
const EMPTY_MASK = "0x00000000";

/** Seconds since midnight from "HH:MM:SS"; "24:00:00" is the end of the day. */
export function parseClock(text) {
  const [h, m, s] = String(text).split(":").map(Number);
  return (h || 0) * 3600 + (m || 0) * 60 + (s || 0);
}

/** "HH:MM:SS" from seconds since midnight; the end of the day stays 24:00:00. */
export function formatClock(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

/** One period string as { on, start, end } in seconds. */
export function parsePeriod(text) {
  const match = /^\s*(\d)\s+(\d{1,2}:\d{2}:\d{2})-(\d{1,2}:\d{2}:\d{2})\s*$/.exec(String(text));
  if (!match) return { on: false, start: 0, end: 0 };
  return { on: match[1] === "1", start: parseClock(match[2]), end: parseClock(match[3]) };
}

/** A mask from the firmware's "0x00000006", or a number already. */
export function parseMask(value) {
  if (typeof value === "number") return value;
  const n = parseInt(String(value), 16);
  return Number.isFinite(n) ? n : 0;
}

/** The firmware's spelling of a mask. */
export function formatMask(mask) {
  return `0x${(mask >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
}

/**
 * One day's periods as slots, each holding the mask recorded in it.
 *
 * Periods that overlap add their kinds together, as the firmware does. A
 * period's edges round to the nearest half hour, which is why a day that does
 * not sit on half hours is only rebuilt once it has been painted.
 */
export function dayToSlots(periods, masks) {
  const slots = new Array(SLOTS).fill(0);
  for (let i = 0; i < Math.min(periods.length, PERIODS); i++) {
    const period = parsePeriod(periods[i]);
    const mask = parseMask(masks[i]);
    if (!period.on || !mask || period.end <= period.start) continue;
    const from = Math.round(period.start / SLOT_SECONDS);
    const to = Math.round(period.end / SLOT_SECONDS);
    for (let slot = from; slot < Math.min(to, SLOTS); slot++) slots[slot] |= mask;
  }
  return slots;
}

/** Whether every enabled period of a day starts and ends on a half hour. */
export function dayIsAligned(periods, masks) {
  return periods.every((text, i) => {
    const period = parsePeriod(text);
    if (!period.on || !parseMask(masks[i])) return true;
    return period.start % SLOT_SECONDS === 0 && period.end % SLOT_SECONDS === 0;
  });
}

/**
 * Slots back into the firmware's six periods and masks.
 *
 * Each run of slots with one mask becomes a period. Answers null when the day
 * needs more than six — the firmware has nowhere to put a seventh, and
 * dropping one silently would leave a camera unrecorded for part of a day.
 *
 * `unused` is how the section spells a period that is off: the record schedule
 * writes "0 00:00:00-00:00:00", a detector "0 00:00:00-24:00:00", and keeping
 * the section's own spelling leaves an unchanged period unchanged.
 */
export function slotsToDay(slots, unused = EMPTY_PERIOD) {
  const runs = [];
  let start = 0;
  for (let slot = 1; slot <= SLOTS; slot++) {
    if (slot === SLOTS || slots[slot] !== slots[start]) {
      if (slots[start]) runs.push({ start, end: slot, mask: slots[start] });
      start = slot;
    }
  }
  if (runs.length > PERIODS) return null;
  const periods = [];
  const masks = [];
  for (let i = 0; i < PERIODS; i++) {
    const run = runs[i];
    if (run) {
      periods.push(`1 ${formatClock(run.start * SLOT_SECONDS)}-${formatClock(run.end * SLOT_SECONDS)}`);
      masks.push(formatMask(run.mask));
    } else {
      periods.push(unused || EMPTY_PERIOD);
      masks.push(EMPTY_MASK);
    }
  }
  return { periods, masks };
}

/** How many periods a day of slots would take. */
export function periodCount(slots) {
  let count = 0;
  for (let slot = 0; slot < SLOTS; slot++) {
    if (slots[slot] && (slot === 0 || slots[slot] !== slots[slot - 1])) count++;
  }
  return count;
}

/** The kind of recording a mask stands for, for colouring a slot. */
export function maskKind(mask) {
  if (mask & RECORD_CONTINUOUS) return "always";
  if ((mask & RECORD_MOTION) && (mask & RECORD_ALARM)) return "event";
  if (mask & RECORD_MOTION) return "motion";
  if (mask & RECORD_ALARM) return "alarm";
  return "none";
}
