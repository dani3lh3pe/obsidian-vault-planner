import { Modal, Notice, type App } from "obsidian";
import type { Graph } from "./graph";
import { getPersonalErrorMessage, GraphApiError } from "./lib/errors";
import { isRecord } from "./lib/odata";
import { fromGraphUtc, plannerDay } from "./lib/time";

/**
 * ponytail: the M9.0 probe (umsetzungsplan M9) — one command that answers what the docs leave open
 * for the personal account, then goes away once the answers are in the plan. It writes only its own
 * test objects: one event tomorrow 06:00 in the private calendar, deleted again even after an
 * error, and the two To Do tasks whose titles start with "M9-Probe", which Daniel creates for it.
 * Times are local, like the grid's (FullCalendar timeZone "local").
 */

const ONCE = "M9-Probe einmalig";
const RECURRING = "M9-Probe wiederkehrend";

/** One probe at a time: a second run would complete the next occurrence and add a second event. */
let probeRunning = false;

/** The real etag with one character changed: the same format, so only its staleness can be refused. */
function staleFrom(etag: string): string {
  const at = etag.indexOf('"') + 1;
  if (at === 0 || at >= etag.length - 1) return 'W/"m9-probe-veraltet"';
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
  error instanceof GraphApiError ? `HTTP ${error.status} (${error.body?.error?.code ?? "ohne Code"})` : getPersonalErrorMessage(error);

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

/** "2026-09-30T22:00:00.0000000 (UTC) → Berliner Tag 2026-10-01" */
function describeDue(due: unknown): { text: string; day: string | null } {
  if (!isRecord(due) || typeof due.dateTime !== "string") return { text: "keine Fälligkeit", day: null };
  const zone = typeof due.timeZone === "string" ? due.timeZone : "?";
  const day = zone === "UTC" ? plannerDay(fromGraphUtc(due.dateTime)) : null;
  return { text: `${due.dateTime} (${zone}) → Berliner Tag ${day ?? "unbekannt, keine UTC-Angabe"}`, day };
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
    if (report) lines.push(`Filter „status ne 'completed'": angenommen.`);
  } catch (error) {
    if (report) lines.push(`Filter „status ne 'completed'": abgelehnt, ${failure(error)} — lese ungefiltert.`);
    result = await graph.readTodoTasks(listId);
  }
  if (result.truncated) lines.push(`Liste ${listId.slice(0, 8)}…: mehr als 10 Seiten, abgeschnitten.`);
  return result.raw
    .map((item) => readTask(listId, item))
    .filter((task): task is ProbeTask => task !== null && task.status !== "completed");
}

async function probeTasks(graph: Graph, lines: string[]): Promise<void> {
  lines.push("## To Do");
  const listsRead = await graph.readTodoLists();
  const lists = listsRead.raw.filter(isRecord);
  lines.push(`Listen: ${lists.length}${listsRead.truncated ? " (abgeschnitten)" : ""}`);
  // Only the kind of list, never its name: the report goes into the chat and its answers into git.
  lists.forEach((list, index) => {
    const flags = [list.wellknownListName, list.isShared === true ? "geteilt" : null].filter(
      (flag) => typeof flag === "string" && flag !== "none",
    );
    lines.push(`- Liste ${index + 1}${flags.length === 0 ? "" : ` (${flags.join(", ")})`}`);
  });

  const found: ProbeTask[] = [];
  let first = true;
  for (const list of lists) {
    // Shared lists are left alone: completing there closes the task for everyone (spec Nr. 28).
    if (typeof list.id !== "string" || list.wellknownListName === "flaggedEmails" || list.isShared === true) continue;
    found.push(...(await openTasks(graph, list.id, lines, first)).filter((task) => task.title.startsWith("M9-Probe")));
    first = false;
  }
  const once = found.find((task) => task.title === ONCE);
  const recurring = found.find((task) => task.title === RECURRING);

  const tomorrow = plannerDay(tomorrowAt(12));
  if (once === undefined) lines.push(`FEHLT: offene Aufgabe „${ONCE}" (Fälligkeit morgen) — Fälligkeit und If-Match nicht geprüft.`);
  else {
    const due = describeDue(once.due);
    lines.push(`Fälligkeit „${ONCE}": ${due.text} — erwartet ${tomorrow}: ${due.day === tomorrow ? "OK" : "ABWEICHUNG"}`);
    lines.push(`etag vorhanden: ${once.etag === null ? "nein" : "ja"}`);
    try {
      await graph.completeTodoTask(once.listId, once.id, staleFrom(once.etag ?? ""));
      lines.push("If-Match mit veraltetem etag: angenommen — To Do beachtet If-Match NICHT (Aufgabe ist jetzt erledigt).");
    } catch (error) {
      if (!(error instanceof GraphApiError) || error.status !== 412) {
        lines.push(`If-Match mit veraltetem etag: UNKLAR, ${failure(error)} statt 412 — keine Aussage.`);
      } else {
        lines.push("If-Match mit veraltetem etag: 412 — To Do beachtet If-Match.");
        try {
          await graph.completeTodoTask(once.listId, once.id, once.etag);
          lines.push("Abschließen mit aktuellem etag: OK");
        } catch (second) {
          lines.push(`Abschließen mit aktuellem etag: FEHLER ${failure(second)}`);
        }
      }
    }
  }

  if (recurring === undefined) lines.push(`FEHLT: offene wiederkehrende Aufgabe „${RECURRING}" — Wiederholung nicht geprüft.`);
  else if (!recurring.recurring) lines.push(`„${RECURRING}" hat keine Wiederholung — bitte in To Do „Wiederholen" setzen.`);
  else {
    try {
      const before = describeDue(recurring.due).text;
      await graph.completeTodoTask(recurring.listId, recurring.id, recurring.etag);
      await wait(3000);
      // Either a new task, or the same one reopened with the next date — both keep the series.
      const next = (await openTasks(graph, recurring.listId, lines, false)).find((task) => task.title === RECURRING);
      if (next === undefined) lines.push("Wiederkehrend abgeschlossen: KEINE offene Wiederholung nach 3 s (dann gilt Spec Nr. 30).");
      else {
        const kind = next.id === recurring.id ? "dieselbe Aufgabe wieder offen" : "neue Aufgabe";
        lines.push(`Wiederkehrend abgeschlossen: ${kind}, Fälligkeit vorher ${before}, jetzt ${describeDue(next.due).text}`);
      }
    } catch (error) {
      lines.push(`Wiederkehrend abschließen: FEHLER ${failure(error)}`);
    }
  }
}

