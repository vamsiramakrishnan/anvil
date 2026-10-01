import { createHash, randomBytes } from "node:crypto";
import type { AirDocument, AuthRequirement } from "@anvil/air";
import { DEFAULT_ACCOUNT } from "./grants.js";
import {
  type ConnectionVault,
  type OAuthClientConfig,
  type StoredConnection,
  tokenRequest,
} from "./vault.js";

/**
 * The connect flow (docs/branchyard.md, ADR-0029): how a person puts an
 * upstream authorization into the gateway vault. Branchyard starts it
 * (`by connect github`); the gateway owns it.
 *
 * - OAuth connectors run the authorization-code grant with PKCE (S256). The
 *   authorization URL goes to the person who asked for it; `state` is a
 *   single-use, short-lived random value bound server-side to that person
 *   (`sub`), connector, and account, so a callback can only complete the
 *   flow its own start began. An `iss` on the callback (RFC 9207) is checked
 *   against the provider's issuer.
 * - Key-based connectors store the key the person submits.
 *
 * Nothing here returns a token to a caller. The one thing a caller receives
 * is the authorization URL, and only from `start`.
 */
export interface ConnectorAuthProfile {
  connector: string;
  /** `oauth`: authorization code. `static`: an API key or personal token. `none`: nothing to connect. */
  kind: "oauth" | "static" | "none" | "unsupported";
  authType: AuthRequirement["type"];
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  scopes: string[];
  /** The authorization server's issuer, for the RFC 9207 `iss` check. */
  issuer?: string;
  /** Gateway-side OAuth client, from `ANVIL_CONNECT_<CONNECTOR>_*`. */
  client?: OAuthClientConfig;
  /** Why an `oauth` connector cannot run the flow yet (missing endpoint or client id). */
  problem?: string;
}

/** `ANVIL_CONNECT_<CONNECTOR>_` — the env prefix for one connector's OAuth client. */
export function connectEnvPrefix(connector: string): string {
  return `ANVIL_CONNECT_${connector.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_`;
}

/**
 * What connecting `connector` means, from its approved operations' AIR auth
 * and the gateway's own client configuration. The OAuth client id and secret
 * are gateway configuration (`ANVIL_CONNECT_<CONNECTOR>_CLIENT_ID` /
 * `_CLIENT_SECRET`), never AIR; `_AUTHORIZATION_ENDPOINT`, `_TOKEN_ENDPOINT`,
 * `_ISSUER`, and `_SCOPES` override what AIR declares.
 */
export function connectorAuthProfile(
  connector: string,
  air: AirDocument,
  env: NodeJS.ProcessEnv = process.env,
): ConnectorAuthProfile {
  const approved = air.operations.filter((op) => op.state === "approved");
  const auths = approved.map((op) => op.auth).filter((auth) => auth.type !== "none");
  const first = auths[0];
  if (!first) return { connector, kind: "none", authType: "none", scopes: [] };
  const prefix = connectEnvPrefix(connector);
  const read = (name: string) => env[`${prefix}${name}`]?.trim() || undefined;
  const scopes = [...new Set(auths.flatMap((auth) => auth.scopes))].sort();
  if (first.type === "oauth2_authorization_code") {
    const provider = auths.find((auth) => auth.provider)?.provider;
    const authorizationEndpoint = read("AUTHORIZATION_ENDPOINT") ?? provider?.authorizationEndpoint;
    const tokenEndpoint = read("TOKEN_ENDPOINT") ?? provider?.tokenEndpoint;
    const clientId = read("CLIENT_ID");
    const clientSecret = read("CLIENT_SECRET");
    const clientAuth =
      provider?.clientAuth === "client_secret_post"
        ? "client_secret_post"
        : clientSecret
          ? "client_secret_basic"
          : "none";
    const envScopes = read("SCOPES");
    const profile: ConnectorAuthProfile = {
      connector,
      kind: "oauth",
      authType: first.type,
      ...(authorizationEndpoint ? { authorizationEndpoint } : {}),
      ...(tokenEndpoint ? { tokenEndpoint } : {}),
      scopes: envScopes ? envScopes.split(/[\s,]+/).filter(Boolean) : scopes,
      ...((read("ISSUER") ?? first.issuer) ? { issuer: read("ISSUER") ?? first.issuer } : {}),
    };
    if (!authorizationEndpoint || !tokenEndpoint) {
      profile.problem = `connector '${connector}' declares no authorization and token endpoint (set ${prefix}AUTHORIZATION_ENDPOINT and ${prefix}TOKEN_ENDPOINT)`;
    } else if (provider?.clientAuth === "private_key_jwt") {
      profile.problem = `connector '${connector}' authenticates with private_key_jwt, which the gateway does not mint`;
    } else if (!clientId) {
      profile.problem = `connector '${connector}' has no OAuth client configured (set ${prefix}CLIENT_ID)`;
    } else {
      profile.client = {
        tokenEndpoint,
        clientId,
        ...(clientSecret ? { clientSecret } : {}),
        clientAuth,
      };
    }
    return profile;
  }
  if (
    first.type === "api_key" ||
    first.type === "custom_header" ||
    first.type === "basic" ||
    first.type === "jwt_bearer" ||
    first.type === "oauth2_client_credentials" ||
    first.type === "oauth2_on_behalf_of"
  ) {
    // A bearer the person already holds (a personal access token) or a key.
    return { connector, kind: "static", authType: first.type, scopes };
  }
  return { connector, kind: "unsupported", authType: first.type, scopes };
}

