import { requestUrl, type App, type ObsidianProtocolData } from "obsidian";
import {
  LOCAL_ACCOUNT_KEY,
  REQUEST_TIMEOUT_MS,
  SECRET_REFRESH_TOKEN,
  TOKEN_REFRESH_MARGIN_MS,
} from "./config";
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

export interface AuthSettings {
  tenantId: string;
  clientId: string;
}

/**
 * Sign-in with auth code + PKCE in the system browser, back through obsidian://vault-planner-auth.
 *
 * The refresh token lives in Obsidian's SecretStorage (encrypted by the OS since 1.11.5, device-
 * local, never synced) — NEVER in data.json, which sits in the OneDrive-synced vault. The access
 * token lives in memory only. Only `login()` ever opens a browser; the timers never do.
 */
export class Auth {
  private access: { token: string; expiresAt: number } | null = null;
  private refreshing: Promise<string> | null = null;
  private pending: { verifier: string; state: string } | null = null;
  /**
   * Bumped by every sign-in and sign-out. A refresh that was already running when the user signed
   * out — or in again — must neither store its token nor wipe the new session.
   */
  private generation = 0;

  constructor(
    private readonly app: App,
    private readonly settings: () => AuthSettings,
    private readonly changed: () => void,
  ) {}

  get configured(): boolean {
    const { tenantId, clientId } = this.settings();
    return tenantId.trim() !== "" && clientId.trim() !== "";
  }

  get signedIn(): boolean {
    return this.refreshToken() !== null;
  }

  get account(): string | null {
    const value: unknown = this.app.loadLocalStorage(LOCAL_ACCOUNT_KEY);
    return typeof value === "string" ? value : null;
  }

  private refreshToken(): string | null {
    const value = this.app.secretStorage.getSecret(SECRET_REFRESH_TOKEN);
    return value === null || value === "" ? null : value;
  }

  async login(): Promise<void> {
    if (!this.configured) throw new Error("Zuerst Tenant-ID und Client-ID in den Einstellungen eintragen.");
    const { tenantId, clientId } = this.settings();
    const verifier = randomVerifier();
    const state = randomVerifier();
    this.pending = { verifier, state };
    window.open(
      authorizeUrl({ tenantId: tenantId.trim(), clientId: clientId.trim(), challenge: await challengeFor(verifier), state }),
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
    await this.redeem(codeGrantBody({ clientId: this.settings().clientId.trim(), code, verifier: pending.verifier }), this.generation);
    this.changed();
  }

  /**
   * A valid access token, renewed five minutes before it expires. Fails at once, without a network
   * call, when there is no refresh token — a signed-out plugin must not keep knocking on Entra.
   */
  async getAccessToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.access !== null && this.access.expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()) {
      return this.access.token;
    }
    const refreshToken = this.refreshToken();
    if (refreshToken === null) throw new SignedOutError();
    // One refresh at a time: a poll and a POST that both hit the expiry wait for the same answer.
    if (this.refreshing === null) {
      const running: Promise<string> = this.refresh(refreshToken).finally(() => {
        // Only clear our own slot: after a sign-out a newer refresh may already sit there.
        if (this.refreshing === running) this.refreshing = null;
      });
      this.refreshing = running;
    }
    return this.refreshing;
  }

  logout(): void {
    this.forget();
  }

  private async refresh(refreshToken: string): Promise<string> {
    const generation = this.generation;
    try {
      const tokens = await this.redeem(refreshGrantBody({ clientId: this.settings().clientId.trim(), refreshToken }), generation);
      return tokens.accessToken;
    } catch (error) {
      const expired = error instanceof AuthError && (error.code === "invalid_grant" || error.code === "interaction_required");
      if (expired && generation === this.generation) this.forget();
      throw error;
    }
  }

  private async redeem(body: string, generation: number): Promise<TokenSet> {
    const response = await withTimeout(
      requestUrl({
        url: tokenUrl(this.settings().tenantId.trim()),
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
    if (tokens.refreshToken !== null) this.app.secretStorage.setSecret(SECRET_REFRESH_TOKEN, tokens.refreshToken);
    if (tokens.account !== null) this.app.saveLocalStorage(LOCAL_ACCOUNT_KEY, tokens.account);
    this.access = { token: tokens.accessToken, expiresAt: tokens.expiresAt };
    return tokens;
  }

  private forget(): void {
    this.generation += 1;
    this.refreshing = null;
    // There is no public deleteSecret; an empty value reads as "no token" above.
    this.app.secretStorage.setSecret(SECRET_REFRESH_TOKEN, "");
    this.app.saveLocalStorage(LOCAL_ACCOUNT_KEY, null);
    this.access = null;
    this.changed();
  }
}
