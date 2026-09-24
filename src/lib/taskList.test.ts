import { describe, expect, it } from "vitest";
import { compareTasks, isOverdue, isUrgent, quadrantOf } from "./priority";
import { buildList } from "./taskList";
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
    aufwand: undefined,
    blockId: null,
    isWaiting: false,
    isRecurring: false,
    kunde: "K",
    projekt: "P",
    ...overrides,
  };
}

const OPTIONS = { search: "", kunde: null, onlyUnplanned: false };

describe("quadrants", () => {
  it("counts a deadline up to seven days out as urgent, inclusive", () => {
    expect(isUrgent({ due: "2026-10-01" }, TODAY)).toBe(true);
    expect(isUrgent({ due: "2026-10-02" }, TODAY)).toBe(false);
    expect(isUrgent({ due: null }, TODAY)).toBe(false);
  });

  it("treats overdue as urgent, and only strictly past as overdue", () => {
    expect(isUrgent({ due: "2026-09-01" }, TODAY)).toBe(true);
    expect(isOverdue({ due: "2026-09-23" }, TODAY)).toBe(true);
    expect(isOverdue({ due: TODAY }, TODAY)).toBe(false);
  });

  it("maps priority and due date onto the four quadrants", () => {
    expect(quadrantOf({ priority: "high", due: "2026-09-25" }, TODAY)).toBe("now");
    expect(quadrantOf({ priority: "highest", due: null }, TODAY)).toBe("schedule");
    expect(quadrantOf({ priority: "medium", due: "2026-09-25" }, TODAY)).toBe("quick");
    expect(quadrantOf({ priority: "none", due: null }, TODAY)).toBe("rest");
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

  it("ignores 'nur ungeplante' while the status is unknown", () => {
    expect(buildList([task("a")], null, { ...OPTIONS, onlyUnplanned: true }, TODAY).shownCount).toBe(1);
  });
});
