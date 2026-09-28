import type { GraphErrorResponse } from "./types";

/**
 * Failures mapped to plain German — never raw Graph or AADSTS JSON, always a next step
 * (ported from daily-planner, calendar area only, plus the sign-in errors this plugin owns).
 * The plugin's own errors below carry their user-facing text as `message`.
 */

/** A Graph response with status >= 400. */
export class GraphApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: GraphErrorResponse | null,
    /** Came from a Planner endpoint: the same status means something else there. */
    public readonly planner = false,
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
    super("Microsoft hat nicht innerhalb von 30 Sekunden geantwortet. Erneut versuchen.");
    this.name = "TimeoutError";
  }
}

/** The task line moved or changed between the list and the write. Nothing was written. */
export class LineChangedError extends Error {
  constructor() {
    super("Die Aufgabe wurde zwischenzeitlich geändert – bitte erneut ziehen.");
    this.name = "LineChangedError";
  }
}

/** Completing needs the Tasks plugin's API; a home-made toggle would lose recurrences silently. */
export class TasksMissingError extends Error {
  constructor() {
    super("Zum Erledigen wird das Tasks-Plugin gebraucht.");
    this.name = "TasksMissingError";
  }
}

/** Tasks returned no line at all (`🏁 delete`): removing it would orphan its indented children. */
export class EmptyToggleError extends Error {
  constructor() {
    super("Diese Aufgabe löscht sich beim Erledigen (🏁 delete) – bitte im Editor erledigen.");
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
  InvalidAuthenticationToken: "Die Anmeldung ist abgelaufen. Bitte neu anmelden.",
  ErrorInvalidTimeZone:
    "Die Zeitzone wurde von Outlook abgelehnt. Prüfe PLANNER_TIME_ZONE in src/config.ts.",
  ErrorItemNotFound: "Der Termin existiert nicht mehr. Er wurde vermutlich in Outlook gelöscht.",
  ErrorAccessDenied: "Kein Zugriff auf den Kalender. Fehlt die Berechtigung Calendars.ReadWrite?",
};

/** Planner's own readings of a status (umsetzungsplan M6). */
const PLANNER_STATUS: Record<number, string> = {
  403: "Kein Zugriff auf Planner. Fehlt die Berechtigung Tasks.ReadWrite? Dann abmelden, neu anmelden und zustimmen.",
  404: "Die Planner-Aufgabe gibt es nicht mehr, oder sie ist dir nicht mehr zugewiesen.",
  // Never retried with the fresh etag: that would overwrite exactly the change that caused it.
  412: "Die Aufgabe wurde zwischenzeitlich in Planner geändert. Die Liste wird neu geladen – bitte erneut versuchen.",
};

function mapGraphError(status: number, body: GraphErrorResponse | null, planner: boolean): string {
  const code = body?.error?.code;
  if (code !== undefined && GRAPH_CODES[code] !== undefined) return GRAPH_CODES[code];
  if (planner && PLANNER_STATUS[status] !== undefined) return PLANNER_STATUS[status];

  if (status === 401) return GRAPH_CODES.InvalidAuthenticationToken;
  if (status === 403) return GRAPH_CODES.ErrorAccessDenied;
  if (status === 404) return GRAPH_CODES.ErrorItemNotFound;
  if (status === 429) return "Zu viele Anfragen an Microsoft. Kurz warten und erneut versuchen.";
  if (status >= 500) return "Microsoft Graph ist gerade nicht erreichbar. Später erneut versuchen.";
  return planner ? "Unerwarteter Fehler beim Planner-Zugriff." : "Unerwarteter Fehler beim Kalenderzugriff.";
}

/** The AADSTS numbers that have a known fix in this setup (see README, Entra-App). */
const AADSTS: Record<string, string> = {
  "50011":
    "Die Redirect-URI passt nicht. In der App-Registrierung muss obsidian://vault-planner-auth " +
    "unter „Mobile- und Desktopanwendungen“ stehen.",
  "700016": "Die App wurde nicht gefunden. Client-ID und Tenant-ID in den Einstellungen prüfen.",
  "90002": "Der Tenant wurde nicht gefunden. Die Tenant-ID in den Einstellungen prüfen.",
  "65001":
    "Die Zustimmung fehlt. „Anmelden“ holt sie ein; ist die Benutzerzustimmung gesperrt, als Administrator " +
    "für Calendars.ReadWrite (mit Planner auch Tasks.ReadWrite) zustimmen.",
  "7000218":
    "Entra verlangt ein Client-Secret. In der App-Registrierung „Öffentliche Clientflows " +
    "zulassen“ auf Ja stellen.",
  "9002326":
    "Entra hat den Token-Tausch als Browser-Anfrage abgelehnt (AADSTS9002326). Das ist ein " +
    "Fehler im Plugin — bitte melden.",
  "53003": "Conditional Access blockiert die Anmeldung. Die Anmeldeprotokolle in Entra zeigen, welche Richtlinie.",
  "53000": "Conditional Access verlangt ein konformes Gerät. Die Anmeldeprotokolle in Entra zeigen die Richtlinie.",
};

function mapAuthError(error: AuthError): string {
  if (error.aadsts !== null && AADSTS[error.aadsts] !== undefined) return AADSTS[error.aadsts];
  if (error.code === "invalid_grant" || error.code === "interaction_required") {
    return "Die Anmeldung ist abgelaufen. Bitte neu anmelden.";
  }
  if (error.code === "access_denied") return "Die Anmeldung wurde abgebrochen.";
  if (error.code === "state_mismatch") {
    return "Diese Rückmeldung gehört zu keiner laufenden Anmeldung. Bitte erneut auf „Anmelden“ klicken.";
  }
  const suffix = error.aadsts === null ? error.code : `AADSTS${error.aadsts}`;
  return `Die Anmeldung ist fehlgeschlagen (${suffix}).`;
}

/**
 * True when the only way forward is signing in again. A missing permission is deliberately NOT
 * this: it arrives as 403, and "Anmelden" would offer a loop instead of a way out.
 */
export function isAuthExpired(error: unknown): boolean {
  if (error instanceof SignedOutError) return true;
  if (error instanceof GraphApiError) return error.status === 401;
  return error instanceof AuthError && (error.code === "invalid_grant" || error.code === "interaction_required");
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof GraphApiError) return mapGraphError(error.status, error.body, error.planner);
  if (error instanceof AuthError) return mapAuthError(error);
  if (error instanceof SignedOutError) return "Nicht angemeldet. Bitte anmelden.";
  // requestUrl rejects with Chromium's net error text when there is no connection at all.
  if (error instanceof Error && error.message.startsWith("net::")) {
    return "Keine Verbindung zu Microsoft. Netzwerk prüfen und erneut versuchen.";
  }
  if (error instanceof Error) return error.message;
  return "Unerwarteter Fehler.";
}
