import { describe, expect, it } from "vitest";
import { TASK_PROPERTY_ID } from "../config";
import { calendarViewUrl, createEventBody, eventUrl, moveEventBody } from "./graphRequests";

const RANGE = { start: new Date("2026-09-21T00:00:00Z"), end: new Date("2026-10-05T00:00:00Z") };

describe("calendarViewUrl", () => {
  it("asks calendarView for UTC bounds, our fields and the task property", () => {
    const url = calendarViewUrl(RANGE);
    expect(url.startsWith("https://graph.microsoft.com/v1.0/me/calendarView?")).toBe(true);
    const params = new URL(url).searchParams;
    expect(params.get("startDateTime")).toBe("2026-09-21T00:00:00.000Z");
    expect(params.get("endDateTime")).toBe("2026-10-05T00:00:00.000Z");
    expect(params.get("$select")).toBe("id,subject,start,end,isAllDay,isCancelled,showAs,responseStatus");
    expect(params.get("$expand")).toBe(`singleValueExtendedProperties($filter=id eq '${TASK_PROPERTY_ID}')`);
    expect(params.get("$top")).toBe("250");
  });

  it("encodes spaces as %20, never as +", () => {
    const url = calendarViewUrl(RANGE);
    expect(url).toContain("%20eq%20");
    expect(url).not.toContain("+");
  });
});

describe("createEventBody", () => {
  const body = createEventBody(
    {
      subject: "ADR-Liste aktualisieren",
      body: "Fokus-Block aus Obsidian",
      start: new Date("2026-09-24T08:00:00Z"),
      end: new Date("2026-09-24T10:00:00Z"),
      link: "Vault|t-3f9a1c",
    },
    "11111111-2222-3333-4444-555555555555",
  );

  it("never carries attendees or categories", () => {
    expect(body).not.toHaveProperty("attendees");
    expect(body).not.toHaveProperty("categories");
  });

  it("writes Berlin wall-clock time with the Windows zone name", () => {
    expect(body.start).toEqual({ dateTime: "2026-09-24T10:00:00", timeZone: "W. Europe Standard Time" });
    expect(body.end).toEqual({ dateTime: "2026-09-24T12:00:00", timeZone: "W. Europe Standard Time" });
  });

  it("links the task, blocks the time quietly and is idempotent on retry", () => {
    expect(body).toMatchObject({
      showAs: "busy",
      isReminderOn: false,
      transactionId: "11111111-2222-3333-4444-555555555555",
      singleValueExtendedProperties: [{ id: TASK_PROPERTY_ID, value: "Vault|t-3f9a1c" }],
    });
  });
});

describe("move and address", () => {
  it("sends only the times on a move", () => {
    expect(Object.keys(moveEventBody(new Date(), new Date())).sort()).toEqual(["end", "start"]);
  });

  it("encodes the event id in the path", () => {
    expect(eventUrl("AAMk/abc=")).toBe("https://graph.microsoft.com/v1.0/me/events/AAMk%2Fabc%3D");
  });
});
