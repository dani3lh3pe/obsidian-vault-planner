import { describe, expect, it } from "vitest";
import {
  AuthError,
  EmptyToggleError,
  getErrorMessage,
  getPersonalErrorMessage,
  GraphApiError,
  isAuthExpired,
  LineChangedError,
  SignedOutError,
  TasksMissingError,
  TimeoutError,
  withTimeout,
} from "./errors";

const graph = (status: number, code?: string) =>
  new GraphApiError(status, code === undefined ? null : { error: { code, message: "raw" } });

describe("getErrorMessage", () => {
  it("prefers Graph's code over the status", () => {
    expect(getErrorMessage(graph(404, "ErrorItemNotFound"))).toContain("in Outlook gelöscht");
    expect(getErrorMessage(graph(400, "ErrorInvalidTimeZone"))).toContain("PLANNER_TIME_ZONE");
  });

  it("falls back to the status", () => {
    expect(getErrorMessage(graph(401))).toContain("neu anmelden");
    expect(getErrorMessage(graph(403))).toContain("Calendars.ReadWrite");
    expect(getErrorMessage(graph(429))).toContain("Zu viele Anfragen");
    expect(getErrorMessage(graph(503))).toContain("nicht erreichbar");
    expect(getErrorMessage(graph(418))).toBe("Unerwarteter Fehler beim Kalenderzugriff.");
  });

  it("reads a Planner status as Planner's, a 412 as a change made elsewhere", () => {
    const planner = (status: number) => new GraphApiError(status, null, true);
    expect(getErrorMessage(planner(403))).toContain("Tasks.ReadWrite");
    expect(getErrorMessage(planner(412))).toContain("in Planner geändert");
    expect(getErrorMessage(planner(404))).toContain("Planner-Aufgabe");
    expect(getErrorMessage(planner(418))).toBe("Unerwarteter Fehler beim Planner-Zugriff.");
  });

  it("never shows raw Graph text", () => {
    expect(getErrorMessage(graph(400, "SomethingNew"))).not.toContain("raw");
  });

  it("maps the AADSTS numbers that have a known fix", () => {
    expect(getErrorMessage(new AuthError("invalid_request", "50011"))).toContain("obsidian://vault-planner-auth");
    expect(getErrorMessage(new AuthError("invalid_client", "7000218"))).toContain("Öffentliche Clientflows");
    expect(getErrorMessage(new AuthError("invalid_grant", "53003"))).toContain("Conditional Access");
  });

  it("names an unknown AADSTS number instead of hiding it", () => {
    expect(getErrorMessage(new AuthError("invalid_request", "12345"))).toBe(
      "Die Anmeldung ist fehlgeschlagen (AADSTS12345).",
    );
  });

  it("covers the plugin's own failures", () => {
    expect(getErrorMessage(new SignedOutError())).toContain("anmelden");
    expect(getErrorMessage(new TimeoutError())).toContain("30 Sekunden");
    expect(getErrorMessage(new LineChangedError())).toContain("erneut ziehen");
    expect(getErrorMessage(new Error("net::ERR_INTERNET_DISCONNECTED"))).toContain("Keine Verbindung");
    expect(getErrorMessage(new TasksMissingError())).toContain("Tasks-Plugin");
    expect(getErrorMessage(new EmptyToggleError())).toContain("im Editor erledigen");
    expect(getErrorMessage(new AuthError("state_mismatch", null))).toContain("erneut auf");
    expect(getErrorMessage("??")).toBe("Unerwarteter Fehler.");
  });
});

describe("isAuthExpired", () => {
  it("is true only where signing in again helps", () => {
    expect(isAuthExpired(new SignedOutError())).toBe(true);
    expect(isAuthExpired(graph(401))).toBe(true);
    expect(isAuthExpired(new AuthError("invalid_grant", "70008"))).toBe(true);
    expect(isAuthExpired(graph(403))).toBe(false);
    expect(isAuthExpired(new AuthError("invalid_request", "50011"))).toBe(false);
    expect(isAuthExpired(new TimeoutError())).toBe(false);
  });
});

describe("withTimeout", () => {
  it("passes a fast result through", async () => {
    await expect(withTimeout(Promise.resolve(42), 1000)).resolves.toBe(42);
  });

  it("gives up with a TimeoutError", async () => {
    await expect(withTimeout(new Promise(() => {}), 5)).rejects.toBeInstanceOf(TimeoutError);
  });
});

describe("getPersonalErrorMessage (M9)", () => {
  it("reads AADSTS700016 as a registration not opened to personal accounts, never as a tenant id", () => {
    const text = getPersonalErrorMessage(new AuthError("unauthorized_client", "700016"));
    expect(text).toContain("nicht für private Microsoft-Konten geöffnet");
    expect(text).not.toContain("Tenant");
  });

  it("names the account in front of every other text", () => {
    expect(getPersonalErrorMessage(new SignedOutError())).toBe("Privates Konto: Nicht angemeldet. Bitte anmelden.");
  });
});
