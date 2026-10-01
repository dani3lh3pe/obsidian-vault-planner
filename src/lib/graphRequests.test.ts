import { describe, expect, it } from "vitest";
import { TASK_PROPERTY_ID } from "../config";
import {
  calendarViewUrl,
  createEventBody,
  eventUrl,
  isGraphUrl,
  graphArea,
  moveEventBody,
  PLANNER_TASKS_URL,
  plannerTaskUrl,
  planUrl,
  TODO_LISTS_URL,
  todoTaskUrl,
  todoTasksUrl,
} from "./graphRequests";

const RANGE = { start: new Date("2026-09-21T00:00:00Z"), end: new Date("2026-10-05T00:00:00Z") };

describe("calendarViewUrl", () => {
  it("asks calendarView for UTC bounds, our fields and the task property", () => {
    const url = calendarViewUrl(RANGE);
    expect(url.startsWith("https://graph.microsoft.com/v1.0/me/calendarView?")).toBe(true);
    const params = new URL(url).searchParams;
    expect(params.get("startDateTime")).toBe("2026-09-21T00:00:00.000Z");
    expect(params.get("endDateTime")).toBe("2026-10-05T00:00:00.000Z");
    expect(params.get("$select")).toBe("id,subject,start,end,isAllDay,isCancelled,showAs,responseStatus,categories");
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
      subject: "Update the ADR list",
      body: "Focus block from Obsidian",
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

describe("planner urls", () => {
  it("encode ids and are recognised as Planner's for their error texts", () => {
    expect(plannerTaskUrl("a/b=")).toBe("https://graph.microsoft.com/v1.0/planner/tasks/a%2Fb%3D");
    expect(graphArea(plannerTaskUrl("x"))).toBe("planner");
    expect(graphArea(`${planUrl("p")}/buckets`)).toBe("planner");
    expect(graphArea(PLANNER_TASKS_URL)).toBe("planner");
    expect(graphArea(eventUrl("x"))).toBe("calendar");
  });
});

describe("isGraphUrl", () => {
  it("lets Graph's own URLs through, a nextLink included", () => {
    expect(isGraphUrl(calendarViewUrl(RANGE))).toBe(true);
    expect(isGraphUrl(eventUrl("AAMk"))).toBe(true);
    expect(isGraphUrl("https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=x&%24skiptoken=abc")).toBe(true);
  });

  it("refuses another host, a lookalike host and plain http", () => {
    expect(isGraphUrl("https://example.com/v1.0/me/calendarView")).toBe(false);
    expect(isGraphUrl("https://graph.microsoft.com.example.com/v1.0/me")).toBe(false);
    expect(isGraphUrl("http://graph.microsoft.com/v1.0/me")).toBe(false);
  });
});

describe("To Do URLs (M9)", () => {
  it("encodes list and task ids, and To Do is no Planner endpoint", () => {
    expect(TODO_LISTS_URL).toBe("https://graph.microsoft.com/v1.0/me/todo/lists");
    expect(todoTasksUrl("AAMk/a=")).toBe("https://graph.microsoft.com/v1.0/me/todo/lists/AAMk%2Fa%3D/tasks");
    expect(todoTaskUrl("L=", "T/1")).toBe("https://graph.microsoft.com/v1.0/me/todo/lists/L%3D/tasks/T%2F1");
    expect(todoTasksUrl("L", true)).toBe("https://graph.microsoft.com/v1.0/me/todo/lists/L/tasks?$filter=status%20ne%20'completed'");
    expect(graphArea(todoTaskUrl("L", "T"))).toBe("todo");
    expect(graphArea(todoTasksUrl("L", true))).toBe("todo");
    expect(graphArea("https://graph.microsoft.com/v1.0/users('u1')/todo/lists/L/tasks?$skip=10")).toBe("todo");
    expect(isGraphUrl(todoTaskUrl("L", "T"))).toBe(true);
  });
});
