import { describe, expect, it } from "vitest";
import { compareTasks, groupOf, isOverdue } from "./priority";
import { buildList } from "./taskList";
import { mapPlannerTasks } from "./planner";
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
    kunde: "K",
    projekt: "P",
    ...overrides,
  };
}

const OPTIONS = { search: "", kunde: null, onlyUnplanned: false };

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
      task("ohne"),
      task("spät", { due: "2026-10-30" }),
      task("früh offen", { due: "2026-09-25" }),
      task("früh in Arbeit", { due: "2026-09-25", status: "/" }),
    ].sort(compareTasks);
    expect(sorted.map((t) => t.description)).toEqual(["früh in Arbeit", "früh offen", "spät", "ohne"]);
  });

  it("ranks the priority after the date, also among undated tasks", () => {
    const sorted = [
      task("ohne, niedrig", { priority: "low" }),
      task("ohne, höchste", { priority: "highest" }),
      task("früh, normal", { due: "2026-09-25" }),
      task("früh, hoch", { due: "2026-09-25", priority: "high" }),
      task("später, höchste", { due: "2026-09-26", priority: "highest" }),
    ].sort(compareTasks);
    expect(sorted.map((t) => t.description)).toEqual(["früh, hoch", "früh, normal", "später, höchste", "ohne, höchste", "ohne, niedrig"]);
  });

  it("sorts a ⏳-only task by its ⏳ date", () => {
    const sorted = [task("fällig", { due: "2026-09-30" }), task("nur geplant", { scheduled: "2026-09-26" })].sort(compareTasks);
    expect(sorted.map((t) => t.description)).toEqual(["nur geplant", "fällig"]);
  });
});

describe("buildList", () => {
  it("drops done tasks and puts WAITING apart", () => {
    const model = buildList(
      [task("offen"), task("erledigt", { status: "x" }), task("WAITING Erika: warten", { isWaiting: true })],
      null,
      OPTIONS,
      TODAY,
    );
    expect(model.groups.flatMap((g) => g.tasks).map((t) => t.description)).toEqual(["offen"]);
    expect(model.waiting.map((t) => t.description)).toEqual(["WAITING Erika: warten"]);
    expect(model.openCount).toBe(2);
  });

  it("searches title, customer and project, but not link targets", () => {
    const tasks = [
      task("Backup klären ([[2026-09-24_capture]])"),
      task("Anderes", { kunde: "Backupfirma" }),
      task("Drittes", { projekt: "Migration" }),
    ];
    const find = (search: string) => buildList(tasks, null, { ...OPTIONS, search }, TODAY).shownCount;
    expect(find("backup")).toBe(2);
    expect(find("MIGRATION")).toBe(1);
    expect(find("capture")).toBe(0);
  });

  it("filters by customer and lists every customer for the dropdown", () => {
    const model = buildList([task("a", { kunde: "Zeta" }), task("b", { kunde: "Alpha" })], null, { ...OPTIONS, kunde: "Zeta" }, TODAY);
    expect(model.shownCount).toBe(1);
    expect(model.kunden).toEqual(["Alpha", "Zeta"]);
  });

  it("hides only planned tasks under 'nur ungeplante'; an expired plan stays visible", () => {
    const block = { eventId: "e", start: new Date(), end: new Date() };
    const statuses: Record<string, PlanStatus> = {
      geplant: { kind: "geplant", next: block },
      abgelaufen: { kind: "abgelaufen", last: block },
      ungeplant: { kind: "ungeplant" },
    };
    const tasks = Object.keys(statuses).map((name) => task(name));
    const model = buildList(tasks, (t) => statuses[t.description], { ...OPTIONS, onlyUnplanned: true }, TODAY);
    expect(model.groups.flatMap((g) => g.tasks).map((t) => t.description).sort()).toEqual(["abgelaufen", "ungeplant"]);
  });

  it("groups Planner tasks with the vault's, under one Planner customer", () => {
    const planner = mapPlannerTasks([
      { "@odata.etag": "e", id: "PT1", planId: "P", title: "Planner dringend", priority: 3, dueDateTime: "2026-09-25T10:00:00Z" },
      { "@odata.etag": "e", id: "PT2", planId: "P", title: "Planner erledigt", percentComplete: 100 },
    ]).tasks;
    const model = buildList([task("Vault offen"), ...planner], null, OPTIONS, TODAY);
    expect(model.groups.find((g) => g.key === "week")?.tasks.map((t) => t.description)).toEqual(["Planner dringend"]);
    expect(model.openCount).toBe(2);
    expect(model.kunden).toEqual(["K", "Planner"]);
    expect(buildList(planner, null, { ...OPTIONS, kunde: "Planner" }, TODAY).shownCount).toBe(1);
  });

  it("moves a task to the day of its next block, but never past its own date", () => {
    const planned = (start: string): PlanStatus => ({
      kind: "geplant",
      next: { eventId: "e", start: new Date(start), end: new Date(new Date(start).getTime() + 3_600_000) },
    });
    const statuses: Record<string, PlanStatus> = {
      "ohne Datum, Block heute": planned(`${TODAY}T09:00:00Z`),
      "ohne Datum, Block Montag": planned("2026-09-28T09:00:00Z"),
      // Started 23:30 Berlin yesterday, still running: today, not overdue.
      "über Mitternacht": planned("2026-09-23T21:30:00Z"),
      "überfällig, Block heute": planned(`${TODAY}T09:00:00Z`),
      "fällig heute, Block Montag": planned("2026-09-28T09:00:00Z"),
      "abgelaufen": { kind: "abgelaufen", last: { eventId: "e", start: new Date(`${TODAY}T06:00:00Z`), end: new Date(`${TODAY}T07:00:00Z`) } },
    };
    const tasks = [
      task("ohne Datum, Block heute"),
      task("ohne Datum, Block Montag"),
      task("über Mitternacht"),
      task("überfällig, Block heute", { due: "2026-09-20" }),
      task("fällig heute, Block Montag", { due: TODAY }),
      task("abgelaufen"),
    ];
    const model = buildList(tasks, (t) => statuses[t.description], OPTIONS, TODAY);
    const group = (key: string) => model.groups.find((g) => g.key === key)?.tasks.map((t) => t.description);
    expect(group("overdue")).toEqual(["überfällig, Block heute"]);
    expect(group("today")).toEqual(["fällig heute, Block Montag", "ohne Datum, Block heute", "über Mitternacht"]);
    expect(group("week")).toEqual(["ohne Datum, Block Montag"]);
    // A block that is over no longer plans anything: the task falls back to its own date.
    expect(group("none")).toEqual(["abgelaufen"]);
  });

  it("ignores 'nur ungeplante' while the status is unknown", () => {
    expect(buildList([task("a")], null, { ...OPTIONS, onlyUnplanned: true }, TODAY).shownCount).toBe(1);
  });
});
