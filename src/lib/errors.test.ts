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
    expect(getErrorMessage(graph(404, "ErrorItemNotFound"))).toContain("deleted in Outlook");
    expect(getErrorMessage(graph(400, "ErrorInvalidTimeZone"))).toContain("PLANNER_TIME_ZONE");
  });

  it("falls back to the status", () => {
    expect(getErrorMessage(graph(401))).toContain("sign in again");
    expect(getErrorMessage(graph(403))).toContain("Calendars.ReadWrite");
    expect(getErrorMessage(graph(429))).toContain("Too many requests");
    expect(getErrorMessage(graph(503))).toContain("unreachable");
    expect(getErrorMessage(graph(418))).toBe("Unexpected error accessing the calendar.");
  });

  it("reads a Planner status as Planner's, a 412 as a change made elsewhere", () => {
    const planner = (status: number) => new GraphApiError(status, null, "planner");
    expect(getErrorMessage(planner(403))).toContain("Tasks.ReadWrite");
    expect(getErrorMessage(planner(412))).toContain("changed in Planner");
    expect(getErrorMessage(planner(404))).toContain("Planner task");
    expect(getErrorMessage(planner(418))).toBe("Unexpected error accessing Planner.");
    // Spec no. 42: the area's reading wins over the generic code — a Planner 403 is not the calendar's.
    expect(getErrorMessage(new GraphApiError(403, { error: { code: "ErrorAccessDenied", message: "raw" } }, "planner"))).toContain("No access to Planner");
  });

  it("never shows raw Graph text", () => {
    expect(getErrorMessage(graph(400, "SomethingNew"))).not.toContain("raw");
  });

  it("maps the AADSTS numbers that have a known fix", () => {
    expect(getErrorMessage(new AuthError("invalid_request", "50011"))).toContain("obsidian://vault-planner-auth");
    expect(getErrorMessage(new AuthError("invalid_client", "7000218"))).toContain("Allow public client flows");
    expect(getErrorMessage(new AuthError("invalid_grant", "53003"))).toContain("Conditional Access");
  });

  it("names an unknown AADSTS number instead of hiding it", () => {
    expect(getErrorMessage(new AuthError("invalid_request", "12345"))).toBe(
      "Sign-in failed (AADSTS12345).",
    );
  });

  it("covers the plugin's own failures", () => {
    expect(getErrorMessage(new SignedOutError())).toContain("sign in");
    expect(getErrorMessage(new TimeoutError())).toContain("30 seconds");
    expect(getErrorMessage(new LineChangedError())).toContain("drag it again");
    expect(getErrorMessage(new Error("net::ERR_INTERNET_DISCONNECTED"))).toContain("No connection");
    expect(getErrorMessage(new TasksMissingError())).toContain("Tasks plugin");
    expect(getErrorMessage(new EmptyToggleError())).toContain("complete it in the editor");
    expect(getErrorMessage(new AuthError("state_mismatch", null))).toContain("“Sign in” again");
    expect(getErrorMessage("??")).toBe("Unexpected error.");
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
    expect(text).toContain("not open to personal Microsoft accounts");
    expect(text).not.toContain("tenant");
  });

  it("names the account in front of every other text", () => {
    expect(getPersonalErrorMessage(new SignedOutError())).toBe("Personal account: Not signed in. Please sign in.");
  });
});

describe("To Do errors (M9)", () => {
  const todo = (status: number, code?: string) =>
    new GraphApiError(status, code === undefined ? null : { error: { code, message: "raw" } }, "todo");

  it("names To Do, not the calendar, even when Graph answers with a calendar-sounding code", () => {
    expect(getErrorMessage(todo(403, "ErrorAccessDenied"))).toContain("No access to To Do");
    expect(getErrorMessage(todo(404))).toBe("The To Do task no longer exists.");
    expect(getErrorMessage(todo(418))).toBe("Unexpected error accessing To Do.");
  });

  it("leaves the shared answers alone: throttling is throttling everywhere", () => {
    expect(getErrorMessage(todo(429))).toContain("Too many requests");
  });
});
