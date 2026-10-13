import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { taskTargets } from "./newTask";
import { parseFileTasks } from "./parseTask";
import { cleanTitle, eventSubject } from "./subject";
import { insertTaskLines, newTaskLines } from "./taskLine";

/**
 * The test vault's fixture files, read through the real parser — so the vault Daniel tests with and
 * the parser tests cannot drift apart. The metadata cache is imitated by its one relevant rule:
 * checkbox lines outside code fences.
 */
function checkboxLines(text: string): number[] {
  const lines: number[] = [];
  let inFence = false;
  text.split(/\r?\n/).forEach((line, index) => {
    if (/^\s*```/.test(line)) inFence = !inFence;
    else if (!inFence && /^\s*([-*+]|\d+[.)]) \[.\]/.test(line)) lines.push(index);
  });
  return lines;
}

/** The test vault's folders as Daniel chooses them there once (M11). */
const FOLDERS = { customerFolder: "10_Kunden", ownFolder: "20_Intern" };

function tasksOf(path: string) {
  const text = readFileSync(`test-vault/${path}`, "utf8");
  return parseFileTasks(path, text, checkboxLines(text), FOLDERS);
}

describe("test vault fixtures", () => {
  const migration = tasksOf("10_Kunden/SampleCustomer/Migration/Migration.md");
  const byText = (start: string) => {
    const hit = migration.find((task) => task.description.startsWith(start));
    if (hit === undefined) throw new Error(`fixture missing: ${start}`);
    return hit;
  };

  it("has every case the plan lists, and the code block is not one", () => {
    expect(migration).toHaveLength(21); // 19 open incl. the indented sub-task, 2 done
    expect(migration.some((task) => task.description.includes("not a task"))).toBe(false);
  });

  it("reads the draft's link-after-fields line exactly like Tasks: no due date", () => {
    const [broken, fixed] = migration.filter((task) => task.description.startsWith("[TEST]"));
    expect(broken.due).toBeNull();
    expect(fixed.due).toBe("2026-09-25");
  });

  it("keeps an old effort note out of title and subject, and still sees the date behind it", () => {
    const adr = byText("Update the ADR list");
    expect(adr.due).toBe("2026-09-29");
    expect(cleanTitle(adr.description)).toBe("Update the ADR list");
    expect(eventSubject(adr.description)).toBe("Update the ADR list");
  });

  it("reads recurrence, block ids and the variation selector", () => {
    expect(byText("Submit the timesheet").isRecurring).toBe(true);
    expect(byText("With block id").blockId).toBe("t-demo01");
    expect(byText("With a foreign").blockId).toBe("abc123");
    expect(byText("With variation").due).toBe("2026-09-28");
    expect(byText("Review the firewall").status).toBe("/");
    // The live vault's shape: only ⏳, and a long slug as block id.
    expect(byText("Scheduled with hourglass")).toMatchObject({ scheduled: "2026-09-23", due: null, blockId: "t-ops-scheduled-with-hourglass-only" });
  });

  it("reads the CRLF file", () => {
    const portal = tasksOf("10_Kunden/SecondCustomer/Portal/Portal.md");
    expect(portal.map((task) => [task.description, task.due, task.priority])).toEqual([
      ["Test the login page", "2026-09-26", "none"],
      ["Renew the certificate", "2026-10-02", "highest"],
    ]);
  });

  it("reads every note: the flat layout, meeting notes and the inbox", () => {
    const label = (path: string) => tasksOf(path).map((task) => [task.customer, task.project]);
    expect(label("10_Kunden/SecondCustomer/Rollout.md")).toEqual([["SecondCustomer", "Rollout"]]);
    expect(label("10_Kunden/SampleCustomer/Migration/Meetings/2026-09-24 Kickoff.md")).toEqual([
      ["SampleCustomer", "2026-09-24 Kickoff"],
    ]);
    expect(label("00_Inbox/2026-09-24_101200_capture.md")).toEqual([["00_Inbox", "2026-09-24_101200_capture"]]);
    expect(label("20_Intern/KnowledgeBase/KnowledgeBase.md")).toEqual([
      ["Intern", "KnowledgeBase"],
      ["Intern", "KnowledgeBase"],
    ]);
  });

  it("offers the customers of the chosen folders in the form", () => {
    const paths = readdirSync("test-vault", { recursive: true, encoding: "utf8" }).filter((path) => path.endsWith(".md"));
    const customers = taskTargets(paths, FOLDERS);
    expect(customers.map(({ customer, targets }) => [customer, targets.map((target) => target.label)])).toEqual([
      ["Intern", ["KnowledgeBase/KnowledgeBase"]],
      ["SampleCustomer", ["SampleCustomer", "Migration/Meetings/2026-09-24 Kickoff", "Migration/Migration"]],
      ["SecondCustomer", ["_infos", "Portal/Portal", "Rollout"]],
    ]);
  });

  it("puts a new task at the right place in the real notes, and reads it back", () => {
    const lines = newTaskLines("Test new task", "First info\nSecond info", "2026-10-11", "t-new001");
    const insert = (path: string) => {
      const text = readFileSync(`test-vault/${path}`, "utf8");
      const next = insertTaskLines(text, lines);
      if (next === null) throw new Error(`no place in ${path}`);
      return { text, next, created: parseFileTasks(path, next, checkboxLines(next), FOLDERS).filter((task) => task.blockId === "t-new001") };
    };

    // Below the last open top-level task, its code block and its sub-task; above "## Done".
    const migration = insert("10_Kunden/SampleCustomer/Migration/Migration.md");
    expect(migration.next).toBe(migration.text.replace("    - [ ] Indented sub-task\n", `    - [ ] Indented sub-task\n${lines.join("\n")}\n`));
    expect(migration.created).toMatchObject([{ description: "Test new task", customer: "SampleCustomer", project: "Migration" }]);

    // CRLF stays CRLF, below the last open task.
    const portal = insert("10_Kunden/SecondCustomer/Portal/Portal.md");
    expect(portal.next).toBe(portal.text.replace("📅 2026-10-02\r\n", `📅 2026-10-02\r\n${lines.join("\r\n")}\r\n`));
    expect(portal.created).toMatchObject([{ customer: "SecondCustomer", project: "Portal" }]);

    // The customer page without a task gets it at the end.
    const infos = insert("10_Kunden/SecondCustomer/_infos.md");
    expect(infos.next).toBe(`${infos.text}${lines.join("\n")}\n`);
    expect(infos.created).toMatchObject([{ customer: "SecondCustomer", project: null }]);
  });
});
