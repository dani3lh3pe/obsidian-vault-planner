import { requestUrl } from "obsidian";
import type { Auth } from "./auth";
import { GRAPH_BASE, IMMUTABLE_ID_HEADER, MAX_EVENT_PAGES, REQUEST_TIMEOUT_MS } from "./config";
import { GraphApiError, withTimeout } from "./lib/errors";
import { calendarViewUrl, createEventBody, eventUrl, isGraphUrl, moveEventBody, type NewBlock } from "./lib/graphRequests";
import { mapGraphEvents, type MapResult } from "./lib/mapGraphEvents";
import { readPage } from "./lib/odata";
import type { GraphErrorResponse, TimeRange } from "./lib/types";

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
  constructor(private readonly auth: Auth) {}

  private async send(method: string, url: string, body?: unknown): Promise<unknown> {
    if (!isGraphUrl(url)) throw new Error("Graph hat auf eine fremde Adresse verwiesen. Die Anfrage wurde nicht gesendet.");
    const attempt = async (token: string) =>
      withTimeout(
        requestUrl({
          url,
          method,
          // The Prefer header is per request: every page, every write.
          headers: { Authorization: `Bearer ${token}`, ...IMMUTABLE_ID_HEADER },
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
    if (response.status >= 400) throw new GraphApiError(response.status, errorBody(parsed));
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

  /** The response carries no extended property (documented); the next read shows the block. */
  async createBlock(block: NewBlock): Promise<void> {
    await this.send("POST", `${GRAPH_BASE}/me/events`, createEventBody(block, crypto.randomUUID()));
  }

  async moveBlock(eventId: string, start: Date, end: Date): Promise<void> {
    await this.send("PATCH", eventUrl(eventId), moveEventBody(start, end));
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
