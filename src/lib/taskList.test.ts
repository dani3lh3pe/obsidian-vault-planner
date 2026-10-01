import { describe, expect, it } from "vitest";
import { compareTasks, groupOf, isOverdue } from "./priority";
import { buildList } from "./taskList";
import { mapPlannerTasks } from "./planner";
import { mapTodoTasks } from "./todo";
import type { PlanStatus, VaultTask } from "./types";

const TODAY = "2026-09-24";

function task(description: string, overrides: Partial<VaultTask> = {}): VaultTask {
  return {
    path: "10_Kunden/K/P/P.md",
    line: 0,
    raw: `- [ ] ${description}`,
    status: " ",
    description,
    priority: "none",
    due: null,
    scheduled: null,
    blockId: null,
    isWaiting: false,
    isRecurring: false,
    customer: "K",
    project: "P",
    ...overrides,
  };
}

const OPTIONS = { search: "", customer: null, onlyUnplanned: false };

describe("date groups", () => {
  const at = (due: string | null, scheduled: string | null = null) => groupOf(due ?? scheduled, TODAY);

  it("puts overdue first, then today, the next seven days inclusive, later and undated", () => {
    expect(at("2026-09-23")).toBe("overdue");
    expect(at(TODAY)).toBe("today");
    expect(at("2026-09-25")).toBe("week");
    expect(at("2026-10-01")).toBe("week");
    expect(at("2026-10-02")).toBe("later");
    expect(at(null)).toBe("none");
  });

  it("falls back to ⏳ only where 📅 is missing — and a past ⏳ is overdue", () => {
    expect(at(null, "2026-07-08")).toBe("overdue");
    expect(at("2026-10-20", "2026-09-01")).toBe("later");
    expect(isOverdue({ due: null, scheduled: "2026-09-23" }, TODAY)).toBe(true);
    expect(isOverdue({ due: TODAY, scheduled: null }, TODAY)).toBe(false);
  });
});

describe("compareTasks", () => {
  it("sorts by due date, undated last, then in progress first", () => {
    const sorted = [
      task("undated"),
      task("late", { due: "2026-10-30" }),
      task("early open", { due: "2026-09-25" }),
      task("early in progress", { due: "2026-09-25", status: "/" }),
    ].sort(compareTasks);
    expect(sorted.map((t) => t.description)).toEqual(["early in progress", "early open", "late", "undated"]);
  });

  it("ranks the priority after the date, also among undated tasks", () => {
    const sorted = [
      task("undated, low", { priority: "low" }),
      task("undated, highest", { priority: "highest" }),
      task("early, normal", { due: "2026-09-25" }),
      task("early, high", { due: "2026-09-25", priority: "high" }),
      task("later, highest", { due: "2026-09-26", priority: "highest" }),
    ].sort(compareTasks);
    expect(sorted.map((t) => t.description)).toEqual(["early, high", "early, normal", "later, highest", "undated, highest", "undated, low"]);
  });

  it("sorts a ⏳-only task by its ⏳ date", () => {
    const sorted = [task("due", { due: "2026-09-30" }), task("scheduled only", { scheduled: "2026-09-26" })].sort(compareTasks);
    expect(sorted.map((t) => t.description)).toEqual(["scheduled only", "due"]);
  });
});

