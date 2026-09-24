import type { EventInput } from "@fullcalendar/core";
import { parseTaskLink } from "./schedule";
import type { CalendarEvent } from "./types";

/** Entries where the user is available must not visually block a free slot. */
const AVAILABLE = new Set(["free", "workingElsewhere"]);

/**
 * What the grid knows about one of our blocks' task:
 * open/done — found once; missing — no task line has the id; conflict — more than one has it;
 * pending — the index is not complete yet, so "missing" would be a guess.
 */
export type BlockState = "open" | "done" | "missing" | "conflict" | "pending";

export interface EventProps {
  kind: "own" | "meeting";
  blockId: string | null;
  state: BlockState | null;
}

/**
 * Calendar events -> what FullCalendar renders. The only place that decides what showAs,
 * isCancelled and isAllDay MEAN for display (ported from daily-planner; own blocks are now
 * recognised by the task property instead of a stored id list).
 */
export function toFullCalendarEvents(
  events: readonly CalendarEvent[],
  vaultName: string,
  stateOf: (blockId: string) => BlockState,
): EventInput[] {
  const result: EventInput[] = [];

  for (const event of events) {
    // A cancelled event can still sit in the calendar; a declined invitation is not blocked time.
    if (event.isCancelled || event.responseStatus === "declined") continue;

    const blockId = parseTaskLink(event.taskLink, vaultName);
    const state = blockId === null ? null : stateOf(blockId);
    const extendedProps: EventProps = { kind: blockId === null ? "meeting" : "own", blockId, state };
    const classNames = blockId === null ? ["vp-meeting"] : ["vp-block", `vp-block-${state}`];

    if (event.isAllDay) {
      // Midnight bounds, `end` on the FOLLOWING day: take the date prefix and never compute a
      // position from them. Never draggable — the all-day row has no times to PATCH back.
      result.push({
        id: event.id,
        title: event.subject,
        start: event.start.toISOString().slice(0, 10),
        end: event.end.toISOString().slice(0, 10),
        allDay: true,
        editable: false,
        classNames,
        extendedProps,
      });
      continue;
    }

    result.push({
      id: event.id,
      title: event.subject,
      start: event.start,
      end: event.end,
      // "free"/"workingElsewhere" tint the slot without claiming it.
      display: AVAILABLE.has(event.showAs) ? "background" : "auto",
      // Only our own blocks move: dragging a real meeting would rewrite someone else's appointment.
      editable: blockId !== null,
      classNames,
      extendedProps,
    });
  }

  return result;
}
