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
  const subject = text === "" ? "Fokus-Block" : text;
  const chars = Array.from(subject);
  return chars.length <= MAX_SUBJECT ? subject : `${chars.slice(0, MAX_SUBJECT - 1).join("")}…`;
}

/** Plain-text body: where the block comes from, readable on the phone without Obsidian. */
export function eventBody(
  task: { path: string; kunde: string; projekt: string | null },
  vaultName: string,
): string {
  const lines = ["Fokus-Block aus Obsidian", `Kunde: ${task.kunde}`];
  if (task.projekt !== null) lines.push(`Projekt: ${task.projekt}`);
  lines.push(`obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(task.path)}`);
  return lines.join("\n");
}

/** The same for a To Do task (M9): its list, and the way to it. The block is in the private calendar. */
export function todoEventBody(task: { projekt: string }, webUrl: string): string {
  return ["Fokus-Block aus Obsidian", `To Do: ${task.projekt}`, webUrl].join("\n");
}

/** The same for a Planner task: its plan, and the way to it without Obsidian. */
export function plannerEventBody(task: { projekt: string | null }, webUrl: string): string {
  return ["Fokus-Block aus Obsidian", `Planner: ${task.projekt ?? "Plan unbekannt"}`, webUrl].join("\n");
}
