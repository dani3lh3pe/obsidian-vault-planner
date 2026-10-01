import type { GraphErrorResponse } from "./types";

/**
 * Failures mapped to plain English — never raw Graph or AADSTS JSON, always a next step
 * (ported from daily-planner, calendar area only, plus the sign-in errors this plugin owns).
 * The plugin's own errors below carry their user-facing text as `message`.
 */

/** A Graph response with status >= 400. */
export class GraphApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: GraphErrorResponse | null,
    /** Which endpoint answered: the same status means something else in Planner or To Do. */
    public readonly area: GraphArea = "calendar",
  ) {
    super(`Graph API error ${status}: ${body?.error?.code ?? "Unknown"}`);
    this.name = "GraphApiError";
  }
}

/** The token endpoint or the authorize redirect refused: OAuth `error` plus the AADSTS number. */
export class AuthError extends Error {
  constructor(
    public readonly code: string,
    public readonly aadsts: string | null,
  ) {
    super(`Sign-in failed: ${code}${aadsts === null ? "" : ` (AADSTS${aadsts})`}`);
    this.name = "AuthError";
  }
}

/** No refresh token on this device: the only way forward is the sign-in button. */
export class SignedOutError extends Error {
  constructor() {
    super("Not signed in");
    this.name = "SignedOutError";
  }
}

/** `requestUrl` has no timeout; this is ours. The message is the user-facing text. */
export class TimeoutError extends Error {
  constructor() {
    super("Microsoft did not answer within 30 seconds. Try again.");
    this.name = "TimeoutError";
  }
}

/** The task line moved or changed between the list and the write. Nothing was written. */
export class LineChangedError extends Error {
  constructor() {
    super("The task has changed in the meantime – please drag it again.");
    this.name = "LineChangedError";
  }
}

/** Completing needs the Tasks plugin's API; a home-made toggle would lose recurrences silently. */
export class TasksMissingError extends Error {
  constructor() {
    super("Completing a task needs the Tasks plugin.");
    this.name = "TasksMissingError";
  }
}

/** Tasks returned no line at all (`🏁 delete`): removing it would orphan its indented children. */
export class EmptyToggleError extends Error {
  constructor() {
    super("This task deletes itself when completed (🏁 delete) – please complete it in the editor.");
    this.name = "EmptyToggleError";
  }
}

/** Reject with TimeoutError when `promise` takes longer than `ms`. */
export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new TimeoutError()), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const GRAPH_CODES: Record<string, string> = {
  InvalidAuthenticationToken: "The sign-in has expired. Please sign in again.",
  ErrorInvalidTimeZone:
    "Outlook rejected the time zone. Check PLANNER_TIME_ZONE in src/config.ts.",
  ErrorItemNotFound: "The event no longer exists. It was probably deleted in Outlook.",
  ErrorAccessDenied: "No access to the calendar. Is the Calendars.ReadWrite permission missing?",
};

export type GraphArea = "calendar" | "planner" | "todo";

/** Planner's own readings of a status (implementation plan M6). */
const PLANNER_STATUS: Record<number, string> = {
  403: "No access to Planner. Is the Tasks.ReadWrite permission missing? Then sign out, sign in again and consent.",
  404: "The Planner task no longer exists, or it is no longer assigned to you.",
  // Never retried with the fresh etag: that would overwrite exactly the change that caused it.
  412: "The task was changed in Planner in the meantime. The list is reloading – please try again.",
};

/** To Do's, for the personal account (M9, spec no. 42). */
const TODO_STATUS: Record<number, string> = {
  403: "No access to To Do. Is the Tasks.ReadWrite permission missing? Then sign the personal account out, sign in again and consent.",
  404: "The To Do task no longer exists.",
};

const AREA_STATUS: Record<GraphArea, Record<number, string>> = { calendar: {}, planner: PLANNER_STATUS, todo: TODO_STATUS };
const AREA_FALLBACK: Record<GraphArea, string> = {
  calendar: "Unexpected error accessing the calendar.",
  planner: "Unexpected error accessing Planner.",
  todo: "Unexpected error accessing To Do.",
};

