import { describe, expect, it } from "vitest";
import { parseAufwand, parseFileTasks, parseTaskLine, taskSource } from "./parseTask";

/** The shape every case is checked against; only the fields a case names are compared. */
function parse(line: string) {
  const parsed = parseTaskLine(line);
  if (parsed === null) throw new Error(`not a task: ${line}`);
  return parsed;
}

describe("parseTaskLine — the draft's example lines", () => {
  it("does NOT see the due date when a link follows the fields", () => {
    // Exactly what Tasks does: the scan stops at the link, so 📅 and ➕ stay description text.
    const task = parse(
      "- [ ] [TEST] M. Muster Rückmeldung zu den CA-Policies geben 📅 2026-09-25 ➕ 2026-09-24 ([[2026-09-24_101200_capture]])",
    );
    expect(task.due).toBeNull();
    expect(task.description).toContain("📅 2026-09-25");
  });

  it("sees it once the link stands before the fields", () => {
    const task = parse(
      "- [ ] [TEST] M. Muster Rückmeldung zu den CA-Policies geben ([[2026-09-24_101200_capture]]) 📅 2026-09-25 ➕ 2026-09-24",
    );
    expect(task.due).toBe("2026-09-25");
    expect(task.description).toBe(
      "[TEST] M. Muster Rückmeldung zu den CA-Policies geben ([[2026-09-24_101200_capture]])",
    );
  });

  it("reads priority next to a created date", () => {
    const task = parse("- [ ] Support-Case zu Mail Routing eröffnen ⏫ ➕ 2026-09-24");
    expect(task).toMatchObject({ priority: "high", due: null, description: "Support-Case zu Mail Routing eröffnen" });
  });

  it("marks WAITING", () => {
    const task = parse("- [ ] WAITING Erika: Backup-Anforderungen klären ➕ 2026-09-24");
    expect(task.isWaiting).toBe(true);
    expect(task.description).toBe("WAITING Erika: Backup-Anforderungen klären");
  });
});

describe("parseTaskLine — fields", () => {
  it("reads every priority", () => {
    expect(parse("- [ ] a 🔺").priority).toBe("highest");
    expect(parse("- [ ] a ⏫").priority).toBe("high");
    expect(parse("- [ ] a 🔼").priority).toBe("medium");
    expect(parse("- [ ] a 🔽").priority).toBe("low");
    expect(parse("- [ ] a ⏬").priority).toBe("lowest");
    expect(parse("- [ ] a").priority).toBe("none");
  });

  it("reads fields in any order", () => {
    const task = parse("- [ ] Mischung ➕ 2026-09-01 📅 2026-09-28 ⏫ 🛫 2026-09-20");
    expect(task).toMatchObject({ priority: "high", due: "2026-09-28", description: "Mischung" });
  });

  it("accepts the alternative due symbols and a variation selector", () => {
    expect(parse("- [ ] a 📆 2026-09-28").due).toBe("2026-09-28");
    expect(parse("- [ ] a 🗓 2026-09-28").due).toBe("2026-09-28");
    expect(parse("- [ ] a 📅️ 2026-09-28").due).toBe("2026-09-28");
    expect(parse("- [ ] a ⏫️").priority).toBe("high");
  });

  it("recognises recurrence before and after the due date", () => {
    expect(parse("- [ ] Timesheet 🔁 every week on Friday 📅 2026-09-26")).toMatchObject({
      isRecurring: true,
      due: "2026-09-26",
      description: "Timesheet",
    });
    expect(parse("- [ ] Timesheet 📅 2026-09-26 🔁 every week")).toMatchObject({
      isRecurring: true,
      due: "2026-09-26",
    });
  });

  it("strips the fields Tasks writes when completing a task", () => {
    const task = parse("- [x] Fertig 🆔 abc123 ⛔ def456 ⏫ 🏁 delete ➕ 2026-09-01 📅 2026-09-10 ✅ 2026-09-09");
    expect(task).toMatchObject({ status: "x", priority: "high", due: "2026-09-10", description: "Fertig" });
  });

  it("keeps tags that sit between fields as part of the description", () => {
    const task = parse("- [ ] Getaggt 📅 2026-09-28 #kunde/x ➕ 2026-09-01");
    expect(task).toMatchObject({ due: "2026-09-28", description: "Getaggt #kunde/x" });
  });

  it("takes the leftmost value of a doubled field, as Tasks does", () => {
    expect(parse("- [ ] a 📅 2026-01-01 📅 2026-02-02").due).toBe("2026-01-01");
  });

  it("keeps emoji and umlauts in the description", () => {
    expect(parse("- [ ] 🚀 Übergabe für Müller vorbereiten 📅 2026-09-30").description).toBe(
      "🚀 Übergabe für Müller vorbereiten",
    );
  });
});

