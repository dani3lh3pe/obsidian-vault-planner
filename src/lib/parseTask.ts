import { CUSTOMER_ROOT, INTERN_LABEL, INTERN_ROOT, TASKS_GLOBAL_FILTER } from "../config";
import type { Priority, VaultTask } from "./types";

/**
 * A task line read the way the Tasks plugin reads it — so the planner never shows a due date that
 * Tasks does not see, or hides one it does.
 *
 * The field patterns follow Tasks' DefaultTaskSerializer (MIT, github.com/obsidian-tasks-group/
 * obsidian-tasks): every field is matched at the END of what is left of the line, in any order,
 * with an optional U+FE0F after the emoji. Anything else at the end stops the scan — so a link
 * after `📅 …` makes the date plain description text, in Tasks and here alike.
 */

const VS = "\\uFE0F?";
function field(symbols: string, value: string | null): RegExp {
  return new RegExp(`${symbols}${VS}${value === null ? "" : ` *${value}`}$`, "u");
}

const DATE = "(\\d{4}-\\d{2}-\\d{2})";
const TASK_ID = "[a-zA-Z0-9-_]+";

const PRIORITY = field("([🔺⏫🔼🔽⏬])", null);
const DUE = field("(?:📅|📆|🗓)", DATE);
const SCHEDULED = field("(?:⏳|⌛)", DATE);
const RECURRENCE = field("🔁", "([a-zA-Z0-9, !]+)");
/** Fields the planner does not use but must strip, or the scan would stop at them. */
const OTHER_FIELDS: readonly RegExp[] = [
  field("🛫", DATE),
  field("➕", DATE),
  field("✅", DATE),
  field("❌", DATE),
  field("🏁", "([a-zA-Z]+)"),
  field("⛔", `(${TASK_ID}( *, *${TASK_ID} *)*)`),
  field("🆔", `(${TASK_ID})`),
];
/** Tags may sit between fields (Tasks >= 1.9); they stay part of the description. */
const TAG_AT_END = /(^|\s)#[^\s!@#$%^&*(),.?":{}|<>]+$/u;

/** Tasks' task line: indentation or quote marks, a list marker, one status character, the body. */
const TASK_LINE = /^([\s\t>]*)([-*+]|[0-9]+[.)]) +\[(.)\] *(.*)$/u;
/** Tasks' block link: a space, a caret, the id, at the very end. */
const BLOCK_LINK = / \^([a-zA-Z0-9-]+)$/u;

const PRIORITIES: Record<string, Priority> = {
  "🔺": "highest",
  "⏫": "high",
  "🔼": "medium",
  "🔽": "low",
  "⏬": "lowest",
};

const AUFWAND = /\[aufwand::\s*([0-9]+(?:[.,][0-9]+)?)\s*(h|m|min)?\s*\]/iu;

export interface ParsedLine {
  status: string;
  description: string;
  priority: Priority;
  due: string | null;
  scheduled: string | null;
  aufwand: number | undefined;
  blockId: string | null;
  isWaiting: boolean;
  isRecurring: boolean;
}

/** Hours from `[aufwand:: 2h]`, `[aufwand:: 90m]`, `[aufwand:: 1,5h]`; a bare number is hours. */
export function parseAufwand(text: string): number | undefined {
  const match = AUFWAND.exec(text);
  if (match === null) return undefined;
  const value = Number.parseFloat(match[1].replace(",", "."));
  const unit = (match[2] ?? "h").toLowerCase();
  const hours = unit === "h" ? value : value / 60;
  return Number.isFinite(hours) && hours > 0 ? hours : undefined;
}

export function parseTaskLine(line: string, globalFilter: string = TASKS_GLOBAL_FILTER): ParsedLine | null {
  const match = TASK_LINE.exec(line);
  if (match === null) return null;
  // Tasks ignores checkbox lines without the global filter; so must the planner.
  if (globalFilter !== "" && !line.includes(globalFilter)) return null;

  let body = match[4].trim();
  let blockId: string | null = null;
  const link = BLOCK_LINK.exec(body);
  if (link !== null) {
    blockId = link[1];
    body = body.replace(BLOCK_LINK, "").trim();
  }

  let priority: Priority = "none";
  let due: string | null = null;
  let scheduled: string | null = null;
  let isRecurring = false;
  const trailingTags: string[] = [];

  // Strip fields from the end until none matches — the same loop, and the same failsafe, as Tasks.
  // A field that appears twice ends with the LEFTMOST value, because it is matched last; Tasks too.
  let matched: boolean;
  let runs = 0;
  do {
    matched = false;
    const priorityMatch = PRIORITY.exec(body);
    if (priorityMatch !== null) {
      priority = PRIORITIES[priorityMatch[1]] ?? "none";
      body = body.replace(PRIORITY, "").trim();
      matched = true;
    }
    const dueMatch = DUE.exec(body);
    if (dueMatch !== null) {
      due = dueMatch[1];
      body = body.replace(DUE, "").trim();
      matched = true;
    }
    const scheduledMatch = SCHEDULED.exec(body);
    if (scheduledMatch !== null) {
      scheduled = scheduledMatch[1];
      body = body.replace(SCHEDULED, "").trim();
      matched = true;
    }
    if (RECURRENCE.test(body)) {
      isRecurring = true;
      body = body.replace(RECURRENCE, "").trim();
      matched = true;
    }
    for (const other of OTHER_FIELDS) {
      if (other.test(body)) {
        body = body.replace(other, "").trim();
        matched = true;
      }
    }
    const tag = TAG_AT_END.exec(body);
    if (tag !== null) {
      trailingTags.unshift(tag[0].trim());
      body = body.replace(TAG_AT_END, "").trim();
      matched = true;
    }
    runs += 1;
  } while (matched && runs <= 20);

  const description = [body, ...trailingTags].filter((part) => part !== "").join(" ");
  return {
    status: match[3],
    description,
    priority,
    due,
    scheduled,
    aufwand: parseAufwand(description),
    blockId,
    isWaiting: /^WAITING\b/u.test(description),
    isRecurring,
  };
}

/**
 * Which customer and project a file belongs to — or null when it is not a task source.
 * A source is any `<Folder>/<Folder>.md` below 10_Kunden/ or 20_Intern/. Meeting notes, OneDrive
 * conflict copies ("Projekt-DESKTOP.md") and everything else stay out.
 */
export function taskSource(path: string): { kunde: string; projekt: string | null } | null {
  const parts = path.split("/");
  const file = parts[parts.length - 1];
  if (parts.length < 3 || !file.endsWith(".md")) return null;
  const folder = parts[parts.length - 2];
  if (file.slice(0, -3) !== folder) return null;

  if (parts[0] === CUSTOMER_ROOT) return { kunde: parts[1], projekt: parts.length === 3 ? null : folder };
  if (parts[0] === INTERN_ROOT) return { kunde: INTERN_LABEL, projekt: folder };
  return null;
}

/**
 * The tasks of one file. `taskLines` are the 0-based lines Obsidian's metadata cache marked as
 * tasks — it already skips code blocks, which a regex over the whole file would not.
 */
export function parseFileTasks(path: string, text: string, taskLines: readonly number[]): VaultTask[] {
  const source = taskSource(path);
  if (source === null) return [];
  const lines = text.split(/\r?\n/);
  const tasks: VaultTask[] = [];
  for (const line of taskLines) {
    const raw = lines[line];
    if (raw === undefined) continue;
    const parsed = parseTaskLine(raw);
    if (parsed === null) continue;
    tasks.push({ path, line, raw, ...parsed, ...source });
  }
  return tasks;
}
