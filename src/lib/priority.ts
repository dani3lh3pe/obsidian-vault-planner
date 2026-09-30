import { URGENT_WITHIN_DAYS } from "../config";
import { isPlannerTask } from "./planner";
import { isTodoTask } from "./todo";
import type { AnyTask, Priority } from "./types";

/**
 * The list's groups, by date: what is overdue on top, then what is due soonest. The date is 📅, or
 * ⏳ where a line has none — the live vault's imports carry only ⏳.
 */
export type Group = "overdue" | "today" | "week" | "later" | "none";

export const GROUP_ORDER: readonly Group[] = ["overdue", "today", "week", "later", "none"];

export const GROUP_TITLE: Record<Group, string> = {
  overdue: "Überfällig",
  today: "Heute",
  week: `Nächste ${URGENT_WITHIN_DAYS} Tage`,
  later: "Später",
  none: "Ohne Datum",
};

/** Day arithmetic on a date-ONLY value; UTC is safe because "yyyy-mm-dd" has no zone. */
function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** The task's own date: 📅, else ⏳. The list may move it earlier, to its next block (taskList). */
export function listDate(task: Pick<AnyTask, "due" | "scheduled">): string | null {
  return task.due ?? task.scheduled;
}

export function groupOf(date: string | null, today: string): Group {
  if (date === null) return "none";
  if (date < today) return "overdue";
  if (date === today) return "today";
  return date <= addDays(today, URGENT_WITHIN_DAYS) ? "week" : "later";
}

/** The task's own date strictly before today; a past ⏳ counts too, it is the date the card shows. */
export const isOverdue = (task: Pick<AnyTask, "due" | "scheduled">, today: string): boolean => groupOf(listDate(task), today) === "overdue";

/**
 * The Tasks emoji and its name, for the card: without the quadrants nothing else shows a priority.
 * Planner's "urgent" and "important" arrive as highest and high.
 */
export const PRIORITY_MARK: Record<Priority, { mark: string; name: string } | null> = {
  highest: { mark: "🔺", name: "höchste" },
  high: { mark: "⏫", name: "hoch" },
  medium: { mark: "🔼", name: "mittel" },
  none: null,
  low: { mark: "🔽", name: "niedrig" },
  lowest: { mark: "⏬", name: "niedrigste" },
};

const PRIORITY_RANK: Record<Priority, number> = { highest: 0, high: 1, medium: 2, none: 3, low: 4, lowest: 5 };

const statusRank = (task: AnyTask): number => (task.status === "/" ? 0 : 1);

/** Where a task lives, for the last tie: file and line, or the Planner or To Do id. */
const origin = (task: AnyTask): { path: string; line: number } => {
  if (isPlannerTask(task)) return { path: `planner:${task.id}`, line: 0 };
  if (isTodoTask(task)) return { path: `todo:${task.id}`, line: 0 };
  return task;
};

/**
 * The list date first (none last), then the priority, then "in progress" before open, then the
 * text. Total — the file and line settle the last tie — so the list never flickers between renders.
 */
export function compareTasks(a: AnyTask, b: AnyTask, dateOf: (task: AnyTask) => string | null = listDate): number {
  const [dateA, dateB] = [dateOf(a), dateOf(b)];
  if (dateA !== dateB) {
    if (dateA === null) return 1;
    if (dateB === null) return -1;
    return dateA < dateB ? -1 : 1;
  }
  if (a.priority !== b.priority) return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  if (statusRank(a) !== statusRank(b)) return statusRank(a) - statusRank(b);
  const byText = a.description.localeCompare(b.description, "de");
  if (byText !== 0) return byText;
  const [from, to] = [origin(a), origin(b)];
  if (from.path !== to.path) return from.path.localeCompare(to.path, "de");
  return from.line - to.line;
}