interface PendingConnect {
  sub: string;
  connector: string;
  account: string;
  verifier: string;
  expiresAt: number;
}

export type ConnectStartResult =
  | { ok: true; kind: "oauth"; url: string; expiresAt: string }
  | { ok: true; kind: "static"; submit: "/connect/api-key" }
  | { ok: false; status: 400 | 404 | 409 | 503; code: string; message: string };

export type ConnectCallbackResult =
  | { ok: true; connector: string; account: string }
  | { ok: false; status: 400 | 502; code: string; message: string };

export interface ConnectFlowOptions {
  vault: ConnectionVault;
  profiles: ReadonlyMap<string, ConnectorAuthProfile>;
  /** The gateway's own `/connect/callback` URL, registered with each provider. */
  redirectUri: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** How long a started flow stays completable. Default ten minutes. */
  stateTtlMs?: number;
}

const DEFAULT_STATE_TTL_MS = 10 * 60_000;
const MAX_PENDING = 1000;

export class ConnectFlow {
  private readonly pending = new Map<string, PendingConnect>();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly ttl: number;

  constructor(private readonly options: ConnectFlowOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.ttl = options.stateTtlMs ?? DEFAULT_STATE_TTL_MS;
  }

  /** The profile for a served connector, or undefined. */
  profile(connector: string): ConnectorAuthProfile | undefined {
    return this.options.profiles.get(connector);
  }

