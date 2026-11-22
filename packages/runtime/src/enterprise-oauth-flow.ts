import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { EnterpriseGrantRecord, EnterpriseOAuthStore } from "./enterprise-oauth-store.js";
import type { EnterprisePrincipal } from "./identity.js";
import { fetchPublicJson, fetchPublicStatus } from "./safe-http.js";
import { type OAuthClientConfig, tokenRequest } from "./vault.js";

type UserGrant = NonNullable<EnterpriseGrantRecord["grant"]>;

const LINK_LIFETIME_MS = 10 * 60_000;
const REFRESH_SKEW_MS = 60_000;
const ownerPattern = /^identity:[0-9a-f]{64}$/;
const noncePattern = /^[a-zA-Z0-9_-]{32,128}$/;
const random = () => randomBytes(32).toString("base64url");
const digest = (value: string) => createHash("sha256").update(value).digest("base64url");

export class EnterpriseOAuthError extends Error {
  constructor(
    readonly status: 400 | 403 | 409 | 503,
    readonly code: string,
  ) {
    super(code);
  }
}

export interface EnterpriseOAuthFlowOptions {
  store: EnterpriseOAuthStore;
  client: OAuthClientConfig;
  authorizationEndpoint: string;
  revocationEndpoint?: string;
  redirectUri: string;
  issuer: string;
  resource: string;
  scopes: readonly string[];
  verifyAccessToken: (
    token: string,
    principal: EnterprisePrincipal,
  ) => Promise<{ expiresAt: number }>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface EnterpriseOAuthCallback {
  state?: string;
  code?: string;
  iss?: string;
  error?: string;
}

function invalidState() {
  return new EnterpriseOAuthError(400, "invalid_state");
}

function unavailable() {
  return new EnterpriseOAuthError(503, "dependency_unavailable");
}

function needsReconnect() {
  return new EnterpriseOAuthError(409, "reauth_required");
}

function sameDigest(value: string, expected: string): boolean {
  const actual = Buffer.from(digest(value));
  const match = Buffer.from(expected);
  return actual.length === match.length && timingSafeEqual(actual, match);
}

// Only these identity coordinates participate in account linking. Never persist
// volatile group membership, scopes, actor data or an inbound bearer in the vault.
function grantOwner(principal: EnterprisePrincipal): EnterprisePrincipal {
  const { issuer, tenant, subject, expiresAt } = principal.identity;
  return {
    id: principal.id,
    scopes: [],
    identity: { issuer, tenant, subject, expiresAt, groups: [], scopes: [] },
  };
}

function sameOwner(left: EnterprisePrincipal, right: EnterprisePrincipal): boolean {
  return (
    left.id === right.id &&
    left.identity.issuer === right.identity.issuer &&
    left.identity.subject === right.identity.subject &&
    left.identity.tenant === right.identity.tenant
  );
}

export class EnterpriseOAuthFlow {
  private readonly now: () => number;

  constructor(private readonly options: EnterpriseOAuthFlowOptions) {
    this.now = options.now ?? Date.now;
  }

  async start(
    principal: EnterprisePrincipal,
    browserNonce: string,
  ): Promise<{ url: string; expiresAt: string }> {
    this.requireLive(principal);
    if (!noncePattern.test(browserNonce)) throw invalidState();
    const state = `${principal.id}.${random()}`;
    const verifier = random();
    const expiresAt = Math.min(this.now() + LINK_LIFETIME_MS, principal.identity.expiresAt);
    const pending = {
      stateHash: digest(state),
      browserHash: digest(browserNonce),
      verifier,
      expiresAt,
      principal: grantOwner(principal),
    };
    await this.options.store.withLock(principal.id, async () => {
      const row = await this.options.store.read(principal.id);
      if (row?.revocation) throw new EnterpriseOAuthError(409, "revocation_pending");
      await this.write(principal.id, row, { ...row, pending });
    });
    const url = new URL(this.options.authorizationEndpoint);
    const params = {
      response_type: "code",
      client_id: this.options.client.clientId,
      redirect_uri: this.options.redirectUri,
      resource: this.options.resource,
      scope: this.options.scopes.join(" "),
      state,
      code_challenge: digest(verifier),
      code_challenge_method: "S256",
    };
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
    return { url: url.toString(), expiresAt: new Date(expiresAt).toISOString() };
  }

