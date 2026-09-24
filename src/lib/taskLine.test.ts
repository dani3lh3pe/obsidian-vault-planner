import { describe, expect, it } from "vitest";
import { ensureBlockId, locateLine, newBlockId, replaceLine } from "./taskLine";

const FILE = ["# Projekt", "", "## Offene Tasks", "- [ ] Erste 📅 2026-09-28", "- [ ] Zweite ^t-abc123", "Absatz ^t-zzz999", ""].join("\n");

describe("locateLine", () => {
  it("finds a line by its exact text wherever it moved", () => {
    const span = locateLine(`Neue Zeile oben\n${FILE}`, { raw: "- [ ] Erste 📅 2026-09-28" });
    expect(span).not.toBe("missing");
    if (typeof span === "string") return;
    expect(`Neue Zeile oben\n${FILE}`.slice(span.start, span.end)).toBe("- [ ] Erste 📅 2026-09-28");
  });

  it("finds a task by block id even after its text changed", () => {
    const edited = FILE.replace("- [ ] Zweite ^t-abc123", "- [ ] Zweite, umformuliert ⏫ ^t-abc123");
    const span = locateLine(edited, { blockId: "t-abc123" });
    if (typeof span === "string") throw new Error(span);
    expect(edited.slice(span.start, span.end)).toBe("- [ ] Zweite, umformuliert ⏫ ^t-abc123");
  });

  it("ignores a block id on a line that is not a task", () => {
    expect(locateLine(FILE, { blockId: "t-zzz999" })).toBe("missing");
  });

  it("refuses to guess between identical lines", () => {
    expect(locateLine("- [ ] Rückruf\n- [ ] Rückruf\n", { raw: "- [ ] Rückruf" })).toBe("ambiguous");
  });

  it("never lands inside a fenced code block", () => {
    // The real line was edited; the copy in the code block must not be taken for it.
    const text = "- [ ] Geändert\n\n```\n- [ ] Original\n```\n~~~\n- [ ] Original ^t-abc123\n~~~\n";
    expect(locateLine(text, { raw: "- [ ] Original" })).toBe("missing");
    expect(locateLine(text, { blockId: "t-abc123" })).toBe("missing");
  });

  it("finds the line after an indented fence under a task", () => {
    const text = "- [ ] Mit Zeiterfassung\n    ```yaml\n    zeit: 1h\n    ```\n    - [ ] Unter-Task\n";
    const span = locateLine(text, { raw: "    - [ ] Unter-Task" });
    expect(typeof span).toBe("object");
  });

  it("reports a line that is gone", () => {
    expect(locateLine(FILE, { raw: "- [ ] Weg" })).toBe("missing");
  });

  it("matches CRLF lines without their carriage return", () => {
    const crlf = FILE.split("\n").join("\r\n");
    const span = locateLine(crlf, { raw: "- [ ] Erste 📅 2026-09-28" });
    if (typeof span === "string") throw new Error(span);
    expect(span.eol).toBe("\r\n");
  });
});

describe("ensureBlockId", () => {
  it("appends a new id after one space", () => {
    expect(ensureBlockId("- [ ] Erste 📅 2026-09-28  ", () => "t-new001")).toEqual({
      line: "- [ ] Erste 📅 2026-09-28 ^t-new001",
      blockId: "t-new001",
      changed: true,
    });
  });

  it("reuses an id the line already carries, ours or Obsidian's", () => {
    expect(ensureBlockId("- [ ] Zweite ^t-abc123", () => "t-never")).toMatchObject({ blockId: "t-abc123", changed: false });
    expect(ensureBlockId("- [ ] Dritte ^8f3kd2", () => "t-never")).toMatchObject({ blockId: "8f3kd2", changed: false });
  });
});

describe("newBlockId", () => {
  it("has the t- shape and skips taken ids", () => {
    const taken = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      const id = newBlockId((candidate) => taken.has(candidate));
      expect(id).toMatch(/^t-[a-z0-9]{6}$/);
      expect(taken.has(id)).toBe(false);
      taken.add(id);
    }
  });
});

describe("replaceLine", () => {
  it("changes one line and keeps every other byte", () => {
    const mixed = "a\r\n- [ ] Ziel\nb\r\n";
    const span = locateLine(mixed, { raw: "- [ ] Ziel" });
    if (typeof span === "string") throw new Error(span);
    expect(replaceLine(mixed, span, "- [x] Ziel ✅ 2026-09-24")).toBe("a\r\n- [x] Ziel ✅ 2026-09-24\nb\r\n");
  });

  it("joins two replacement lines with the file's CRLF", () => {
    const crlf = "- [ ] Timesheet 🔁 every week\r\n    ```yaml\r\n";
    const span = locateLine(crlf, { raw: "- [ ] Timesheet 🔁 every week" });
    if (typeof span === "string") throw new Error(span);
    expect(replaceLine(crlf, span, "- [ ] Timesheet 🔁 every week\n- [x] Timesheet 🔁 every week ✅ 2026-09-24")).toBe(
      "- [ ] Timesheet 🔁 every week\r\n- [x] Timesheet 🔁 every week ✅ 2026-09-24\r\n    ```yaml\r\n",
    );
  });

  it("handles a last line without an ending", () => {
    const text = "a\r\n- [ ] Ziel";
    const span = locateLine(text, { raw: "- [ ] Ziel" });
    if (typeof span === "string") throw new Error(span);
    expect(replaceLine(text, span, "x\ny")).toBe("a\r\nx\r\ny");
  });
});
