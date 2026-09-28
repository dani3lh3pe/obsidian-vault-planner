import { describe, it, expect } from "vitest";
import { mapGraphEvents, readCategoryColors } from "./mapGraphEvents";

const utc = (dateTime: string) => ({ dateTime, timeZone: "UTC" });

describe("mapGraphEvents", () => {
  it("parses Graph's seven fractional digits as UTC", () => {
    // The response has no trailing Z; treating it as local time is the silent
    // two-hour bug this whole read path is built to avoid.
    const { events, droppedCount } = mapGraphEvents([
      { id: "AAA", subject: "Termin", start: utc("2026-09-10T07:00:00.0000000"), end: utc("2026-09-10T08:00:00.0000000") },
    ]);

    expect(droppedCount).toBe(0);
    expect(events[0].start.toISOString()).toBe("2026-09-10T07:00:00.000Z");
  });

  it("DROPS an event whose timeZone is not UTC instead of guessing", () => {
    // Would mean someone added Prefer: outlook.timezone. Reading that string as
    // UTC would shift every event by the offset — refusing is the safe failure.
    const { events, droppedCount } = mapGraphEvents([
      {
        id: "AAA",
        start: { dateTime: "2026-09-10T09:00:00.0000000", timeZone: "W. Europe Standard Time" },
        end: { dateTime: "2026-09-10T10:00:00.0000000", timeZone: "W. Europe Standard Time" },
      },
    ]);

    expect(events).toEqual([]);
    expect(droppedCount).toBe(1);
  });

  it("drops entries that are not objects or carry no id", () => {
    const { events, droppedCount } = mapGraphEvents([null, "nope", 42, { subject: "kein id" }]);

    expect(events).toEqual([]);
    expect(droppedCount).toBe(4);
  });

  it("keeps cancelled, declined and all-day events — filtering is not its job", () => {
    // Shape and meaning are separate steps: reconcile decides scheduling,
    // toFullCalendarEvents decides display. This one only narrows types.
    const { events } = mapGraphEvents([
      {
        id: "AAA",
        start: utc("2026-09-10T00:00:00.0000000"),
        end: utc("2026-09-11T00:00:00.0000000"),
        isAllDay: true,
        isCancelled: true,
        responseStatus: { response: "declined" },
      },
    ]);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ isAllDay: true, isCancelled: true, responseStatus: "declined" });
  });

  it("falls back to a safe default for an unknown showAs value", () => {
    // Graph may add enum values later; an unknown one must not crash the render.
    const { events } = mapGraphEvents([
      { id: "AAA", start: utc("2026-09-10T07:00:00.0"), end: utc("2026-09-10T08:00:00.0"), showAs: "brandNew" },
    ]);

    expect(events[0].showAs).toBe("unknown");
  });

  it("reads the task link from the expanded extended property", () => {
    const { events } = mapGraphEvents([
      {
        id: "AAA",
        start: utc("2026-09-10T07:00:00.0"),
        end: utc("2026-09-10T08:00:00.0"),
        singleValueExtendedProperties: [{ id: "String {guid} Name vaultTaskId", value: "Vault|t-3f9a1c" }],
      },
    ]);

    expect(events[0].taskLink).toBe("Vault|t-3f9a1c");
  });

  it("takes the first property without comparing its id spelling", () => {
    // $filter already chose the property; Graph may echo the id back in another case.
    const { events } = mapGraphEvents([
      {
        id: "AAA",
        start: utc("2026-09-10T07:00:00.0"),
        end: utc("2026-09-10T08:00:00.0"),
        singleValueExtendedProperties: [{ id: "string {GUID} name VAULTTASKID", value: "Vault|t-1" }],
      },
    ]);

    expect(events[0].taskLink).toBe("Vault|t-1");
  });

  it("has no task link for a foreign meeting", () => {
    const { events } = mapGraphEvents([
      { id: "AAA", start: utc("2026-09-10T07:00:00.0"), end: utc("2026-09-10T08:00:00.0") },
      { id: "BBB", start: utc("2026-09-10T07:00:00.0"), end: utc("2026-09-10T08:00:00.0"), singleValueExtendedProperties: [] },
      { id: "CCC", start: utc("2026-09-10T07:00:00.0"), end: utc("2026-09-10T08:00:00.0"), singleValueExtendedProperties: [{ value: "" }] },
    ]);

    expect(events.map((event) => event.taskLink)).toEqual([null, null, null]);
  });

  it("keeps the category names in their order and drops anything that is not a name", () => {
    const { events } = mapGraphEvents([
      { id: "AAA", start: utc("2026-09-10T07:00:00.0"), end: utc("2026-09-10T08:00:00.0"), categories: ["Kunde A", 7, null, "Privat"] },
      { id: "BBB", start: utc("2026-09-10T07:00:00.0"), end: utc("2026-09-10T08:00:00.0") },
    ]);

    expect(events.map((event) => event.categories)).toEqual([["Kunde A", "Privat"], []]);
  });
});

describe("readCategoryColors", () => {
  it("maps each name to its preset number and leaves out none, unknown and broken entries", () => {
    const colors = readCategoryColors([
      { displayName: "Kunde A", color: "preset7" },
      { displayName: "Privat", color: "Preset24" },
      { displayName: "Farblos", color: "none" },
      { displayName: "Zukunft", color: "preset25" },
      { displayName: "Kaputt" },
      "nonsense",
    ]);

    expect([...colors]).toEqual([
      ["Kunde A", 7],
      ["Privat", 24],
    ]);
  });
});
