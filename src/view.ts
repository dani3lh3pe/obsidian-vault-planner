import {
  Calendar,
  type DatesSetArg,
  type EventChangeArg,
  type EventContentArg,
  type EventMountArg,
} from "@fullcalendar/core";
import enGbLocale from "@fullcalendar/core/locales/en-gb";
import interactionPlugin, { Draggable, type EventReceiveArg } from "@fullcalendar/interaction";
import timeGridPlugin from "@fullcalendar/timegrid";
import { ItemView, Menu, Modal, Notice, setIcon, type App, type WorkspaceLeaf } from "obsidian";
import {
  BUSINESS_HOURS,
  CALENDAR_VIEW_KEY,
  CLICK_SLOP_PX,
  BLOCK_DURATION,
  PLANNER_REFRESH_INTERVAL_MS,
  REFRESH_INTERVAL_MS,
  VIEW_TYPE,
  WORK_HOURS,
} from "./config";
import type { Graph } from "./graph";
import type VaultPlannerPlugin from "./main";
import type { ChangeReason } from "./main";
import { getErrorMessage, getPersonalErrorMessage, isAuthExpired } from "./lib/errors";
import { isPlannerTask, plannerWebUrl, type PlannerSnapshot } from "./lib/planner";
import { RemoteSource } from "./lib/remoteSource";
import { isTodoTask, todoWebUrl, type TodoSnapshot } from "./lib/todo";
import { GROUP_TITLE, isOverdue, listDate, PRIORITY_MARK } from "./lib/priority";
import { ReadGate } from "./lib/readGate";
import { blocksByTask, fetchRange, inRange, linkKey, plannerIdOf, plannerKey, planStatus, statusWindow, todoIdOf, todoKey } from "./lib/schedule";
import { cleanTitle, eventBody, eventSubject, plannerEventBody, todoEventBody } from "./lib/subject";
import { buildList, isOpen, type ListOptions } from "./lib/taskList";
import { formatDue, formatSlot, formatSlotWithDate, plannerDay, shiftWorkdays } from "./lib/time";
import type { MapResult } from "./lib/mapGraphEvents";
import { toFullCalendarEvents, type BlockState, type CalendarSide, type EventProps } from "./lib/toFullCalendarEvents";
import type { AnyTask, CalendarEvent, PlannerBucket, PlannerTask, PlanStatus, TimeRange, TodoTask, VaultTask } from "./lib/types";
import { visibleHours } from "./lib/visibleHours";
import { toggleDone, writeBlockId } from "./vault";

const UNPLANNED: PlanStatus = { kind: "unplanned" };

/** A dragged card's To Do id — a To Do card goes into the private calendar (spec no. 18, 47). */
const todoIdFrom = (props: { todoId?: unknown }): string | null =>
  typeof props.todoId === "string" && props.todoId !== "" ? props.todoId : null;

/**
 * The toolbar's views. dayCount counts visible days only: with the weekend hidden, "3" from
 * Thursday is Thu, Fri, Mon — and the 1–4 day views page by as many weekdays (step).
 */
const VIEWS: Record<string, { type: string; buttonText: string; dayCount?: number; weekends?: boolean }> = {
  days1: { type: "timeGrid", dayCount: 1, buttonText: "1" },
  days2: { type: "timeGrid", dayCount: 2, buttonText: "2" },
  days3: { type: "timeGrid", dayCount: 3, buttonText: "3" },
  days4: { type: "timeGrid", dayCount: 4, buttonText: "4" },
  workWeek: { type: "timeGridWeek", buttonText: "Work week" },
  fullWeek: { type: "timeGridWeek", weekends: true, buttonText: "Week" },
};

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
  todoId: string | null;
  /** False for a recurring To Do task until M9.0 shows Graph keeps its series (spec no. 30, 37). */
  checkable: boolean;
  /** The Tasks emoji of a set priority, and its name for screen readers. */
  priority: { mark: string; name: string } | null;
  title: string;
  /** Customer · project. */
  meta: string;
  bucket: string | null;
  /** "with 2 other people", Planner only. */
  shared: string | null;
  /** "due Tue 22/09" from 📅, "⏳ Wed 08/07" from ⏳ where 📅 is missing. */
  date: string | null;
  overdue: boolean;
  status: { text: string; muted: boolean } | null;
  conflict: string | null;
  pending: boolean;
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
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
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

/** "one other person" / "2 other people". */
const others = (count: number): string => (count === 1 ? "one other person" : `${count} other people`);

