import { PLANNER_LABEL } from "../config";
import { isRecord } from "./odata";
import { fromGraphUtc, plannerDay } from "./time";
import type { AnyTask, PlannerBucket, PlannerTask, Priority } from "./types";

/**
 * Planner's answers -> what the list needs (umsetzungsplan M6; the mappings come from the web
 * app's M13, briefing §12). Shape and meaning only — graph.ts reads, the view decides.
 */

export function isPlannerTask(task: AnyTask): task is PlannerTask {
  return "source" in task;
}

/**
 * Planner's 0–10 scale as a Tasks priority. Planner reads 0–1 as "urgent" and 2–4 as "important" —
 * both are what the quadrants call important. A missing value is Planner's default 5 ("medium"), so
 * absence must read as NOT important: the other reading fills the top row with unrated tasks.
 */
export function plannerPriority(value: unknown): Priority {
  if (typeof value !== "number" || !Number.isFinite(value)) return "none";
  if (value <= 1) return "highest";
  if (value <= 4) return "high";
  return value >= 8 ? "low" : "none";
}

/** 1–99 % is what Planner's own board calls "In Bearbeitung"; 100 is done. */
export function plannerStatus(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return " ";
  return value >= 100 ? "x" : "/";
}

/**
 * A real instant (Planner Web stores 10:00Z), not a date: its Berlin day. The UTC date prefix would
 * be right most of the time and wrong near midnight.
 */
export function plannerDue(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  const instant = fromGraphUtc(value);
  return Number.isNaN(instant.getTime()) ? null : plannerDay(instant);
}

export interface PlannerSnapshot {
  /** Done ones included: their blocks still need a task to belong to. */
  tasks: PlannerTask[];
  /** planId -> buckets in board order, for every plan with an open task. */
  buckets: Map<string, PlannerBucket[]>;
  /** Entries that could not be narrowed or had no etag to write with. Surfaced, never swallowed. */
  droppedCount: number;
  /** More pages than MAX_PLANNER_PAGES: done tasks count too, so a long history can get there. */
  truncated: boolean;
}

/** `GET /me/planner/tasks` entries -> tasks. The plan title is filled in later (`projekt: null`). */
export function mapPlannerTasks(raw: readonly unknown[]): { tasks: PlannerTask[]; droppedCount: number } {
  const tasks: PlannerTask[] = [];
  let droppedCount = 0;
  for (const item of raw) {
    const etag = isRecord(item) ? item["@odata.etag"] : undefined;
    // Without an etag there is no write path: a task that silently refuses to close is worse than
    // one that is visibly not there.
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      item.id === "" ||
      typeof item.planId !== "string" ||
      item.planId === "" ||
      typeof etag !== "string" ||
      etag === ""
    ) {
      droppedCount += 1;
      continue;
    }
    const assigned = isRecord(item.assignments) ? Object.keys(item.assignments).length : null;
    tasks.push({
      source: "planner",
      id: item.id,
      etag,
      planId: item.planId,
      bucketId: typeof item.bucketId === "string" && item.bucketId !== "" ? item.bucketId : null,
      description: typeof item.title === "string" && item.title.trim() !== "" ? item.title.trim() : "(ohne Titel)",
      status: plannerStatus(item.percentComplete),
      priority: plannerPriority(item.priority),
      due: plannerDue(item.dueDateTime),
      aufwand: undefined,
      isWaiting: false,
      kunde: PLANNER_LABEL,
      projekt: null,
      // The signed-in user is one of them: /me/planner/tasks lists only what is assigned to them.
      othersAssigned: assigned === null ? null : Math.max(0, assigned - 1),
    });
  }
  return { tasks, droppedCount };
}

export function planTitle(body: unknown): string | null {
  return isRecord(body) && typeof body.title === "string" && body.title.trim() !== "" ? body.title.trim() : null;
}

/**
 * A plan's buckets in board order. The docs prescribe comparing orderHint by character ordinal;
 * `<` on strings does exactly that for Planner's ASCII hints, localeCompare would not.
 */
export function readBuckets(raw: readonly unknown[]): PlannerBucket[] {
  const buckets: { id: string; name: string; orderHint: string }[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.id !== "string" || item.id === "") continue;
    buckets.push({
      id: item.id,
      name: typeof item.name === "string" && item.name.trim() !== "" ? item.name.trim() : "(ohne Namen)",
      orderHint: typeof item.orderHint === "string" ? item.orderHint : "",
    });
  }
  buckets.sort((a, b) => (a.orderHint < b.orderHint ? -1 : a.orderHint > b.orderHint ? 1 : 0));
  return buckets.map(({ id, name }) => ({ id, name }));
}

/**
 * The task in Planner Web. ponytail: ASSUMED, not verified (the web app used the same form in M14) —
 * umsetzungsplan M6 checks it; the documented alternative needs the planId.
 */
export function plannerWebUrl(tenantId: string, taskId: string): string {
  return `https://tasks.office.com/${encodeURIComponent(tenantId)}/Home/Task/${encodeURIComponent(taskId)}`;
}
