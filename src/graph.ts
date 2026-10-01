import { requestUrl } from "obsidian";
import type { Auth } from "./auth";
import { GRAPH_BASE, IMMUTABLE_ID_HEADER, MAX_EVENT_PAGES, MAX_PLANNER_PAGES, REQUEST_TIMEOUT_MS } from "./config";
import { GraphApiError, withTimeout } from "./lib/errors";
import {
  calendarViewUrl,
  createEventBody,
  eventUrl,
  isGraphUrl,
  graphArea,
  MASTER_CATEGORIES_URL,
  moveEventBody,
  PLANNER_TASKS_URL,
  plannerTaskUrl,
  planUrl,
  TODO_LISTS_URL,
  todoTaskUrl,
  todoTasksUrl,
  type NewBlock,
} from "./lib/graphRequests";
import { mapGraphEvents, readCategoryColors, type MapResult } from "./lib/mapGraphEvents";
import { readPage } from "./lib/odata";
import { mapPlannerTasks, planTitle, readBuckets, type PlannerSnapshot } from "./lib/planner";
import { mapTodoTasks, readTodoLists, type TodoSnapshot } from "./lib/todo";
import type { GraphErrorResponse, PlannerBucket, PlannerTask, TimeRange } from "./lib/types";

function parseBody(text: string): unknown {
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function errorBody(value: unknown): GraphErrorResponse | null {
  if (typeof value !== "object" || value === null) return null;
  const error: unknown = (value as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return null;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return typeof code === "string" ? { error: { code, message: typeof message === "string" ? message : "" } } : null;
}

/**
 * The one door to Microsoft Graph. `requestUrl`, never `fetch`: fetch sends
 * `Origin: app://obsidian.md` and fails on CORS. The graph-calendar skill owns the rules.
 */
export class Graph {
  /** Plan titles for the session: they rarely change, and each is one request per plan. */
  private readonly planTitles = new Map<string, string>();
  /** Graph refused To Do's status filter once: do not ask again every minute (spec no. 37). */
  private todoFilterRejected = false;

  constructor(private readonly auth: Auth) {}

  /** `headers`: the immutable-id preference for calendar calls, If-Match for Planner writes. */
  private async send(
    method: string,
    url: string,
    body?: unknown,
    headers: Record<string, string> = IMMUTABLE_ID_HEADER,
  ): Promise<unknown> {
    if (!isGraphUrl(url)) throw new Error("Graph pointed to a foreign address. The request was not sent.");
    const attempt = async (token: string) =>
      withTimeout(
        requestUrl({
          url,
          method,
          // Headers are per request: the calendar's Prefer goes on every page and every write.
          headers: { Authorization: `Bearer ${token}`, ...headers },
          ...(body === undefined ? {} : { contentType: "application/json", body: JSON.stringify(body) }),
          throw: false,
        }),
        REQUEST_TIMEOUT_MS,
      );

    let response = await attempt(await this.auth.getAccessToken());
    // A token can be revoked before it expires: one fresh token, one retry, no loop.
    if (response.status === 401) response = await attempt(await this.auth.getAccessToken(true));

    // `.json` would throw on the empty body of a 204; read text and parse only what is there.
    const parsed = parseBody(response.text);
    if (response.status >= 400) throw new GraphApiError(response.status, errorBody(parsed), graphArea(url));
    return parsed;
  }

  /** Every event in `range`, series expanded by the server, our task property attached. */
  async readCalendar(range: TimeRange): Promise<MapResult> {
    const raw: unknown[] = [];
    let url: string | null = calendarViewUrl(range);
    for (let page = 0; url !== null && page < MAX_EVENT_PAGES; page += 1) {
      // nextLink already carries every query option — follow it exactly as returned.
      const { value, nextLink } = readPage(await this.send("GET", url));
      raw.push(...value);
      url = nextLink;
    }
    return mapGraphEvents(raw);
  }

  /**
   * Category name -> colour preset, for tinting other people's entries. Not an event request, so
   * no IdType preference.
   */
  async readCategoryColors(): Promise<Map<string, number>> {
    // ponytail: first page only — a master list longer than one page leaves some categories uncoloured.
    return readCategoryColors(readPage(await this.send("GET", MASTER_CATEGORIES_URL, undefined, {})).value);
  }

  /** The response carries no extended property (documented); the next read shows the block. */
  async createBlock(block: NewBlock): Promise<void> {
    await this.send("POST", `${GRAPH_BASE}/me/events`, createEventBody(block, crypto.randomUUID()));
  }

  async moveBlock(eventId: string, start: Date, end: Date): Promise<void> {
    await this.send("PATCH", eventUrl(eventId), moveEventBody(start, end));
  }

  /**
   * Everything assigned to the signed-in user, with the titles and buckets of every plan that has
   * an open task. No IdType preference: that one is the calendar's. A failing task list fails the
   * read (the view keeps the last good one and says so); a plan that cannot be read only lacks its
   * title or buckets this round — a plan the user has left must not hide every other task.
   */
  async readPlanner(): Promise<PlannerSnapshot> {
    const { raw, truncated } = await this.readAll(PLANNER_TASKS_URL);
    const { tasks, droppedCount } = mapPlannerTasks(raw);

    const planIds = [...new Set(tasks.filter((task) => task.status !== "x").map((task) => task.planId))];
    const buckets = new Map<string, PlannerBucket[]>();
    // ponytail: one bucket read per plan and minute; cache them if Planner starts to throttle.
    const readPlan = async (planId: string): Promise<void> => {
      if (this.planTitles.has(planId)) return;
      const title = planTitle(await this.send("GET", planUrl(planId), undefined, {}));
      if (title !== null) this.planTitles.set(planId, title);
    };
    // ponytail: first page only — a plan with more buckets than one page shows a shorter menu.
    const readPlanBuckets = async (planId: string): Promise<void> => {
      buckets.set(planId, readBuckets(readPage(await this.send("GET", `${planUrl(planId)}/buckets`, undefined, {})).value));
    };
    await Promise.allSettled(planIds.flatMap((planId) => [readPlan(planId), readPlanBuckets(planId)]));

    return {
      tasks: tasks.map((task) => ({ ...task, project: this.planTitles.get(task.planId) ?? null })),
      buckets,
      droppedCount,
      truncated,
    };
  }

  /** Planner write #1. If-Match is mandatory; a 412 is never retried with a fresh etag (M6.4). */
  async completePlannerTask(task: Pick<PlannerTask, "id" | "etag">): Promise<void> {
    await this.send("PATCH", plannerTaskUrl(task.id), { percentComplete: 100 }, { "If-Match": task.etag });
  }

  /** Planner write #2: the bucket, nothing else. */
  async movePlannerTask(task: Pick<PlannerTask, "id" | "etag">, bucketId: string): Promise<void> {
    await this.send("PATCH", plannerTaskUrl(task.id), { bucketId }, { "If-Match": task.etag });
  }

  /**
   * Every page of a Planner or To Do collection, the nextLink followed as returned. No IdType
   * preference: that one is the calendar's. `truncated`: the page limit cut it short — say so.
   */
  private async readAll(first: string): Promise<{ raw: unknown[]; truncated: boolean }> {
    const raw: unknown[] = [];
    let url: string | null = first;
    for (let page = 0; url !== null && page < MAX_PLANNER_PAGES; page += 1) {
      const { value, nextLink } = readPage(await this.send("GET", url, undefined, {}));
      raw.push(...value);
      url = nextLink;
    }
    return { raw, truncated: url !== null };
  }

  async readTodoLists(): Promise<{ raw: unknown[]; truncated: boolean }> {
    return this.readAll(TODO_LISTS_URL);
  }

  async readTodoTasks(listId: string, openOnly = false): Promise<{ raw: unknown[]; truncated: boolean }> {
    return this.readAll(todoTasksUrl(listId, openOnly));
  }

  /**
   * The personal account's open To Do tasks, every list but flagged emails. A failing list fails
   * the read: the view keeps the last good one and says so.
   */
  async readTodo(): Promise<TodoSnapshot> {
    const listsRead = await this.readTodoLists();
    const snapshot: TodoSnapshot = { tasks: [], droppedCount: 0, truncated: listsRead.truncated };
    // One list after another: Outlook allows four concurrent requests per app and mailbox, and the
    // private calendar reads alongside. With all lists at once, the live read drew a 429 (M9.1b).
    // ponytail: one round trip per list; a $batch of four if many lists make the read slow.
    for (const list of readTodoLists(listsRead.raw)) {
      let read: { raw: unknown[]; truncated: boolean };
      try {
        read = await this.readTodoTasks(list.id, !this.todoFilterRejected);
      } catch (error) {
        if (!(error instanceof GraphApiError)) throw error;
        // Deleted between the list read and this one: gone from the next read, nothing to report.
        if (error.status === 404) continue;
        // ponytail: the status filter is undocumented (spec no. 37); unfiltered, a long history can hit
        // the page limit. Drop this fallback once M9.0 shows the filter works.
        if (error.status !== 400 || this.todoFilterRejected) throw error;
        this.todoFilterRejected = true;
        read = await this.readTodoTasks(list.id);
      }
      const mapped = mapTodoTasks(list, read.raw);
      snapshot.tasks.push(...mapped.tasks);
      snapshot.droppedCount += mapped.droppedCount;
      snapshot.truncated ||= read.truncated;
    }
    return snapshot;
  }

  /** The one To Do write (M9). `ifMatch` only once M9.0 has shown that To Do honours it. */
  async completeTodoTask(listId: string, taskId: string, ifMatch: string | null): Promise<void> {
    await this.send("PATCH", todoTaskUrl(listId, taskId), { status: "completed" }, ifMatch === null ? {} : { "If-Match": ifMatch });
  }

  /** A 404 counts as success: the block is gone, which is what the caller wanted. */
  async deleteBlock(eventId: string): Promise<void> {
    try {
      await this.send("DELETE", eventUrl(eventId));
    } catch (error) {
      if (!(error instanceof GraphApiError) || error.status !== 404) throw error;
    }
  }
}
