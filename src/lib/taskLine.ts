import { OPEN_STATUSES, TASKS_GLOBAL_FILTER } from "../config";
import { parseTaskLine } from "./parseTask";

/**
 * The three vault writes, as pure text operations. Everything here works on the CURRENT file text
 * inside `vault.process`. The first two touch exactly one line, the third only adds lines; every
 * other byte — including a mixed or CRLF line ending that Claude or Python wrote — stays as it was.
 */

/** One line of a text: [start, end) without its line ending, plus that ending. */
export interface LineSpan {
  start: number;
  end: number;
  /** "\r\n", "\n", or "" for a last line without one. */
  eol: string;
}

function lineSpans(text: string): LineSpan[] {
  const spans: LineSpan[] = [];
  const breaks = /\r?\n/g;
  let start = 0;
  for (let match = breaks.exec(text); match !== null; match = breaks.exec(text)) {
    spans.push({ start, end: match.index, eol: match[0] });
    start = match.index + match[0].length;
  }
  spans.push({ start, end: text.length, eol: "" });
  return spans;
}

/** Found by our block id when the task has one, else by its exact text — never by line number. */
export type LineTarget = { blockId: string } | { raw: string };

/** A fence: indentation and quote marks, three or more backticks or tildes, the rest of the line. */
const FENCE = /^([\s>]*)(`{3,}|~{3,})(.*)/;

/**
 * Lines inside fenced code blocks are skipped, as the metadata cache skips them for the index:
 * a copy of a task line in a code block must never receive a block id or a completion.
 *
 * A block closes only on a fence that looks like its opener: the same character, at least as long,
 * the same quote marks and indentation, nothing after it. Once a line leaves the opener's list item
 * or quote, nothing closes it. That is stricter than CommonMark, so a misread keeps a block open:
 * the task is then "missing" and the write aborts. Not covered, and then a copy can be taken: a
 * fence on a list marker's own line (`1. ```js`), a fence inside an HTML comment, indented code.
 */
export function locateLine(text: string, target: LineTarget): LineSpan | "missing" | "ambiguous" {
  const hits = linesOutsideFences(text)
    .filter(({ line }) =>
      // The global filter is irrelevant here: the id alone says which line it is.
      "raw" in target ? line === target.raw : parseTaskLine(line, "")?.blockId === target.blockId,
    )
    .map(({ span }) => span);
  if (hits.length === 0) return "missing";
  if (hits.length > 1) return "ambiguous";
  return hits[0];
}

/** Every line outside fenced code blocks, by the rules above, with its index among all lines. */
function linesOutsideFences(text: string): { span: LineSpan; line: string; index: number }[] {
  let open: { run: string; prefix: string; left: boolean } | null = null;
  return lineSpans(text).flatMap((span, index) => {
    const line = text.slice(span.start, span.end);
    if (open !== null) {
      // A blank line ends a quote unless it keeps the `>`; a list item only ends at a line outside it.
      const quotes = (s: string) => (s.match(/>/g) ?? []).length;
      const stays = /^[\s>]*$/.test(line)
        ? quotes(line) >= quotes(open.prefix)
        : line.replace(/\t/g, "    ").startsWith(open.prefix);
      if (!stays) open.left = true;
    }
    const fence = FENCE.exec(line);
    if (fence !== null) {
      const [, rawPrefix, run, rest] = fence;
      const prefix = rawPrefix.replace(/\t/g, "    ");
      // A backtick in the info string makes it inline code ("```a``` b").
      if (open === null && !(run[0] === "`" && rest.includes("`"))) {
        open = { run, prefix, left: false };
        return [];
      }
      if (open !== null && !open.left && run[0] === open.run[0] && run.length >= open.run.length && prefix === open.prefix && /^[ \t]*$/.test(rest)) {
        open = null;
        return [];
      }
    }
    return open !== null ? [] : [{ span, line, index }];
  });
}

