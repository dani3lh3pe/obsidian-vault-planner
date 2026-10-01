import { requestUrl, type App, type ObsidianProtocolData } from "obsidian";
import { REQUEST_TIMEOUT_MS, TOKEN_REFRESH_MARGIN_MS } from "./config";
import { AuthError, SignedOutError, withTimeout } from "./lib/errors";
import {
  authorizeUrl,
  challengeFor,
  codeGrantBody,
  parseTokenResponse,
  randomVerifier,
  redirectError,
  refreshGrantBody,
  tokenUrl,
  type TokenSet,
} from "./lib/oauth";

/**
 * Which account an Auth signs in, read anew on every call: the settings can change underneath.
 * The work account: its tenant and the scope of the Planner switch. The personal account (M9): the
 * consumers authority and To Do plus the private calendar.
 */
export interface AuthProfile {
  authority: string;
  clientId: string;
  scope: string;
  /** What login() says while authority or client id is empty. */
  missing: string;
}

/** Where this account's refresh token and account name live — one pair per account. */
export interface AuthKeys {
  secret: string;
  account: string;
}

/**
 * Sign-in with auth code + PKCE in the system browser, back through obsidian://vault-planner-auth.
 *
 * The refresh token lives in Obsidian's SecretStorage (encrypted by the OS since 1.11.5, device-
 * local, never synced) — NEVER in data.json, which sits in the synced vault. The access
 * token lives in memory only. Only `login()` ever opens a browser; the timers never do.
 */
export class Auth {
  /**
   * Both remember their scope: after the Planner switch flips, a token for the other scope is the
   * wrong token, even though it has not expired.
   */
  private access: { token: string; expiresAt: number; scope: string } | null = null;
  private refreshing: { scope: string; promise: Promise<string> } | null = null;
  private pending: { verifier: string; state: string; scope: string } | null = null;
  /**
   * Bumped by every sign-in and sign-out. A refresh that was already running when the user signed
   * out — or in again — must neither store its token nor wipe the new session.
   */
  private generation = 0;

  constructor(
    private readonly app: App,
    private readonly profile: () => AuthProfile,
    private readonly keys: AuthKeys,
    private readonly changed: () => void,
  ) {}

  get configured(): boolean {
    const { authority, clientId } = this.profile();
    return authority.trim() !== "" && clientId.trim() !== "";
  }

  get signedIn(): boolean {
    return this.refreshToken() !== null;
  }

  get account(): string | null {
    const value: unknown = this.app.loadLocalStorage(this.keys.account);
    return typeof value === "string" ? value : null;
  }

  private scope(): string {
    return this.profile().scope;
  }

  /** Whether a redirect belongs to this account's sign-in — two accounts share one redirect URI. */
  expects(state: unknown): boolean {
    return this.pending !== null && state === this.pending.state;
  }

  private refreshToken(): string | null {
    const value = this.app.secretStorage.getSecret(this.keys.secret);
    return value === null || value === "" ? null : value;
  }

  async login(): Promise<void> {
    const { authority, clientId, missing } = this.profile();
    if (!this.configured) throw new Error(missing);
    const verifier = randomVerifier();
    const state = randomVerifier();
    // The code is redeemed for the scope it was granted for, even if the switch flips meanwhile.
    const scope = this.scope();
    this.pending = { verifier, state, scope };
    window.open(
      authorizeUrl({ authority: authority.trim(), clientId: clientId.trim(), challenge: await challengeFor(verifier), state, scope }),
    );
  }

  /** `obsidian://vault-planner-auth?code=…&state=…` — the browser's way back. */
  async handleRedirect(params: ObsidianProtocolData): Promise<void> {
    const pending = this.pending;
    // A link without a login of ours in progress — or for another vault window — is ignored.
    if (pending === null || params.state !== pending.state) throw new AuthError("state_mismatch", null);
    this.pending = null;

    const failure = redirectError(params);
    if (failure !== null) throw failure;
    const code = params.code;
    if (typeof code !== "string" || code === "" || code === "true") throw new AuthError("missing_code", null);

    this.generation += 1;
    this.refreshing = null;
    const { scope } = pending;
    await this.redeem(codeGrantBody({ clientId: this.profile().clientId.trim(), code, verifier: pending.verifier, scope }), this.generation, scope);
    this.changed();
  }

  /**
   * A valid access token, renewed five minutes before it expires. Fails at once, without a network
   * call, when there is no refresh token — a signed-out plugin must not keep knocking on Entra.
   */
  async getAccessToken(forceRefresh = false): Promise<string> {
    const scope = this.scope();
    const access = this.access;
    if (!forceRefresh && access !== null && access.scope === scope && access.expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()) {
      return access.token;
    }
    const refreshToken = this.refreshToken();
    if (refreshToken === null) throw new SignedOutError();
    // One refresh at a time: a poll and a POST that both hit the expiry wait for the same answer.
    if (this.refreshing === null || this.refreshing.scope !== scope) {
      const running: Promise<string> = this.refresh(refreshToken, scope).finally(() => {
        // Only clear our own slot: after a sign-out a newer refresh may already sit there.
        if (this.refreshing?.promise === running) this.refreshing = null;
      });
      this.refreshing = { scope, promise: running };
    }
    return this.refreshing.promise;
  }

  logout(): void {
    this.forget();
  }

  private async refresh(refreshToken: string, scope: string): Promise<string> {
    const generation = this.generation;
    try {
      const tokens = await this.redeem(
        refreshGrantBody({ clientId: this.profile().clientId.trim(), refreshToken, scope }),
        generation,
        scope,
      );
      return tokens.accessToken;
    } catch (error) {
      // Also the missing consent after switching Planner on (AADSTS65001): "Sign in" asks for it.
      const expired = error instanceof AuthError && (error.code === "invalid_grant" || error.code === "interaction_required");
      // A refresh for a scope the switch has left since must not end the session of the new one.
      if (expired && generation === this.generation && scope === this.scope()) this.forget();
      throw error;
    }
  }

  private async redeem(body: string, generation: number, scope: string): Promise<TokenSet> {
    const response = await withTimeout(
      requestUrl({
        url: tokenUrl(this.profile().authority.trim()),
        method: "POST",
        contentType: "application/x-www-form-urlencoded",
        body,
        // Errors arrive as 400 JSON; with throw:true requestUrl would drop the AADSTS body.
        throw: false,
      }),
      REQUEST_TIMEOUT_MS,
    );
    const tokens = parseTokenResponse(response.status, response.text, Date.now());
    // Signed out, or in again, while this request ran: its tokens belong to a session that is over.
    if (generation !== this.generation) throw new SignedOutError();
    // Every refresh returns a new refresh token with a fresh 90-day lifetime: keep the newest.
    if (tokens.refreshToken !== null) this.app.secretStorage.setSecret(this.keys.secret, tokens.refreshToken);
    if (tokens.account !== null) this.app.saveLocalStorage(this.keys.account, tokens.account);
    // A late answer for a scope the switch has left since must not replace the current token.
    if (scope === this.scope()) this.access = { token: tokens.accessToken, expiresAt: tokens.expiresAt, scope };
    return tokens;
  }

  private forget(): void {
    this.generation += 1;
    this.refreshing = null;
    // There is no public deleteSecret; an empty value reads as "no token" above.
    this.app.secretStorage.setSecret(this.keys.secret, "");
    this.app.saveLocalStorage(this.keys.account, null);
    this.access = null;
    this.changed();
  }
}
