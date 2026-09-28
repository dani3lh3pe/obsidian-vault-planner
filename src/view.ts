import {
  Calendar,
  type DatesSetArg,
  type EventChangeArg,
  type EventContentArg,
  type EventMountArg,
} from "@fullcalendar/core";
import deLocale from "@fullcalendar/core/locales/de";
import interactionPlugin, { Draggable, type EventReceiveArg } from "@fullcalendar/interaction";
import timeGridPlugin from "@fullcalendar/timegrid";
import { ItemView, Menu, Modal, Notice, setIcon, type App, type WorkspaceLeaf } from "obsidian";
import {
  BUSINESS_HOURS,
  CLICK_SLOP_PX,
  DEFAULT_AUFWAND_HOURS,
  PLANNER_REFRESH_INTERVAL_MS,
  REFRESH_INTERVAL_MS,
  VIEW_TYPE,
  WORK_HOURS,
} from "./config";
import type VaultPlannerPlugin from "./main";
import type { ChangeReason } from "./main";
import { getErrorMessage, isAuthExpired } from "./lib/errors";
import { isPlannerTask, plannerWebUrl, type PlannerSnapshot } from "./lib/planner";
import { isOverdue, QUADRANT_TITLE } from "./lib/priority";
import { ReadGate } from "./lib/readGate";
import { blocksByTask, fetchRange, inRange, linkKey, plannerIdOf, plannerKey, planStatus, statusWindow } from "./lib/schedule";
import { cleanTitle, eventBody, eventSubject, plannerEventBody } from "./lib/subject";
import { buildList, isOpen, type ListOptions } from "./lib/taskList";
import { aufwandToDuration, formatSlot, formatSlotWithDate, plannerDay } from "./lib/time";
import { toFullCalendarEvents, type BlockState, type EventProps } from "./lib/toFullCalendarEvents";
import type { AnyTask, CalendarEvent, PlannerBucket, PlannerTask, PlanStatus, TimeRange, VaultTask } from "./lib/types";
import { visibleHours } from "./lib/visibleHours";
import { toggleDone, writeBlockId } from "./vault";

const UNPLANNED: PlanStatus = { kind: "ungeplant" };

/**
 * A card's saving marker before it has a block id. Needed on the FIRST booking: the index only
 * learns the new id after the metadata cache reports the write, and until then the card would look
 * draggable again.
 */
const rawKey = (task: { path: string; raw: string }): string => `${task.path}\n${task.raw}`;

/** What one card shows. Serialized as the list's signature, so it holds plain data only. */
interface CardData {
  path: string;
  line: number;
  raw: string;
  blockId: string | null;
  plannerId: string | null;
  title: string;
  meta: string;
  due: string | null;
  overdue: boolean;
  status: { text: string; muted: boolean } | null;
  conflict: string | null;
  pending: boolean;
  duration: string;
}

