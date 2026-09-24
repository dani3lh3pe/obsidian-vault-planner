import {
  EVENT_PAGE_SIZE,
  EVENT_SELECT,
  GRAPH_BASE,
  PLANNER_TIME_ZONE,
  TASK_PROPERTY_ID,
} from "../config";
import { toWallClock } from "./time";
import type { TimeRange } from "./types";

/**
 * Query strings with encodeURIComponent: spaces become %20. URLSearchParams would write "+",
 * and Graph's OData parser does not promise to read "+" as a space inside a $filter.
 */
export function encodeParams(params: ReadonlyArray<readonly [string, string]>): string {
  return params.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&");
}

/**
 * /me/calendarView, not /me/events: only calendarView expands series server-side and applies
 * their exceptions. The $expand brings our task property along, so recognising our own blocks
 * costs no second request.
 */
export function calendarViewUrl(range: TimeRange): string {
  return `${GRAPH_BASE}/me/calendarView?${encodeParams([
    ["startDateTime", range.start.toISOString()],
    ["endDateTime", range.end.toISOString()],
    ["$select", EVENT_SELECT],
    ["$expand", `singleValueExtendedProperties($filter=id eq '${TASK_PROPERTY_ID}')`],
    ["$top", String(EVENT_PAGE_SIZE)],
  ])}`;
}

/** Ids are base64-ish and can carry "=" or "/". */
export function eventUrl(eventId: string): string {
  return `${GRAPH_BASE}/me/events/${encodeURIComponent(eventId)}`;
}

function slot(start: Date, end: Date) {
  return {
    start: { dateTime: toWallClock(start), timeZone: PLANNER_TIME_ZONE },
    end: { dateTime: toWallClock(end), timeZone: PLANNER_TIME_ZONE },
  };
}

export interface NewBlock {
  subject: string;
  body: string;
  start: Date;
  end: Date;
  /** "<vaultName>|<blockId>" */
  link: string;
}

/**
 * The POST body for a focus block.
 *
 * Deliberately absent: `attendees` (Graph mails an invitation to everyone in it, even for an empty
 * draft of intent) and `categories` (decoration the user did not want in the web app either).
 */
export function createEventBody(block: NewBlock, transactionId: string): Record<string, unknown> {
  return {
    subject: block.subject,
    body: { contentType: "text", content: block.body },
    ...slot(block.start, block.end),
    showAs: "busy",
    // Outlook defaults to a 15-minute reminder; a self-blocker that beeps is noise.
    isReminderOn: false,
    // Guards a POST that the transport re-sends; a second drop is a second transaction.
    transactionId,
    singleValueExtendedProperties: [{ id: TASK_PROPERTY_ID, value: block.link }],
  };
}

/** PATCH body for a move or resize: the times, nothing else. */
export function moveEventBody(start: Date, end: Date): Record<string, unknown> {
  return slot(start, end);
}
