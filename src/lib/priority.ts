import { URGENT_WITHIN_DAYS } from "../config";
import { isPlannerTask } from "./planner";
import type { AnyTask } from "./types";

/**
 * The Eisenhower quadrants, as in the web app: same rules, same order, same titles — only
 * "important" now comes from the Tasks priority instead of a flag.
 */
export type Quadrant = "now" | "schedule" | "quick" | "rest";

export const QUADRANT_ORDER: readonly Quadrant[] = ["now", "schedule", "quick", "rest"];

export const QUADRANT_TITLE: Record<Quadrant, string> = {
  now: "Wichtig & dringend",
  schedule: "Wichtig",
  quick: "Dringend",
  rest: "Rest",
};

/** Day arithmetic on a date-ONLY value; UTC is safe because "yyyy-mm-dd" has no zone. */
function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function isImportant(task: Pick<AnyTask, "priority">): boolean {
  return task.priority === "highest" || task.priority === "high";
}

/** Due within URGENT_WITHIN_DAYS, inclusive; overdue is urgent too (a past date is <= the cutoff). */
export function isUrgent(task: Pick<AnyTask, "due">, today: string): boolean {
  return task.due !== null && task.due <= addDays(today, URGENT_WITHIN_DAYS);
}

export function isOverdue(task: Pick<AnyTask, "due">, today: string): boolean {
  return task.due !== null && task.due < today;
}

export function quadrantOf(task: Pick<AnyTask, "priority" | "due">, today: string): Quadrant {
  const important = isImportant(task);
  const urgent = isUrgent(task, today);
  if (important && urgent) return "now";
  if (important) return "schedule";
  if (urgent) return "quick";
  return "rest";
}

const statusRank = (task: AnyTask): number => (task.status === "/" ? 0 : 1);

/** Where a task lives, for the last tie: file and line, or the Planner id. */
const origin = (task: AnyTask): { path: string; line: number } =>
  isPlannerTask(task) ? { path: `planner:${task.id}`, line: 0 } : task;

/**
 * Due date first (none last), then "in progress" before open, then the text. Total — the file and
 * line settle the last tie — so the list never flickers between renders.
 */
export function compareTasks(a: AnyTask, b: AnyTask): number {
  if (a.due !== b.due) {
    if (a.due === null) return 1;
    if (b.due === null) return -1;
    return a.due < b.due ? -1 : 1;
  }
  if (statusRank(a) !== statusRank(b)) return statusRank(a) - statusRank(b);
  const byText = a.description.localeCompare(b.description, "de");
  if (byText !== 0) return byText;
  const [from, to] = [origin(a), origin(b)];
  if (from.path !== to.path) return from.path.localeCompare(to.path, "de");
  return from.line - to.line;
}
