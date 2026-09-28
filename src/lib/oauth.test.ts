import { describe, expect, it } from "vitest";
import {
  accountFromIdToken,
  authorizeUrl,
  base64Url,
  challengeFor,
  codeGrantBody,
  parseTokenResponse,
  randomVerifier,
  redirectError,
  refreshGrantBody,
} from "./oauth";
import { scopes } from "../config";
import { AuthError } from "./errors";

describe("PKCE", () => {
  it("matches the RFC 7636 test vector", async () => {
    expect(await challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("makes 43-character url-safe verifiers", () => {
    const verifier = randomVerifier();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(base64Url(new Uint8Array([251, 255]))).toBe("-_8");
  });
});

describe("authorizeUrl", () => {
  it("carries PKCE, state and the obsidian redirect for this tenant", () => {
    const url = new URL(authorizeUrl({ tenantId: "tenant-guid", clientId: "client-guid", challenge: "abc", state: "xyz", scope: scopes(false) }));
    expect(url.origin + url.pathname).toBe("https://login.microsoftonline.com/tenant-guid/oauth2/v2.0/authorize");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: "client-guid",
      response_type: "code",
      redirect_uri: "obsidian://vault-planner-auth",
      code_challenge: "abc",
      code_challenge_method: "S256",
      state: "xyz",
      scope: "openid profile offline_access https://graph.microsoft.com/Calendars.ReadWrite",
    });
  });

  it("asks for Tasks.ReadWrite only while Planner is switched on", () => {
    expect(scopes(false)).not.toContain("Tasks.");
    expect(scopes(true)).toBe(
      "openid profile offline_access https://graph.microsoft.com/Calendars.ReadWrite https://graph.microsoft.com/Tasks.ReadWrite",
    );
  });
});

describe("grant bodies", () => {
  it("send the verifier with the code, and no secret anywhere", () => {
    const code = new URLSearchParams(codeGrantBody({ clientId: "c", code: "the-code", verifier: "v", scope: "s" }));
    expect(Object.fromEntries(code)).toMatchObject({ grant_type: "authorization_code", code: "the-code", code_verifier: "v" });
    const refresh = new URLSearchParams(refreshGrantBody({ clientId: "c", refreshToken: "rt", scope: "s" }));
    expect(Object.fromEntries(refresh)).toMatchObject({ grant_type: "refresh_token", refresh_token: "rt", scope: "s" });
    expect(codeGrantBody({ clientId: "c", code: "x", verifier: "v", scope: "s" })).not.toContain("client_secret");
  });
});

describe("parseTokenResponse", () => {
  // {"preferred_username":"daniel@example.org"}
  const idToken = `x.${base64Url(new TextEncoder().encode('{"preferred_username":"daniel@example.org"}'))}.y`;

  it("reads tokens, expiry and the account", () => {
    const tokens = parseTokenResponse(
      200,
      JSON.stringify({ access_token: "at", expires_in: 3600, refresh_token: "rt", id_token: idToken }),
      1_000,
    );
    expect(tokens).toEqual({ accessToken: "at", expiresAt: 3_601_000, refreshToken: "rt", account: "daniel@example.org" });
  });

  it("turns an Entra error into an AuthError with its AADSTS number", () => {
    const error = (() => {
      try {
        parseTokenResponse(400, JSON.stringify({ error: "invalid_grant", error_description: "AADSTS70008: expired" }), 0);
      } catch (caught) {
        return caught;
      }
      return null;
    })();
    expect(error).toBeInstanceOf(AuthError);
    expect(error).toMatchObject({ code: "invalid_grant", aadsts: "70008" });
  });

  it("does not choke on a non-JSON answer", () => {
    expect(() => parseTokenResponse(502, "<html>Bad gateway</html>", 0)).toThrow(AuthError);
  });
});

describe("redirect and id token", () => {
  it("reads an error from the redirect query", () => {
    expect(redirectError({ action: "vault-planner-auth", error: "access_denied", error_description: "AADSTS65004: declined" })).toMatchObject({
      code: "access_denied",
      aadsts: "65004",
    });
    expect(redirectError({ action: "vault-planner-auth", code: "c" })).toBeNull();
  });

  it("decodes UTF-8 names and survives garbage", () => {
    const token = `h.${base64Url(new TextEncoder().encode('{"name":"Jörg"}'))}.s`;
    expect(accountFromIdToken(token)).toBe("Jörg");
    expect(accountFromIdToken("kaputt")).toBeNull();
    expect(accountFromIdToken(undefined)).toBeNull();
  });
});
