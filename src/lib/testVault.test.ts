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
  const migration = tasksOf("10_Kunden/Beispielkunde/Migration/Migration.md");
  const byText = (start: string) => {
    const hit = migration.find((task) => task.description.startsWith(start));
    if (hit === undefined) throw new Error(`fixture missing: ${start}`);
    return hit;
  };

  it("has every case the plan lists, and the code block is not one", () => {
    expect(migration).toHaveLength(21); // 19 open incl. the indented sub-task, 2 done
    expect(migration.some((task) => task.description.includes("kein Task"))).toBe(false);
  });

  it("reads the draft's link-after-fields line exactly like Tasks: no due date", () => {
    const [broken, fixed] = migration.filter((task) => task.description.startsWith("[TEST]"));
    expect(broken.due).toBeNull();
    expect(fixed.due).toBe("2026-09-25");
  });

  it("keeps an old effort note out of title and subject, and still sees the date behind it", () => {
    const adr = byText("ADR-Liste");
    expect(adr.due).toBe("2026-09-29");
    expect(cleanTitle(adr.description)).toBe("ADR-Liste aktualisieren");
    expect(eventSubject(adr.description)).toBe("ADR-Liste aktualisieren");
  });

  it("reads recurrence, block ids and the variation selector", () => {
    expect(byText("Timesheet").isRecurring).toBe(true);
    expect(byText("Mit Block-ID").blockId).toBe("t-demo01");
    expect(byText("Mit fremder").blockId).toBe("abc123");
    expect(byText("Mit Variation").due).toBe("2026-09-28");
    expect(byText("Firewall").status).toBe("/");
    // The live vault's shape: only ⏳, and a long slug as block id.
    expect(byText("Nur mit Sanduhr")).toMatchObject({ scheduled: "2026-09-23", due: null, blockId: "t-ops-nur-mit-sanduhr-geplant" });
  });

  it("reads the CRLF file", () => {
    const portal = tasksOf("10_Kunden/Zweitkunde/Portal/Portal.md");
    expect(portal.map((task) => [task.description, task.due, task.priority])).toEqual([
      ["Login-Seite testen", "2026-09-26", "none"],
      ["Zertifikat erneuern", "2026-10-02", "highest"],
    ]);
  });

  it("keeps meeting notes and the inbox out", () => {
    expect(taskSource("10_Kunden/Beispielkunde/Migration/Meetings/2026-09-24 Kickoff.md")).toBeNull();
    expect(taskSource("00_Inbox/2026-09-24_101200_capture.md")).toBeNull();
  });
});
