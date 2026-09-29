import { describe, expect, it } from "vitest";
import { mapPlannerTasks, plannerDue, plannerPriority, plannerStatus, plannerWebUrl, readBuckets } from "./planner";

const entry = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  "@odata.etag": 'W/"JzEtVGFzayAgQEBAQEBAQEBAQEBAQEBAWCc="',
  id: "01gzSlKkIUSUl6DF_EilrmQAKDhh",
  planId: "xqQg5FS2LkCp935s-FIFm2QAFkHM",
  bucketId: "gcrYAaAkgU2EQUvpkNNXLGQAGTtu",
  title: "Angebot prüfen",
  percentComplete: 0,
  priority: 5,
  dueDateTime: "2026-10-01T10:00:00Z",
  assignments: { me: {} },
  ...overrides,
});

describe("plannerPriority", () => {
  it("reads 0–1 as urgent and 2–4 as important — the two ranks above an unrated task", () => {
    expect([0, 1].map(plannerPriority)).toEqual(["highest", "highest"]);
    expect([2, 3, 4].map(plannerPriority)).toEqual(["high", "high", "high"]);
  });

  it("reads medium, low and a MISSING value as not important", () => {
    expect([5, 7, 8, 10].map(plannerPriority)).toEqual(["none", "none", "low", "low"]);
    expect(plannerPriority(undefined)).toBe("none");
  });
});

describe("plannerStatus", () => {
  it("maps 0 / 1–99 / 100 to open / in progress / done", () => {
    expect([0, 50, 99, 100, undefined].map(plannerStatus)).toEqual([" ", "/", "/", "x", " "]);
  });
});

describe("plannerDue", () => {
  it("takes the Berlin day of the instant, not the UTC date prefix", () => {
    expect(plannerDue("2026-10-01T10:00:00Z")).toBe("2026-10-01");
    // 22:30 UTC in October is 00:30 the next day in Berlin.
    expect(plannerDue("2026-10-01T22:30:00Z")).toBe("2026-10-02");
    expect(plannerDue(null)).toBeNull();
  });
});

describe("mapPlannerTasks", () => {
  it("narrows an entry into a list task under the Planner label", () => {
    const { tasks, droppedCount } = mapPlannerTasks([entry({ priority: 1, percentComplete: 50 })]);
    expect(droppedCount).toBe(0);
    expect(tasks[0]).toMatchObject({
      source: "planner",
      id: "01gzSlKkIUSUl6DF_EilrmQAKDhh",
      description: "Angebot prüfen",
      status: "/",
      priority: "highest",
      due: "2026-10-01",
      kunde: "Planner",
      projekt: null,
      othersAssigned: 0,
    });
  });

  it("counts the other assignees, never the signed-in user — and unreadable ones as unknown", () => {
    const { tasks } = mapPlannerTasks([entry({ assignments: { me: {}, a: {}, b: {} } }), entry({ assignments: undefined })]);
    expect(tasks.map((task) => task.othersAssigned)).toEqual([2, null]);
  });

  it("drops and counts what it cannot write back: no etag, no id, no plan", () => {
    const { tasks, droppedCount } = mapPlannerTasks([
      entry({ "@odata.etag": undefined }),
      entry({ id: "" }),
      entry({ planId: undefined }),
      "nonsense",
      entry(),
    ]);
    expect(tasks).toHaveLength(1);
    expect(droppedCount).toBe(4);
  });
});

describe("readBuckets", () => {
  it("sorts by orderHint ordinal, as the docs prescribe — not by locale", () => {
    const buckets = readBuckets([
      { id: "c", name: "Erledigt", orderHint: "b" },
      { id: "b", name: "In Arbeit", orderHint: "ab" },
      { id: "a", name: "Backlog", orderHint: "a" },
      // "Z" (90) sorts before "a" (97) by ordinal; localeCompare would put it last.
      { id: "z", name: "Ideen", orderHint: "Z" },
    ]);
    expect(buckets.map((bucket) => bucket.id)).toEqual(["z", "a", "b", "c"]);
  });
});

describe("plannerWebUrl", () => {
  it("encodes tenant and task id into the path", () => {
    expect(plannerWebUrl("tenant", "a/b")).toBe("https://tasks.office.com/tenant/Home/Task/a%2Fb");
  });
});
