import type { CalendarEvent } from "./types";

/** FullCalendar wants "HH:MM:SS"; a whole hour is all this ever produces. */
const asSlot = (hour: number): string => `${String(hour).padStart(2, "0")}:00:00`;

export interface VisibleHours {
  start: string;
  end: string;
}

/**
 * The hours the grid has to draw so nothing in the displayed week stays hidden (ported from
 * daily-planner). The configured window is a FLOOR: an appointment at 06:15 that the grid refuses
 * to render is the planner claiming the morning is free.
 *
 * Read in the BROWSER's zone, the zone FullCalendar draws in. All-day entries are skipped: their
 * midnight bounds would open the grid to 24 hours.
 */
export function visibleHours(
  events: readonly CalendarEvent[],
  floor: { start: string; end: string },
): VisibleHours {
  let first = Number.parseInt(floor.start.slice(0, 2), 10);
  let last = Number.parseInt(floor.end.slice(0, 2), 10);

  for (const event of events) {
    if (event.isAllDay || event.isCancelled) continue;

    const startHour = event.start.getHours();
    // Partial hours round outwards: an event ending 19:30 needs the 19 o'clock row drawn whole.
    let endHour = event.end.getHours() + (event.end.getMinutes() > 0 ? 1 : 0);
    // Ends at or before it starts: it runs past midnight, so it runs to the end of this grid day.
    if (endHour <= startHour) endHour = 24;

    if (startHour < first) first = startHour;
    if (endHour > last) last = endHour;
  }

  return { start: asSlot(Math.max(0, first)), end: asSlot(Math.min(24, last)) };
}
