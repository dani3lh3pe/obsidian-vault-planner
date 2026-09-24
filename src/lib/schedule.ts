import { STATUS_WINDOW_DAYS } from "../config";
import type { Block, CalendarEvent, PlanStatus, TimeRange } from "./types";

/**
 * Which task is planned, derived from the calendar on every render — never stored. The event's
 * extended property ("<vaultName>|<blockId>") is the only link; the vault holds just the block id.
 */

/** The block id an event links to — but only for THIS vault: the test vault shares the calendar. */
export function parseTaskLink(link: string | null, vaultName: string): string | null {
  if (link === null) return null;
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
