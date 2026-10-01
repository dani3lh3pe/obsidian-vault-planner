import { OPEN_STATUSES } from "../config";
import { compareTasks, GROUP_ORDER, groupOf, listDate, type Group } from "./priority";
import { cleanTitle } from "./subject";
import { plannerDay } from "./time";
import type { AnyTask, PlanStatus } from "./types";

export interface ListOptions {
  search: string;
  /** null = all customers. */
  customer: string | null;
  onlyUnplanned: boolean;
}

export interface ListModel {
  groups: { key: Group; tasks: AnyTask[] }[];
  /** WAITING tasks: their own group, collapsed at the end — waiting is not something to plan. */
  waiting: AnyTask[];
  /** Every customer with an open task, for the dropdown — independent of the filters. */
  customers: string[];
  openCount: number;
  shownCount: number;
}

export function isOpen(task: Pick<AnyTask, "status">): boolean {
  return OPEN_STATUSES.includes(task.status);
}

/**
 * The planning list. `statusOf` is null while the calendar is not ready: the status is unknown
 * then, and "unplanned only" must not claim anything (the view disables the box too).
 */
export function buildList(
  tasks: readonly AnyTask[],
  statusOf: ((task: AnyTask) => PlanStatus) | null,
  options: ListOptions,
  today: string,
): ListModel {
  // The earlier of the task's own date and the day of its next block: planned for today is today.
  // A block never moves a task past its deadline — an overdue one stays overdue.
  const dateOf = (task: AnyTask): string | null => {
    const own = listDate(task);
    const plan = statusOf?.(task);
    if (plan?.kind !== "planned") return own;
    // Not before today: a block still running past midnight started "yesterday".
    const start = plannerDay(plan.next.start);
    const day = start < today ? today : start;
    return own === null || day < own ? day : own;
  };
  const open = tasks.filter(isOpen);
  const customers = [...new Set(open.map((task) => task.customer))].sort((a, b) => a.localeCompare(b, "de"));
  const needle = options.search.trim().toLocaleLowerCase("de");

  const visible = open
    .filter((task) => {
      if (options.customer !== null && task.customer !== options.customer) return false;
      if (needle !== "") {
        const haystack = [cleanTitle(task.description), task.customer, task.project ?? ""];
        if (!haystack.some((text) => text.toLocaleLowerCase("de").includes(needle))) return false;
      }
      if (options.onlyUnplanned && statusOf !== null && statusOf(task).kind === "planned") return false;
      return true;
    })
    .sort((a, b) => compareTasks(a, b, dateOf));

  const groups = GROUP_ORDER.map((key) => ({ key, tasks: [] as AnyTask[] }));
  const waiting: AnyTask[] = [];
  for (const task of visible) {
    if (task.isWaiting) waiting.push(task);
    else groups[GROUP_ORDER.indexOf(groupOf(dateOf(task), today))].tasks.push(task);
  }
  return { groups, waiting, customers, openCount: open.length, shownCount: visible.length };
}
