import { describe, expect, it } from "vitest";
import { mapTodoTasks, readTodoLists, todoDue, todoPriority, todoStatus, todoWebUrl } from "./todo";

const LIST = { id: "L1", name: "Privat", shared: false };

const entry = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  "@odata.etag": 'W/"xzyPKP0BiUGgld+lMKXwbQ=="',
  id: "AAMkT1",
  title: "Reifen wechseln",
  status: "notStarted",
  importance: "normal",
  ...overrides,
});

describe("readTodoLists", () => {
  it("keeps every list but flagged emails, with its name and whether it is shared", () => {
    const lists = readTodoLists([
      { id: "L1", displayName: "Aufgaben", wellknownListName: "defaultList", isShared: false },
      { id: "L2", displayName: "Gekennzeichnete E-Mail", wellknownListName: "flaggedEmails" },
      { id: "L3", displayName: "Familie", wellknownListName: "none", isShared: true },
      { displayName: "ohne id" },
    ]);
    expect(lists).toEqual([
      { id: "L1", name: "Aufgaben", shared: false },
      { id: "L3", name: "Familie", shared: true },
    ]);
  });

  it("treats a list whose sharing Graph left out as shared — the dialog asks rather than not", () => {
    expect(readTodoLists([{ id: "L", displayName: "?" }])[0].shared).toBe(true);
  });
});

describe("todoStatus and todoPriority", () => {
  it("reads waiting and deferred as open but waiting, in progress as /, unknown as open", () => {
    expect(["notStarted", "inProgress", "waitingOnOthers", "deferred", "completed", "brandNew"].map(todoStatus)).toEqual([
      { status: " ", waiting: false },
      { status: "/", waiting: false },
      { status: " ", waiting: true },
      { status: " ", waiting: true },
      { status: "x", waiting: false },
      { status: " ", waiting: false },
    ]);
  });

  it("maps high to ⏫ and low to 🔽, normal and missing to none", () => {
    expect(["high", "low", "normal", undefined].map(todoPriority)).toEqual(["high", "low", "none", "none"]);
  });
});

describe("todoDue", () => {
  it("takes the Berlin day of a UTC instant, also just before midnight", () => {
    expect(todoDue({ dateTime: "2026-10-01T00:00:00.0000000", timeZone: "UTC" })).toBe("2026-10-01");
    // Midnight Berlin in summer is 22:00 UTC the day before.
    expect(todoDue({ dateTime: "2026-09-30T22:00:00.0000000", timeZone: "UTC" })).toBe("2026-10-01");
  });

  it("reads another zone's wall clock as its own date, and nothing as no date", () => {
    expect(todoDue({ dateTime: "2026-10-01T00:00:00.0000000", timeZone: "W. Europe Standard Time" })).toBe("2026-10-01");
    expect(todoDue(undefined)).toBeNull();
    expect(todoDue({ dateTime: "gestern", timeZone: "UTC" })).toBeNull();
  });
});

describe("mapTodoTasks", () => {
  it("narrows an entry into a list task under the To Do label, the list as project", () => {
    const { tasks, droppedCount } = mapTodoTasks(LIST, [
      entry({ importance: "high", status: "inProgress", dueDateTime: { dateTime: "2026-10-01T00:00:00.0000000", timeZone: "UTC" } }),
    ]);
    expect(droppedCount).toBe(0);
    expect(tasks[0]).toMatchObject({
      source: "todo",
      id: "AAMkT1",
      listId: "L1",
      description: "Reifen wechseln",
      status: "/",
      priority: "high",
      due: "2026-10-01",
      isWaiting: false,
      isRecurring: false,
      kunde: "To Do",
      projekt: "Privat",
      shared: false,
    });
  });

  it("leaves completed tasks out, drops entries without an id, and notes recurrence", () => {
    const { tasks, droppedCount } = mapTodoTasks(LIST, [
      entry({ status: "completed" }),
      entry({ id: "" }),
      "nonsense",
      entry({ id: "R", recurrence: { pattern: { type: "daily", interval: 1 } } }),
      entry({ id: "E", "@odata.etag": undefined, title: "  " }),
    ]);
    expect(droppedCount).toBe(2);
    expect(tasks.map((task) => [task.id, task.isRecurring, task.etag, task.description])).toEqual([
      ["R", true, 'W/"xzyPKP0BiUGgld+lMKXwbQ=="', "Reifen wechseln"],
      ["E", false, null, "(ohne Titel)"],
    ]);
  });
});

describe("todoWebUrl", () => {
  it("encodes the task id into the path", () => {
    expect(todoWebUrl("AAMk/a=")).toBe("https://to-do.live.com/tasks/id/AAMk%2Fa%3D/details");
  });
});
