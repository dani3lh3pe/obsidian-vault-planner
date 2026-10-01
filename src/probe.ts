import { Modal, Notice, type App } from "obsidian";
import type { Graph } from "./graph";
import { getPersonalErrorMessage, GraphApiError } from "./lib/errors";
import { isRecord } from "./lib/odata";
import { fromGraphUtc, plannerDay } from "./lib/time";

/**
 * ponytail: the M9.0 probe (implementation plan M9) — one command that answers what the docs leave open
 * for the personal account, then goes away once the answers are in the plan. It writes only its own
 * test objects: one event tomorrow 06:00 in the private calendar, deleted again even after an
 * error, and the two To Do tasks whose titles start with "M9-Probe", which Daniel creates for it.
 * Those titles stay German: they must match the tasks already created.
 * Times are local, like the grid's (FullCalendar timeZone "local").
 */

const ONCE = "M9-Probe einmalig";
const RECURRING = "M9-Probe wiederkehrend";

/** One probe at a time: a second run would complete the next occurrence and add a second event. */
let probeRunning = false;

/** The real etag with one character changed: the same format, so only its staleness can be refused. */
function staleFrom(etag: string): string {
  const at = etag.indexOf('"') + 1;
  if (at === 0 || at >= etag.length - 1) return 'W/"m9-probe-stale"';
  return `${etag.slice(0, at)}${etag[at] === "A" ? "B" : "A"}${etag.slice(at + 1)}`;
}

interface ProbeTask {
  listId: string;
  id: string;
  title: string;
  status: string;
  etag: string | null;
  due: unknown;
  recurring: boolean;
}

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

const failure = (error: unknown): string =>
  error instanceof GraphApiError ? `HTTP ${error.status} (${error.body?.error?.code ?? "no code"})` : getPersonalErrorMessage(error);

function readTask(listId: string, item: unknown): ProbeTask | null {
  if (!isRecord(item) || typeof item.id !== "string" || typeof item.title !== "string") return null;
  const etag = item["@odata.etag"];
  return {
    listId,
    id: item.id,
    title: item.title,
    status: typeof item.status === "string" ? item.status : "?",
    etag: typeof etag === "string" ? etag : null,
    due: item.dueDateTime,
    recurring: isRecord(item.recurrence),
  };
}

/** "2026-09-30T22:00:00.0000000 (UTC) → Berlin day 2026-10-01" */
function describeDue(due: unknown): { text: string; day: string | null } {
  if (!isRecord(due) || typeof due.dateTime !== "string") return { text: "no due date", day: null };
  const zone = typeof due.timeZone === "string" ? due.timeZone : "?";
  const day = zone === "UTC" ? plannerDay(fromGraphUtc(due.dateTime)) : null;
  return { text: `${due.dateTime} (${zone}) → Berlin day ${day ?? "unknown, not given in UTC"}`, day };
}

/** Local midnight tomorrow, and a local time on that day. */
function tomorrowAt(hours = 0, minutes = 0): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, hours, minutes);
}

async function openTasks(graph: Graph, listId: string, lines: string[], report: boolean): Promise<ProbeTask[]> {
  let result: { raw: unknown[]; truncated: boolean };
  try {
    result = await graph.readTodoTasks(listId, true);
    if (report) lines.push(`Filter "status ne 'completed'": accepted.`);
  } catch (error) {
    if (report) lines.push(`Filter "status ne 'completed'": rejected, ${failure(error)} — reading unfiltered.`);
    result = await graph.readTodoTasks(listId);
  }
  if (result.truncated) lines.push(`List ${listId.slice(0, 8)}…: more than 10 pages, truncated.`);
  return result.raw
    .map((item) => readTask(listId, item))
    .filter((task): task is ProbeTask => task !== null && task.status !== "completed");
}

