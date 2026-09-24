import { parseTaskLine } from "./parseTask";

/**
 * The two vault writes, as pure text operations. Everything here works on the CURRENT file text
 * inside `vault.process` and touches exactly one line; every other byte — including a mixed or
 * CRLF line ending that Claude or Python wrote — stays as it was.
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

const FENCE = /^\s*(```|~~~)/;

/**
 * Lines inside fenced code blocks are skipped, as the metadata cache skips them for the index:
 * a copy of a task line in a code block must never receive a block id or a completion.
 */
export function locateLine(text: string, target: LineTarget): LineSpan | "missing" | "ambiguous" {
  let inFence = false;
  const hits = lineSpans(text).filter((span) => {
    const line = text.slice(span.start, span.end);
    if (FENCE.test(line)) {
      inFence = !inFence;
      return false;
    }
    if (inFence) return false;
    if ("raw" in target) return line === target.raw;
    // The global filter is irrelevant here: the id alone says which line it is.
    return parseTaskLine(line, "")?.blockId === target.blockId;
  });
  if (hits.length === 0) return "missing";
  if (hits.length > 1) return "ambiguous";
  return hits[0];
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