const EXISTING_BLOCK_LINK = / \^([a-zA-Z0-9-]+)\s*$/u;

/**
 * The line with a block id at its end. An id the line already carries — ours, or one Obsidian's
 * "copy block link" made — is reused: a second `^id` on one line would break both.
 */
export function ensureBlockId(
  line: string,
  makeId: () => string,
): { line: string; blockId: string; changed: boolean } {
  const existing = EXISTING_BLOCK_LINK.exec(line);
  if (existing !== null) return { line, blockId: existing[1], changed: false };
  const blockId = makeId();
  return { line: `${line.trimEnd()} ^${blockId}`, blockId, changed: true };
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** `t-` plus six random characters, retried until `isTaken` says no. */
export function newBlockId(isTaken: (id: string) => boolean): string {
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    const id = `t-${Array.from(bytes, (byte) => ALPHABET[byte % ALPHABET.length]).join("")}`;
    if (!isTaken(id)) return id;
  }
}

/**
 * Replace exactly one line. `replacement` may hold several "\n"-separated lines — the Tasks
 * toggle returns two for a recurring task — which are joined with THIS file's line ending.
 */
export function replaceLine(text: string, span: LineSpan, replacement: string): string {
  const eol = span.eol !== "" ? span.eol : text.includes("\r\n") ? "\r\n" : "\n";
  return text.slice(0, span.start) + replacement.split("\n").join(eol) + text.slice(span.end);
}

/**
 * Vault write #3 (M10): the lines of a new task. A line break in the name would split the task, so
 * it becomes a space; every non-empty info line becomes a sub-bullet below it. Tasks ignores a line
 * without its global filter, so a set one goes in front.
 */
export function newTaskLines(
  name: string,
  info: string,
  today: string,
  blockId: string,
  globalFilter: string = TASKS_GLOBAL_FILTER,
): string[] {
  const title = [globalFilter, name.replace(/\s*[\r\n]+\s*/gu, " ").trim()].filter((part) => part !== "").join(" ");
  const bullets = info
    .split(/\r?\n/)
    // A bullet typed out of habit would nest a second one; "- [ ] x" stays a sub-task.
    .map((line) => line.trim().replace(/^[-*+](\s+|$)/u, ""))
    .filter((line) => line !== "");
  return [`- [ ] ${title} ➕ ${today} ^${blockId}`, ...bullets.map((line) => `\t- ${line}`)];
}

/**
 * Insert a new task's lines below the last open, unindented task outside a code block and the
 * lines that belong to it; a note without one gets them at the end. They take the note's line
 * ending. null when the new task would land inside a code block: the fence rules above fail closed,
 * so a fence left open or misread aborts the write instead of writing into code.
 */
export function insertTaskLines(text: string, lines: readonly string[]): string | null {
  const outside = linesOutsideFences(text);
  const anchors = outside.filter(({ line }) => /^[^\s>]/.test(line) && OPEN_STATUSES.includes(parseTaskLine(line)?.status ?? ""));
  const fileEol = text.includes("\r\n") ? "\r\n" : "\n";
  let next: string;
  if (anchors.length === 0) {
    const head = text === "" || text.endsWith("\n") ? text : text + fileEol;
    next = head + lines.join(fileEol) + fileEol;
  } else {
    const spans = lineSpans(text);
    let last = anchors[anchors.length - 1].index;
    // Its lines, as Markdown reads a list item: indented ones, and blank lines followed by more of
    // them. The first unindented line ends it, a fence too.
    for (let i = last + 1; i < spans.length; i += 1) {
      const line = text.slice(spans[i].start, spans[i].end);
      if (line.trim() === "") continue;
      if (!/^\s/.test(line)) break;
      last = i;
    }
    const span = spans[last];
    const eol = span.eol !== "" ? span.eol : fileEol;
    next = text.slice(0, span.end) + eol + lines.join(eol) + text.slice(span.end);
  }
  return linesOutsideFences(next).some(({ line }) => line === lines[0]) ? next : null;
}