async function probeTasks(graph: Graph, lines: string[]): Promise<void> {
  lines.push("## To Do");
  const listsRead = await graph.readTodoLists();
  const lists = listsRead.raw.filter(isRecord);
  lines.push(`Lists: ${lists.length}${listsRead.truncated ? " (truncated)" : ""}`);
  // Only the kind of list, never its name: the report goes into the chat and its answers into git.
  lists.forEach((list, index) => {
    const flags = [list.wellknownListName, list.isShared === true ? "shared" : null].filter(
      (flag) => typeof flag === "string" && flag !== "none",
    );
    lines.push(`- List ${index + 1}${flags.length === 0 ? "" : ` (${flags.join(", ")})`}`);
  });

  const found: ProbeTask[] = [];
  let first = true;
  for (const list of lists) {
    // Shared lists are left alone: completing there closes the task for everyone (spec no. 28).
    if (typeof list.id !== "string" || list.wellknownListName === "flaggedEmails" || list.isShared === true) continue;
    found.push(...(await openTasks(graph, list.id, lines, first)).filter((task) => task.title.startsWith("M9-Probe")));
    first = false;
  }
  const once = found.find((task) => task.title === ONCE);
  const recurring = found.find((task) => task.title === RECURRING);

  const tomorrow = plannerDay(tomorrowAt(12));
  if (once === undefined) lines.push(`MISSING: open task "${ONCE}" (due tomorrow) — due date and If-Match not checked.`);
  else {
    const due = describeDue(once.due);
    lines.push(`Due date "${ONCE}": ${due.text} — expected ${tomorrow}: ${due.day === tomorrow ? "OK" : "MISMATCH"}`);
    lines.push(`etag present: ${once.etag === null ? "no" : "yes"}`);
    try {
      await graph.completeTodoTask(once.listId, once.id, staleFrom(once.etag ?? ""));
      lines.push("If-Match with a stale etag: accepted — To Do does NOT honour If-Match (the task is now completed).");
    } catch (error) {
      if (!(error instanceof GraphApiError) || error.status !== 412) {
        lines.push(`If-Match with a stale etag: UNCLEAR, ${failure(error)} instead of 412 — no conclusion.`);
      } else {
        lines.push("If-Match with a stale etag: 412 — To Do honours If-Match.");
        try {
          await graph.completeTodoTask(once.listId, once.id, once.etag);
          lines.push("Completing with the current etag: OK");
        } catch (second) {
          lines.push(`Completing with the current etag: ERROR ${failure(second)}`);
        }
      }
    }
  }

  if (recurring === undefined) lines.push(`MISSING: open recurring task "${RECURRING}" — recurrence not checked.`);
  else if (!recurring.recurring) lines.push(`"${RECURRING}" has no recurrence — please set "Repeat" in To Do.`);
  else {
    try {
      const before = describeDue(recurring.due).text;
      await graph.completeTodoTask(recurring.listId, recurring.id, recurring.etag);
      await wait(3000);
      // Either a new task, or the same one reopened with the next date — both keep the series.
      const next = (await openTasks(graph, recurring.listId, lines, false)).find((task) => task.title === RECURRING);
      if (next === undefined) lines.push("Recurring completed: NO open recurrence after 3 s (then spec no. 30 applies).");
      else {
        const kind = next.id === recurring.id ? "the same task open again" : "a new task";
        lines.push(`Recurring completed: ${kind}, due before ${before}, now ${describeDue(next.due).text}`);
      }
    } catch (error) {
      lines.push(`Completing recurring: ERROR ${failure(error)}`);
    }
  }
}