  async callback(params: EnterpriseOAuthCallback, browserNonce: string): Promise<string> {
    const state = params.state ?? "";
    const match = /^(identity:[0-9a-f]{64})\.[a-zA-Z0-9_-]{43}$/.exec(state);
    const owner = match?.[1];
    if (!owner || !noncePattern.test(browserNonce)) throw invalidState();
    await this.options.store.withLock(owner, async () => {
      const row = await this.options.store.read(owner);
      const pending = row?.pending;
      if (
        !pending ||
        pending.principal.id !== owner ||
        pending.expiresAt <= this.now() ||
        !sameDigest(state, pending.stateHash) ||
        !sameDigest(browserNonce, pending.browserHash)
      ) {
        throw invalidState();
      }
      // Spend state before the network call. A late token response cannot replace
      // a disconnected grant or a newer link, even if this replica's lease expired.
      const claimed = await this.write(owner, row, { grant: row.grant, reconnect: row.reconnect });
      if (params.error) throw new EnterpriseOAuthError(403, "authorization_denied");
      if (
        !params.code ||
        params.code.length > 16_384 ||
        (params.iss !== undefined && params.iss !== this.options.issuer)
      )
        throw new EnterpriseOAuthError(400, "invalid_callback");
      const candidate = await this.exchange(pending.principal, {
        grant_type: "authorization_code",
        code: params.code,
        code_verifier: pending.verifier,
        redirect_uri: this.options.redirectUri,
      });
      const grant = await this.verify(candidate, pending.principal);
      if (pending.expiresAt <= this.now()) throw invalidState();
      // A new authorization replaces the old grant in full. A refresh token
      // retained from an earlier authorization could belong to a different grant.
      await this.write(owner, claimed, { grant });
    });
    return owner;
  }

  async status(
    principal: EnterprisePrincipal,
  ): Promise<"unconnected" | "reconnect" | "connected" | "revocation_pending"> {
    this.requireLive(principal);
    const row = await this.options.store.read(principal.id);
    if (row?.revocation) return "revocation_pending";
    if (row?.reconnect) return "reconnect";
    const grant = row?.grant;
    if (!grant || !sameOwner(grant.principal, principal)) return "unconnected";
    return !grant.refreshToken && grant.expiresAt <= this.now() ? "reconnect" : "connected";
  }

  async disconnect(principal: EnterprisePrincipal): Promise<boolean> {
    this.requireLive(principal);
    return this.options.store.withLock(principal.id, async () => {
      const row = await this.options.store.read(principal.id);
      if (!row) return false;
      let current = row;
      const endpoint = this.options.revocationEndpoint;
      if (endpoint && (row.grant || row.revocation)) {
        // A failed logout leaves an encrypted tombstone. Neither a tool call
        // nor a fresh enrollment can use these credentials during retries.
        if (row.grant) {
          current = await this.write(principal.id, row, {
            revocation: {
              accessToken: row.grant.accessToken,
              refreshToken: row.grant.refreshToken,
            },
          });
        }
        const revocation = current.revocation;
        if (!revocation) throw unavailable();
        if (revocation.refreshToken) {
          await this.revoke(endpoint, revocation.refreshToken, "refresh_token");
          current = await this.write(principal.id, current, {
            revocation: { accessToken: revocation.accessToken },
          });
        }
        await this.revoke(endpoint, revocation.accessToken, "access_token");
      }
      if (!(await this.options.store.commit(principal.id, current.revision, undefined)))
        throw unavailable();
      return Boolean(row.grant || row.pending || row.reconnect || row.revocation);
    });
  }

  async accessToken(principal: EnterprisePrincipal): Promise<string> {
    this.requireLive(principal);
    return this.options.store.withLock(principal.id, async () => {
      const row = await this.options.store.read(principal.id);
      const grant = row?.grant;
      if (!grant || row.reconnect || !sameOwner(grant.principal, principal)) throw needsReconnect();
      this.requireLive(principal);
      const remaining = grant.expiresAt - this.now();
      if (
        !grant.awaitingVerification &&
        remaining > 0 &&
        (!grant.refreshToken || remaining > REFRESH_SKEW_MS)
      )
        return grant.accessToken;
      let current = row;
      let candidate = grant;
      let fresh: UserGrant;
      try {
        if (!grant.awaitingVerification) {
          if (!grant.refreshToken) throw needsReconnect();
          const response = await this.exchange(principal, {
            grant_type: "refresh_token",
            refresh_token: grant.refreshToken,
          });
          candidate = {
            ...response,
            refreshToken: response.refreshToken ?? grant.refreshToken,
            awaitingVerification: true,
          };
          // The issuer may invalidate the prior refresh token at this instant.
          // Quarantine its replacement durably before introspection so an outage
          // can be retried without reusing a rotated token or dispatching an
          // access token whose subject and resource have not been established.
          current = await this.write(principal.id, row, { pending: row.pending, grant: candidate });
        }
        fresh = await this.verify(candidate, principal);
      } catch (error) {
        if (
          error instanceof EnterpriseOAuthError &&
          (error.code === "invalid_grant" || error.code === "invalid_user_grant")
        ) {
          await this.write(principal.id, current, { pending: current.pending, reconnect: true });
          throw needsReconnect();
        }
        throw error;
      }
      await this.write(principal.id, current, { pending: current.pending, grant: fresh });
      this.requireLive(principal);
      return fresh.accessToken;
    });
  }