function mapGraphError(status: number, body: GraphErrorResponse | null, area: GraphArea): string {
  // The area's own reading first: a 403 from To Do with ErrorAccessDenied is not the calendar's.
  const own = AREA_STATUS[area][status];
  if (own !== undefined) return own;
  const code = body?.error?.code;
  if (code !== undefined && GRAPH_CODES[code] !== undefined) return GRAPH_CODES[code];

  if (status === 401) return GRAPH_CODES.InvalidAuthenticationToken;
  if (status === 403) return GRAPH_CODES.ErrorAccessDenied;
  if (status === 404) return GRAPH_CODES.ErrorItemNotFound;
  if (status === 429) return "Too many requests to Microsoft. Wait a moment and try again.";
  if (status >= 500) return "Microsoft Graph is unreachable right now. Try again later.";
  return AREA_FALLBACK[area];
}

/** The AADSTS numbers that have a known fix in this setup (see README, Setup). */
const AADSTS: Record<string, string> = {
  "50011":
    "The redirect URI does not match. The app registration must list obsidian://vault-planner-auth " +
    "under “Mobile and desktop applications”.",
  "700016": "The app was not found. Check the client id and tenant id in the settings.",
  "90002": "The tenant was not found. Check the tenant id in the settings.",
  "65001":
    "Consent is missing. “Sign in” asks for it; if user consent is blocked, an administrator grants it " +
    "for Calendars.ReadWrite and MailboxSettings.Read (with Planner also Tasks.ReadWrite).",
  "7000218":
    "Entra expects a client secret. In the app registration, set “Allow public client " +
    "flows” to Yes.",
  "9002326":
    "Entra rejected the token exchange as a browser request (AADSTS9002326). This is a " +
    "bug in the plugin — please report it.",
  "53003": "Conditional Access blocks the sign-in. The sign-in logs in Entra show which policy.",
  "53000": "Conditional Access requires a compliant device. The sign-in logs in Entra show the policy.",
};

function mapAuthError(error: AuthError): string {
  if (error.aadsts !== null && AADSTS[error.aadsts] !== undefined) return AADSTS[error.aadsts];
  if (error.code === "invalid_grant" || error.code === "interaction_required") {
    return "The sign-in has expired. Please sign in again.";
  }
  if (error.code === "access_denied") return "The sign-in was cancelled.";
  if (error.code === "state_mismatch") {
    return "This response belongs to no pending sign-in. Please click “Sign in” again.";
  }
  const suffix = error.aadsts === null ? error.code : `AADSTS${error.aadsts}`;
  return `Sign-in failed (${suffix}).`;
}

/**
 * True when the only way forward is signing in again. A missing permission is deliberately NOT
 * this: it arrives as 403, and "Sign in" would offer a loop instead of a way out.
 */
export function isAuthExpired(error: unknown): boolean {
  if (error instanceof SignedOutError) return true;
  if (error instanceof GraphApiError) return error.status === 401;
  return error instanceof AuthError && (error.code === "invalid_grant" || error.code === "interaction_required");
}

/**
 * The personal account (M9) shares the work account's registration. There, AADSTS700016 means the
 * registration is not opened to personal accounts — not a wrong tenant id, which it has none of.
 * ponytail: only this one differs so far; the rest of the private texts come with M9.1 (spec no. 34).
 */
export function getPersonalErrorMessage(error: unknown): string {
  if (error instanceof AuthError && error.aadsts === "700016") {
    return "Personal account: the app registration is not open to personal Microsoft accounts (README, Setup step 5).";
  }
  return `Personal account: ${getErrorMessage(error)}`;
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof GraphApiError) return mapGraphError(error.status, error.body, error.area);
  if (error instanceof AuthError) return mapAuthError(error);
  if (error instanceof SignedOutError) return "Not signed in. Please sign in.";
  // requestUrl rejects with Chromium's net error text when there is no connection at all.
  if (error instanceof Error && error.message.startsWith("net::")) {
    return "No connection to Microsoft. Check the network and try again.";
  }
  if (error instanceof Error) return error.message;
  return "Unexpected error.";
}