/**
 * Tasks on the left, the Outlook week on the right. The calendar is the truth: the view derives
 * "planned" from what Graph returns and writes nothing to the vault except a block id on drop
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
  /**
   * The personal account's calendar (M9.1b): read in the same refresh as the work calendar, with
   * its own readiness and error — a failure there is a hint and never touches the work side.
   */
  private privateEvents: CalendarEvent[] = [];
  private privateReady = false;
  private privateDropped = 0;
  private privateError: string | null = null;
  private inFlight: number | null = null;
  private options: ListOptions = { search: "", customer: null, onlyUnplanned: false };
  private waitingOpen = false;
  private listSignature = "";
  private eventsSignature = "";
  private slotSignature = "";
  private customerSignature = "";
  private renderTimer: number | null = null;
  private calendarStale = false;
  private unsubscribe: (() => void) | null = null;
  /**
   * Planner's and To Do's last good reads, null while switched off or not read yet, kept when a read
   * fails. Their read and write rules live in RemoteSource.
   */
  private readonly plannerSource = new RemoteSource<PlannerSnapshot>();
  private readonly todoSource = new RemoteSource<TodoSnapshot>();
  /** Outlook category name -> colour preset. Empty until read, and after a failed read. */
  private categoryColors: ReadonlyMap<string, number> = new Map();
  /** Only the newest category read may land: an older one may be the previous account's. */
  private categorySeq = 0;

  private bannerEl: HTMLElement | null = null;
  private plannerHintEl: HTMLElement | null = null;
  private todoHintEl: HTMLElement | null = null;
  private countEl: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;
  private loadingEl: HTMLElement | null = null;
  private customerSelect: HTMLSelectElement | null = null;
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
        text: "Vault Planner only runs in the main window. Please drag the tab back into the main window.",
      });
      return;
    }

    this.buildLeft(root.createDiv({ cls: "vp-left" }));
    this.buildCalendar(root.createDiv({ cls: "vp-right" }));

    this.unsubscribe = this.plugin.onChange((reason) => this.onPluginChange(reason));
    // Registered on the VIEW, not the plugin: closing the tab must stop the poll.
    this.registerInterval(window.setInterval(() => this.poll(), REFRESH_INTERVAL_MS));
    // Planner and To Do on their own clock: a 429 there must not stall the calendar.
    this.registerInterval(
      window.setInterval(() => {
        if (!this.isVisible()) return;
        void this.refreshPlanner();
        void this.refreshTodo();
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
    void this.refreshTodo();
    void this.loadCategoryColors();
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
    header.createEl("h3", { text: "Tasks" });
    this.countEl = header.createDiv({ cls: "vp-count" });
    this.bannerEl = left.createDiv({ cls: "vp-banner" });
    this.plannerHintEl = left.createDiv({ cls: "vp-banner" });
    this.todoHintEl = left.createDiv({ cls: "vp-banner" });

    // Controls live OUTSIDE the container that is rebuilt, so typing keeps its focus.
    const controls = left.createDiv({ cls: "vp-controls" });
    const search = controls.createEl("input", { type: "search", cls: "vp-search", attr: { placeholder: "Search tasks" } });
    search.addEventListener("input", () => {
      this.options = { ...this.options, search: search.value };
      this.renderList();
    });
    const select = controls.createEl("select", { cls: "dropdown vp-customer" });
    select.addEventListener("change", () => {
      this.options = { ...this.options, customer: select.value === "" ? null : select.value };
      this.renderList();
    });
    this.customerSelect = select;
    const label = controls.createEl("label", { cls: "vp-unplanned" });
    const box = label.createEl("input", { type: "checkbox" });
    label.appendText(" unplanned only");
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
        // Required: without it FullCalendar gives the drop no end (hasEnd, interaction/index.js:1942),
        // and onEventReceive returns silently — every drop would vanish.
        duration: BLOCK_DURATION,
        create: true,
        extendedProps: {
          path: el.dataset.path,
          raw: el.dataset.raw,
          blockId: el.dataset.blockId,
          plannerId: el.dataset.plannerId,
          todoId: el.dataset.todoId,
        },
      }),
    });
  }

  private buildCalendar(right: HTMLElement): void {
    this.loadingEl = right.createDiv({ cls: "vp-loading", text: "Loading events…" });
    const stored: unknown = this.app.loadLocalStorage(CALENDAR_VIEW_KEY);
    const calendar = new Calendar(right.createDiv({ cls: "vp-calendar" }), {
      plugins: [timeGridPlugin, interactionPlugin],
      views: VIEWS,
      // en-gb brings no button texts, and FullCalendar's default is a lowercase "today".
      buttonText: { today: "Today" },
      buttonHints: {
        days1: "1 day",
        days2: "2 work days",
        days3: "3 work days",
        days4: "4 work days",
        workWeek: "Work week (Mon–Fri)",
        fullWeek: "Week (Mon–Sun)",
      },
      initialView: typeof stored === "string" && Object.hasOwn(VIEWS, stored) ? stored : "workWeek",
      // The locale OBJECT: a bare "en-gb" finds no loaded locale, and texts and week rules fall back to "en".
      locale: enGbLocale,
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
      // Own arrows: FullCalendar's would page a dayCount view by one day.
      customButtons: {
        vpPrev: { icon: "chevron-left", hint: "Previous", click: () => this.step(-1) },
        vpNext: { icon: "chevron-right", hint: "Next", click: () => this.step(1) },
      },
      headerToolbar: { left: "vpPrev,vpNext today", center: "title", right: "days1,days2,days3,days4 workWeek,fullWeek" },
      droppable: true,
      editable: true,
      eventResizableFromStart: true,
      // 0, not the default 5 px: with a threshold, eventDragStart fires only after the mouse has
      // moved, and a read landing in between would swap the event source under the pressed block
      // (FullCalendar then merges the old copy back: a ghost block). At 0 the gesture opens on
      // mousedown; resizing uses the same option.
      eventDragMinDistance: 0,
      // THE drop gate. `droppable` does not stop drops from the list in 6.1.21 — external drops
      // only consult dropAccept and eventAllow. Not ready, or the all-day row: refused. A To Do card
      // or a private block needs the private calendar, everything else the work one (spec no. 47).
      eventAllow: (span, moving) => {
        if (span.allDay) return false;
        const props = (moving?.extendedProps ?? {}) as { todoId?: unknown; calendar?: unknown };
        return todoIdFrom(props) !== null || props.calendar === "private" ? this.privateReady : this.ready;
      },
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

  /** Back from Outlook, Planner or To Do: all may have changed. Planner and To Do at most every 30 s. */
  private onReturn(): void {
    this.poll();
    if (!this.isVisible()) return;
    // Half their clock: prompt after the web app, but no full read on every window switch.
    const due = (readAt: number) => Date.now() - readAt >= PLANNER_REFRESH_INTERVAL_MS / 2;
    if (due(this.plannerSource.readAt)) void this.refreshPlanner();
    if (due(this.todoSource.readAt)) void this.refreshTodo();
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
      // The client id is the personal account's too.
      void this.refreshTodo(true);
      // The Planner switch leaves this scope alone; a sign-in may be another account's.
      if (reason === "auth") void this.loadCategoryColors();
      return;
    }
    // The To Do switch or the personal account: To Do reads again, and so does the calendar — the
    // private one is read together with the work one (spec no. 43). Nothing else of the work side
    // changes.
    if (reason === "todo") {
      // Switched off or signed out: the private side goes now, not when the read lands — until then
      // a private block could still be moved with the personal account.
      if (!this.readsPrivate()) {
        this.applyPrivate(null);
        this.renderAll();
      }
      void this.refreshTodo(true);
      void this.refresh(true);
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
      this.applyPrivate(null);
      this.gate.settled(this.gate.start());
      this.renderAll();
      return;
    }
    if (!force && this.inFlight !== null) return;

    const seq = this.gate.start();
    this.inFlight = seq;
    const range = fetchRange(this.displayed, new Date());
    // Both calendars in one read, so the gate's rules hold for both. Never rejects: the private
    // side's failure is its own (spec no. 43).
    const privateRead = this.readsPrivate()
      ? this.plugin.todoGraph.readCalendar(range).then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        )
      : null;
    try {
      const result = await graph.readCalendar(range);
      // ponytail: the work grid waits for the private read, at worst its 30 s timeout. Apply the work
      // side first if outlook.com proves slow — then todo: markers must wait for the private side.
      const privateResult = privateRead === null ? null : await privateRead;
      if (!this.gate.accepts(seq)) return;
      this.applyPrivate(privateResult);
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
      // Stale events would make a plausible, wrong plan: clear them and say the status is unknown —
      // the private side's too.
      this.events = [];
      this.ready = false;
      this.applyPrivate(null);
      this.error = { message: getErrorMessage(error), needsLogin: isAuthExpired(error) };
      this.gate.settled(seq);
    } finally {
      if (this.inFlight === seq) this.inFlight = null;
      this.renderAll();
    }
  }

  /** To Do and the private calendar are read only with the switch on and the personal account signed in. */
  private readsPrivate(): boolean {
    const { settings, todoAuth } = this.plugin;
    return settings.todoEnabled && todoAuth.configured && todoAuth.signedIn;
  }

  /** The one place a calendar side names its account: the Graph client and the error texts. */
  private calendarAccount(side: CalendarSide): { graph: Graph; describe: (error: unknown) => string } {
    return side === "private"
      ? { graph: this.plugin.todoGraph, describe: getPersonalErrorMessage }
      : { graph: this.plugin.graph, describe: getErrorMessage };
  }

  /** null: not read (switched off, signed out, or the work side failed) — nothing to show, no drops. */
  private applyPrivate(read: { result: MapResult } | { error: unknown } | null): void {
    if (read !== null && "result" in read) {
      this.privateEvents = read.result.events;
      this.privateDropped = read.result.droppedCount;
      this.privateReady = true;
      this.privateError = null;
      return;
    }
    this.privateEvents = [];
    this.privateDropped = 0;
    this.privateReady = false;
    this.privateError = read === null ? null : getPersonalErrorMessage(read.error);
  }

  /**
   * Planner tasks and buckets. Never touches the calendar: a failure here is a hint, not a banner.
   * `force` starts a read even while one runs (RemoteSource).
   */
  private async refreshPlanner(force = false): Promise<void> {
    const { auth, graph, settings } = this.plugin;
    if (!settings.plannerEnabled || !auth.configured || !auth.signedIn) {
      if (this.plannerSource.clear()) this.renderAll();
      return;
    }
    if (await this.plannerSource.read(() => graph.readPlanner(), getErrorMessage, force)) this.renderAll();
  }

  /**
   * The personal account's To Do (M9). Like Planner: a hint, never a banner, never a sign-out of the
   * work account. Nothing is read while the switch is off.
   */
  private async refreshTodo(force = false): Promise<void> {
    if (!this.readsPrivate()) {
      // Tasks gone: the whole list. Otherwise only the hint — "not signed in" comes and goes with
      // the switch, and a full render on every tick would rebuild the list under a drag.
      if (this.todoSource.clear()) this.renderAll();
      else this.renderSourceHints();
      return;
    }
    // Switched on or signed in just now: "werden geladen…" while the first read runs (UX rule 1).
    if (this.todoSource.snapshot === null) this.renderSourceHints();
    if (await this.todoSource.read(() => this.plugin.todoGraph.readTodo(), getPersonalErrorMessage, force)) this.renderAll();
  }

  /**
   * Decoration only: a failed read leaves every meeting in the base colour, no banner — the plan
   * status does not depend on it. Never the last list on failure or sign-out: it may be another
   * account's. Read on open and after sign-in, so a category created meanwhile shows once the view
   * is reopened.
   */
  private async loadCategoryColors(): Promise<void> {
    const { auth, graph } = this.plugin;
    const seq = ++this.categorySeq;
    let colors: ReadonlyMap<string, number> = new Map();
    if (auth.configured && auth.signedIn) {
      try {
        colors = await graph.readCategoryColors();
      } catch {
        // The base colour; see above.
      }
    }
    if (seq !== this.categorySeq) return;
    this.categoryColors = colors;
    this.renderCalendar();
  }

  /** The task as the LAST read knows it: its etag may have changed since the card was built. */
  private plannerTask(id: string): PlannerTask | undefined {
    return this.plannerSource.task(id);
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

  /** The 1–4 day views move by as many weekdays (Mon–Wed, Thu–Mon), the weeks by a week. */
  private step(direction: 1 | -1): void {
    const calendar = this.calendar;
    if (calendar === null) return;
    const days = VIEWS[calendar.view.type]?.dayCount;
    if (days !== undefined) calendar.gotoDate(shiftWorkdays(calendar.view.currentStart, direction * days));
    else if (direction === 1) calendar.next();
    else calendar.prev();
  }

  private onDatesSet(arg: DatesSetArg): void {
    // Per device, like the account hint: the view is a habit of this screen, not of the vault.
    this.app.saveLocalStorage(CALENDAR_VIEW_KEY, arg.view.type);
    const previous = this.displayed;
    // datesSet also fires on renders that did not change the range; reading then would loop.
    if (previous !== null && previous.start.getTime() === arg.start.getTime() && previous.end.getTime() === arg.end.getTime()) {
      return;
    }
    this.displayed = { start: arg.start, end: arg.end };
    // This week has not been read yet: no drops until it has, in either calendar.
    this.ready = false;
    this.privateReady = false;
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
    const blocks = blocksByTask([...this.events, ...this.privateEvents], this.app.vault.getName(), statusWindow(now));
    return (task) => {
      // No private calendar read yet: a To Do task's status is unknown — no line (spec no. 49).
      if (isTodoTask(task) && !this.privateReady) return UNPLANNED;
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

    if (!auth.configured) show("Set up Vault Planner: enter the tenant id and client id in the plugin settings.");
    else if (!auth.signedIn) show("Not signed in – without signing in there is no calendar and no planning status.", ["Sign in", login]);
    else if (this.error !== null && this.error.needsLogin) show(this.error.message, ["Sign in", login], true);
    else if (this.error !== null) {
      show(`Calendar unreachable – planning status unknown. ${this.error.message}`, ["Retry", () => void this.refresh(true)], true);
    } else if (!this.ready) show("Loading planning status…");
    else if (this.dropped > 0) {
      show(`Not every event was readable (${this.dropped}) – the calendar does not show everything.`, ["Retry", () => void this.refresh(true)], true);
    } else el.toggle(false);

    this.loadingEl?.toggle(auth.configured && auth.signedIn && !this.everLoaded && this.error === null);
    this.renderSourceHints();
  }

  /** Planner's and To Do's hints above the list: a failure there is a hint, never the banner. */
  private renderSourceHints(): void {
    const { auth, todoAuth, settings } = this.plugin;
    type Hint = { text: string; warning: boolean; action?: [string, () => void] } | null;
    const draw = (el: HTMLElement | null, hint: Hint) => {
      if (el === null) return;
      el.empty();
      el.toggle(hint !== null);
      if (hint === null) return;
      el.toggleClass("is-warning", hint.warning);
      el.createSpan({ text: hint.text });
      if (hint.action !== undefined) el.createEl("button", { text: hint.action[0], cls: "mod-cta" }).addEventListener("click", hint.action[1]);
    };
    const fromSource = (
      source: { snapshot: { truncated: boolean; droppedCount: number } | null; error: string | null },
      names: { tasks: string; truncated: string; failed: (error: string) => string },
      retry: () => void,
    ): Hint => {
      const { snapshot, error } = source;
      // Everything but the first load is something missing.
      if (error !== null) return { text: names.failed(error), warning: true, action: ["Retry", retry] };
      if (snapshot === null) return { text: `Loading ${names.tasks}…`, warning: false };
      if (snapshot.truncated) return { text: names.truncated, warning: true };
      if (snapshot.droppedCount > 0) return { text: `${snapshot.droppedCount} ${names.tasks} were unreadable and are missing from the list.`, warning: true };
      return null;
    };

    draw(
      this.plannerHintEl,
      settings.plannerEnabled && auth.configured && auth.signedIn
        ? fromSource(
            this.plannerSource,
            {
              tasks: "Planner tasks",
              truncated: "Planner returned more tasks than the plugin reads – some are missing.",
              failed: (error) => `Planner unreachable – ${error}`,
            },
            () => void this.refreshPlanner(true),
          )
        : null,
    );

    let todo: Hint = null;
    if (settings.todoEnabled && (!todoAuth.configured || !todoAuth.signedIn)) {
      // Switched on, signed out: say so, with the one way forward (spec no. 39).
      todo = {
        text: "Personal account not signed in – without signing in there are no To Do tasks.",
        warning: false,
        action: [
          "Sign in",
          () => {
            todoAuth.login().catch((error: unknown) => new Notice(getPersonalErrorMessage(error)));
          },
        ],
      };
    } else if (settings.todoEnabled) {
      // The personal error texts already name the account.
      todo = fromSource(
        this.todoSource,
        {
          tasks: "To Do tasks",
          truncated: "To Do returned more tasks than the plugin reads – some are missing.",
          failed: (error) => error,
        },
        () => void this.refreshTodo(true),
      );
      // The private calendar (spec no. 51). Loading only while a read really runs: after a work
      // read that succeeded — a failed or missing one has its own banner.
      const privateHint: Hint =
        this.privateError !== null
          ? { text: this.privateError, warning: true, action: ["Retry", () => void this.refresh(true)] }
          : this.ready && !this.privateReady
            ? { text: "Loading private calendar…", warning: false }
            : this.privateDropped > 0
              ? { text: `Not every private event was readable (${this.privateDropped}) – the calendar does not show everything.`, warning: true }
              : null;
      // An error first, from either side: a lasting "truncated" must not hide that drops fail.
      todo = (todo?.action ? todo : null) ?? (privateHint?.action ? privateHint : null) ?? todo ?? privateHint;
    }
    draw(this.todoHintEl, todo);
  }

  private cardData(
    task: AnyTask,
    statusOf: ((task: AnyTask) => PlanStatus) | null,
    byBlock: Map<string, VaultTask[]>,
    today: string,
    weekEnd: Date,
  ): CardData {
    const planner = isPlannerTask(task) ? task : null;
    const todo = isTodoTask(task) ? task : null;
    const vault = isPlannerTask(task) || isTodoTask(task) ? null : task;
    const siblings = vault === null || vault.blockId === null ? undefined : byBlock.get(vault.blockId);
    const conflict =
      siblings !== undefined && siblings.length > 1
        ? `Duplicate block id (${siblings.map((other) => other.path.split("/").pop()?.replace(/\.md$/, "")).join(", ")})`
        : null;

    let status: CardData["status"] = null;
    const plan = statusOf?.(task);
    if (plan?.kind === "planned") {
      const format = plan.next.start.getTime() >= weekEnd.getTime() ? formatSlotWithDate : formatSlot;
      status = { text: format(plan.next.start, plan.next.end), muted: false };
    } else if (plan?.kind === "past") {
      status = { text: `past: ${formatSlot(plan.last.start, plan.last.end)}`, muted: true };
    }

    const bucket =
      planner === null ? undefined : this.plannerSource.snapshot?.buckets.get(planner.planId)?.find((b) => b.id === planner.bucketId);
    const key = linkKey(task);
    const date = listDate(task);

    return {
      path: vault?.path ?? "",
      line: vault?.line ?? 0,
      raw: vault?.raw ?? "",
      blockId: vault?.blockId ?? null,
      plannerId: planner?.id ?? null,
      todoId: todo?.id ?? null,
      // ponytail: the safe default until the M9.0 report (spec no. 37); then per its answer.
      checkable: todo === null || !todo.isRecurring,
      priority: PRIORITY_MARK[task.priority],
      title: cleanTitle(task.description) || task.description,
      meta: task.project === null ? task.customer : `${task.customer} · ${task.project}`,
      bucket: bucket?.name ?? null,
      shared: planner === null || !planner.othersAssigned ? null : `with ${others(planner.othersAssigned)}`,
      date: date === null ? null : `${task.due === null ? "⏳" : "due"} ${formatDue(date, today)}`,
      overdue: isOverdue(task, today),
      status,
      conflict,
      pending:
        (key !== null && this.gate.isPending(key)) ||
        (vault !== null && this.gate.isPending(rawKey(vault))) ||
        (planner !== null && this.plannerSource.isWriting(planner.id)) ||
        (todo !== null && this.todoSource.isWriting(todo.id)),
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
    const tasks = [...index.tasks, ...(this.plannerSource.snapshot?.tasks ?? []), ...(this.todoSource.snapshot?.tasks ?? [])];
    const model = buildList(tasks, statusOf, this.options, today);

    // The chosen customer has no open task left: the filter was reset, so build the list again.
    if (this.syncCustomers(model.customers)) {
      this.renderList();
      return;
    }
    if (this.unplannedBox !== null) this.unplannedBox.disabled = statusOf === null;
    this.countEl?.setText(model.openCount === 0 ? "" : `${model.shownCount} of ${model.openCount} open`);

    const toRows = (tasks: AnyTask[]) =>
      tasks.map((task) => ({ task, card: this.cardData(task, statusOf, byBlock, today, weekEnd) }));
    const groups = model.groups.map((group) => ({ key: group.key, rows: toRows(group.tasks) }));
    const waiting = toRows(model.waiting);
    const { auth, todoAuth, settings } = this.plugin;
    const loading = (source: { snapshot: unknown; error: string | null }) => source.snapshot === null && source.error === null;
    const sourcesLoading =
      (settings.plannerEnabled && auth.configured && auth.signedIn && loading(this.plannerSource)) ||
      (settings.todoEnabled && todoAuth.configured && todoAuth.signedIn && loading(this.todoSource));
    const empty = (!index.complete || sourcesLoading) && model.openCount === 0
      ? "Reading tasks…"
      : model.openCount === 0
        ? "No open tasks."
        : model.shownCount === 0
          ? "No task matches the filter."
          : null;

    // Rebuild only when something visible changed: a rebuild every 15 s would reset the scroll
    // position and the open "Waiting for" section in the middle of reading.
    const cardsOf = (rows: { card: CardData }[]) => rows.map((row) => row.card);
    const signature = JSON.stringify({
      groups: groups.map((group) => [group.key, cardsOf(group.rows)]),
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
      section.createEl("h4", { cls: `vp-group-title vp-g-${group.key}`, text: `${GROUP_TITLE[group.key]} · ${group.rows.length}` });
      for (const row of group.rows) this.buildCard(section, row.task, row.card);
    }
    if (waiting.length > 0) {
      const details = list.createEl("details", { cls: "vp-group vp-waiting" });
      details.open = this.waitingOpen;
      details.addEventListener("toggle", () => {
        this.waitingOpen = details.open;
      });
      details.createEl("summary", { cls: "vp-group-title", text: `Waiting for · ${waiting.length}` });
      for (const row of waiting) this.buildCard(details, row.task, row.card);
    }
    list.scrollTop = scrollTop;
  }

  private buildCard(parent: HTMLElement, task: AnyTask, card: CardData): void {
    // Self-contained class: FullCalendar's drag preview is a copy of this element in <body>,
    // where styles scoped to the view would not reach it.
    const el = parent.createDiv({ cls: "vp-card" });
    // The source colour, the same as the block this card turns into.
    el.toggleClass("is-planner", card.plannerId !== null);
    el.toggleClass("is-todo", card.todoId !== null);
    el.toggleClass("is-pending", card.pending);
    el.toggleClass("is-conflict", card.conflict !== null);
    if (!card.pending && card.conflict === null) {
      el.dataset.drag = "";
      if (card.plannerId !== null) el.dataset.plannerId = card.plannerId;
      else if (card.todoId !== null) el.dataset.todoId = card.todoId;
      else {
        el.dataset.path = card.path;
        el.dataset.raw = card.raw;
        if (card.blockId !== null) el.dataset.blockId = card.blockId;
      }
      el.dataset.title = card.title;
    }

    if (card.checkable) {
      const check = el.createEl("input", { type: "checkbox", cls: "vp-check", attr: { "aria-label": "Complete", title: "Complete" } });
      // FullCalendar starts a drag on mousedown/touchstart of the list; the checkbox must not.
      for (const type of ["mousedown", "touchstart", "click"]) check.addEventListener(type, (event) => event.stopPropagation());
      // Saving: a second tick would send a used-up etag, or complete a task that is being booked.
      check.disabled = card.pending;
      check.addEventListener("change", () => {
        if (isPlannerTask(task)) this.completePlanner(task.id, check);
        else if (isTodoTask(task)) this.completeTodo(task.id, check);
        else void this.complete(task, check);
      });
    } else {
      // Where the checkbox would be, the same size: says why there is none (spec no. 30, 37).
      const label = "Recurring – tick it off in To Do";
      setIcon(el.createSpan({ cls: "vp-check-spacer", attr: { title: label, "aria-label": label, role: "img" } }), "repeat");
    }

    const opens = isPlannerTask(task) ? "Open in Planner" : isTodoTask(task) ? "Open in To Do" : "Open";
    const body = el.createDiv({ cls: "vp-card-body", attr: { role: "button", tabindex: "0", title: opens } });
    const title = body.createDiv({ cls: "vp-title" });
    if (card.priority !== null) {
      const label = `Priority ${card.priority.name}`;
      title.createSpan({ cls: "vp-priority", text: card.priority.mark, attr: { title: label, "aria-label": label } });
    }
    title.appendText(card.title);
    const meta = body.createDiv({ cls: "vp-meta", text: card.meta });
    if (card.bucket !== null) {
      meta.appendText(" ");
      meta.createSpan({ cls: "vp-chip", text: card.bucket });
    }
    if (card.shared !== null) meta.appendText(` · ${card.shared}`);
    if (card.date !== null) {
      meta.appendText(" · ");
      // Red is an addition, not the message: the date itself says what is wrong.
      meta.createSpan({ cls: card.overdue ? "vp-due is-overdue" : "vp-due", text: card.date });
    }
    if (card.pending) body.createDiv({ cls: "vp-status", text: "Saving…" });
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
  private syncCustomers(customers: string[]): boolean {
    const select = this.customerSelect;
    if (select === null) return false;
    const signature = customers.join("\u0000");
    if (signature === this.customerSignature) return false;
    this.customerSignature = signature;
    const reset = this.options.customer !== null && !customers.includes(this.options.customer);
    if (reset) this.options = { ...this.options, customer: null };
    select.empty();
    select.createEl("option", { text: "All customers", value: "" });
    for (const customer of customers) select.createEl("option", { text: customer, value: customer });
    select.value = this.options.customer ?? "";
    return reset;
  }

  private blockState(byBlock: Map<string, VaultTask[]>): (blockId: string) => BlockState {
    const complete = this.plugin.index.complete;
    return (blockId) => {
      const plannerId = plannerIdOf(blockId);
      if (plannerId !== null) {
        // Switched off or not read yet: say nothing rather than "Task not found".
        if (this.plannerSource.snapshot === null) return "pending";
        const task = this.plannerTask(plannerId);
        if (task === undefined) return "missing";
        return isOpen(task) ? "open" : "done";
      }
      const todoId = todoIdOf(blockId);
      if (todoId !== null) {
        const snapshot = this.todoSource.snapshot;
        if (this.todoSource.task(todoId) !== undefined) return "open";
        // Completed To Dos are not read: not among the open ones means done or gone (spec no. 46) —
        // but only after a complete read; a cut or unreadable one says nothing.
        return snapshot === null || snapshot.truncated || snapshot.droppedCount > 0 ? "pending" : "done";
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

    const vaultName = this.app.vault.getName();
    const stateOf = this.blockState(this.plugin.index.blockIndex());
    const input = [
      ...toFullCalendarEvents(this.events, vaultName, stateOf, this.categoryColors),
      ...toFullCalendarEvents(this.privateEvents, vaultName, stateOf, this.categoryColors, "private"),
    ];
    const signature = JSON.stringify(input);
    if (signature !== this.eventsSignature) {
      this.eventsSignature = signature;
      calendar.batchRendering(() => {
        calendar.getEventSourceById("graph")?.remove();
        calendar.addEventSource({ id: "graph", events: input });
      });
    }

    // The configured hours are a floor that widens to the displayed week's events.
    const hours = visibleHours(inRange([...this.events, ...this.privateEvents], this.displayed), WORK_HOURS);
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
    } else if (props.calendar === "private") {
      // The private calendar's meetings: a lock, besides their grey (spec no. 45).
      setIcon(wrap.createSpan({ cls: "vp-event-icon" }), "lock");
    }
    const text = wrap.createDiv({ cls: "vp-event-text" });
    if (arg.timeText !== "" && !arg.event.allDay) text.createDiv({ cls: "vp-event-time", text: arg.timeText });
    text.createDiv({ cls: "vp-event-title", text: arg.event.title });
    return { domNodes: [wrap] };
  }

  private onEventMount(arg: EventMountArg): void {
    const props = arg.event.extendedProps as Partial<EventProps>;
    const { start, end } = arg.event;
    const when = start !== null && end !== null && !arg.event.allDay ? formatSlot(start, end) : "all day";
    const todoId = typeof props.blockId === "string" ? todoIdOf(props.blockId) : null;
    const hint =
      props.state === "missing"
        ? "\nTask not found"
        : props.state === "conflict"
          ? "\nDuplicate block id"
          : todoId !== null && props.state === "done"
            ? "\nTask completed or no longer in To Do"
            : "";
    const side = props.calendar === "private" ? "\nPrivate calendar" : "";
    arg.el.setAttribute("title", `${arg.event.title}\n${when}${side}${hint}`);

    if (props.kind !== "own" || typeof props.blockId !== "string") return;
    const blockId = props.blockId;
    const { calendar: calendarSide, eventId } = arg.event.extendedProps as EventProps;
    arg.el.addEventListener("contextmenu", (event) => {
      // Without this, Electron shows its own menu on top.
      event.preventDefault();
      event.stopPropagation();
      const menu = new Menu();
      const plannerId = plannerIdOf(blockId);
      const tasks = this.plugin.index.blockIndex().get(blockId);
      if (plannerId !== null) {
        menu.addItem((item) => item.setTitle("Open in Planner").setIcon("external-link").onClick(() => this.openPlanner(plannerId)));
        menu.addSeparator();
      } else if (todoId !== null) {
        // A click opens the browser (Invariant 6).
        menu.addItem((item) => item.setTitle("Open in To Do").setIcon("external-link").onClick(() => this.openTodo(todoId)));
        menu.addSeparator();
      } else if (tasks !== undefined && tasks.length === 1) {
        const task = tasks[0];
        menu.addItem((item) => item.setTitle("Open task").setIcon("file-text").onClick(() => void this.openTask(task)));
        menu.addSeparator();
      }
      menu.addItem((item) =>
        item
          .setTitle("Delete block…")
          .setIcon("trash-2")
          .setWarning(true)
          .onClick(() => {
            // Looked up now, not at mount: a block moved within its day is not remounted, so the
            // times captured in eventDidMount would name the old slot.
            const current = this.calendar?.getEventById(arg.event.id) ?? arg.event;
            this.confirmDelete(eventId, calendarSide, current.title, current.start, current.end);
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
    const props = arg.event.extendedProps as { path?: unknown; raw?: unknown; blockId?: unknown; plannerId?: unknown; todoId?: unknown };
    arg.revert();
    if (start === null || end === null || arg.event.allDay) return;

    // A To Do card goes into the PRIVATE calendar, wherever it was dropped (spec no. 18). The
    // second door for each calendar; eventAllow is the first.
    const todoId = todoIdFrom(props);
    if (todoId !== null) {
      if (!this.privateReady) {
        new Notice("The private calendar is not ready yet – please wait a moment.");
        return;
      }
      void this.bookTodo(todoId, start, end);
      return;
    }
    if (!this.ready) {
      new Notice("The calendar is not ready yet – please wait a moment.");
      return;
    }
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
      new Notice("The task has changed in the meantime – please drag it again.");
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
      new Notice(`Event created: ${formatSlot(start, end)}.`);
    } catch (error) {
      new Notice(getErrorMessage(error));
    } finally {
      // The card stays "Saving…" until a read started NOW has come back.
      this.gate.releaseAfterNextRead(blockId);
      this.gate.releaseAfterNextRead(draftKey);
      void this.refresh(true);
    }
  }

  private onEventChange(arg: EventChangeArg): void {
    const { start, end, id } = arg.event;
    // Back to the calendar it came from, with that account (spec no. 25, 44).
    // toFullCalendarEvents sets both on every event; the grid id carries a prefix (spec no. 44).
    const { calendar, eventId } = arg.event.extendedProps as EventProps;
    const account = this.calendarAccount(calendar);
    if (start === null || end === null || id === "" || arg.event.allDay) {
      arg.revert();
      return;
    }
    if (this.patching.has(id)) {
      arg.revert();
      new Notice("The event is being moved right now.");
      return;
    }
    this.patching.add(id);
    this.gate.beginGesture();
    void (async () => {
      try {
        await account.graph.moveBlock(eventId, start, end);
      } catch (error) {
        // Never keep showing a move that did not reach Outlook.
        arg.revert();
        new Notice(account.describe(error));
      } finally {
        this.patching.delete(id);
        this.gate.endGesture();
        if (this.calendarStale) this.renderCalendar();
        void this.refresh(true);
      }
    })();
  }

  private confirmDelete(eventId: string, side: CalendarSide, title: string, start: Date | null, end: Date | null): void {
    const when = start !== null && end !== null ? ` (${formatSlot(start, end)})` : "";
    const where = side === "private" ? "from your private calendar" : "from Outlook";
    new ConfirmModal(
      this.app,
      {
        title: "Delete block?",
        message: `“${title}”${when} will be deleted ${where}. The task stays as it is.`,
        confirm: "Delete",
        warning: true,
      },
      () => void this.deleteBlock(eventId, side),
    ).open();
  }

  private async deleteBlock(eventId: string, side: CalendarSide): Promise<void> {
    const account = this.calendarAccount(side);
    try {
      await account.graph.deleteBlock(eventId);
      new Notice("Block deleted.");
    } catch (error) {
      new Notice(account.describe(error));
    } finally {
      void this.refresh(true);
    }
  }

  private async complete(task: VaultTask, box: HTMLInputElement): Promise<void> {
    box.disabled = true;
    try {
      await toggleDone(this.app, task);
      // Blocks stay in Outlook: booked time is history. The block menu can still delete them.
      new Notice(`“${cleanTitle(task.description)}” completed.`);
    } catch (error) {
      box.checked = false;
      box.disabled = false;
      new Notice(getErrorMessage(error));
    }
  }

  /** Not `open`: that name belongs to Obsidian's View (see CLAUDE.md, Code-Standards). */
  private openCard(task: AnyTask): void {
    if (isPlannerTask(task)) this.openPlanner(task.id);
    else if (isTodoTask(task)) this.openTodo(task.id);
    else void this.openTask(task);
  }

  /** A click, never a timer, opens the browser (Invariant 6). */
  private openTodo(taskId: string): void {
    window.open(todoWebUrl(taskId));
  }

  /** A click, never a timer, opens the browser (Invariant 6). */
  private openPlanner(taskId: string): void {
    window.open(plannerWebUrl(this.plugin.settings.tenantId.trim(), taskId));
  }

  /**
   * Like bookPlanner, but into the PRIVATE calendar through the personal account (spec no. 18, 24):
   * the same block rules, the To Do link, nothing written to the vault or to To Do.
   */
  private async bookTodo(taskId: string, start: Date, end: Date): Promise<void> {
    const task = this.todoSource.task(taskId);
    if (task === undefined || !isOpen(task)) {
      new Notice("The To Do task is no longer open – please check the list.");
      return;
    }
    const key = todoKey(task.id);
    this.gate.hold(key);
    this.renderList();
    try {
      await this.plugin.todoGraph.createBlock({
        subject: eventSubject(task.description),
        body: todoEventBody(task, todoWebUrl(task.id)),
        start,
        end,
        link: key,
      });
      new Notice(`Event created in the private calendar: ${formatSlot(start, end)}.`);
    } catch (error) {
      new Notice(getPersonalErrorMessage(error));
    } finally {
      this.gate.releaseAfterNextRead(key);
      void this.refresh(true);
    }
  }

  /** Like book(), but nothing is written to the vault: the Planner id is already stable. */
  private async bookPlanner(taskId: string, start: Date, end: Date): Promise<void> {
    const task = this.plannerTask(taskId);
    if (task === undefined || !isOpen(task)) {
      new Notice("The Planner task is no longer open – please check the list.");
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
      new Notice(`Event created: ${formatSlot(start, end)}.`);
    } catch (error) {
      new Notice(getErrorMessage(error));
    } finally {
      this.gate.releaseAfterNextRead(key);
      void this.refresh(true);
    }
  }

  /**
   * The Planner and To Do writes: mark the card, send, and keep the mark until a read brings the
   * new etag — the one this write used is spent either way, and a second click would only earn a
   * 412 (RemoteSource). Checked here, not at the checkbox: a confirm dialog can outlive a second one.
   */
  private async writeRemote(
    target: { source: RemoteSource<{ tasks: { id: string; etag: string | null }[] }>; describe: (error: unknown) => string; reread: () => Promise<void> },
    task: { id: string; etag: string | null },
    write: () => Promise<void>,
    success: string,
  ): Promise<void> {
    if (target.source.isWriting(task.id)) {
      new Notice("The task is already being saved.");
      return;
    }
    target.source.beginWrite(task.id);
    this.renderList();
    let spent: string | null = null;
    try {
      await write();
      spent = task.etag;
      new Notice(success);
    } catch (error) {
      new Notice(target.describe(error));
    } finally {
      target.source.endWrite(task.id, spent);
      void target.reread();
    }
  }

  private plannerWrite(task: PlannerTask, write: () => Promise<void>, success: string): Promise<void> {
    return this.writeRemote({ source: this.plannerSource, describe: getErrorMessage, reread: () => this.refreshPlanner(true) }, task, write, success);
  }

  private todoWrite(task: TodoTask, write: () => Promise<void>, success: string): Promise<void> {
    return this.writeRemote({ source: this.todoSource, describe: getPersonalErrorMessage, reread: () => this.refreshTodo(true) }, task, write, success);
  }

  /** Planner write #1. Shared with others: ask first, it closes the task on their board too. */
  private completePlanner(taskId: string, box: HTMLInputElement): void {
    const task = this.plannerTask(taskId);
    // The card is rebuilt as "Saving…" and then disappears; the tick itself is not the state.
    box.checked = false;
    if (task === undefined || this.plannerSource.isWriting(taskId)) {
      new Notice("The Planner task is no longer open – please check the list.");
      return;
    }
    // Blocks stay in Outlook: booked time is history.
    const run = (): void =>
      void this.plannerWrite(task, () => this.plugin.graph.completePlannerTask(task), `“${task.description}” completed in Planner.`);
    if (task.othersAssigned === 0) {
      run();
      return;
    }
    new ConfirmModal(
      this.app,
      {
        title: "Complete task?",
        message:
          task.othersAssigned === null
            ? `For “${task.description}” it was not readable who else the task is assigned to. Completing it completes it in Planner for everyone.`
            : `“${task.description}” is also assigned to ${others(task.othersAssigned)}. Completing it completes the task in Planner for everyone.`,
        confirm: "Complete",
        warning: false,
      },
      run,
    ).open();
  }

  /** Planner write #2, from the card's menu. The bucket list is the last read's. */
  private showPlannerMenu(event: MouseEvent, taskId: string): void {
    const task = this.plannerTask(taskId);
    if (task === undefined || this.plannerSource.isWriting(taskId)) return;
    const menu = new Menu();
    menu.addItem((item) => item.setTitle("Open in Planner").setIcon("external-link").onClick(() => this.openPlanner(task.id)));
    menu.addSeparator();
    const buckets = this.plannerSource.snapshot?.buckets.get(task.planId) ?? [];
    menu.addItem((item) => item.setTitle(buckets.length === 0 ? "No buckets read" : "Move to bucket").setDisabled(true));
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
    if (current === undefined || current.etag !== shown.etag || this.plannerSource.isWriting(shown.id)) {
      new Notice("The task has changed in the meantime – please open the menu again.");
      return;
    }
    void this.plannerWrite(shown, () => this.plugin.graph.movePlannerTask(shown, bucket.id), `“${shown.description}” moved to “${bucket.name}”.`);
  }

  /**
   * The one To Do write (M9, spec no. 27): complete, on a click. A shared list asks first — it
   * closes the task for everyone (no. 28, 41). No If-Match until M9.0 says To Do honours it (no. 37).
   */
  private completeTodo(taskId: string, box: HTMLInputElement): void {
    const task: TodoTask | undefined = this.todoSource.task(taskId);
    // The card is rebuilt as "Saving…" and then disappears; the tick itself is not the state.
    box.checked = false;
    if (task === undefined || this.todoSource.isWriting(taskId)) {
      new Notice("The To Do task is no longer open – please check the list.");
      return;
    }
    const run = (): void =>
      void this.todoWrite(task, () => this.plugin.todoGraph.completeTodoTask(task.listId, task.id, null), `“${task.description}” completed in To Do.`);
    if (!task.shared) {
      run();
      return;
    }
    new ConfirmModal(
      this.app,
      {
        title: "Complete task?",
        message: `“${task.description}” is in a shared list. Completing it completes the task in To Do for everyone.`,
        confirm: "Complete",
        warning: false,
      },
      run,
    ).open();
  }

  /** In a NEW tab — the planner itself must never be replaced by the note. */
  private async openTask(task: VaultTask): Promise<void> {
    const file = this.app.vault.getFileByPath(task.path);
    if (file === null) {
      new Notice("The file no longer exists.");
      return;
    }
    await this.app.workspace.getLeaf("tab").openFile(file, { active: true, eState: { line: task.line } });
  }
}

