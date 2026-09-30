import { STATUS_WINDOW_DAYS } from "../config";
import { isPlannerTask } from "./planner";
import { isTodoTask } from "./todo";
import type { AnyTask, Block, CalendarEvent, PlanStatus, TimeRange } from "./types";

/**
 * Which task is planned, derived from the calendar on every render — never stored. The event's
 * extended property is the only link: "<vaultName>|<blockId>" for a vault task, "planner:<taskId>"
 * for a Planner task — which needs no vault write at all.
 */

/**
 * A Planner task is the same in every vault, so its link carries no vault name: the test vault and
 * the live vault share one calendar and must agree on it. Never confused with a vault link — block
 * ids are [a-zA-Z0-9-] and a Windows folder name cannot hold ":".
 */
const PLANNER_KEY = "planner:";

export function plannerKey(taskId: string): string {
  return `${PLANNER_KEY}${taskId}`;
}

export function plannerIdOf(key: string): string | null {
  return key.startsWith(PLANNER_KEY) && key.length > PLANNER_KEY.length ? key.slice(PLANNER_KEY.length) : null;
}

/** A To Do task's link (M9): vault-independent like Planner's. Its blocks live in the private calendar. */
export function todoKey(taskId: string): string {
  return `todo:${taskId}`;
}

/** The key a task's blocks carry — null for a vault task that was never booked. */
export function linkKey(task: AnyTask): string | null {
  if (isPlannerTask(task)) return plannerKey(task.id);
  if (isTodoTask(task)) return todoKey(task.id);
  return task.blockId;
}

/**
 * The key an event links to: a block id only for THIS vault (the test vault shares the calendar),
 * a Planner key in any vault.
 */
export function parseTaskLink(link: string | null, vaultName: string): string | null {
  if (link === null) return null;
  if (plannerIdOf(link) !== null) return link;
  const prefix = `${vaultName}|`;
  return link.startsWith(prefix) && link.length > prefix.length ? link.slice(prefix.length) : null;
}

/**
 * Monday of the current week, 00:00 local, to STATUS_WINDOW_DAYS later. Counted in calendar days,
 * not milliseconds, so a DST change inside the window cannot shift its end by an hour.
 */
export function statusWindow(now: Date): TimeRange {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const end = new Date(start);
  end.setDate(end.getDate() + STATUS_WINDOW_DAYS);
  return { start, end };
}

/** One read covers what is on screen AND what the status needs, so paging never changes the status. */
export function fetchRange(displayed: TimeRange, now: Date): TimeRange {
  const status = statusWindow(now);
  return {
    start: new Date(Math.min(displayed.start.getTime(), status.start.getTime())),
    end: new Date(Math.max(displayed.end.getTime(), status.end.getTime())),
  };
}

function overlaps(item: { start: Date; end: Date }, range: TimeRange): boolean {
  return item.start.getTime() < range.end.getTime() && item.end.getTime() > range.start.getTime();
}

export function inRange<T extends { start: Date; end: Date }>(items: readonly T[], range: TimeRange): T[] {
  return items.filter((item) => overlaps(item, range));
}

/** Our blocks per block id inside `range`, sorted by start. A cancelled entry is not a plan. */
export function blocksByTask(
  events: readonly CalendarEvent[],
  vaultName: string,
  range: TimeRange,
): Map<string, Block[]> {
  const result = new Map<string, Block[]>();
  for (const event of events) {
    if (event.isCancelled || !overlaps(event, range)) continue;
    const blockId = parseTaskLink(event.taskLink, vaultName);
    if (blockId === null) continue;
    const list = result.get(blockId) ?? [];
    list.push({ eventId: event.id, start: event.start, end: event.end });
    result.set(blockId, list);
  }
  for (const list of result.values()) list.sort((a, b) => a.start.getTime() - b.start.getTime());
  return result;
}

/**
 * geplant: a block that has not ended (running counts). abgelaufen: blocks, all over — the task
 * counts as unplanned again, no button needed. ungeplant: no block in the window.
 */
export function planStatus(blocks: readonly Block[] | undefined, now: Date): PlanStatus {
  if (blocks === undefined || blocks.length === 0) return { kind: "ungeplant" };
  const next = blocks.find((block) => block.end.getTime() > now.getTime());
  if (next !== undefined) return { kind: "geplant", next };
  return { kind: "abgelaufen", last: blocks[blocks.length - 1] };
}
