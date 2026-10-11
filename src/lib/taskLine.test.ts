import { describe, expect, it } from "vitest";
import { ensureBlockId, locateLine, newBlockId, replaceLine } from "./taskLine";

const FILE = ["# Project", "", "## Open tasks", "- [ ] First 📅 2026-09-28", "- [ ] Second ^t-abc123", "Paragraph ^t-zzz999", ""].join("\n");

describe("locateLine", () => {
  it("finds a line by its exact text wherever it moved", () => {
    const span = locateLine(`New line on top\n${FILE}`, { raw: "- [ ] First 📅 2026-09-28" });
    expect(span).not.toBe("missing");
    if (typeof span === "string") return;
    expect(`New line on top\n${FILE}`.slice(span.start, span.end)).toBe("- [ ] First 📅 2026-09-28");
  });

  it("finds a task by block id even after its text changed", () => {
    const edited = FILE.replace("- [ ] Second ^t-abc123", "- [ ] Second, reworded ⏫ ^t-abc123");
    const span = locateLine(edited, { blockId: "t-abc123" });
    if (typeof span === "string") throw new Error(span);
    expect(edited.slice(span.start, span.end)).toBe("- [ ] Second, reworded ⏫ ^t-abc123");
  });

  it("ignores a block id on a line that is not a task", () => {
    expect(locateLine(FILE, { blockId: "t-zzz999" })).toBe("missing");
  });

  it("refuses to guess between identical lines", () => {
    expect(locateLine("- [ ] Call Jürgen\n- [ ] Call Jürgen\n", { raw: "- [ ] Call Jürgen" })).toBe("ambiguous");
  });

  it("never lands inside a fenced code block", () => {
    // The real line was edited; the copy in the code block must not be taken for it.
    const text = "- [ ] Edited\n\n```\n- [ ] Original\n```\n~~~\n- [ ] Original ^t-abc123\n~~~\n";
    expect(locateLine(text, { raw: "- [ ] Original" })).toBe("missing");
    expect(locateLine(text, { blockId: "t-abc123" })).toBe("missing");
  });

  it("pairs fences as CommonMark does", () => {
    // A ```` block shows a ``` block: the copy inside stays a copy, the real line is found.
    const nested = "````md\n```\n- [ ] Weekly review ^t-abc123\n````\n\n- [ ] Weekly review ^t-abc123\n";
    const span = locateLine(nested, { blockId: "t-abc123" });
    if (typeof span === "string") throw new Error(span);
    expect(span.start).toBe(nested.lastIndexOf("- [ ] Weekly"));
    expect(locateLine("````md\n```\n- [ ] Original\n````\n", { raw: "- [ ] Original" })).toBe("missing");
    // A `~~~` line inside a ``` block is content, not a fence.
    expect(typeof locateLine("```\n~~~\n```\n\n- [ ] Pay invoice\n", { raw: "- [ ] Pay invoice" })).toBe("object");
    // A fence in a quote, and inline code that only looks like one.
    expect(locateLine("> ```\n> - [ ] Copy ^t-abc123\n> ```\n", { blockId: "t-abc123" })).toBe("missing");
    expect(typeof locateLine("```a``` b\n- [ ] Task\n", { raw: "- [ ] Task" })).toBe("object");
  });

  it.each([
    ["a quoted fence inside a code block", "```\n> ```\n- [ ] Copy ^t-abc123\n```\n"],
    ["a top-level fence after a quoted one", "> ```\n> code\n```\n- [ ] Copy ^t-abc123\n```\n"],
    ["an indented fence inside a code block", "```\n    ```\n- [ ] Copy ^t-abc123\n```\n"],
    ["a tab-indented fence inside a code block", "```\n\t```\n- [ ] Copy ^t-abc123\n```\n"],
    ["a fence with a no-break space after it", "```\n``` \n- [ ] Copy ^t-abc123\n```\n"],
    ["an opener ending in a stray carriage return", "```js\r\r\n- [ ] Copy ^t-abc123\r\n```\r\n"],
    ["a fence left open in a list item", "- [ ] Parent\n  ```\n  code\n- [ ] Next\n\n```\n- [ ] Copy ^t-abc123\n```\n"],
    ["a sibling item's fence after an unclosed one", "- [ ] Parent\n  ```\n  code\n- [ ] Next\n  ```\n  - [ ] Copy ^t-abc123\n  ```\n"],
    ["a callout's fence after an unclosed one", "> [!note]\n> ```\n> x\n\n> [!tip]\n> ```\n> - [ ] Copy ^t-abc123\n> ```\n"],
    ["a fence indented as code after a paragraph", "Para\n\n    ```\n```\n- [ ] x\n    ```\n- [ ] Copy ^t-abc123\n```\n"],
  ])("keeps the block open on %s: the copy is never taken", (_case, text) => {
    expect(locateLine(text, { blockId: "t-abc123" })).toBe("missing");
  });

  it("finds the line after an indented fence under a task", () => {
    const text = "- [ ] With time tracking\n    ```yaml\n    time: 1h\n    ```\n    - [ ] Sub-task\n";
    const span = locateLine(text, { raw: "    - [ ] Sub-task" });
    expect(typeof span).toBe("object");
  });

  it("reports a line that is gone", () => {
    expect(locateLine(FILE, { raw: "- [ ] Gone" })).toBe("missing");
  });

  it("matches CRLF lines without their carriage return", () => {
    const crlf = FILE.split("\n").join("\r\n");
    const span = locateLine(crlf, { raw: "- [ ] First 📅 2026-09-28" });
    if (typeof span === "string") throw new Error(span);
    expect(span.eol).toBe("\r\n");
  });
});

describe("ensureBlockId", () => {
  it("appends a new id after one space", () => {
    expect(ensureBlockId("- [ ] First 📅 2026-09-28  ", () => "t-new001")).toEqual({
      line: "- [ ] First 📅 2026-09-28 ^t-new001",
      blockId: "t-new001",
      changed: true,
    });
  });

  it("reuses an id the line already carries, ours or Obsidian's", () => {
    expect(ensureBlockId("- [ ] Second ^t-abc123", () => "t-never")).toMatchObject({ blockId: "t-abc123", changed: false });
    expect(ensureBlockId("- [ ] Third ^8f3kd2", () => "t-never")).toMatchObject({ blockId: "8f3kd2", changed: false });
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
    const mixed = "a\r\n- [ ] Thank Jörg\nb\r\n";
    const span = locateLine(mixed, { raw: "- [ ] Thank Jörg" });
    if (typeof span === "string") throw new Error(span);
    expect(replaceLine(mixed, span, "- [x] Thank Jörg ✅ 2026-09-24")).toBe("a\r\n- [x] Thank Jörg ✅ 2026-09-24\nb\r\n");
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
    const text = "a\r\n- [ ] Target";
    const span = locateLine(text, { raw: "- [ ] Target" });
    if (typeof span === "string") throw new Error(span);
    expect(replaceLine(text, span, "x\ny")).toBe("a\r\nx\r\ny");
  });
});
