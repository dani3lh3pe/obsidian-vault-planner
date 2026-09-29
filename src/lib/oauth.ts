import { LOGIN_BASE, REDIRECT_URI } from "../config";
import { AuthError } from "./errors";
import { encodeParams } from "./graphRequests";
import { isRecord } from "./odata";

/**
 * OAuth 2.0 authorization code + PKCE against Entra v2, as pure functions (auth.ts adds storage,
 * the browser and the network). A public client: no secret, ever.
 */

export function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 32 random bytes, base64url: a 43-character verifier (RFC 7636 §4.1). */
export function randomVerifier(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

/**
 * `authority` is the tenant id for the work account, or "consumers" for the personal Microsoft
 * account (M9) — the same host either way (Invariant 5).
 */
export function authorizeUrl(input: {
  authority: string;
  clientId: string;
  challenge: string;
  state: string;
  scope: string;
}): string {
  return `${LOGIN_BASE}/${encodeURIComponent(input.authority)}/oauth2/v2.0/authorize?${encodeParams([
    ["client_id", input.clientId],
    ["response_type", "code"],
    ["redirect_uri", REDIRECT_URI],
    ["response_mode", "query"],
    ["scope", input.scope],
    ["code_challenge", input.challenge],
    ["code_challenge_method", "S256"],
    ["state", input.state],
    // The consultant has accounts in several tenants; never sign in the wrong one silently.
    ["prompt", "select_account"],
  ])}`;
}

export function tokenUrl(authority: string): string {
  return `${LOGIN_BASE}/${encodeURIComponent(authority)}/oauth2/v2.0/token`;
}

export function codeGrantBody(input: { clientId: string; code: string; verifier: string; scope: string }): string {
  return encodeParams([
    ["client_id", input.clientId],
    ["grant_type", "authorization_code"],
    ["code", input.code],
    ["redirect_uri", REDIRECT_URI],
    ["code_verifier", input.verifier],
    ["scope", input.scope],
  ]);
}

export function refreshGrantBody(input: { clientId: string; refreshToken: string; scope: string }): string {
  return encodeParams([
    ["client_id", input.clientId],
    ["grant_type", "refresh_token"],
    ["refresh_token", input.refreshToken],
    ["scope", input.scope],
  ]);
}

export interface TokenSet {
  accessToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  /** Every refresh returns a new one; the caller must store it at once. */
  refreshToken: string | null;
  /** preferred_username from the id token, for the settings tab. */
  account: string | null;
}

/** "AADSTS70008: The provided authorization code…" -> "70008". */
function aadstsOf(description: unknown, codes: unknown): string | null {
  if (typeof description === "string") {
    const match = /AADSTS(\d+)/.exec(description);
    if (match !== null) return match[1];
  }
  if (Array.isArray(codes) && typeof codes[0] === "number") return String(codes[0]);
  return null;
}

export function authErrorFrom(body: unknown): AuthError {
  if (!isRecord(body)) return new AuthError("unknown_error", null);
  const code = typeof body.error === "string" ? body.error : "unknown_error";
  return new AuthError(code, aadstsOf(body.error_description, body.error_codes));
}

/** The error an Entra redirect carries in its query (`?error=…&error_description=…`), if any. */
export function redirectError(params: Record<string, string>): AuthError | null {
  if (params.error === undefined) return null;
  return new AuthError(params.error, aadstsOf(params.error_description, undefined));
}

export function accountFromIdToken(idToken: unknown): string | null {
  if (typeof idToken !== "string") return null;
  const payload = idToken.split(".")[1];
  if (payload === undefined) return null;
  try {
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const claims: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!isRecord(claims)) return null;
    const name = claims.preferred_username ?? claims.email ?? claims.name;
    return typeof name === "string" ? name : null;
  } catch {
    return null;
  }
}

/** The token endpoint's answer, narrowed. Throws AuthError for anything but a usable token. */
export function parseTokenResponse(status: number, text: string, now: number): TokenSet {
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    throw new AuthError(`http_${status}`, null);
  }
  if (status >= 400 || !isRecord(body) || typeof body.access_token !== "string") throw authErrorFrom(body);

  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : Number(body.expires_in);
  return {
    accessToken: body.access_token,
    expiresAt: now + (Number.isFinite(expiresIn) ? expiresIn : 3600) * 1000,
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : null,
    account: accountFromIdToken(body.id_token),
  };
}
