import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseFileTasks, taskSource } from "./parseTask";
import { cleanTitle, eventSubject } from "./subject";

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

function tasksOf(path: string) {
  const text = readFileSync(`test-vault/${path}`, "utf8");
  return parseFileTasks(path, text, checkboxLines(text));
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

  it("keeps meeting notes and the inbox out", () => {
    expect(taskSource("10_Kunden/SampleCustomer/Migration/Meetings/2026-09-24 Kickoff.md")).toBeNull();
    expect(taskSource("00_Inbox/2026-09-24_101200_capture.md")).toBeNull();
  });
});