  /** Begin connecting `connector` for `sub`: an authorization URL, or the key-submission route. */
  start(input: { sub: string; connector: string; account?: string }): ConnectStartResult {
    const account = input.account ?? DEFAULT_ACCOUNT;
    const profile = this.options.profiles.get(input.connector);
    if (!profile) {
      return {
        ok: false,
        status: 404,
        code: "unknown_connector",
        message: `The gateway serves no connector '${input.connector}'.`,
      };
    }
    if (profile.kind === "none") {
      return {
        ok: false,
        status: 409,
        code: "nothing_to_connect",
        message: `Connector '${input.connector}' needs no account.`,
      };
    }
    if (profile.kind === "unsupported") {
      return {
        ok: false,
        status: 409,
        code: "unsupported_auth",
        message: `Connector '${input.connector}' uses ${profile.authType}, which the gateway does not hold per person.`,
      };
    }
    if (profile.kind === "static") return { ok: true, kind: "static", submit: "/connect/api-key" };
    if (!profile.client || !profile.authorizationEndpoint || profile.problem) {
      return {
        ok: false,
        status: 503,
        code: "connector_not_configured",
        message: profile.problem ?? `Connector '${input.connector}' is not configured for OAuth.`,
      };
    }
    this.prune();
    if (this.pending.size >= MAX_PENDING) {
      return {
        ok: false,
        status: 503,
        code: "too_many_pending",
        message: "Too many connect flows are in progress; try again shortly.",
      };
    }
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const expiresAt = this.now() + this.ttl;
    this.pending.set(state, {
      sub: input.sub,
      connector: input.connector,
      account,
      verifier,
      expiresAt,
    });
    const url = new URL(profile.authorizationEndpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", profile.client.clientId);
    url.searchParams.set("redirect_uri", this.options.redirectUri);
    if (profile.scopes.length > 0) url.searchParams.set("scope", profile.scopes.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    return {
      ok: true,
      kind: "oauth",
      url: url.toString(),
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  /** Finish an OAuth flow from the provider's redirect. */
  async callback(params: {
    state?: string;
    code?: string;
    iss?: string;
    error?: string;
  }): Promise<ConnectCallbackResult> {
    this.prune();
    const pending = params.state ? this.pending.get(params.state) : undefined;
    if (!params.state || !pending) {
      return {
        ok: false,
        status: 400,
        code: "invalid_state",
        message: "This connect link is unknown, already used, or expired. Start again.",
      };
    }
    // Single use, whatever happens next.
    this.pending.delete(params.state);
    if (params.error) {
      return {
        ok: false,
        status: 400,
        code: "authorization_denied",
        message: `The provider did not authorize the connection (${params.error.slice(0, 64)}).`,
      };
    }
    const profile = this.options.profiles.get(pending.connector);
    if (!profile?.client) {
      return {
        ok: false,
        status: 400,
        code: "connector_not_configured",
        message: `Connector '${pending.connector}' is no longer configured for OAuth.`,
      };
    }
    if (params.iss !== undefined && !issuerMatches(params.iss, profile)) {
      return {
        ok: false,
        status: 400,
        code: "issuer_mismatch",
        message: "The authorization response came from an unexpected issuer.",
      };
    }
    if (!params.code) {
      return { ok: false, status: 400, code: "missing_code", message: "No authorization code." };
    }
    const request = tokenRequest(profile.client, {
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: this.options.redirectUri,
      code_verifier: pending.verifier,
    });
    let res: Response;
    try {
      res = await this.fetchImpl(profile.client.tokenEndpoint, {
        method: "POST",
        headers: request.headers,
        body: request.body,
      });
    } catch {
      return {
        ok: false,
        status: 502,
        code: "token_endpoint_unreachable",
        message: "The provider's token endpoint could not be reached.",
      };
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || typeof body.access_token !== "string" || body.access_token.length === 0) {
      return {
        ok: false,
        status: 502,
        code: "token_exchange_failed",
        message: "The provider refused the authorization code.",
      };
    }
    const stamp = new Date(this.now()).toISOString();
    const existing = safeGet(this.options.vault, pending.sub, pending.connector, pending.account);
    // A reconnect whose response does not rotate the refresh token keeps the
    // one already stored, exactly as a refresh does (vault.ts).
    const refreshToken =
      typeof body.refresh_token === "string" && body.refresh_token.length > 0
        ? body.refresh_token
        : existing?.kind === "oauth"
          ? existing.refreshToken
          : undefined;
    const connection: StoredConnection = {
      sub: pending.sub,
      connector: pending.connector,
      account: pending.account,
      kind: "oauth",
      status: "active",
      accessToken: body.access_token,
      ...(refreshToken ? { refreshToken } : {}),
      ...(typeof body.expires_in === "number"
        ? { expiresAt: this.now() + body.expires_in * 1000 }
        : {}),
      ...(typeof body.scope === "string" ? { scope: body.scope } : {}),
      createdAt: existing?.createdAt ?? stamp,
      updatedAt: stamp,
    };
    this.options.vault.put(connection);
    return { ok: true, connector: pending.connector, account: pending.account };
  }

  /** Store an API key or personal token the person submitted for a key-based connector. */
  putStatic(input: {
    sub: string;
    connector: string;
    account?: string;
    secret: string;
  }):
    | { ok: true; connector: string; account: string }
    | { ok: false; status: 400 | 404 | 409; code: string; message: string } {
    const account = input.account ?? DEFAULT_ACCOUNT;
    const profile = this.options.profiles.get(input.connector);
    if (!profile) {
      return {
        ok: false,
        status: 404,
        code: "unknown_connector",
        message: `The gateway serves no connector '${input.connector}'.`,
      };
    }
    if (profile.kind !== "static") {
      return {
        ok: false,
        status: 409,
        code: "wrong_connect_kind",
        message: `Connector '${input.connector}' is connected with ${profile.kind === "oauth" ? "OAuth (use /connect/start)" : profile.authType}, not a key.`,
      };
    }
    if (input.secret.length === 0 || input.secret.length > 8192 || /[\r\n]/.test(input.secret)) {
      return {
        ok: false,
        status: 400,
        code: "invalid_secret",
        message: "The key must be one non-empty line.",
      };
    }
    const stamp = new Date(this.now()).toISOString();
    const existing = safeGet(this.options.vault, input.sub, input.connector, account);
    this.options.vault.put({
      sub: input.sub,
      connector: input.connector,
      account,
      kind: "static",
      status: "active",
      secret: input.secret,
      createdAt: existing?.createdAt ?? stamp,
      updatedAt: stamp,
    });
    return { ok: true, connector: input.connector, account };
  }

  private prune(): void {
    const now = this.now();
    for (const [state, pending] of this.pending) {
      if (pending.expiresAt <= now) this.pending.delete(state);
    }
  }
}

function safeGet(
  vault: ConnectionVault,
  sub: string,
  connector: string,
  account: string,
): StoredConnection | undefined {
  try {
    return vault.get(sub, connector, account);
  } catch {
    return undefined;
  }
}

/**
 * RFC 9207: an `iss` on the authorization response must be the issuer we
 * sent the person to. With an issuer configured (AIR `auth.issuer` or
 * `ANVIL_CONNECT_<CONNECTOR>_ISSUER`) it must match exactly; without one it
 * must at least share the authorization endpoint's origin.
 */
function issuerMatches(iss: string, profile: ConnectorAuthProfile): boolean {
  if (profile.issuer) return iss === profile.issuer;
  if (!profile.authorizationEndpoint) return false;
  try {
    return new URL(iss).origin === new URL(profile.authorizationEndpoint).origin;
  } catch {
    return false;
  }
}
