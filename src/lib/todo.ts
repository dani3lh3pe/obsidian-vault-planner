import { TODO_LABEL } from "../config";
import { isRecord } from "./odata";
import { fromGraphUtc, plannerDay } from "./time";
import type { AnyTask, Priority, TodoTask } from "./types";

/**
 * Microsoft To Do of the personal account (M9): Graph's lists and tasks -> list entries. Shape
 * only, like the Planner mapping; what the entries mean for the list is taskList's job.
 */

export function isTodoTask(task: AnyTask): task is TodoTask {
  return "source" in task && task.source === "todo";
}

export interface TodoList {
  id: string;
  name: string;
  shared: boolean;
}

export interface TodoSnapshot {
  tasks: TodoTask[];
  /** Entries Graph sent that could not be narrowed. Surfaced, never swallowed. */
  droppedCount: number;
  /** The page limit cut a collection short: tasks are missing. */
  truncated: boolean;
}

/** Every list but "Flagged emails": those are mails, not tasks (spec Nr. 8). */
export function readTodoLists(raw: readonly unknown[]): TodoList[] {
  const lists: TodoList[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.id !== "string" || item.id === "") continue;
    if (item.wellknownListName === "flaggedEmails") continue;
    lists.push({
      id: item.id,
      name: typeof item.displayName === "string" && item.displayName.trim() !== "" ? item.displayName.trim() : "(ohne Namen)",
      // Unknown asks: the dialog is the only guard of the write, like Planner's unreadable assignments.
      shared: item.isShared !== false,
    });
  }
  return lists;
}

/** high -> ⏫, low -> 🔽, normal or missing -> none (spec Nr. 11). */
export function todoPriority(importance: unknown): Priority {
  if (importance === "high") return "high";
  if (importance === "low") return "low";
  return "none";
}

/**
 * notStarted open, inProgress in progress, completed done; waitingOnOthers and deferred are open
 * but under "Warten auf" (spec Nr. 10). An unknown value reads as open, not as done.
 */
export function todoStatus(status: unknown): { status: string; waiting: boolean } {
  if (status === "completed") return { status: "x", waiting: false };
  if (status === "inProgress") return { status: "/", waiting: false };
  return { status: " ", waiting: status === "waitingOnOthers" || status === "deferred" };
}

/**
 * The due date as a Berlin day (spec Nr. 12). Graph answers in UTC: the instant is read and its
 * Berlin day taken, like Planner's. Any other zone is a wall clock in that zone, whose date is
 * the day itself.
 */
export function todoDue(due: unknown): string | null {
  if (!isRecord(due) || typeof due.dateTime !== "string" || !/^\d{4}-\d{2}-\d{2}/u.test(due.dateTime)) return null;
  if (due.timeZone !== "UTC") return due.dateTime.slice(0, 10);
  const instant = fromGraphUtc(due.dateTime);
  return Number.isNaN(instant.getTime()) ? null : plannerDay(instant);
}

/** One list's tasks. Completed ones are left out, entries without an id are dropped and counted. */
export function mapTodoTasks(list: TodoList, raw: readonly unknown[]): { tasks: TodoTask[]; droppedCount: number } {
  const tasks: TodoTask[] = [];
  let droppedCount = 0;
  for (const item of raw) {
    if (!isRecord(item) || typeof item.id !== "string" || item.id === "") {
      droppedCount += 1;
      continue;
    }
    const { status, waiting } = todoStatus(item.status);
    if (status === "x") continue;
    const etag = item["@odata.etag"];
    tasks.push({
      source: "todo",
      id: item.id,
      listId: list.id,
      etag: typeof etag === "string" && etag !== "" ? etag : null,
      description: typeof item.title === "string" && item.title.trim() !== "" ? item.title.trim() : "(ohne Titel)",
      status,
      priority: todoPriority(item.importance),
      due: todoDue(item.dueDateTime),
      scheduled: null,
      isWaiting: waiting,
      isRecurring: isRecord(item.recurrence),
      kunde: TODO_LABEL,
      projekt: list.name,
      shared: list.shared,
    });
  }
  return { tasks, droppedCount };
}

/** Assumed like Planner's link (spec Nr. 38): checked live. Only a click opens it (Invariant 6). */
export function todoWebUrl(taskId: string): string {
  return `https://to-do.live.com/tasks/id/${encodeURIComponent(taskId)}/details`;
}
