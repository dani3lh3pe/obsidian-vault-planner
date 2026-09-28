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
    categories: [],
    ...overrides,
  };
}

const COLORS = new Map([
  ["Kunde A", 7],
  ["Privat", 0],
]);
const map = (events: CalendarEvent[]) => toFullCalendarEvents(events, "Vault", () => "open", COLORS);

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
    const [missing] = toFullCalendarEvents([event({ taskLink: "Vault|t-9" })], "Vault", () => "missing", COLORS);
    expect(missing.classNames).toEqual(["vp-block", "vp-block-missing"]);
  });

  it("tints a meeting by its FIRST category that has a colour, and hatches tentative time", () => {
    const [first, skipped, none, tentative] = map([
      event({ categories: ["Kunde A", "Privat"] }),
      event({ categories: ["Unbekannt", "Privat"] }),
      event({ categories: ["Unbekannt"] }),
      event({ showAs: "tentative" }),
    ]);
    expect(first.classNames).toEqual(["vp-meeting", "vp-cat-7"]);
    expect(skipped.classNames).toEqual(["vp-meeting", "vp-cat-0"]);
    expect(none.classNames).toEqual(["vp-meeting"]);
    expect(tentative.classNames).toEqual(["vp-meeting", "vp-tentative"]);
  });

  it("colours our blocks by source, never by a category someone added in Outlook", () => {
    const [vault, planner] = map([
      event({ taskLink: "Vault|t-1", categories: ["Kunde A"] }),
      event({ taskLink: "planner:abc", categories: ["Kunde A"] }),
    ]);
    expect(vault.classNames).toEqual(["vp-block", "vp-block-open"]);
    expect(planner.classNames).toEqual(["vp-block", "vp-block-open", "vp-source-planner"]);
  });
});
