import { describe, expect, it } from "vitest";
import { blocksByTask, fetchRange, linkKey, parseTaskLink, plannerIdOf, plannerKey, planStatus, statusWindow, todoIdOf } from "./schedule";
import { mapPlannerTasks } from "./planner";
import { mapTodoTasks } from "./todo";
import type { CalendarEvent } from "./types";

function event(id: string, start: string, end: string, overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id,
    subject: "Block",
    start: new Date(start),
    end: new Date(end),
    isAllDay: false,
    isCancelled: false,
    showAs: "busy",
    responseStatus: "organizer",
    taskLink: null,
    categories: [],
    ...overrides,
  };
}

// Wednesday 2026-09-23, 12:00 UTC (the suite runs in UTC).
const NOW = new Date("2026-09-23T12:00:00Z");

describe("parseTaskLink", () => {
  it("accepts only this vault's links", () => {
    expect(parseTaskLink("Vault|t-abc123", "Vault")).toBe("t-abc123");
    expect(parseTaskLink("test-vault|t-abc123", "Vault")).toBeNull();
    expect(parseTaskLink("Vault|", "Vault")).toBeNull();
    expect(parseTaskLink(null, "Vault")).toBeNull();
  });

  it("gives a To Do task its own vault-independent key, never a Planner one (M9)", () => {
    const [task] = mapTodoTasks({ id: "L", name: "Personal", shared: false }, [{ id: "T1", title: "x" }]).tasks;
    expect(linkKey(task)).toBe("todo:T1");
    expect(plannerIdOf(linkKey(task) ?? "")).toBeNull();
    // Its blocks are ours in any vault, like Planner's; "todo:" alone is no key.
    expect(parseTaskLink("todo:T1", "Vault")).toBe("todo:T1");
    expect(parseTaskLink("todo:T1", "test-vault")).toBe("todo:T1");
    expect(parseTaskLink("todo:", "Vault")).toBeNull();
    expect(todoIdOf("todo:T1")).toBe("T1");
    expect(todoIdOf("planner:T1")).toBeNull();
  });

  it("carries a Planner task's key through the same link, apart from every block id", () => {
    const [task] = mapPlannerTasks([{ "@odata.etag": "e", id: "PT1", planId: "P" }]).tasks;
    expect(linkKey(task)).toBe("planner:PT1");
    // No vault name: the same Planner task is planned in the test vault and the live vault alike.
    expect(parseTaskLink(plannerKey("PT1"), "Vault")).toBe("planner:PT1");
    expect(parseTaskLink(plannerKey("PT1"), "test-vault")).toBe("planner:PT1");
    expect(parseTaskLink("planner:", "Vault")).toBeNull();
    expect(plannerIdOf("planner:PT1")).toBe("PT1");
    // Tasks block ids are [a-zA-Z0-9-]: never a colon, so never a Planner key.
    expect(plannerIdOf("t-abc123")).toBeNull();
  });
});

describe("statusWindow", () => {
  it("runs from this Monday for two weeks", () => {
    const window = statusWindow(NOW);
    expect(window.start.toISOString()).toBe("2026-09-21T00:00:00.000Z");
    expect(window.end.toISOString()).toBe("2026-10-05T00:00:00.000Z");
  });

  it("treats Sunday as the end of the week, not the start", () => {
    expect(statusWindow(new Date("2026-09-27T20:00:00Z")).start.toISOString()).toBe("2026-09-21T00:00:00.000Z");
  });
});

describe("fetchRange", () => {
  it("covers the status window even while a later week is on screen", () => {
    const displayed = { start: new Date("2026-10-12T00:00:00Z"), end: new Date("2026-10-17T00:00:00Z") };
    const range = fetchRange(displayed, NOW);
    expect(range.start.toISOString()).toBe("2026-09-21T00:00:00.000Z");
    expect(range.end.toISOString()).toBe("2026-10-17T00:00:00.000Z");
  });

  it("reaches back to an earlier week on screen", () => {
    const displayed = { start: new Date("2026-09-07T00:00:00Z"), end: new Date("2026-09-12T00:00:00Z") };
    expect(fetchRange(displayed, NOW).start.toISOString()).toBe("2026-09-07T00:00:00.000Z");
  });
});

describe("blocksByTask", () => {
  const window = statusWindow(NOW);

  it("groups this vault's blocks by task and sorts them", () => {
    const blocks = blocksByTask(
      [
        event("b2", "2026-09-25T08:00:00Z", "2026-09-25T09:00:00Z", { taskLink: "Vault|t-1" }),
        event("b1", "2026-09-22T08:00:00Z", "2026-09-22T09:00:00Z", { taskLink: "Vault|t-1" }),
        event("x", "2026-09-22T08:00:00Z", "2026-09-22T09:00:00Z", { taskLink: "test-vault|t-1" }),
        event("m", "2026-09-22T10:00:00Z", "2026-09-22T11:00:00Z"),
      ],
      "Vault",
      window,
    );
    expect([...blocks.keys()]).toEqual(["t-1"]);
    expect(blocks.get("t-1")?.map((block) => block.eventId)).toEqual(["b1", "b2"]);
  });

  it("skips cancelled blocks and blocks outside the window", () => {
    const blocks = blocksByTask(
      [
        event("c", "2026-09-22T08:00:00Z", "2026-09-22T09:00:00Z", { taskLink: "Vault|t-1", isCancelled: true }),
        event("old", "2026-09-14T08:00:00Z", "2026-09-14T09:00:00Z", { taskLink: "Vault|t-1" }),
      ],
      "Vault",
      window,
    );
    expect(blocks.size).toBe(0);
  });
});

describe("planStatus", () => {
  const block = (start: string, end: string) => ({ eventId: start, start: new Date(start), end: new Date(end) });

  it("is planned for a future or running block", () => {
    expect(planStatus([block("2026-09-24T08:00:00Z", "2026-09-24T09:00:00Z")], NOW)).toMatchObject({ kind: "planned" });
    expect(planStatus([block("2026-09-23T11:00:00Z", "2026-09-23T13:00:00Z")], NOW)).toMatchObject({ kind: "planned" });
  });

  it("names the next block, not the first", () => {
    const status = planStatus(
      [block("2026-09-21T08:00:00Z", "2026-09-21T09:00:00Z"), block("2026-09-24T08:00:00Z", "2026-09-24T09:00:00Z")],
      NOW,
    );
    expect(status.kind === "planned" && status.next.start.toISOString()).toBe("2026-09-24T08:00:00.000Z");
  });

  it("is past when every block is over", () => {
    const status = planStatus([block("2026-09-21T08:00:00Z", "2026-09-21T09:00:00Z")], NOW);
    expect(status.kind).toBe("past");
  });

  it("is unplanned without blocks", () => {
    expect(planStatus(undefined, NOW).kind).toBe("unplanned");
    expect(planStatus([], NOW).kind).toBe("unplanned");
  });
});
