import { describe, expect, it } from "vitest";
import { ensureBlockId, insertTaskLines, locateLine, newBlockId, newTaskLines, replaceLine } from "./taskLine";

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

describe("newTaskLines", () => {
  it("writes the task line and one tab-indented bullet per non-empty info line", () => {
    expect(newTaskLines("  Call Jörg  ", "Number in the CRM\r\n\n  Ask about the offer  \n", "2026-10-11", "t-new001")).toEqual([
      "- [ ] Call Jörg ➕ 2026-10-11 ^t-new001",
      "\t- Number in the CRM",
      "\t- Ask about the offer",
    ]);
  });

  it("never splits the task over two lines", () => {
    expect(newTaskLines("First\r\n  second", "", "2026-10-11", "t-new001")).toEqual(["- [ ] First second ➕ 2026-10-11 ^t-new001"]);
  });

  it("drops a bullet typed out of habit, but keeps a typed sub-task", () => {
    expect(newTaskLines("X", "- Number\n* two\n+ three\n- [ ] Call back\n-", "2026-10-11", "t-new001").slice(1)).toEqual([
      "\t- Number",
      "\t- two",
      "\t- three",
      "\t- [ ] Call back",
    ]);
  });

  it("puts a set global filter in front, or Tasks would not see the line", () => {
    expect(newTaskLines("Call", "", "2026-10-11", "t-new001", "#task")).toEqual(["- [ ] #task Call ➕ 2026-10-11 ^t-new001"]);
  });
});

describe("insertTaskLines", () => {
  const NEW = ["- [ ] New ➕ 2026-10-11 ^t-new001", "\t- Info"];

  it("goes below the last open top-level task and the lines that belong to it", () => {
    const text = [
      "## Open tasks",
      "- [ ] First",
      "- [/] Last open, with its lines",
      "    ```yaml",
      "    time: 1h",
      "",
      "    more: 2h",
      "    ```",
      "    - [ ] Sub-task",
      "- [x] Done",
      "",
      "> - [ ] Quoted",
      "```",
      "- [ ] Copy in a code block",
      "```",
      "",
    ].join("\n");
    const expected = text.replace("    - [ ] Sub-task\n", "    - [ ] Sub-task\n- [ ] New ➕ 2026-10-11 ^t-new001\n\t- Info\n");
    expect(insertTaskLines(text, NEW)).toBe(expected);
  });

  it("keeps the lines after a blank line that still belong to the task, as Markdown does", () => {
    const text = "- [ ] A\n    - sub\n\n    - [ ] Deep sub-task\n\n## Next\n";
    expect(insertTaskLines(text, NEW)).toBe(text.replace("Deep sub-task\n", "Deep sub-task\n- [ ] New ➕ 2026-10-11 ^t-new001\n\t- Info\n"));
  });

  it("stops at an unindented code block after the task: it is not the task's", () => {
    const text = "- [ ] A\n```yaml\nmeta: 1\n```\n## Notes\n";
    expect(insertTaskLines(text, NEW)).toBe(text.replace("- [ ] A\n", "- [ ] A\n- [ ] New ➕ 2026-10-11 ^t-new001\n\t- Info\n"));
  });

  it("takes the anchor line's own ending in a mixed file", () => {
    expect(insertTaskLines("# P\r\n- [ ] A\nb\r\n", NEW)).toBe("# P\r\n- [ ] A\n- [ ] New ➕ 2026-10-11 ^t-new001\n\t- Info\nb\r\n");
  });

  it.each([
    ["a fence left open under the task", "- [ ] A\n    ```\n    code\n"],
    ["a fence left open in a note without tasks", "# C\n\n```\ncode\n"],
    ["a closer the fence rules do not accept", "- [ ] A\n  ```\n  code\n   ```\n- [ ] B\n## H\ntext\n"],
    ["a fence on a list marker's own line", "- [ ] A\n    - ```bash\n      echo 1\n\n      echo 2\n      ```\n## Notes\n"],
  ])("refuses %s rather than write into code", (_case, text) => {
    expect(insertTaskLines(text, NEW)).toBeNull();
  });

  it("keeps CRLF and a last line without an ending", () => {
    expect(insertTaskLines("# P\r\n- [ ] Only", NEW)).toBe("# P\r\n- [ ] Only\r\n- [ ] New ➕ 2026-10-11 ^t-new001\r\n\t- Info");
  });

  it("appends to a note without an open task", () => {
    expect(insertTaskLines("# Customer\n\n- [x] Done\n", NEW)).toBe("# Customer\n\n- [x] Done\n- [ ] New ➕ 2026-10-11 ^t-new001\n\t- Info\n");
    expect(insertTaskLines("# Customer\r\nText", NEW)).toBe("# Customer\r\nText\r\n- [ ] New ➕ 2026-10-11 ^t-new001\r\n\t- Info\r\n");
    expect(insertTaskLines("", NEW)).toBe("- [ ] New ➕ 2026-10-11 ^t-new001\n\t- Info\n");
  });

  it("never takes a task in a code block as the place", () => {
    const text = "Intro\n\n```\n- [ ] Copy\n```\n";
    expect(insertTaskLines(text, NEW)).toBe(`${text}- [ ] New ➕ 2026-10-11 ^t-new001\n\t- Info\n`);
  });
});