/** A real dialog naming the thing, never window.confirm (UX rule 3). */
class ConfirmModal extends Modal {
  constructor(
    app: App,
    private readonly text: { title: string; message: string; confirm: string; warning: boolean },
    private readonly onConfirm: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(this.text.title);
    this.contentEl.createEl("p", { text: this.text.message });
    const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
    buttons.createEl("button", { text: "Abbrechen" }).addEventListener("click", () => this.close());
    const confirm = buttons.createEl("button", { text: this.text.confirm, cls: this.text.warning ? "mod-warning" : "mod-cta" });
    confirm.addEventListener("click", () => {
      this.close();
      this.onConfirm();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** "einer weiteren Person" / "2 weiteren Personen". */
const others = (count: number): string => (count === 1 ? "einer weiteren Person" : `${count} weiteren Personen`);

/**
 * Tasks on the left, the Outlook week on the right. The calendar is the truth: the view derives
 * "geplant" from what Graph returns and writes nothing to the vault except a block id on drop
 * and a completion through the Tasks API. Planner tasks (M6) join the same list; their writes go
 * to Planner only.
 */
export class PlannerView extends ItemView {
  private calendar: Calendar | null = null;
  private draggable: Draggable | null = null;
  private readonly gate = new ReadGate();
  private readonly patching = new Set<string>();
  private events: CalendarEvent[] = [];
  private displayed: TimeRange | null = null;
  /** Signed in and the last read for the displayed range succeeded. Drops are allowed only then. */
  private ready = false;
  private everLoaded = false;
  /** Entries of the last read that mapGraphEvents could not narrow. */
  private dropped = 0;
  private error: { message: string; needsLogin: boolean } | null = null;
  private inFlight: number | null = null;
  private options: ListOptions = { search: "", kunde: null, onlyUnplanned: false };
  private waitingOpen = false;
  private listSignature = "";
  private eventsSignature = "";
  private slotSignature = "";
  private kundenSignature = "";
  private renderTimer: number | null = null;
  private calendarStale = false;
  private unsubscribe: (() => void) | null = null;
  /** Planner's last good read; null while switched off or not read yet. Kept when a read fails. */
  private planner: PlannerSnapshot | null = null;
  private plannerError: string | null = null;
  /** Only the newest Planner read may land — the same rule as the calendar's, without gestures. */
  private plannerSeq = 0;
  private plannerInFlight: number | null = null;
  private plannerReadAt = 0;
  /**
   * Planner tasks with a PATCH under way or not yet re-read: the etag it used is spent, so the card
   * stays "Wird gespeichert…" until a read started after the write (`from`; ∞ while the PATCH runs)
   * shows a DIFFERENT etag — Planner can lag behind its own writes. `spent` is null when the write
   * failed: then the next read is news enough.
   */
  private readonly plannerWriting = new Map<string, { from: number; spent: string | null }>();

  private bannerEl: HTMLElement | null = null;
  private plannerHintEl: HTMLElement | null = null;
  private countEl: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;
  private loadingEl: HTMLElement | null = null;
  private kundeSelect: HTMLSelectElement | null = null;
  private unplannedBox: HTMLInputElement | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: VaultPlannerPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Planner";
  }

  getIcon(): string {
    return "calendar-check";
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("vault-planner-view");

    // FullCalendar injects its CSS into the main document and its Draggable listens on the
    // global document; in a pop-out window neither works.
    if (this.containerEl.win !== window) {
      root.createDiv({
        cls: "vp-popout-hint",
        text: "Der Planner läuft nur im Hauptfenster. Bitte den Tab zurück ins Hauptfenster ziehen.",
      });
      return;
    }

    this.buildLeft(root.createDiv({ cls: "vp-left" }));
    this.buildCalendar(root.createDiv({ cls: "vp-right" }));

    this.unsubscribe = this.plugin.onChange((reason) => this.onPluginChange(reason));
    // Registered on the VIEW, not the plugin: closing the tab must stop the poll.
    this.registerInterval(window.setInterval(() => this.poll(), REFRESH_INTERVAL_MS));
    // Planner on its own clock: a 429 there must not stall the calendar.
    this.registerInterval(
      window.setInterval(() => {
        if (this.isVisible()) void this.refreshPlanner();
      }, PLANNER_REFRESH_INTERVAL_MS),
    );
    this.registerDomEvent(document, "visibilitychange", () => this.onReturn());
    // Switching back from Outlook does not always fire visibilitychange; focus does.
    this.registerDomEvent(window, "focus", () => this.onReturn());
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf === this.leaf) this.poll();
      }),
    );
    this.renderAll();
    void this.refreshPlanner();
  }

  async onClose(): Promise<void> {
    this.unsubscribe?.();
    this.draggable?.destroy();
    this.calendar?.destroy();
    if (this.renderTimer !== null) window.clearTimeout(this.renderTimer);
  }

  onResize(): void {
    this.calendar?.updateSize();
  }

  // ---------------------------------------------------------------------------------------------
  // Layout

  private buildLeft(left: HTMLElement): void {
    const header = left.createDiv({ cls: "vp-header" });
    header.createEl("h3", { text: "Aufgaben" });
    this.countEl = header.createDiv({ cls: "vp-count" });
    this.bannerEl = left.createDiv({ cls: "vp-banner" });
    this.plannerHintEl = left.createDiv({ cls: "vp-banner" });

    // Controls live OUTSIDE the container that is rebuilt, so typing keeps its focus.
    const controls = left.createDiv({ cls: "vp-controls" });
    const search = controls.createEl("input", { type: "search", cls: "vp-search", attr: { placeholder: "Aufgaben durchsuchen" } });
    search.addEventListener("input", () => {
      this.options = { ...this.options, search: search.value };
      this.renderList();
    });
    const select = controls.createEl("select", { cls: "dropdown vp-kunde" });
    select.addEventListener("change", () => {
      this.options = { ...this.options, kunde: select.value === "" ? null : select.value };
      this.renderList();
    });
    this.kundeSelect = select;
    const label = controls.createEl("label", { cls: "vp-unplanned" });
    const box = label.createEl("input", { type: "checkbox" });
    label.appendText(" nur ungeplante");
    box.addEventListener("change", () => {
      this.options = { ...this.options, onlyUnplanned: box.checked };
      this.renderList();
    });
    this.unplannedBox = box;

    const list = left.createDiv({ cls: "vp-list" });
    this.listEl = list;
    // One Draggable, bound once. It reads data-* attributes, so rebuilding the cards never
    // rebuilds it; cards without data-drag (saving, conflicting) simply are not drag sources.
    this.draggable = new Draggable(list, {
      itemSelector: ".vp-card[data-drag]",
      eventData: (el) => ({
        title: el.dataset.title ?? "",
        duration: el.dataset.duration ?? "01:00",
        create: true,
        extendedProps: { path: el.dataset.path, raw: el.dataset.raw, blockId: el.dataset.blockId, plannerId: el.dataset.plannerId },
      }),
    });
  }

  private buildCalendar(right: HTMLElement): void {
    this.loadingEl = right.createDiv({ cls: "vp-loading", text: "Termine werden geladen…" });
    const calendar = new Calendar(right.createDiv({ cls: "vp-calendar" }), {
      plugins: [timeGridPlugin, interactionPlugin],
      initialView: "timeGridWeek",
      // The locale OBJECT: the string "de" silently falls back to English without it.
      locale: deLocale,
      timeZone: "local",
      firstDay: 1,
      weekends: false,
      // Stays on: a holiday in the all-day row is information, even if nothing is dropped there.
      allDaySlot: true,
      slotMinTime: WORK_HOURS.start,
      slotMaxTime: WORK_HOURS.end,
      slotDuration: "00:30:00",
      snapDuration: "00:15:00",
      nowIndicator: true,
      expandRows: true,
      height: "100%",
      businessHours: BUSINESS_HOURS,
      headerToolbar: { left: "prev,next today", center: "title", right: "" },
      droppable: true,
      editable: true,
      eventResizableFromStart: true,
      // 0, not the default 5 px: with a threshold, eventDragStart fires only after the mouse has
      // moved, and a read landing in between would swap the event source under the pressed block
      // (FullCalendar then merges the old copy back: a ghost block). At 0 the gesture opens on
      // mousedown; resizing uses the same option.
      eventDragMinDistance: 0,
      // THE drop gate. `droppable` does not stop drops from the list in 6.1.21 — external drops
      // only consult dropAccept and eventAllow. Not ready, or the all-day row: refused.
      eventAllow: (span) => this.ready && !span.allDay,
      datesSet: (arg) => this.onDatesSet(arg),
      eventReceive: (arg) => this.onEventReceive(arg),
      eventChange: (arg) => this.onEventChange(arg),
      eventDragStart: () => this.gate.beginGesture(),
      eventDragStop: () => this.endGesture(),
      eventResizeStart: () => this.gate.beginGesture(),
      eventResizeStop: () => this.endGesture(),
      eventContent: (arg) => this.eventContent(arg),
      eventDidMount: (arg) => this.onEventMount(arg),
    });
    this.calendar = calendar;
    calendar.render();
  }

  // ---------------------------------------------------------------------------------------------
  // Reading

  private isVisible(): boolean {
    return document.visibilityState === "visible" && this.containerEl.isShown();
  }

  /** Back from Outlook or Planner Web: both may have changed. Planner at most every 15 s. */
  private onReturn(): void {
    this.poll();
    // Half the Planner clock: prompt after Planner Web, but no full read on every window switch.
    if (this.isVisible() && Date.now() - this.plannerReadAt >= PLANNER_REFRESH_INTERVAL_MS / 2) void this.refreshPlanner();
  }

  private poll(): void {
    if (this.isVisible()) void this.refresh(false);
  }

  private onPluginChange(reason: ChangeReason): void {
    // The Planner switch changes the token's scope too: the calendar reads with the new one.
    if (reason === "auth" || reason === "settings") {
      this.error = null;
      void this.refresh(true);
      void this.refreshPlanner(true);
      return;
    }
    if (this.renderTimer !== null) return;
    this.renderTimer = window.setTimeout(() => {
      this.renderTimer = null;
      this.renderAll();
    }, 300);
  }

  /**
   * One read of the displayed week plus the status window. Numbered: only the newest read may
   * change the screen, and not in the middle of a drag or PATCH (ReadGate). `force` starts a read
   * even while one runs — after a write, only a read started now can show the result.
   */
  private async refresh(force: boolean): Promise<void> {
    const { auth, graph } = this.plugin;
    if (this.displayed === null) return;
    // Signed out means no poll at all — no network call, no noise in the sign-in logs. The last
    // calendar goes too (its blocks could not be changed anyway), and so do the saving markers:
    // settling a fresh read number releases every marker that waited for one.
    if (!auth.configured || !auth.signedIn) {
      this.ready = false;
      this.events = [];
      this.dropped = 0;
      this.gate.settled(this.gate.start());
      this.renderAll();
      return;
    }
    if (!force && this.inFlight !== null) return;

    const seq = this.gate.start();
    this.inFlight = seq;
    try {
      const result = await graph.readCalendar(fetchRange(this.displayed, new Date()));
      if (!this.gate.accepts(seq)) return;
      this.events = result.events;
      // Surfaced, never swallowed: an entry Graph sent that could not be read is a meeting the
      // grid does not show.
      this.dropped = result.droppedCount;
      this.ready = true;
      this.everLoaded = true;
      this.error = null;
      this.gate.settled(seq);
    } catch (error) {
      if (!this.gate.isCurrent(seq)) return;
      // Stale events would make a plausible, wrong plan: clear them and say the status is unknown.
      this.events = [];
      this.ready = false;
      this.error = { message: getErrorMessage(error), needsLogin: isAuthExpired(error) };
      this.gate.settled(seq);
    } finally {
      if (this.inFlight === seq) this.inFlight = null;
      this.renderAll();
    }
  }

  /**
   * Planner tasks and buckets. Never touches the calendar: a failure here is a hint, not a banner.
   * `force` starts a read even while one runs — after a write only a read started now can show it;
   * the clocks wait, or a slow read would be superseded forever.
   */
  private async refreshPlanner(force = false): Promise<void> {
    const { auth, graph, settings } = this.plugin;
    if (!settings.plannerEnabled || !auth.configured || !auth.signedIn) {
      // A read still running must not bring the tasks back.
      this.plannerSeq += 1;
      if (this.planner === null && this.plannerError === null) return;
      this.planner = null;
      this.plannerError = null;
      this.plannerWriting.clear();
      this.renderAll();
      return;
    }
    if (!force && this.plannerInFlight !== null) return;
    const seq = ++this.plannerSeq;
    this.plannerInFlight = seq;
    this.plannerReadAt = Date.now();
    try {
      const snapshot = await graph.readPlanner();
      if (seq !== this.plannerSeq) return;
      this.planner = snapshot;
      this.plannerError = null;
      for (const [id, mark] of this.plannerWriting) {
        const now = snapshot.tasks.find((task) => task.id === id);
        if (seq >= mark.from && (mark.spent === null || now?.etag !== mark.spent)) this.plannerWriting.delete(id);
      }
    } catch (error) {
      if (seq !== this.plannerSeq) return;
      this.plannerError = getErrorMessage(error);
    } finally {
      if (this.plannerInFlight === seq) this.plannerInFlight = null;
    }
    this.renderAll();
  }

  /** The task as the LAST read knows it: its etag may have changed since the card was built. */
  private plannerTask(id: string): PlannerTask | undefined {
    return this.planner?.tasks.find((task) => task.id === id);
  }

  /**
   * eventDragStop/eventResizeStop fire BEFORE FullCalendar hands the drop to eventChange. Swapping
   * the event source right here would remove the very event being dropped, so the catch-up runs
   * after this event-loop turn — by then eventChange has opened the PATCH gesture, and
   * renderCalendar waits for that one too.
   */
  private endGesture(): void {
    const readAgain = this.gate.endGesture();
    window.setTimeout(() => {
      if (this.calendarStale) this.renderCalendar();
      if (readAgain) void this.refresh(true);
    }, 0);
  }

  private onDatesSet(arg: DatesSetArg): void {
    const previous = this.displayed;
    // datesSet also fires on renders that did not change the range; reading then would loop.
    if (previous !== null && previous.start.getTime() === arg.start.getTime() && previous.end.getTime() === arg.end.getTime()) {
      return;
    }
    this.displayed = { start: arg.start, end: arg.end };
    // This week has not been read yet: no drops until it has.
    this.ready = false;
    this.renderAll();
    void this.refresh(true);
  }

  // ---------------------------------------------------------------------------------------------
  // Rendering

  private renderAll(): void {
    this.renderBanner();
    this.renderList();
    this.renderCalendar();
  }

  private statusFn(): ((task: AnyTask) => PlanStatus) | null {
    if (!this.ready) return null;
    const now = new Date();
    const blocks = blocksByTask(this.events, this.app.vault.getName(), statusWindow(now));
    return (task) => {
      const key = linkKey(task);
      return key === null ? UNPLANNED : planStatus(blocks.get(key), now);
    };
  }

  private renderBanner(): void {
    const el = this.bannerEl;
    if (el === null) return;
    const { auth } = this.plugin;
    el.empty();
    const show = (text: string, action?: [string, () => void], warning = false) => {
      el.toggle(true);
      el.toggleClass("is-warning", warning);
      el.createSpan({ text });
      if (action !== undefined) {
        const button = el.createEl("button", { text: action[0], cls: "mod-cta" });
        button.addEventListener("click", action[1]);
      }
    };
    const login = (): void => {
      auth.login().catch((error: unknown) => new Notice(getErrorMessage(error)));
    };

    if (!auth.configured) show("Vault Planner einrichten: Tenant-ID und Client-ID in den Plugin-Einstellungen eintragen.");
    else if (!auth.signedIn) show("Nicht angemeldet – ohne Anmeldung kein Kalender und kein Planungsstatus.", ["Anmelden", login]);
    else if (this.error !== null && this.error.needsLogin) show(this.error.message, ["Anmelden", login], true);
    else if (this.error !== null) {
      show(`Kalender nicht erreichbar – Planungsstatus unbekannt. ${this.error.message}`, ["Erneut versuchen", () => void this.refresh(true)], true);
    } else if (!this.ready) show("Planungsstatus wird geladen…");
    else if (this.dropped > 0) {
      show(`Nicht alle Termine waren lesbar (${this.dropped}) – der Kalender zeigt nicht alles.`, ["Erneut versuchen", () => void this.refresh(true)], true);
    } else el.toggle(false);

    this.loadingEl?.toggle(auth.configured && auth.signedIn && !this.everLoaded && this.error === null);
    this.renderPlannerHint();
  }

  private renderPlannerHint(): void {
    const el = this.plannerHintEl;
    if (el === null) return;
    const { auth, settings } = this.plugin;
    el.empty();
    let text: string | null = null;
    if (settings.plannerEnabled && auth.configured && auth.signedIn) {
      if (this.plannerError !== null) text = `Planner nicht erreichbar – ${this.plannerError}`;
      else if (this.planner === null) text = "Planner-Aufgaben werden geladen…";
      else if (this.planner.truncated) text = "Planner hat mehr Aufgaben geliefert, als das Plugin liest – es fehlen welche.";
      else if (this.planner.droppedCount > 0) text = `${this.planner.droppedCount} Planner-Aufgaben waren nicht lesbar und fehlen in der Liste.`;
    }
    el.toggle(text !== null);
    if (text === null) return;
    // Everything but the first load is something missing.
    el.toggleClass("is-warning", this.planner !== null || this.plannerError !== null);
    el.createSpan({ text });
    if (this.plannerError !== null) {
      el.createEl("button", { text: "Erneut versuchen", cls: "mod-cta" }).addEventListener("click", () => void this.refreshPlanner(true));
    }
  }

  private cardData(
    task: AnyTask,
    statusOf: ((task: AnyTask) => PlanStatus) | null,
    byBlock: Map<string, VaultTask[]>,
    today: string,
    weekEnd: Date,
  ): CardData {
    const [planner, vault] = isPlannerTask(task) ? [task, null] : [null, task];
    const siblings = vault === null || vault.blockId === null ? undefined : byBlock.get(vault.blockId);
    const conflict =
      siblings !== undefined && siblings.length > 1
        ? `Block-ID doppelt (${siblings.map((other) => other.path.split("/").pop()?.replace(/\.md$/, "")).join(", ")})`
        : null;

    let status: CardData["status"] = null;
    const plan = statusOf?.(task);
    if (plan?.kind === "geplant") {
      const format = plan.next.start.getTime() >= weekEnd.getTime() ? formatSlotWithDate : formatSlot;
      status = { text: format(plan.next.start, plan.next.end), muted: false };
    } else if (plan?.kind === "abgelaufen") {
      status = { text: `abgelaufen: ${formatSlot(plan.last.start, plan.last.end)}`, muted: true };
    }

    const bucket =
      planner === null ? undefined : this.planner?.buckets.get(planner.planId)?.find((b) => b.id === planner.bucketId);
    const meta = [
      task.aufwand === undefined ? "Aufwand?" : `${String(task.aufwand).replace(".", ",")} h`,
      task.kunde,
      ...(task.projekt === null ? [] : [task.projekt]),
      ...(bucket === undefined ? [] : [bucket.name]),
      ...(planner === null || !planner.othersAssigned ? [] : [`mit ${others(planner.othersAssigned)}`]),
    ].join(" · ");
    const key = linkKey(task);

    return {
      path: vault?.path ?? "",
      line: vault?.line ?? 0,
      raw: vault?.raw ?? "",
      blockId: vault?.blockId ?? null,
      plannerId: planner?.id ?? null,
      title: cleanTitle(task.description) || task.description,
      meta,
      due: task.due,
      overdue: isOverdue(task, today),
      status,
      conflict,
      pending:
        (key !== null && this.gate.isPending(key)) ||
        (vault !== null && this.gate.isPending(rawKey(vault))) ||
        (planner !== null && this.plannerWriting.has(planner.id)),
      // The drag preview shows the length that will be booked: effort, or one hour without it.
      duration: aufwandToDuration(task.aufwand ?? DEFAULT_AUFWAND_HOURS),
    };
  }

  private renderList(): void {
    const list = this.listEl;
    if (list === null) return;
    const index = this.plugin.index;
    const now = new Date();
    const today = plannerDay(now);
    const weekEnd = new Date(statusWindow(now).start);
    weekEnd.setDate(weekEnd.getDate() + 7);
    const statusOf = this.statusFn();
    const byBlock = index.blockIndex();
    const model = buildList([...index.tasks, ...(this.planner?.tasks ?? [])], statusOf, this.options, today);

    // The chosen customer has no open task left: the filter was reset, so build the list again.
    if (this.syncKunden(model.kunden)) {
      this.renderList();
      return;
    }
    if (this.unplannedBox !== null) this.unplannedBox.disabled = statusOf === null;
    this.countEl?.setText(model.openCount === 0 ? "" : `${model.shownCount} von ${model.openCount} offen`);

    const toRows = (tasks: AnyTask[]) =>
      tasks.map((task) => ({ task, card: this.cardData(task, statusOf, byBlock, today, weekEnd) }));
    const groups = model.groups.map((group) => ({ quadrant: group.quadrant, rows: toRows(group.tasks) }));
    const waiting = toRows(model.waiting);
    const { auth, settings } = this.plugin;
    const plannerLoading =
      settings.plannerEnabled && auth.configured && auth.signedIn && this.planner === null && this.plannerError === null;
    const empty = (!index.complete || plannerLoading) && model.openCount === 0
      ? "Aufgaben werden gelesen…"
      : model.openCount === 0
        ? "Keine offenen Aufgaben."
        : model.shownCount === 0
          ? "Keine Aufgabe passt zum Filter."
          : null;

    // Rebuild only when something visible changed: a rebuild every 15 s would reset the scroll
    // position and the open "Warten auf" section in the middle of reading.
    const cardsOf = (rows: { card: CardData }[]) => rows.map((row) => row.card);
    const signature = JSON.stringify({
      groups: groups.map((group) => [group.quadrant, cardsOf(group.rows)]),
      waiting: cardsOf(waiting),
      empty,
    });
    if (signature === this.listSignature) return;
    this.listSignature = signature;

    const scrollTop = list.scrollTop;
    list.empty();
    if (empty !== null) list.createDiv({ cls: "vp-empty", text: empty });
    for (const group of groups) {
      if (group.rows.length === 0) continue;
      const section = list.createDiv({ cls: "vp-group" });
      section.createEl("h4", { cls: "vp-group-title", text: `${QUADRANT_TITLE[group.quadrant]} · ${group.rows.length}` });
      for (const row of group.rows) this.buildCard(section, row.task, row.card);
    }
    if (waiting.length > 0) {
      const details = list.createEl("details", { cls: "vp-group vp-waiting" });
      details.open = this.waitingOpen;
      details.addEventListener("toggle", () => {
        this.waitingOpen = details.open;
      });
      details.createEl("summary", { cls: "vp-group-title", text: `Warten auf · ${waiting.length}` });
      for (const row of waiting) this.buildCard(details, row.task, row.card);
    }
    list.scrollTop = scrollTop;
  }

  private buildCard(parent: HTMLElement, task: AnyTask, card: CardData): void {
    // Self-contained class: FullCalendar's drag preview is a copy of this element in <body>,
    // where styles scoped to the view would not reach it.
    const el = parent.createDiv({ cls: "vp-card" });
    el.toggleClass("is-pending", card.pending);
    el.toggleClass("is-conflict", card.conflict !== null);
    if (!card.pending && card.conflict === null) {
      el.dataset.drag = "";
      if (card.plannerId !== null) el.dataset.plannerId = card.plannerId;
      else {
        el.dataset.path = card.path;
        el.dataset.raw = card.raw;
        if (card.blockId !== null) el.dataset.blockId = card.blockId;
      }
      el.dataset.title = card.title;
      el.dataset.duration = card.duration;
    }

    const check = el.createEl("input", { type: "checkbox", cls: "vp-check", attr: { "aria-label": "Erledigen", title: "Erledigen" } });
    // FullCalendar starts a drag on mousedown/touchstart of the list; the checkbox must not.
    for (const type of ["mousedown", "touchstart", "click"]) check.addEventListener(type, (event) => event.stopPropagation());
    // Saving: a second tick would send a used-up etag, or complete a task that is being booked.
    check.disabled = card.pending;
    check.addEventListener("change", () => (isPlannerTask(task) ? this.completePlanner(task.id, check) : void this.complete(task, check)));

    const body = el.createDiv({
      cls: "vp-card-body",
      attr: { role: "button", tabindex: "0", title: isPlannerTask(task) ? "In Planner öffnen" : "Öffnen" },
    });
    body.createDiv({ cls: "vp-title", text: card.title });
    const meta = body.createDiv({ cls: "vp-meta", text: card.meta });
    if (card.due !== null) {
      meta.appendText(" · ");
      // Red is an addition, not the message: the date itself says what is wrong.
      meta.createSpan({ cls: card.overdue ? "vp-due is-overdue" : "vp-due", text: `bis ${card.due}` });
    }
    if (card.pending) body.createDiv({ cls: "vp-status", text: "Wird gespeichert…" });
    else if (card.conflict !== null) body.createDiv({ cls: "vp-status is-warning", text: card.conflict });
    else if (card.status !== null) body.createDiv({ cls: card.status.muted ? "vp-status is-muted" : "vp-status", text: card.status.text });

    // A drag that starts and ends on the card still fires a click; opening the note is the wrong
    // answer to a cancelled drag (web app CLICK_SLOP_PX).
    let pressed: { x: number; y: number } | null = null;
    body.addEventListener("mousedown", (event) => {
      pressed = { x: event.clientX, y: event.clientY };
    });
    body.addEventListener("click", (event) => {
      const from = pressed;
      pressed = null;
      if (from !== null && Math.hypot(event.clientX - from.x, event.clientY - from.y) > CLICK_SLOP_PX) return;
      this.openCard(task);
    });
    body.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        this.openCard(task);
      }
    });
    if (isPlannerTask(task)) {
      el.addEventListener("contextmenu", (event) => {
        // Without this, Electron shows its own menu on top.
        event.preventDefault();
        this.showPlannerMenu(event, task.id);
      });
    }
  }

  /** Refresh the dropdown; true when the chosen customer disappeared and the filter was reset. */
  private syncKunden(kunden: string[]): boolean {
    const select = this.kundeSelect;
    if (select === null) return false;
    const signature = kunden.join("\u0000");
    if (signature === this.kundenSignature) return false;
    this.kundenSignature = signature;
    const reset = this.options.kunde !== null && !kunden.includes(this.options.kunde);
    if (reset) this.options = { ...this.options, kunde: null };
    select.empty();
    select.createEl("option", { text: "Alle Kunden", value: "" });
    for (const kunde of kunden) select.createEl("option", { text: kunde, value: kunde });
    select.value = this.options.kunde ?? "";
    return reset;
  }

  private blockState(byBlock: Map<string, VaultTask[]>): (blockId: string) => BlockState {
    const complete = this.plugin.index.complete;
    return (blockId) => {
      const plannerId = plannerIdOf(blockId);
      if (plannerId !== null) {
        // Switched off or not read yet: say nothing rather than "Aufgabe nicht gefunden".
        if (this.planner === null) return "pending";
        const task = this.plannerTask(plannerId);
        if (task === undefined) return "missing";
        return isOpen(task) ? "open" : "done";
      }
      const tasks = byBlock.get(blockId);
      if (tasks === undefined) return complete ? "missing" : "pending";
      if (tasks.length > 1) return "conflict";
      return isOpen(tasks[0]) ? "open" : "done";
    };
  }

  private renderCalendar(): void {
    const calendar = this.calendar;
    if (calendar === null || this.displayed === null) return;
    // Never swap the events under a drag or resize — FullCalendar would lose the element.
    if (this.gate.busy) {
      this.calendarStale = true;
      return;
    }
    this.calendarStale = false;

    const input = toFullCalendarEvents(this.events, this.app.vault.getName(), this.blockState(this.plugin.index.blockIndex()));
    const signature = JSON.stringify(input);
    if (signature !== this.eventsSignature) {
      this.eventsSignature = signature;
      calendar.batchRendering(() => {
        calendar.getEventSourceById("graph")?.remove();
        calendar.addEventSource({ id: "graph", events: input });
      });
    }

    // The configured hours are a floor that widens to the displayed week's events.
    const hours = visibleHours(inRange(this.events, this.displayed), WORK_HOURS);
    const slots = `${hours.start}-${hours.end}`;
    if (slots !== this.slotSignature) {
      this.slotSignature = slots;
      calendar.setOption("slotMinTime", hours.start);
      calendar.setOption("slotMaxTime", hours.end);
    }
  }

  private eventContent(arg: EventContentArg): { domNodes: Node[] } {
    const props = arg.event.extendedProps as Partial<EventProps>;
    const wrap = createDiv({ cls: "vp-event" });
    if (props.kind === "own") {
      // Colour is never the only signal: our blocks carry an icon too.
      setIcon(wrap.createSpan({ cls: "vp-event-icon" }), props.state === "done" ? "check" : "list-todo");
    }
    const text = wrap.createDiv({ cls: "vp-event-text" });
    if (arg.timeText !== "" && !arg.event.allDay) text.createDiv({ cls: "vp-event-time", text: arg.timeText });
    text.createDiv({ cls: "vp-event-title", text: arg.event.title });
    return { domNodes: [wrap] };
  }

  private onEventMount(arg: EventMountArg): void {
    const props = arg.event.extendedProps as Partial<EventProps>;
    const { start, end } = arg.event;
    const when = start !== null && end !== null && !arg.event.allDay ? formatSlot(start, end) : "ganztägig";
    const hint =
      props.state === "missing" ? "\nAufgabe nicht gefunden" : props.state === "conflict" ? "\nBlock-ID doppelt" : "";
    arg.el.setAttribute("title", `${arg.event.title}\n${when}${hint}`);

    if (props.kind !== "own" || typeof props.blockId !== "string") return;
    const blockId = props.blockId;
    arg.el.addEventListener("contextmenu", (event) => {
      // Without this, Electron shows its own menu on top.
      event.preventDefault();
      event.stopPropagation();
      const menu = new Menu();
      const plannerId = plannerIdOf(blockId);
      const tasks = this.plugin.index.blockIndex().get(blockId);
      if (plannerId !== null) {
        menu.addItem((item) => item.setTitle("In Planner öffnen").setIcon("external-link").onClick(() => this.openPlanner(plannerId)));
        menu.addSeparator();
      } else if (tasks !== undefined && tasks.length === 1) {
        const task = tasks[0];
        menu.addItem((item) => item.setTitle("Aufgabe öffnen").setIcon("file-text").onClick(() => void this.openTask(task)));
        menu.addSeparator();
      }
      menu.addItem((item) =>
        item
          .setTitle("Block löschen…")
          .setIcon("trash-2")
          .setWarning(true)
          .onClick(() => {
            // Looked up now, not at mount: a block moved within its day is not remounted, so the
            // times captured in eventDidMount would name the old slot.
            const current = this.calendar?.getEventById(arg.event.id) ?? arg.event;
            this.confirmDelete(current.id, current.title, current.start, current.end);
          }),
      );
      menu.showAtMouseEvent(event);
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Actions

  private onEventReceive(arg: EventReceiveArg): void {
    // Read the drop BEFORE reverting it, then drop FullCalendar's provisional event: the grid is
    // drawn from Graph alone, so nothing shows twice and nothing shows that Outlook does not have.
    const { start, end } = arg.event;
    const props = arg.event.extendedProps as { path?: unknown; raw?: unknown; blockId?: unknown; plannerId?: unknown };
    arg.revert();

    // The second door; eventAllow is the first.
    if (!this.ready) {
      new Notice("Der Kalender ist noch nicht bereit – bitte kurz warten.");
      return;
    }
    if (start === null || end === null || arg.event.allDay) return;
    if (typeof props.plannerId === "string" && props.plannerId !== "") {
      void this.bookPlanner(props.plannerId, start, end);
      return;
    }
    if (typeof props.path !== "string" || typeof props.raw !== "string") return;
    const blockId = typeof props.blockId === "string" && props.blockId !== "" ? props.blockId : null;
    void this.book(props.path, props.raw, blockId, start, end);
  }

  private async book(path: string, raw: string, knownBlockId: string | null, start: Date, end: Date): Promise<void> {
    const { index, graph } = this.plugin;
    const task = index.find(path, raw, knownBlockId);
    if (task === null) {
      new Notice("Die Aufgabe wurde zwischenzeitlich geändert – bitte erneut ziehen.");
      return;
    }

    // Vault first, then Outlook: a failed POST leaves an unused block id (harmless); the other
    // order could leave an event that points at nothing.
    const draftKey = rawKey(task);
    this.gate.hold(draftKey);
    this.renderList();
    let blockId: string;
    try {
      const taken = index.blockIndex();
      blockId = await writeBlockId(this.app, task, (id) => taken.has(id));
    } catch (error) {
      this.gate.release(draftKey);
      this.renderList();
      new Notice(getErrorMessage(error));
      return;
    }

    this.gate.hold(blockId);
    const vaultName = this.app.vault.getName();
    try {
      await graph.createBlock({
        subject: eventSubject(task.description),
        body: eventBody(task, vaultName),
        start,
        end,
        link: `${vaultName}|${blockId}`,
      });
      new Notice(`Termin angelegt: ${formatSlot(start, end)}.`);
    } catch (error) {
      new Notice(getErrorMessage(error));
    } finally {
      // The card stays "Wird gespeichert…" until a read started NOW has come back.
      this.gate.releaseAfterNextRead(blockId);
      this.gate.releaseAfterNextRead(draftKey);
      void this.refresh(true);
    }
  }

  private onEventChange(arg: EventChangeArg): void {
    const { start, end, id } = arg.event;
    if (start === null || end === null || id === "" || arg.event.allDay) {
      arg.revert();
      return;
    }
    if (this.patching.has(id)) {
      arg.revert();
      new Notice("Der Termin wird gerade verschoben.");
      return;
    }
    this.patching.add(id);
    this.gate.beginGesture();
    void (async () => {
      try {
        await this.plugin.graph.moveBlock(id, start, end);
      } catch (error) {
        // Never keep showing a move that did not reach Outlook.
        arg.revert();
        new Notice(getErrorMessage(error));
      } finally {
        this.patching.delete(id);
        this.gate.endGesture();
        if (this.calendarStale) this.renderCalendar();
        void this.refresh(true);
      }
    })();
  }

  private confirmDelete(eventId: string, title: string, start: Date | null, end: Date | null): void {
    const when = start !== null && end !== null ? ` (${formatSlot(start, end)})` : "";
    new ConfirmModal(
      this.app,
      {
        title: "Block löschen?",
        message: `„${title}“${when} wird in Outlook gelöscht. Die Aufgabe bleibt, wie sie ist.`,
        confirm: "Löschen",
        warning: true,
      },
      () => void this.deleteBlock(eventId),
    ).open();
  }

  private async deleteBlock(eventId: string): Promise<void> {
    try {
      await this.plugin.graph.deleteBlock(eventId);
      new Notice("Block gelöscht.");
    } catch (error) {
      new Notice(getErrorMessage(error));
    } finally {
      void this.refresh(true);
    }
  }

  private async complete(task: VaultTask, box: HTMLInputElement): Promise<void> {
    box.disabled = true;
    try {
      await toggleDone(this.app, task);
      // Blocks stay in Outlook: booked time is history. The block menu can still delete them.
      new Notice(`„${cleanTitle(task.description)}“ erledigt.`);
    } catch (error) {
      box.checked = false;
      box.disabled = false;
      new Notice(getErrorMessage(error));
    }
  }

  /** Not `open`: that name belongs to Obsidian's View (see CLAUDE.md, Code-Standards). */
  private openCard(task: AnyTask): void {
    if (isPlannerTask(task)) this.openPlanner(task.id);
    else void this.openTask(task);
  }

  /** A click, never a timer, opens the browser (Invariant 6). */
  private openPlanner(taskId: string): void {
    window.open(plannerWebUrl(this.plugin.settings.tenantId.trim(), taskId));
  }

  /** Like book(), but nothing is written to the vault: the Planner id is already stable. */
  private async bookPlanner(taskId: string, start: Date, end: Date): Promise<void> {
    const task = this.plannerTask(taskId);
    if (task === undefined || !isOpen(task)) {
      new Notice("Die Planner-Aufgabe ist nicht mehr offen – bitte die Liste prüfen.");
      return;
    }
    const key = plannerKey(task.id);
    this.gate.hold(key);
    this.renderList();
    try {
      await this.plugin.graph.createBlock({
        subject: eventSubject(task.description),
        body: plannerEventBody(task, plannerWebUrl(this.plugin.settings.tenantId.trim(), task.id)),
        start,
        end,
        link: key,
      });
      new Notice(`Termin angelegt: ${formatSlot(start, end)}.`);
    } catch (error) {
      new Notice(getErrorMessage(error));
    } finally {
      this.gate.releaseAfterNextRead(key);
      void this.refresh(true);
    }
  }

  /**
   * Both Planner writes: mark the card, send, and keep the mark until a read brings the new etag —
   * the one this write used is spent either way, and a second click would only earn a 412.
   */
  private async writePlanner(task: PlannerTask, write: () => Promise<void>, success: string): Promise<void> {
    this.plannerWriting.set(task.id, { from: Number.POSITIVE_INFINITY, spent: null });
    this.renderList();
    let spent: string | null = null;
    try {
      await write();
      spent = task.etag;
      new Notice(success);
    } catch (error) {
      new Notice(getErrorMessage(error));
    } finally {
      this.plannerWriting.set(task.id, { from: this.plannerSeq + 1, spent });
      void this.refreshPlanner(true);
    }
  }

  /** Planner write #1. Shared with others: ask first, it closes the task on their board too. */
  private completePlanner(taskId: string, box: HTMLInputElement): void {
    const task = this.plannerTask(taskId);
    // The card is rebuilt as "Wird gespeichert…" and then disappears; the tick itself is not the state.
    box.checked = false;
    if (task === undefined || this.plannerWriting.has(taskId)) {
      new Notice("Die Planner-Aufgabe ist nicht mehr offen – bitte die Liste prüfen.");
      return;
    }
    // Blocks stay in Outlook: booked time is history.
    const run = (): void =>
      void this.writePlanner(task, () => this.plugin.graph.completePlannerTask(task), `„${task.description}“ in Planner abgeschlossen.`);
    if (task.othersAssigned === 0) {
      run();
      return;
    }
    new ConfirmModal(
      this.app,
      {
        title: "Aufgabe abschließen?",
        message:
          task.othersAssigned === null
            ? `Für „${task.description}“ war nicht lesbar, wem die Aufgabe noch zugewiesen ist. Abschließen schließt sie in Planner für alle ab.`
            : `„${task.description}“ ist noch ${others(task.othersAssigned)} zugewiesen. Abschließen schließt die Aufgabe in Planner für alle ab.`,
        confirm: "Abschließen",
        warning: false,
      },
      run,
    ).open();
  }

  /** Planner write #2, from the card's menu. The bucket list is the last read's. */
  private showPlannerMenu(event: MouseEvent, taskId: string): void {
    const task = this.plannerTask(taskId);
    if (task === undefined || this.plannerWriting.has(taskId)) return;
    const menu = new Menu();
    menu.addItem((item) => item.setTitle("In Planner öffnen").setIcon("external-link").onClick(() => this.openPlanner(task.id)));
    menu.addSeparator();
    const buckets = this.planner?.buckets.get(task.planId) ?? [];
    menu.addItem((item) => item.setTitle(buckets.length === 0 ? "Keine Buckets gelesen" : "Bucket wechseln").setDisabled(true));
    for (const bucket of buckets) {
      const current = bucket.id === task.bucketId;
      menu.addItem((item) =>
        item
          .setTitle(bucket.name)
          .setChecked(current)
          .setDisabled(current)
          .onClick(() => this.movePlanner(task, bucket)),
      );
    }
    menu.showAtMouseEvent(event);
  }

  /**
   * With the etag of the task the menu SHOWED: if a read brought a newer version while the menu was
   * open, someone changed it — moving with the fresh etag would overwrite that unseen.
   */
  private movePlanner(shown: PlannerTask, bucket: PlannerBucket): void {
    const current = this.plannerTask(shown.id);
    if (current === undefined || current.etag !== shown.etag || this.plannerWriting.has(shown.id)) {
      new Notice("Die Aufgabe hat sich inzwischen geändert – bitte das Menü erneut öffnen.");
      return;
    }
    void this.writePlanner(shown, () => this.plugin.graph.movePlannerTask(shown, bucket.id), `„${shown.description}“ nach „${bucket.name}“ verschoben.`);
  }

  /** In a NEW tab — the planner itself must never be replaced by the note. */
  private async openTask(task: VaultTask): Promise<void> {
    const file = this.app.vault.getFileByPath(task.path);
    if (file === null) {
      new Notice("Die Datei gibt es nicht mehr.");
      return;
    }
    await this.app.workspace.getLeaf("tab").openFile(file, { active: true, eState: { line: task.line } });
  }
}

