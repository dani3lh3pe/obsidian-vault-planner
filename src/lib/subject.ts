/**
 * Task description -> what a person reads: in the list, and as the Outlook subject.
 */

function linkText(target: string): string {
  const withoutHeading = target.split("#")[0] ?? target;
  return withoutHeading.split("/").pop() ?? withoutHeading;
}

/** Links become their text; an old `[aufwand::]` note (no longer read, M8) and the WAITING marker go. */
export function cleanTitle(description: string): string {
  return description
    .replace(/!\[\[[^\]]*\]\]/gu, "") // embeds
    .replace(/\(\[\[[^\]]*\]\]\)/gu, "") // a source link in parentheses, e.g. ([[…_capture]])
    .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/gu, "$1") // [[target|alias]] -> alias
    .replace(/\[\[([^\]]*)\]\]/gu, (_whole, target: string) => linkText(target)) // [[folder/Note#h]] -> Note
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1") // [text](url) -> text
    .replace(/\[aufwand::[^\]]*\]/giu, "")
    .replace(/^WAITING\b:?\s*/u, "")
    .replace(/\s+/gu, " ")
    .trim();
}

const MAX_SUBJECT = 255;

/** The Outlook subject: the clean title without tags, at most 255 characters. */
export function eventSubject(description: string): string {
  const text = cleanTitle(description)
    .replace(/(^|\s)#[^\s#]+/gu, "$1")
    .replace(/\s+/gu, " ")
    .trim();
  const subject = text === "" ? "Focus block" : text;
  const chars = Array.from(subject);
  return chars.length <= MAX_SUBJECT ? subject : `${chars.slice(0, MAX_SUBJECT - 1).join("")}…`;
}

/** Plain-text body: where the block comes from, readable on the phone without Obsidian. */
export function eventBody(
  task: { path: string; customer: string; project: string | null },
  vaultName: string,
): string {
  const lines = ["Focus block from Obsidian", `Customer: ${task.customer}`];
  if (task.project !== null) lines.push(`Project: ${task.project}`);
  lines.push(`obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(task.path)}`);
  return lines.join("\n");
}

/** The same for a To Do task (M9): its list, and the way to it. The block is in the private calendar. */
export function todoEventBody(task: { project: string }, webUrl: string): string {
  return ["Focus block from Obsidian", `To Do: ${task.project}`, webUrl].join("\n");
}

/** The same for a Planner task: its plan, and the way to it without Obsidian. */
export function plannerEventBody(task: { project: string | null }, webUrl: string): string {
  return ["Focus block from Obsidian", `Planner: ${task.project ?? "unknown plan"}`, webUrl].join("\n");
}
