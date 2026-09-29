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
  /** Outlook category names, in the event's order; the first one with a colour tints it. */
  categories: string[];
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
  /** Text left of the Tasks fields, block link removed. Still carries links and old `[aufwand::]` notes. */
  description: string;
  priority: Priority;
  /** yyyy-mm-dd from 📅, or null. */
  due: string | null;
  /**
   * yyyy-mm-dd from ⏳, or null. Read only, as the list's date where 📅 is missing — never written,
   * never the plan status (Invariant 1).
   */
  scheduled: string | null;
  blockId: string | null;
  isWaiting: boolean;
  isRecurring: boolean;
  kunde: string;
  projekt: string | null;
}

/**
 * A Planner task assigned to the signed-in user. Resolved on every read, never stored. Carries the
 * list fields under the same names as VaultTask, so groups, sorting and filters apply as they are.
 */
export interface PlannerTask {
  source: "planner";
  id: string;
  /** From the last read; every PATCH sends it as If-Match. */
  etag: string;
  planId: string;
  bucketId: string | null;
  /** The title. */
  description: string;
  /** In the vault's checkbox alphabet: " " open, "/" in progress (1–99 %), "x" done. */
  status: string;
  priority: Priority;
  due: string | null;
  scheduled: null;
  isWaiting: false;
  kunde: string;
  /** The plan's title, or null while it is unknown. */
  projekt: string | null;
  /**
   * How many OTHER people the task is assigned to: completing it closes it for them too. null when
   * the assignments could not be read — treated as shared, never as "only me".
   */
  othersAssigned: number | null;
}

export type AnyTask = VaultTask | PlannerTask;

export interface PlannerBucket {
  id: string;
  name: string;
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
