/** Graph's `showAs`. "unknown" covers a value Graph adds after this was written. */
export type ShowAs = "free" | "tentative" | "busy" | "oof" | "workingElsewhere" | "unknown";

/** One calendar entry, normalized: wall-clock strings already resolved to instants. */
export interface CalendarEvent {
  id: string;
  subject: string;
  start: Date;
  end: Date;
  isAllDay: boolean;
  isCancelled: boolean;
  showAs: ShowAs;
  /** "none" | "organizer" | "accepted" | "declined" | … */
  responseStatus: string;
  /** The task property's raw value ("<vaultName>|<blockId>"), or null for anything else. */
  taskLink: string | null;
}

/** A half-open span of time, [start, end). */
export interface TimeRange {
  start: Date;
  end: Date;
}

/** Graph error response body. */
export interface GraphErrorResponse {
  error: {
    code: string;
    message: string;
  };
}

export type Priority = "highest" | "high" | "medium" | "none" | "low" | "lowest";

/** One checkbox line of a source file, as the index saw it. */
export interface VaultTask {
  path: string;
  /** 0-based line at index time. For opening the file only — writes locate by text. */
  line: number;
  /** The line exactly as indexed, without its line ending. */
  raw: string;
  /** The checkbox character: " " open, "/" in progress, "x" done, … */
  status: string;
  /** Text left of the Tasks fields, block link removed. Still carries links and `[aufwand::]`. */
  description: string;
  priority: Priority;
  /** yyyy-mm-dd from 📅, or null. */
  due: string | null;
  /** Hours from `[aufwand:: …]`, or undefined. */
  aufwand: number | undefined;
  blockId: string | null;
  isWaiting: boolean;
  isRecurring: boolean;
  kunde: string;
  projekt: string | null;
}

/** One of our own blocks, as found in the calendar. */
export interface Block {
  eventId: string;
  start: Date;
  end: Date;
}

/** Derived on every render from the calendar — never stored. */
export type PlanStatus =
  | { kind: "geplant"; next: Block }
  | { kind: "abgelaufen"; last: Block }
  | { kind: "ungeplant" };
