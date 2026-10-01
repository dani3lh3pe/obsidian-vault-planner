import { describe, expect, it } from "vitest";
import { parseFileTasks, parseTaskLine, taskSource } from "./parseTask";

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
      "- [ ] [TEST] M. Muster send feedback on the CA policies 📅 2026-09-25 ➕ 2026-09-24 ([[2026-09-24_101200_capture]])",
    );
    expect(task.due).toBeNull();
    expect(task.description).toContain("📅 2026-09-25");
  });

  it("sees it once the link stands before the fields", () => {
    const task = parse(
      "- [ ] [TEST] M. Muster send feedback on the CA policies ([[2026-09-24_101200_capture]]) 📅 2026-09-25 ➕ 2026-09-24",
    );
    expect(task.due).toBe("2026-09-25");
    expect(task.description).toBe(
      "[TEST] M. Muster send feedback on the CA policies ([[2026-09-24_101200_capture]])",
    );
  });

  it("reads priority next to a created date", () => {
    const task = parse("- [ ] Open a support case on mail routing ⏫ ➕ 2026-09-24");
    expect(task).toMatchObject({ priority: "high", due: null, description: "Open a support case on mail routing" });
  });

  it("marks WAITING", () => {
    const task = parse("- [ ] WAITING Erika: clarify backup requirements ➕ 2026-09-24");
    expect(task.isWaiting).toBe(true);
    expect(task.description).toBe("WAITING Erika: clarify backup requirements");
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
    const task = parse("- [ ] Mixture ➕ 2026-09-01 📅 2026-09-28 ⏫ 🛫 2026-09-20");
    expect(task).toMatchObject({ priority: "high", due: "2026-09-28", description: "Mixture" });
  });

  it("reads ⏳ as the scheduled date, apart from 📅 — the live vault's import format", () => {
    const task = parse("- [ ] Clean up roles [aufwand:: 3h] ⏳ 2026-07-08 ^t-ops-clean-up-roles");
    expect(task).toMatchObject({ scheduled: "2026-07-08", due: null, blockId: "t-ops-clean-up-roles" });
    // The old effort note stays description text; cleanTitle hides it (subject.test.ts).
    expect(task.description).toBe("Clean up roles [aufwand:: 3h]");
    expect(parse("- [ ] a ⌛ 2026-07-08 📅 2026-07-10")).toMatchObject({ scheduled: "2026-07-08", due: "2026-07-10" });
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
    const task = parse("- [x] Finished 🆔 abc123 ⛔ def456 ⏫ 🏁 delete ➕ 2026-09-01 📅 2026-09-10 ✅ 2026-09-09");
    expect(task).toMatchObject({ status: "x", priority: "high", due: "2026-09-10", description: "Finished" });
  });

  it("keeps tags that sit between fields as part of the description", () => {
    const task = parse("- [ ] Tagged 📅 2026-09-28 #customer/x ➕ 2026-09-01");
    expect(task).toMatchObject({ due: "2026-09-28", description: "Tagged #customer/x" });
  });

  it("takes the leftmost value of a doubled field, as Tasks does", () => {
    expect(parse("- [ ] a 📅 2026-01-01 📅 2026-02-02").due).toBe("2026-01-01");
  });

  it("keeps emoji and umlauts in the description", () => {
    expect(parse("- [ ] 🚀 Prepare the handover for Müller 📅 2026-09-30").description).toBe(
      "🚀 Prepare the handover for Müller",
    );
  });
});

describe("parseTaskLine — block link", () => {
  it("reads our own block id and a foreign one", () => {
    expect(parse("- [ ] With block 📅 2026-09-28 ^t-3f9a1c")).toMatchObject({
      blockId: "t-3f9a1c",
      due: "2026-09-28",
    });
    expect(parse("- [ ] Foreign id ^abc123").blockId).toBe("abc123");
  });

  it("needs the space before the caret, like Tasks", () => {
    expect(parse("- [ ] Text^abc").blockId).toBeNull();
  });
});

describe("parseTaskLine — what is a task", () => {
  it("reads status characters", () => {
    expect(parse("- [/] In progress").status).toBe("/");
    expect(parse("- [-] Cancelled ❌ 2026-09-01").status).toBe("-");
  });

  it("accepts indentation, numbered lists and quotes", () => {
    expect(parse("    - [ ] Subtask").description).toBe("Subtask");
    expect(parse("1. [ ] Numbered").description).toBe("Numbered");
    expect(parse("> - [ ] Quote").description).toBe("Quote");
  });

  it("rejects everything else", () => {
    expect(parseTaskLine("- Not a task")).toBeNull();
    expect(parseTaskLine("Plain text")).toBeNull();
    expect(parseTaskLine("")).toBeNull();
  });

  it("honours a global filter", () => {
    expect(parseTaskLine("- [ ] without filter", "#task")).toBeNull();
    expect(parseTaskLine("- [ ] with #task", "#task")?.description).toBe("with #task");
  });
});

describe("taskSource", () => {
  it("accepts customer and project files", () => {
    expect(taskSource("10_Kunden/SampleCustomer/SampleCustomer.md")).toEqual({ customer: "SampleCustomer", project: null });
    expect(taskSource("10_Kunden/SampleCustomer/Migration/Migration.md")).toEqual({
      customer: "SampleCustomer",
      project: "Migration",
    });
    expect(taskSource("20_Intern/KnowledgeBase/KnowledgeBase.md")).toEqual({ customer: "junis intern", project: "KnowledgeBase" });
  });

  it("rejects meeting notes, conflict copies and other folders", () => {
    expect(taskSource("10_Kunden/SampleCustomer/Migration/Meetings/2026-09-24 Kickoff.md")).toBeNull();
    expect(taskSource("10_Kunden/SampleCustomer/Migration/Migration-DESKTOP-1.md")).toBeNull();
    expect(taskSource("00_Inbox/Inbox/Inbox.md")).toBeNull();
    expect(taskSource("10_Kunden/SampleCustomer.md")).toBeNull();
    expect(taskSource("10_Kunden/SampleCustomer/SampleCustomer.canvas")).toBeNull();
  });
});

describe("parseFileTasks", () => {
  it("reads the lines the metadata cache named, in a CRLF file too", () => {
    const text = "# Portal\r\n\r\n## Open tasks\r\n- [ ] First 📅 2026-09-28\r\n- [x] Second\r\n";
    const tasks = parseFileTasks("10_Kunden/SecondCustomer/Portal/Portal.md", text, [3, 4]);

    expect(tasks.map((task) => [task.line, task.raw, task.due])).toEqual([
      [3, "- [ ] First 📅 2026-09-28", "2026-09-28"],
      [4, "- [x] Second", null],
    ]);
    expect(tasks[0]).toMatchObject({ customer: "SecondCustomer", project: "Portal" });
  });

  it("returns nothing for a file that is not a task source", () => {
    expect(parseFileTasks("00_Inbox/x.md", "- [ ] a", [0])).toEqual([]);
  });
});
