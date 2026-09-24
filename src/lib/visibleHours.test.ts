import { describe, it, expect } from "vitest";
import { visibleHours } from "./visibleHours";
import type { CalendarEvent } from "./types";

const WORK = { start: "07:00:00", end: "19:00:00" };

/** Local-time bounds, because that is the zone the grid is drawn in. */
function event(
  startHour: number,
  endHour: number,
  overrides: Partial<CalendarEvent> = {},
): CalendarEvent {
  return {
    id: `ev_${startHour}`,
    subject: "Termin",
    start: new Date(2026, 8, 24, startHour, 0),
    end: new Date(2026, 8, 24, endHour, 0),
    isAllDay: false,
    isCancelled: false,
    showAs: "busy",
    responseStatus: "none",
    taskLink: null,
    ...overrides,
  };
}

describe("visibleHours", () => {
  it("keeps the working day when everything fits inside it", () => {
    expect(visibleHours([event(9, 10)], WORK)).toEqual(WORK);
  });

  it("opens the grid downwards for an early appointment", () => {
    // The bug this fixes: a 06:00 meeting was simply not drawn, and the app
    // showed an empty morning.
    expect(visibleHours([event(6, 7)], WORK).start).toBe("06:00:00");
  });

  it("rounds a partial hour outwards rather than cutting it off", () => {
    const late = event(20, 20);
    late.end = new Date(2026, 8, 24, 20, 30);

    expect(visibleHours([late], WORK).end).toBe("21:00:00");
  });

  it("never shrinks below the configured day", () => {
    // A week with one midday meeting must still look like a working day.
    expect(visibleHours([event(12, 13)], WORK)).toEqual(WORK);
  });

  it("takes the widest span across the whole week, not the last event", () => {
    expect(visibleHours([event(5, 6), event(12, 13), event(21, 22)], WORK)).toEqual({
      start: "05:00:00",
      end: "22:00:00",
    });
  });

  it("ignores all-day entries", () => {
    // Their bounds are midnight to midnight. Counting them would open the grid
    // to a full 24 hours every time somebody takes a holiday, and shrink every
    // day to a sliver — for an entry that occupies no grid time at all.
    const holiday = { ...event(0, 0), isAllDay: true };
    holiday.end = new Date(2026, 8, 25, 0, 0);

    expect(visibleHours([holiday], WORK)).toEqual(WORK);
  });

  it("ignores a cancelled event, which the grid does not draw either", () => {
    expect(visibleHours([event(4, 5, { isCancelled: true })], WORK)).toEqual(WORK);
  });

  it("treats an event running past midnight as running to the end of the day", () => {
    // 22:00 to 02:00 would otherwise read as "ends at 2" and produce bounds
    // that are the wrong way round.
    const overnight = event(22, 22);
    overnight.end = new Date(2026, 8, 25, 2, 0);

    expect(visibleHours([overnight], WORK)).toEqual({ start: "07:00:00", end: "24:00:00" });
  });

  it("clamps to a real day", () => {
    expect(visibleHours([event(0, 1)], WORK).start).toBe("00:00:00");
  });
});