  private async revoke(endpoint: string, token: string, type: string) {
    const request = tokenRequest(this.options.client, { token, token_type_hint: type });
    const status = await fetchPublicStatus(
      endpoint,
      {
        method: "POST",
        ...request,
        signal: AbortSignal.timeout(10_000),
      },
      { fetchImpl: this.options.fetchImpl },
    ).catch(() => undefined);
    if (status !== 200) throw new EnterpriseOAuthError(503, "revocation_pending");
  }

  private requireLive(principal: EnterprisePrincipal) {
    if (
      !ownerPattern.test(principal.id) ||
      !Number.isFinite(principal.identity.expiresAt) ||
      principal.identity.expiresAt <= this.now()
    )
      throw new EnterpriseOAuthError(403, "user_authorization_expired");
  }

  private async write(
    owner: string,
    previous: EnterpriseGrantRecord | undefined,
    data: Omit<EnterpriseGrantRecord, "revision">,
  ) {
    const next = { ...data, revision: random() };
    if (!(await this.options.store.commit(owner, previous?.revision, next))) throw unavailable();
    return next;
  }

  private async exchange(
    principal: EnterprisePrincipal,
    fields: Record<string, string>,
  ): Promise<UserGrant> {
    const request = tokenRequest(this.options.client, {
      ...fields,
      resource: this.options.resource,
    });
    const { response, json } = await fetchPublicJson(
      this.options.client.tokenEndpoint,
      { method: "POST", ...request, signal: AbortSignal.timeout(10_000) },
      { fetchImpl: this.options.fetchImpl },
    ).catch(() => {
      throw unavailable();
    });
    if (!json || typeof json !== "object" || Array.isArray(json)) throw unavailable();
    const reply = json as Record<string, unknown>;
    if (!response.ok) {
      if (response.status === 400 && reply.error === "invalid_grant")
        throw new EnterpriseOAuthError(400, "invalid_grant");
      throw unavailable();
    }
    if (
      typeof reply.access_token !== "string" ||
      !reply.access_token ||
      typeof reply.token_type !== "string" ||
      reply.token_type.toLowerCase() !== "bearer" ||
      (reply.refresh_token !== undefined &&
        (typeof reply.refresh_token !== "string" || !reply.refresh_token)) ||
      (reply.expires_in !== undefined &&
        (typeof reply.expires_in !== "number" ||
          !Number.isSafeInteger(reply.expires_in) ||
          reply.expires_in <= 0))
    ) {
      throw unavailable();
    }
    return {
      principal: grantOwner(principal),
      accessToken: reply.access_token,
      ...(typeof reply.refresh_token === "string" ? { refreshToken: reply.refresh_token } : {}),
      // Introspection establishes the actual expiry; the token response can
      // shorten it when the issuer also supplies expires_in.
      expiresAt:
        typeof reply.expires_in === "number"
          ? Math.min(this.now() + reply.expires_in * 1000, Number.MAX_SAFE_INTEGER)
          : Number.MAX_SAFE_INTEGER,
    };
  }

  private async verify(candidate: UserGrant, principal: EnterprisePrincipal): Promise<UserGrant> {
    this.requireLive(principal);
    const { expiresAt: verifiedExpiry } = await this.options
      .verifyAccessToken(candidate.accessToken, principal)
      .catch((error: unknown) => {
        if (error instanceof EnterpriseOAuthError) throw error;
        throw unavailable();
      });
    const expiresAt = Math.min(candidate.expiresAt, verifiedExpiry);
    if (!Number.isSafeInteger(verifiedExpiry) || expiresAt <= this.now())
      throw new EnterpriseOAuthError(403, "invalid_user_grant");
    const { awaitingVerification: _verified, ...grant } = candidate;
    return { ...grant, expiresAt };
  }
}