describe("parseTaskLine — block link", () => {
  it("reads our own block id and a foreign one", () => {
    expect(parse("- [ ] Mit Block 📅 2026-09-28 ^t-3f9a1c")).toMatchObject({
      blockId: "t-3f9a1c",
      due: "2026-09-28",
    });
    expect(parse("- [ ] Fremde ID ^abc123").blockId).toBe("abc123");
  });

  it("needs the space before the caret, like Tasks", () => {
    expect(parse("- [ ] Text^abc").blockId).toBeNull();
  });
});

describe("parseTaskLine — what is a task", () => {
  it("reads status characters", () => {
    expect(parse("- [/] In Arbeit").status).toBe("/");
    expect(parse("- [-] Abgebrochen ❌ 2026-09-01").status).toBe("-");
  });

  it("accepts indentation, numbered lists and quotes", () => {
    expect(parse("    - [ ] Unteraufgabe").description).toBe("Unteraufgabe");
    expect(parse("1. [ ] Nummeriert").description).toBe("Nummeriert");
    expect(parse("> - [ ] Zitat").description).toBe("Zitat");
  });

  it("rejects everything else", () => {
    expect(parseTaskLine("- Kein Task")).toBeNull();
    expect(parseTaskLine("Fließtext")).toBeNull();
    expect(parseTaskLine("")).toBeNull();
  });

  it("honours a global filter", () => {
    expect(parseTaskLine("- [ ] ohne Filter", "#task")).toBeNull();
    expect(parseTaskLine("- [ ] mit #task", "#task")?.description).toBe("mit #task");
  });
});

describe("parseAufwand", () => {
  it("reads hours and minutes", () => {
    expect(parseAufwand("x [aufwand:: 2h] y")).toBe(2);
    expect(parseAufwand("[aufwand:: 90m]")).toBe(1.5);
    expect(parseAufwand("[aufwand:: 1.5h]")).toBe(1.5);
    expect(parseAufwand("[aufwand:: 1,5 h]")).toBe(1.5);
    expect(parseAufwand("[Aufwand:: 30 min]")).toBe(0.5);
    expect(parseAufwand("[aufwand:: 3]")).toBe(3);
  });

  it("has no effort for nonsense or absence", () => {
    expect(parseAufwand("keins")).toBeUndefined();
    expect(parseAufwand("[aufwand:: 0h]")).toBeUndefined();
  });
});

describe("taskSource", () => {
  it("accepts customer and project files", () => {
    expect(taskSource("10_Kunden/Beispielkunde/Beispielkunde.md")).toEqual({ kunde: "Beispielkunde", projekt: null });
    expect(taskSource("10_Kunden/Beispielkunde/Migration/Migration.md")).toEqual({
      kunde: "Beispielkunde",
      projekt: "Migration",
    });
    expect(taskSource("20_Intern/Wissensbasis/Wissensbasis.md")).toEqual({ kunde: "junis intern", projekt: "Wissensbasis" });
  });

  it("rejects meeting notes, conflict copies and other folders", () => {
    expect(taskSource("10_Kunden/Beispielkunde/Migration/Meetings/2026-09-24 Kickoff.md")).toBeNull();
    expect(taskSource("10_Kunden/Beispielkunde/Migration/Migration-DESKTOP-1.md")).toBeNull();
    expect(taskSource("00_Inbox/Inbox/Inbox.md")).toBeNull();
    expect(taskSource("10_Kunden/Beispielkunde.md")).toBeNull();
    expect(taskSource("10_Kunden/Beispielkunde/Beispielkunde.canvas")).toBeNull();
  });
});

describe("parseFileTasks", () => {
  it("reads the lines the metadata cache named, in a CRLF file too", () => {
    const text = "# Portal\r\n\r\n## Offene Tasks\r\n- [ ] Erste 📅 2026-09-28\r\n- [x] Zweite\r\n";
    const tasks = parseFileTasks("10_Kunden/Zweitkunde/Portal/Portal.md", text, [3, 4]);

    expect(tasks.map((task) => [task.line, task.raw, task.due])).toEqual([
      [3, "- [ ] Erste 📅 2026-09-28", "2026-09-28"],
      [4, "- [x] Zweite", null],
    ]);
    expect(tasks[0]).toMatchObject({ kunde: "Zweitkunde", projekt: "Portal" });
  });

  it("returns nothing for a file that is not a task source", () => {
    expect(parseFileTasks("00_Inbox/x.md", "- [ ] a", [0])).toEqual([]);
  });
});
