import { isRecord } from "./odata";
import { fromGraphUtc } from "./time";
import type { CalendarEvent, ShowAs } from "./types";

const SHOW_AS_VALUES: readonly string[] = ["free", "tentative", "busy", "oof", "workingElsewhere"];

export interface MapResult {
  events: CalendarEvent[];
  /** Entries Graph sent that could not be narrowed. Surfaced, never swallowed. */
  droppedCount: number;
}

/**
 * Read a Graph dateTimeTimeZone — but ONLY when it is the UTC we asked for. The single place a
 * wall-clock string becomes an instant. A non-UTC zone means someone added the
 * Prefer: outlook.timezone header; guessing would shift every event by the offset.
 */
function readUtcInstant(value: unknown): Date | null {
  if (!isRecord(value)) return null;
  if (value.timeZone !== "UTC") return null;
  if (typeof value.dateTime !== "string") return null;
  const instant = fromGraphUtc(value.dateTime);
  return Number.isNaN(instant.getTime()) ? null : instant;
}

function readShowAs(value: unknown): ShowAs {
  return typeof value === "string" && SHOW_AS_VALUES.includes(value) ? (value as ShowAs) : "unknown";
}

function readResponse(value: unknown): string {
  return isRecord(value) && typeof value.response === "string" ? value.response : "none";
}

/**
 * The `$expand=singleValueExtendedProperties($filter=id eq …)` result. The filter already chose
 * the one property, so the first entry's value is taken as is — comparing the id would depend on
 * the spelling Graph echoes back.
 */
function readTaskLink(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const first: unknown = value[0];
  return isRecord(first) && typeof first.value === "string" && first.value !== "" ? first.value : null;
}

/**
 * Shape only: unknown[] -> CalendarEvent[]. Drops what cannot be narrowed and counts it. Never
 * filters on meaning — cancelled, declined and all-day events all survive this step.
 */
export function mapGraphEvents(raw: readonly unknown[]): MapResult {
  const events: CalendarEvent[] = [];
  let droppedCount = 0;

  for (const item of raw) {
    if (!isRecord(item) || typeof item.id !== "string" || item.id.length === 0) {
      droppedCount += 1;
      continue;
    }
    const start = readUtcInstant(item.start);
    const end = readUtcInstant(item.end);
    if (start === null || end === null) {
      droppedCount += 1;
      continue;
    }

    events.push({
      id: item.id,
      subject: typeof item.subject === "string" ? item.subject : "(ohne Betreff)",
      start,
      end,
      isAllDay: item.isAllDay === true,
      isCancelled: item.isCancelled === true,
      showAs: readShowAs(item.showAs),
      responseStatus: readResponse(item.responseStatus),
      taskLink: readTaskLink(item.singleValueExtendedProperties),
    });
  }

  return { events, droppedCount };
}
