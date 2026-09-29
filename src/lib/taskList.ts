import { OPEN_STATUSES } from "../config";
import { compareTasks, GROUP_ORDER, groupOf, type Group } from "./priority";
import { cleanTitle } from "./subject";
import type { AnyTask, PlanStatus } from "./types";

export interface ListOptions {
  search: string;
  /** null = all customers. */
  kunde: string | null;
  onlyUnplanned: boolean;
}

export interface ListModel {
  groups: { key: Group; tasks: AnyTask[] }[];
  /** WAITING tasks: their own group, collapsed at the end — waiting is not something to plan. */
  waiting: AnyTask[];
  /** Every customer with an open task, for the dropdown — independent of the filters. */
  kunden: string[];
  openCount: number;
  shownCount: number;
}

export function isOpen(task: Pick<AnyTask, "status">): boolean {
  return OPEN_STATUSES.includes(task.status);
}

/**
 * The planning list. `statusOf` is null while the calendar is not ready: the status is unknown
 * then, and "nur ungeplante" must not claim anything (the view disables the box too).
 */
export function buildList(
  tasks: readonly AnyTask[],
  statusOf: ((task: AnyTask) => PlanStatus) | null,
  options: ListOptions,
  today: string,
): ListModel {
  const open = tasks.filter(isOpen);
  const kunden = [...new Set(open.map((task) => task.kunde))].sort((a, b) => a.localeCompare(b, "de"));
  const needle = options.search.trim().toLocaleLowerCase("de");

  const visible = open
    .filter((task) => {
      if (options.kunde !== null && task.kunde !== options.kunde) return false;
      if (needle !== "") {
        const haystack = [cleanTitle(task.description), task.kunde, task.projekt ?? ""];
        if (!haystack.some((text) => text.toLocaleLowerCase("de").includes(needle))) return false;
      }
      if (options.onlyUnplanned && statusOf !== null && statusOf(task).kind === "geplant") return false;
      return true;
    })
    .sort(compareTasks);

  const groups = GROUP_ORDER.map((key) => ({ key, tasks: [] as AnyTask[] }));
  const waiting: AnyTask[] = [];
  for (const task of visible) {
    if (task.isWaiting) waiting.push(task);
    else groups[GROUP_ORDER.indexOf(groupOf(task, today))].tasks.push(task);
  }
  return { groups, waiting, kunden, openCount: open.length, shownCount: visible.length };
}