async function probeCalendar(graph: Graph, lines: string[]): Promise<void> {
  lines.push("## Privater Kalender");
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
      subject: "M9-Probe (wird gleich gelöscht)",
      body: "Test von Vault Planner, M9.0",
      start: tomorrowAt(6, 0),
      end: tomorrowAt(6, 15),
      link,
    });
    lines.push("Testtermin angelegt (morgen 06:00–06:15).");

    const first = await findSoon();
    if (first.dropped > 0) lines.push(`Nicht lesbare Termine: ${first.dropped} (Zeitzone nicht UTC?)`);
    if (first.event === undefined) {
      lines.push("Property mit $select: NICHT zurückgekommen, auch nach 4 s — der Testtermin wird nicht als eigener erkannt.");
      return;
    }
    lines.push(`Property mit $select: OK. Start ${first.event.start.toISOString()} (erwartet 06:00 Berlin).`);

    await graph.moveBlock(first.event.id, tomorrowAt(6, 15), tomorrowAt(6, 30));
    const moved = await findSoon();
    lines.push(
      moved.event === undefined
        ? "Nach dem Verschieben: Termin NICHT mehr gefunden."
        : `Nach dem Verschieben: ${moved.event.id === first.event.id ? "dieselbe ID" : "ANDERE ID"}, Start ${moved.event.start.toISOString()}.`,
    );

    await graph.deleteBlock(moved.event?.id ?? first.event.id);
    gone = (await findOurs()).event === undefined;
    lines.push(gone ? "Gelöscht: OK (DELETE angenommen, nicht mehr zu finden)." : "Gelöscht: Termin ist NOCH DA.");
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
          "ACHTUNG: Nicht bestätigt, dass der Testtermin „M9-Probe“ (morgen 06:00, privater Kalender) gelöscht ist — " +
            "bitte in Outlook.com nachsehen und gegebenenfalls von Hand löschen.",
        );
      }
    }
  }
}

export async function runProbe(graph: Graph): Promise<string> {
  const lines = [`M9.0-Probe, ${new Date().toISOString()}`];
  for (const step of [probeTasks, probeCalendar]) {
    try {
      await step(graph, lines);
    } catch (error) {
      lines.push(`ABGEBROCHEN: ${failure(error)}`);
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
    this.titleEl.setText("M9.0-Probe: privates Konto");
    this.contentEl.empty();
    if (this.probeReport !== null) this.renderReport(this.probeReport);
    else if (probeRunning) this.contentEl.createEl("p", { text: "Probe läuft…" });
    else {
      this.contentEl.createEl("p", {
        text:
          `Die Probe legt morgen um 06:00 einen Testtermin im privaten Kalender an, verschiebt und löscht ihn, ` +
          `und schließt in To Do die Aufgaben „${ONCE}“ und „${RECURRING}“ ab. Sonst ändert sie nichts.`,
      });
      const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
      buttons.createEl("button", { text: "Abbrechen" }).addEventListener("click", () => this.close());
      buttons.createEl("button", { text: "Probe starten", cls: "mod-cta" }).addEventListener("click", () => void this.runAndShow());
    }
  }

  private async runAndShow(): Promise<void> {
    if (probeRunning) {
      new Notice("Die Probe läuft bereits.");
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
    buttons.createEl("button", { text: "Kopieren", cls: "mod-cta" }).addEventListener("click", () => {
      navigator.clipboard.writeText(report).then(
        () => new Notice("Bericht kopiert."),
        () => new Notice("Kopieren ging nicht — bitte markieren und kopieren."),
      );
    });
  }

  onClose(): void {
    this.probeClosed = true;
    this.contentEl.empty();
  }
}