async function probeCalendar(graph: Graph, lines: string[]): Promise<void> {
  lines.push("## Private calendar");
  const range = { start: tomorrowAt(), end: new Date(tomorrowAt().getTime() + 86_400_000) };
  const link = `todo:m9-probe-${Math.random().toString(36).slice(2, 8)}`;
  const findOurs = async () => {
    const result = await graph.readCalendar(range);
    return { event: result.events.find((event) => event.taskLink === link), dropped: result.droppedCount };
  };
  // The POST may not show in calendarView at once: three reads, two seconds apart.
  const findSoon = async () => {
    for (let attempt = 0; ; attempt += 1) {
      const found = await findOurs();
      if (found.event !== undefined || attempt === 2) return found;
      await wait(2000);
    }
  };

  let gone = false;
  try {
    await graph.createBlock({
      subject: "M9 probe (deleted right away)",
      body: "Test by Vault Planner, M9.0",
      start: tomorrowAt(6, 0),
      end: tomorrowAt(6, 15),
      link,
    });
    lines.push("Test event created (tomorrow 06:00–06:15).");

    const first = await findSoon();
    if (first.dropped > 0) lines.push(`Unreadable events: ${first.dropped} (time zone not UTC?)`);
    if (first.event === undefined) {
      lines.push("Property with $select: NOT returned, even after 4 s — the test event is not recognised as our own.");
      return;
    }
    lines.push(`Property with $select: OK. Start ${first.event.start.toISOString()} (expected 06:00 Berlin).`);

    await graph.moveBlock(first.event.id, tomorrowAt(6, 15), tomorrowAt(6, 30));
    const moved = await findSoon();
    lines.push(
      moved.event === undefined
        ? "After moving: event NOT found any more."
        : `After moving: ${moved.event.id === first.event.id ? "same id" : "DIFFERENT ID"}, start ${moved.event.start.toISOString()}.`,
    );

    await graph.deleteBlock(moved.event?.id ?? first.event.id);
    gone = (await findOurs()).event === undefined;
    lines.push(gone ? "Deleted: OK (DELETE accepted, no longer found)." : "Deleted: the event is STILL THERE.");
  } finally {
    if (!gone) {
      // Whatever went wrong: one more try by the link, and a warning unless the deletion is confirmed.
      // A failed read confirms nothing.
      try {
        const left = await findOurs();
        if (left.event !== undefined) {
          await graph.deleteBlock(left.event.id);
          gone = (await findOurs()).event === undefined;
        }
      } catch {
        gone = false;
      }
      if (!gone) {
        lines.push(
          "WARNING: not confirmed that the test event “M9 probe” (tomorrow 06:00, private calendar) is deleted — " +
            "please check Outlook.com and delete it by hand if needed.",
        );
      }
    }
  }
}

export async function runProbe(graph: Graph): Promise<string> {
  const lines = [`M9.0 probe, ${new Date().toISOString()}`];
  for (const step of [probeTasks, probeCalendar]) {
    try {
      await step(graph, lines);
    } catch (error) {
      lines.push(`ABORTED: ${failure(error)}`);
    }
  }
  return lines.join("\n");
}

/**
 * Asks first — the probe writes — then shows the report to copy into the chat. Fields and methods
 * carry probe names: Modal has members obsidian.d.ts does not list.
 */
export class ProbeModal extends Modal {
  private probeReport: string | null = null;
  private probeClosed = false;

  constructor(
    app: App,
    private readonly todoGraph: Graph,
  ) {
    super(app);
  }

  onOpen(): void {
    this.probeClosed = false;
    this.titleEl.setText("M9.0 probe: personal account");
    this.contentEl.empty();
    if (this.probeReport !== null) this.renderReport(this.probeReport);
    else if (probeRunning) this.contentEl.createEl("p", { text: "Probe running…" });
    else {
      this.contentEl.createEl("p", {
        text:
          `The probe creates a test event tomorrow at 06:00 in the private calendar, moves and deletes it, ` +
          `and completes the To Do tasks “${ONCE}” and “${RECURRING}”. It changes nothing else.`,
      });
      const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
      buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
      buttons.createEl("button", { text: "Start probe", cls: "mod-cta" }).addEventListener("click", () => void this.runAndShow());
    }
  }

  private async runAndShow(): Promise<void> {
    if (probeRunning) {
      new Notice("The probe is already running.");
      return;
    }
    probeRunning = true;
    this.onOpen();
    try {
      this.probeReport = await runProbe(this.todoGraph);
    } finally {
      probeRunning = false;
    }
    // Closed while it ran: the writes happened, so the report comes back rather than getting lost.
    if (this.probeClosed) this.open();
    else this.onOpen();
  }

  private renderReport(report: string): void {
    const area = this.contentEl.createEl("textarea", { attr: { readonly: "", rows: "18" } });
    area.value = report;
    area.style.width = "100%";
    const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
    buttons.createEl("button", { text: "Copy", cls: "mod-cta" }).addEventListener("click", () => {
      navigator.clipboard.writeText(report).then(
        () => new Notice("Report copied."),
        () => new Notice("Copying failed — please select and copy."),
      );
    });
  }

  onClose(): void {
    this.probeClosed = true;
    this.contentEl.empty();
  }
}