describe("buildList", () => {
  it("drops done tasks and puts WAITING apart", () => {
    const model = buildList(
      [task("open"), task("done", { status: "x" }), task("WAITING Erika: waiting", { isWaiting: true })],
      null,
      OPTIONS,
      TODAY,
    );
    expect(model.groups.flatMap((g) => g.tasks).map((t) => t.description)).toEqual(["open"]);
    expect(model.waiting.map((t) => t.description)).toEqual(["WAITING Erika: waiting"]);
    expect(model.openCount).toBe(2);
  });

  it("searches title, customer and project, but not link targets", () => {
    const tasks = [
      task("Clarify backup ([[2026-09-24_capture]])"),
      task("Other", { customer: "Backup Ltd" }),
      task("Third", { project: "Migration" }),
    ];
    const find = (search: string) => buildList(tasks, null, { ...OPTIONS, search }, TODAY).shownCount;
    expect(find("backup")).toBe(2);
    expect(find("MIGRATION")).toBe(1);
    expect(find("capture")).toBe(0);
  });

  it("filters by customer and lists every customer for the dropdown", () => {
    const model = buildList([task("a", { customer: "Zeta" }), task("b", { customer: "Alpha" })], null, { ...OPTIONS, customer: "Zeta" }, TODAY);
    expect(model.shownCount).toBe(1);
    expect(model.customers).toEqual(["Alpha", "Zeta"]);
  });

  it("hides only planned tasks under 'unplanned only'; an expired plan stays visible", () => {
    const block = { eventId: "e", start: new Date(), end: new Date() };
    const statuses: Record<string, PlanStatus> = {
      planned: { kind: "planned", next: block },
      past: { kind: "past", last: block },
      unplanned: { kind: "unplanned" },
    };
    const tasks = Object.keys(statuses).map((name) => task(name));
    const model = buildList(tasks, (t) => statuses[t.description], { ...OPTIONS, onlyUnplanned: true }, TODAY);
    expect(model.groups.flatMap((g) => g.tasks).map((t) => t.description).sort()).toEqual(["past", "unplanned"]);
  });

  it("groups Planner tasks with the vault's, under one Planner customer", () => {
    const planner = mapPlannerTasks([
      { "@odata.etag": "e", id: "PT1", planId: "P", title: "Planner urgent", priority: 3, dueDateTime: "2026-09-25T10:00:00Z" },
      { "@odata.etag": "e", id: "PT2", planId: "P", title: "Planner done", percentComplete: 100 },
    ]).tasks;
    const model = buildList([task("Vault open"), ...planner], null, OPTIONS, TODAY);
    expect(model.groups.find((g) => g.key === "week")?.tasks.map((t) => t.description)).toEqual(["Planner urgent"]);
    expect(model.openCount).toBe(2);
    expect(model.customers).toEqual(["K", "Planner"]);
    expect(buildList(planner, null, { ...OPTIONS, customer: "Planner" }, TODAY).shownCount).toBe(1);
  });

  it("moves a task to the day of its next block, but never past its own date", () => {
    const planned = (start: string): PlanStatus => ({
      kind: "planned",
      next: { eventId: "e", start: new Date(start), end: new Date(new Date(start).getTime() + 3_600_000) },
    });
    const statuses: Record<string, PlanStatus> = {
      "no date, block today": planned(`${TODAY}T09:00:00Z`),
      "no date, block Monday": planned("2026-09-28T09:00:00Z"),
      // Started 23:30 Berlin yesterday, still running: today, not overdue.
      "over midnight": planned("2026-09-23T21:30:00Z"),
      "overdue, block today": planned(`${TODAY}T09:00:00Z`),
      "due today, block Monday": planned("2026-09-28T09:00:00Z"),
      "past": { kind: "past", last: { eventId: "e", start: new Date(`${TODAY}T06:00:00Z`), end: new Date(`${TODAY}T07:00:00Z`) } },
    };
    const tasks = [
      task("no date, block today"),
      task("no date, block Monday"),
      task("over midnight"),
      task("overdue, block today", { due: "2026-09-20" }),
      task("due today, block Monday", { due: TODAY }),
      task("past"),
    ];
    const model = buildList(tasks, (t) => statuses[t.description], OPTIONS, TODAY);
    const group = (key: string) => model.groups.find((g) => g.key === key)?.tasks.map((t) => t.description);
    expect(group("overdue")).toEqual(["overdue, block today"]);
    expect(group("today")).toEqual(["due today, block Monday", "no date, block today", "over midnight"]);
    expect(group("week")).toEqual(["no date, block Monday"]);
    // A block that is over no longer plans anything: the task falls back to its own date.
    expect(group("none")).toEqual(["past"]);
  });

  it("puts To Do tasks into the date groups and under Waiting for, with one To Do filter entry", () => {
    const todo = mapTodoTasks({ id: "L", name: "Personal", shared: false }, [
      { id: "T1", title: "Change the tyres", status: "notStarted", dueDateTime: { dateTime: "2026-09-25T00:00:00.0000000", timeZone: "UTC" } },
      { id: "T2", title: "Reply from the landlord", status: "waitingOnOthers" },
      { id: "T3", title: "Done", status: "completed" },
    ]).tasks;
    const model = buildList([task("Vault open"), ...todo], null, OPTIONS, TODAY);
    expect(model.groups.find((g) => g.key === "week")?.tasks.map((t) => t.description)).toEqual(["Change the tyres"]);
    expect(model.waiting.map((t) => t.description)).toEqual(["Reply from the landlord"]);
    expect(model.customers).toEqual(["K", "To Do"]);
    expect(buildList(todo, null, { ...OPTIONS, customer: "To Do", search: "personal" }, TODAY).shownCount).toBe(2);
  });

  it("ignores 'unplanned only' while the status is unknown", () => {
    expect(buildList([task("a")], null, { ...OPTIONS, onlyUnplanned: true }, TODAY).shownCount).toBe(1);
  });
});
