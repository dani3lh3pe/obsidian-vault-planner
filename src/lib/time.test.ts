import { describe, it, expect } from "vitest";
import {
  toWallClock,
  fromGraphUtc,
  formatSlot,
  formatSlotWithDate,
  plannerDay,
  formatDue,
  shiftWorkdays,
} from "./time";

describe("toWallClock", () => {
  it("applies the winter offset (CET, +1)", () => {
    expect(toWallClock(new Date("2026-01-15T08:00:00Z"))).toBe("2026-01-15T09:00:00");
  });

  it("applies the summer offset (CEST, +2)", () => {
    // The single most common silent bug in calendar apps: a fixed +1 all year.
    expect(toWallClock(new Date("2026-07-15T08:00:00Z"))).toBe("2026-07-15T10:00:00");
  });

  it("skips the spring-forward gap — 02:xx does not exist on that day", () => {
    expect(toWallClock(new Date("2026-03-29T00:30:00Z"))).toBe("2026-03-29T01:30:00");
    expect(toWallClock(new Date("2026-03-29T01:30:00Z"))).toBe("2026-03-29T03:30:00");
  });

  it("maps both fall-back hours onto the SAME wall-clock string", () => {
    // Documented, not fixed: dateTimeTimeZone cannot express which of the two
    // 02:30s is meant, so Graph resolves it by its own rule. One hour a year.
    expect(toWallClock(new Date("2026-10-25T00:30:00Z"))).toBe("2026-10-25T02:30:00");
    expect(toWallClock(new Date("2026-10-25T01:30:00Z"))).toBe("2026-10-25T02:30:00");
  });

  it("renders midnight as 00, never 24", () => {
    // hourCycle "h23" guarantees this; hour12:false does not on every ICU build.
    expect(toWallClock(new Date("2026-01-14T23:00:00Z"))).toBe("2026-01-15T00:00:00");
  });
});

describe("plannerDay", () => {
  it("returns the planner's day, not the UTC day", () => {
    // 22:30 UTC in summer is already 00:30 the next morning in Berlin. The
    // suite runs under TZ=UTC, so reading the date off the instant would put
    // every late-evening block on the wrong day.
    expect(plannerDay(new Date("2026-09-11T22:30:00Z"))).toBe("2026-09-12");
  });

  it("still returns the same day before the Berlin midnight", () => {
    expect(plannerDay(new Date("2026-09-11T21:30:00Z"))).toBe("2026-09-11");
  });

  it("uses the winter offset in winter", () => {
    // CET is +1, so the rollover happens an hour later than in summer.
    expect(plannerDay(new Date("2026-01-11T22:30:00Z"))).toBe("2026-01-11");
    expect(plannerDay(new Date("2026-01-11T23:30:00Z"))).toBe("2026-01-12");
  });

  it("pads month and day to two digits", () => {
    // The value is compared and sorted as a string; "2026-9-1" would break both.
    expect(plannerDay(new Date("2026-09-01T10:00:00Z"))).toBe("2026-09-01");
  });
});

describe("fromGraphUtc", () => {
  it("parses Graph's seven fractional digits without a trailing Z", () => {
    // Without the appended Z this string is read as LOCAL time — silently wrong.
    expect(fromGraphUtc("2026-09-10T07:00:00.0000000").toISOString()).toBe("2026-09-10T07:00:00.000Z");
  });

  it("round-trips through toWallClock", () => {
    expect(toWallClock(fromGraphUtc("2026-07-15T08:00:00.0000000"))).toBe("2026-07-15T10:00:00");
  });
});

describe("formatSlot", () => {
  it("names the weekday and both times in Berlin time", () => {
    // Proves the list can report a block that sits outside the visible grid hours.
    const slot = formatSlot(new Date("2026-09-07T04:00:00Z"), new Date("2026-09-07T06:00:00Z"));
    expect(slot).toContain("06:00");
    expect(slot).toContain("08:00");
    expect(slot).toMatch(/^Mo/);
  });
});

describe("formatSlotWithDate", () => {
  it("adds the date, for blocks outside the current week", () => {
    const slot = formatSlotWithDate(new Date("2026-09-28T08:00:00Z"), new Date("2026-09-28T09:00:00Z"));
    expect(slot).toMatch(/^Mo/);
    expect(slot).toContain("28/09");
    expect(slot).toContain("10:00");
    expect(slot).toContain("11:00");
  });
});

describe("the test clock", () => {
  it("runs in UTC, or the Berlin-day tests prove nothing", () => {
    // `npm test` sets TZ=UTC. A run without it on a Berlin machine would hide exactly the
    // late-evening day bugs plannerDay exists for.
    expect(new Date(0).getTimezoneOffset()).toBe(0);
  });
});

describe("formatDue", () => {
  it("names the weekday, and the year only when it is not this one", () => {
    expect(formatDue("2026-09-22", "2026-09-28")).toBe("Tue 22/09");
    expect(formatDue("2027-01-15", "2026-09-28")).toBe("Fri 15/01/2027");
  });

  it("keeps a typo that is no real date as written, instead of throwing or rolling it over", () => {
    expect(formatDue("2026-13-01", "2026-09-28")).toBe("2026-13-01");
    expect(formatDue("2026-02-30", "2026-09-28")).toBe("2026-02-30");
  });
});

describe("shiftWorkdays", () => {
  // TZ=UTC in the tests; the function counts in local calendar days either way.
  const day = (text: string) => new Date(`${text}T00:00:00`);
  const iso = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

  it("pages the 3-day view Mon–Wed, Thu–Mon, Tue–Thu — no day twice, none left out", () => {
    expect(iso(shiftWorkdays(day("2026-09-28"), 3))).toBe("2026-10-01"); // Mon -> Thu
    expect(iso(shiftWorkdays(day("2026-10-01"), 3))).toBe("2026-10-06"); // Thu -> Tue
  });

  it("goes back over the weekend the same way", () => {
    expect(iso(shiftWorkdays(day("2026-10-06"), -3))).toBe("2026-10-01"); // Tue -> Thu
    expect(iso(shiftWorkdays(day("2026-09-28"), -1))).toBe("2026-09-25"); // Mon -> Fri
    expect(iso(shiftWorkdays(day("2026-09-28"), -4))).toBe("2026-09-22"); // Mon -> Tue
  });

  it("lands on midnight, whatever time of day it starts from", () => {
    const after = shiftWorkdays(new Date("2026-10-23T09:30:00"), 1); // Fri -> Mon
    expect(iso(after)).toBe("2026-10-26");
    expect(after.getHours()).toBe(0);
  });
});
