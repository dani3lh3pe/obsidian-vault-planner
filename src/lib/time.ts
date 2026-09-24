import { PLANNER_IANA_ZONE } from "../config";

/**
 * The plugin's whole time-zone strategy, in one file (ported from daily-planner).
 *
 * In application code only the absolute instant (Date) exists. Wall-clock time lives
 * exclusively at the Graph boundary:
 *   - window bounds  -> Graph : date.toISOString()          (UTC, has a Z)
 *   - Graph          -> app   : fromGraphUtc()              (we ask for UTC)
 *   - app            -> Graph : toWallClock() + timeZone    (write path)
 */

const WALL_CLOCK = new Intl.DateTimeFormat("de-DE", {
  timeZone: PLANNER_IANA_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  // h23, not hour12:false — some ICU builds render midnight as "24" with the latter.
  hourCycle: "h23",
});

function wallClockParts(instant: Date): Record<string, string> {
  const parts: Record<string, string> = {};
  for (const part of WALL_CLOCK.formatToParts(instant)) {
    parts[part.type] = part.value;
  }
  return parts;
}

/**
 * An absolute instant as the Berlin wall-clock string Graph's dateTimeTimeZone expects.
 *
 * The one case this cannot fix: during the autumn fall-back hour two different instants produce
 * the SAME wall-clock string, and Graph resolves it by its own rule.
 */
export function toWallClock(instant: Date): string {
  const p = wallClockParts(instant);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

/**
 * Which calendar day an instant falls on in Berlin: "yyyy-mm-dd". Deadlines are compared against
 * this, because "is it due today" cannot be answered in UTC.
 */
export function plannerDay(instant: Date): string {
  const p = wallClockParts(instant);
  return `${p.year}-${p.month}-${p.day}`;
}

/**
 * Parse a Graph dateTime that we KNOW is UTC. Graph sends seven fractional digits and no Z;
 * without the Z, `new Date()` reads it as LOCAL time — two hours off in Berlin, silently.
 */
export function fromGraphUtc(dateTime: string): Date {
  return new Date(`${dateTime.slice(0, 19)}Z`);
}

const MIN_HOURS = 0.25;
const MAX_HOURS = 8;

/**
 * Hours -> block length in minutes, clamped to 15 min – 8 h and snapped to the quarter hour.
 *
 * An unknown effort falls to the floor so one missing value cannot break a render. It is NOT a
 * scheduling default: callers pass `aufwand ?? DEFAULT_AUFWAND_HOURS`.
 */
export function aufwandToMinutes(hours: number | undefined): number {
  const safe = hours !== undefined && Number.isFinite(hours) && hours > 0 ? hours : MIN_HOURS;
  const clamped = Math.min(MAX_HOURS, Math.max(MIN_HOURS, safe));
  return Math.round((clamped * 60) / 15) * 15;
}

/** The same length as the "HH:MM" string FullCalendar's Draggable expects. */
export function aufwandToDuration(hours: number | undefined): string {
  const minutes = aufwandToMinutes(hours);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

const DAY_AND_TIME = new Intl.DateTimeFormat("de-DE", {
  timeZone: PLANNER_IANA_ZONE,
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const DATE_AND_TIME = new Intl.DateTimeFormat("de-DE", {
  timeZone: PLANNER_IANA_ZONE,
  weekday: "short",
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const TIME_ONLY = new Intl.DateTimeFormat("de-DE", {
  timeZone: PLANNER_IANA_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** "Mi., 09:00–12:00" for the task list. */
export function formatSlot(start: Date, end: Date): string {
  return `${DAY_AND_TIME.format(start)}–${TIME_ONLY.format(end)}`;
}

/** "Mo., 29.09., 10:00–11:00" — for blocks outside the current week, where a weekday is ambiguous. */
export function formatSlotWithDate(start: Date, end: Date): string {
  return `${DATE_AND_TIME.format(start)}–${TIME_ONLY.format(end)}`;
}
