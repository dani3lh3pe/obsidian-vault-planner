import { describe, expect, it } from "vitest";
import { toFullCalendarEvents } from "./toFullCalendarEvents";
import type { CalendarEvent } from "./types";

function event(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "e1",
    subject: "Termin",
    start: new Date("2026-09-24T08:00:00Z"),
    end: new Date("2026-09-24T09:00:00Z"),
    isAllDay: false,
    isCancelled: false,
    showAs: "busy",
    responseStatus: "accepted",
    taskLink: null,
    ...overrides,
  };
}

const map = (events: CalendarEvent[]) => toFullCalendarEvents(events, "Vault", () => "open");

describe("toFullCalendarEvents", () => {
  it("drops cancelled and declined entries", () => {
    expect(map([event({ isCancelled: true }), event({ responseStatus: "declined" })])).toEqual([]);
  });

  it("makes only our own blocks editable", () => {
    const [meeting, own] = map([event(), event({ id: "e2", taskLink: "Vault|t-1" })]);
    expect(meeting).toMatchObject({ editable: false, classNames: ["vp-meeting"], extendedProps: { kind: "meeting" } });
    expect(own).toMatchObject({
      editable: true,
      classNames: ["vp-block", "vp-block-open"],
      extendedProps: { kind: "own", blockId: "t-1", state: "open" },
    });
  });

  it("treats another vault's block as a meeting", () => {
    expect(map([event({ taskLink: "test-vault|t-1" })])[0]).toMatchObject({ editable: false, extendedProps: { kind: "meeting" } });
  });

  it("tints free and working-elsewhere time instead of walling it off", () => {
    const [free, elsewhere, tentative] = map([
      event({ showAs: "free" }),
      event({ showAs: "workingElsewhere" }),
      event({ showAs: "tentative" }),
    ]);
    expect(free.display).toBe("background");
    expect(elsewhere.display).toBe("background");
    expect(tentative.display).toBe("auto");
  });

  it("puts all-day entries in the all-day row by date, never editable", () => {
    const [allDay] = map([
      event({
        isAllDay: true,
        start: new Date("2026-09-24T00:00:00Z"),
        end: new Date("2026-09-25T00:00:00Z"),
        taskLink: "Vault|t-1",
      }),
    ]);
    expect(allDay).toMatchObject({ start: "2026-09-24", end: "2026-09-25", allDay: true, editable: false });
  });

  it("carries the task state into the class", () => {
    const [missing] = toFullCalendarEvents([event({ taskLink: "Vault|t-9" })], "Vault", () => "missing");
    expect(missing.classNames).toEqual(["vp-block", "vp-block-missing"]);
  });
});
