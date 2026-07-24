/**
 * Outbound upstream credential resolution — the token-acquisition seam the
 * `EnvCredentialResolver` only stubbed. Three resolvers behind the existing
 * `CredentialResolver` interface (auth.ts), routed per-call by a composite, and
 * selected by a fail-closed registry that mirrors `resolveLedger`:
 *
 *   1. SecretManagerCredentialResolver — a DECORATOR over the env convention:
 *      any ANVIL_<PROFILE>_* value shaped as a secret reference (`sm://…` or a
 *      bare `projects/*​/secrets/*​/versions/*`) is fetched from Secret Manager at
 *      runtime (REST + metadata-server token), TTL-cached, so `latest` rotates
 *      without a redeploy. Literals pass through unchanged, so dev is identical.
 *   2. TokenExchangeResolver — actually acquires a token: OAuth2 client
 *      credentials (RFC 6749 §4.4), RFC 8693 token exchange / OBO (subject_token
 *      = the validated inbound caller token), RFC 7523 JWT-bearer assertion, and
 *      GCP workload-identity ID/access tokens from the metadata server. Caches
 *      per (profile, subject, audience, scopes) with expiry-leeway refresh.
 *   3. EnvCredentialResolver — the unchanged static default (api_key/basic/bearer).
 *
 * SECURITY: decrypted secrets and exchanged tokens live only transiently inside
 * a resolve() call's AuthMaterial; they are never returned to agents, never
 * written to an ExecutionRecord, never logged. On any acquisition failure a
 * resolver returns null → the executor emits a structured `auth_required` with
 * NAMES ONLY. The removed "collapse point" (silent static-bearer fallback for
 * every OAuth variant) means a mis-set delegated op now fails closed, by design.
 */

import { createHash } from "node:crypto";
import { type AuthRequirement, authCoherenceIssues } from "@anvil/air";
import {
  type AuthMaterial,
  apiKeyMaterial as apiKeyMaterialFor,
  type CredentialCallContext,
  type CredentialResolver,
  credentialRequirement,
  EnvCredentialResolver,
  envPrefix,
} from "./auth.js";
import type { RuntimeConfig } from "./config.js";
import { fetchPublicJson, type HostResolver, type PublicJsonFetchOptions } from "./safe-http.js";

/** Shared, injectable knobs so every resolver is unit-testable offline. */
export interface CredentialBackendOptions {
  env?: NodeJS.ProcessEnv;
  /** Injectable fetch — defaults to the global. Tests stub it. */
  fetchImpl?: typeof fetch;
  /** Injectable clock (epoch ms) — defaults to Date.now. */
  now?: () => number;
  /** Secret Manager cache TTL for `latest` versions (default 300s). */
  ttlMs?: number;
  /** Injectable metadata-server access-token minter (tests never hit the network). */
  metadataToken?: () => Promise<string>;
  /** Default GCP project for shorthand `sm://<secret>` references. */
  secretProject?: string;
  /** DNS seam for public token endpoints. */
  resolveHost?: HostResolver;
  /**
   * Permit a token endpoint at the exact `http://127.0.0.1` origin. Used only
   * by explicit dev runtimes for hermetic local issuers; `resolveCredentials`
   * disables it for staging/prod regardless of caller options.
   */
  allowLoopbackHttp?: boolean;
  /** Bound exchanged-token cache size (default 256). */
  maxTokenCacheEntries?: number;
  /** Token endpoint response limit (default 64 KiB). */
  maxTokenResponseBytes?: number;
  /** Token endpoint timeout (default 10 seconds). */
  tokenTimeoutMs?: number;
}

const DEFAULT_TTL_MS = 300_000;
const EXP_LEEWAY_MS = 60_000;
const SM_ENDPOINT = "https://secretmanager.googleapis.com/v1";
const METADATA_BASE =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default";

/** Hash cache dimensions so bearer/actor tokens never become observable map keys. */
function tokenCacheKey(...dimensions: Array<string | undefined>): string {
  return createHash("sha256").update(JSON.stringify(dimensions)).digest("hex");
}

/* -------------------------------------------------------------------------- */
/* Secret Manager dereference (REST + metadata token, dependency-light)        */
/* -------------------------------------------------------------------------- */

/** True when a value is a Secret Manager reference rather than a literal secret. */
export function isSecretRef(value: string): boolean {
  return (
    value.startsWith("sm://") || /^projects\/[^/]+\/secrets\/[^/]+\/versions\/[^/]+$/.test(value)
  );
}

/** Thrown when a secret reference cannot be dereferenced; callers map it to null. */
class SecretRefError extends Error {}

/**
 * Fetches Secret Manager payloads and mints the metadata-server access token,
 * with a TTL cache (so `latest` rotates within one TTL, no redeploy) and a short
 * negative cache (so 403/404 does not hammer the API). Injectable end to end.
 */
class SecretDeref {
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly secretProject?: string;
  private readonly mintToken: () => Promise<string>;
  private readonly cache = new Map<string, { value: string; expEpochMs: number }>();
  private readonly negative = new Map<string, number>();
  private metadata?: { token: string; expEpochMs: number };

  constructor(opts: CredentialBackendOptions = {}) {
    this.env = opts.env ?? process.env;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.secretProject = opts.secretProject;
    this.mintToken = opts.metadataToken ?? (() => this.defaultMetadataToken());
  }

  /** Resolve a possibly-referenced value. Literals pass through; refs are fetched. */
  async deref(raw: string | undefined): Promise<string | undefined> {
    if (raw === undefined || !isSecretRef(raw)) return raw;
    const name = this.resourceName(raw);
    const cached = this.cache.get(name);
    if (cached && this.now() < cached.expEpochMs) return cached.value;
    const negUntil = this.negative.get(name);
    if (negUntil !== undefined && this.now() < negUntil) {
      throw new SecretRefError(`secret ${name} recently failed`);
    }
    try {
      const token = await this.token();
      const res = await this.fetchImpl(`${SM_ENDPOINT}/${name}:access`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new SecretRefError(`secret access failed: ${res.status}`);
      const body = (await res.json()) as { payload?: { data?: string } };
      const data = body.payload?.data;
      if (!data) throw new SecretRefError("secret payload empty");
      const value = Buffer.from(data, "base64").toString("utf8");
      this.cache.set(name, { value, expEpochMs: this.now() + this.ttlMs });
      return value;
    } catch (err) {
      // Negative-cache to avoid hammering; never surface the SM error body.
      this.negative.set(name, this.now() + Math.min(this.ttlMs, 30_000));
      throw err instanceof SecretRefError ? err : new SecretRefError("secret access failed");
    }
  }

  /** The metadata-server access token (for SM + workload identity), cached. */
  async token(): Promise<string> {
    return this.mintToken();
  }

  private async defaultMetadataToken(): Promise<string> {
    if (this.metadata && this.now() < this.metadata.expEpochMs) return this.metadata.token;
    const res = await this.fetchImpl(`${METADATA_BASE}/token`, {
      headers: { "metadata-flavor": "Google" },
    });
    if (!res.ok) throw new SecretRefError(`metadata token failed: ${res.status}`);
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new SecretRefError("metadata token empty");
    const ttl = (body.expires_in ?? 3600) * 1000 - EXP_LEEWAY_MS;
    this.metadata = { token: body.access_token, expEpochMs: this.now() + Math.max(ttl, 0) };
    return body.access_token;
  }

  /** Mint a GCP ID token for an audience (Cloud-Run→Cloud-Run / IAP), uncached here. */
  async identityToken(audience: string): Promise<string> {
    const res = await this.fetchImpl(
      `${METADATA_BASE}/identity?audience=${encodeURIComponent(audience)}&format=full`,
      { headers: { "metadata-flavor": "Google" } },
    );
    if (!res.ok) throw new SecretRefError(`metadata identity token failed: ${res.status}`);
    return (await res.text()).trim();
  }

  private resourceName(ref: string): string {
    const body = ref.startsWith("sm://") ? ref.slice("sm://".length) : ref;
    if (body.startsWith("projects/")) return body;
    // Shorthand `sm://<secret>` → project default + latest version.
    if (!this.secretProject) {
      throw new SecretRefError(
        `secret shorthand "${ref}" needs ANVIL_SECRET_PROJECT to resolve the project`,
      );
    }
    return `projects/${this.secretProject}/secrets/${body}/versions/latest`;
  }
}

/* -------------------------------------------------------------------------- */
/* 1. Secret Manager resolver (decorator over the env convention)              */
/* -------------------------------------------------------------------------- */

/**
 * Reuses Anvil's ANVIL_<PROFILE>_* env convention verbatim, but any value that
 * is a secret reference is dereferenced from Secret Manager at runtime. Static
 * schemes only (api_key/basic/bearer); OAuth grants route to the exchange
 * resolver, which shares this class to read its own client secret.
 */
export class SecretManagerCredentialResolver implements CredentialResolver {
  private readonly env: NodeJS.ProcessEnv;
  private readonly secrets: SecretDeref;
  private readonly inner: EnvCredentialResolver;

  constructor(opts: CredentialBackendOptions = {}) {
    this.env = opts.env ?? process.env;
    this.secrets = new SecretDeref(opts);
    this.inner = new EnvCredentialResolver(this.env);
  }

  expectedCredentials(profileName: string, auth: AuthRequirement): string[] {
    return this.inner.expectedCredentials(profileName, auth);
  }

  async resolve(profileName: string, auth: AuthRequirement): Promise<AuthMaterial | null> {
    const prefix = envPrefix(profileName);
    try {
      switch (auth.type) {
        case "none":
          return {};
        case "api_key": {
          const key = await this.secrets.deref(this.env[`${prefix}_API_KEY`]);
          return key ? apiKeyMaterialFor(key, auth, prefix, this.env) : null;
        }
        case "basic": {
          const user = await this.secrets.deref(this.env[`${prefix}_USERNAME`]);
          const pass = await this.secrets.deref(this.env[`${prefix}_PASSWORD`]);
          if (!user || !pass) return null;
          const b64 = Buffer.from(`${user}:${pass}`).toString("base64");
          return { headers: { Authorization: `Basic ${b64}` } };
        }
        case "mtls":
        case "custom_header":
        case "oauth2_authorization_code":
          return null;
        default: {
          const token = await this.secrets.deref(this.env[`${prefix}_TOKEN`]);
          return token ? { headers: { Authorization: `Bearer ${token}` } } : null;
        }
      }
    } catch {
      // A referenced secret could not be fetched — fail closed (auth_required),
      // never leak the Secret Manager error.
      return null;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* 2. Token-acquisition resolver (client-credentials, RFC 8693 OBO, 7523, WI)  */
/* -------------------------------------------------------------------------- */

const GRANT_TOKEN_EXCHANGE = "urn:ietf:params:oauth:grant-type:token-exchange";
const GRANT_JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const TOKEN_TYPE = {
  access_token: "urn:ietf:params:oauth:token-type:access_token",
  jwt: "urn:ietf:params:oauth:token-type:jwt",
  id_token: "urn:ietf:params:oauth:token-type:id_token",
} as const;

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
}

/**
 * Acquires an outbound bearer by running the appropriate grant. Handles:
 *  - oauth2_on_behalf_of / principal delegated|impersonation → RFC 8693 exchange
 *    (subject_token = the inbound caller token; actor_token present ⇒ delegation,
 *    absent ⇒ impersonation).
 *  - oauth2_client_credentials → RFC 6749 §4.4 (service principal, no user).
 *  - jwt_bearer → RFC 7523 assertion grant.
 *  - workload_identity → GCP metadata-server ID token (audience) / access token.
 * Exchanged tokens are cached per (profile, subject, audience, scopes) until
 * expiry minus a leeway, then re-acquired.
 */
export class TokenExchangeResolver implements CredentialResolver {
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private readonly secrets: SecretDeref;
  private readonly cache = new Map<string, { token: string; expEpochMs: number }>();
  private readonly inFlight = new Map<string, Promise<string | null>>();
  private readonly maxCacheEntries: number;
  private readonly httpOptions: PublicJsonFetchOptions;

  constructor(opts: CredentialBackendOptions = {}) {
    this.env = opts.env ?? process.env;
    this.now = opts.now ?? Date.now;
    this.secrets = new SecretDeref(opts);
    this.maxCacheEntries = opts.maxTokenCacheEntries ?? 256;
    this.httpOptions = {
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      ...(opts.resolveHost ? { resolveHost: opts.resolveHost } : {}),
      ...(opts.maxTokenResponseBytes ? { maxBytes: opts.maxTokenResponseBytes } : {}),
      ...(opts.tokenTimeoutMs ? { timeoutMs: opts.tokenTimeoutMs } : {}),
      ...(opts.allowLoopbackHttp ? { allowLoopbackHttp: true } : {}),
    };
  }

  expectedCredentials(profileName: string, auth: AuthRequirement): string[] {
    const contract = credentialRequirement(profileName, auth);
    const names = [...contract.required];
    if (contract.requiredOneOf && contract.requiredOneOf.length > 0) {
      names.push(
        `one of: ${contract.requiredOneOf.map((group) => group.join(" + ")).join(" OR ")}`,
      );
    }
    if (auth.type === "oauth2_on_behalf_of") {
      names.push("a validated inbound caller token");
    }
    return names;
  }

  async resolve(
    profileName: string,
    auth: AuthRequirement,
    callCtx?: CredentialCallContext,
  ): Promise<AuthMaterial | null> {
    try {
      const token = await this.acquire(profileName, auth, callCtx);
      return token ? { headers: { Authorization: `Bearer ${token}` } } : null;
    } catch {
      return null;
    }
  }

  private async acquire(
    profileName: string,
    auth: AuthRequirement,
    callCtx?: CredentialCallContext,
  ): Promise<string | null> {
    if (authCoherenceIssues(auth).length > 0) return null;
    const p = envPrefix(profileName);
    const audience = this.env[`${p}_AUDIENCE`] ?? auth.audience;
    const resource = this.env[`${p}_RESOURCE`] ?? auth.provider?.resource;
    const envScopes = this.env[`${p}_SCOPES`]?.split(/\s+/).filter(Boolean);
    const scope = [...new Set(envScopes && envScopes.length > 0 ? envScopes : auth.scopes)].join(
      " ",
    );

    // GCP workload identity: mint from the metadata server, no token endpoint.
    if (auth.type === "workload_identity") {
      const target = audience ?? resource;
      const key = tokenCacheKey(profileName, "workload_identity", target ?? "access");
      return this.cached(key, async () =>
        target
          ? { access_token: await this.secrets.identityToken(target), expires_in: 3600 }
          : { access_token: await this.secrets.token(), expires_in: 3600 },
      );
    }

    const isObo = auth.type === "oauth2_on_behalf_of";

    const configuredTokenEndpoint = this.env[`${p}_TOKEN_ENDPOINT`];
    const tokenEndpoint = configuredTokenEndpoint ?? auth.provider?.tokenEndpoint;
    if (!tokenEndpoint) return null;
    const approvedHosts = configuredTokenEndpoint
      ? undefined
      : this.env.ANVIL_CREDENTIAL_HOSTS?.split(",")
          .map((host) => host.trim())
          .filter(Boolean);
    // A token endpoint imported from an API contract is untrusted input. It must
    // be explicitly admitted by the deploy operator before any secret is sent.
    if (!configuredTokenEndpoint && (!approvedHosts || approvedHosts.length === 0)) return null;

    // RFC 7523 assertion grant (self-signed impersonation).
    if (auth.provider?.grant === "jwt_bearer") {
      const subject = auth.delegation?.subject ?? callCtx?.inbound?.email ?? callCtx?.inbound?.sub;
      const key = tokenCacheKey(
        profileName,
        "jwt_bearer",
        tokenEndpoint,
        this.env[`${p}_CLIENT_ID`],
        scope,
        subject,
      );
      const assertion = await this.buildAssertion(p, tokenEndpoint, subject, scope);
      if (!assertion) return null;
      return this.cached(key, () =>
        this.post(
          tokenEndpoint,
          {
            grant_type: GRANT_JWT_BEARER,
            assertion,
            ...(scope ? { scope } : {}),
          },
          {},
          approvedHosts,
        ),
      );
    }

    // RFC 8693 token exchange (delegated / OBO).
    if (isObo) {
      const inbound = callCtx?.inbound;
      if (!inbound) return null; // no subject token → fail closed, no static fallback
      const clientAuth = await this.clientAuth(p, auth, tokenEndpoint);
      if (!clientAuth) return null;
      const actorToken = auth.delegation?.actor
        ? await this.secrets.deref(this.env[`${p}_ACTOR_TOKEN`])
        : undefined;
      if (auth.delegation?.actor && !actorToken) return null;
      const subjectTokenType = auth.provider?.subjectTokenType ?? inbound.subjectTokenType;
      const requestedTokenType = auth.provider?.requestedTokenType ?? "access_token";
      const key = tokenCacheKey(
        profileName,
        "token_exchange",
        tokenEndpoint,
        this.env[`${p}_CLIENT_ID`],
        auth.provider?.clientAuth ?? "client_secret_basic",
        inbound.subjectToken,
        subjectTokenType,
        requestedTokenType,
        actorToken,
        audience,
        resource,
        scope,
      );
      return this.cached(key, () =>
        this.post(
          tokenEndpoint,
          {
            grant_type: GRANT_TOKEN_EXCHANGE,
            subject_token: inbound.subjectToken,
            subject_token_type: TOKEN_TYPE[subjectTokenType],
            requested_token_type: TOKEN_TYPE[requestedTokenType],
            ...(audience ? { audience } : {}),
            ...(resource ? { resource } : {}),
            ...(scope ? { scope } : {}),
            ...(actorToken ? { actor_token: actorToken, actor_token_type: TOKEN_TYPE.jwt } : {}),
            ...clientAuth.body,
          },
          clientAuth.headers,
          approvedHosts,
        ),
      );
    }

    // OAuth2 client credentials (RFC 6749 §4.4): service principal, no user.
    const clientAuth = await this.clientAuth(p, auth, tokenEndpoint);
    if (!clientAuth) return null;
    const key = tokenCacheKey(
      profileName,
      "client_credentials",
      tokenEndpoint,
      this.env[`${p}_CLIENT_ID`],
      auth.provider?.clientAuth ?? "client_secret_basic",
      audience,
      resource,
      scope,
    );
    return this.cached(key, () =>
      this.post(
        tokenEndpoint,
        {
          grant_type: "client_credentials",
          ...(scope ? { scope } : {}),
          ...(audience ? { audience } : {}),
          ...(resource ? { resource } : {}),
          ...clientAuth.body,
        },
        clientAuth.headers,
        approvedHosts,
      ),
    );
  }

  /** Client authentication to the STS: client_secret_basic (default) / _post / private_key_jwt. */
  private async clientAuth(
    prefix: string,
    auth: AuthRequirement,
    tokenEndpoint: string,
  ): Promise<{ headers: Record<string, string>; body: Record<string, string> } | null> {
    const clientId = this.env[`${prefix}_CLIENT_ID`];
    const method = auth.provider?.clientAuth ?? "client_secret_basic";
    if (method === "private_key_jwt") {
      const assertion = await this.buildAssertion(
        prefix,
        tokenEndpoint,
        clientId,
        undefined,
        clientId,
      );
      if (!assertion) return null;
      return {
        headers: {},
        body: {
          client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: assertion,
          ...(clientId ? { client_id: clientId } : {}),
        },
      };
    }
    const secret = await this.secrets.deref(this.env[`${prefix}_CLIENT_SECRET`]);
    if (!clientId || !secret) return null;
    if (method === "client_secret_post") {
      return { headers: {}, body: { client_id: clientId, client_secret: secret } };
    }
    const basic = Buffer.from(`${clientId}:${secret}`).toString("base64");
    return { headers: { authorization: `Basic ${basic}` }, body: {} };
  }

  /** Build an RS256-signed JWT assertion (RFC 7523 grant OR private_key_jwt client auth). */
  private async buildAssertion(
    prefix: string,
    aud: string,
    subject: string | undefined,
    _scope: string | undefined,
    iss?: string,
  ): Promise<string | null> {
    const pem = await this.secrets.deref(this.env[`${prefix}_CLIENT_ASSERTION_KEY`]);
    const issuer = iss ?? this.env[`${prefix}_CLIENT_ID`];
    if (!pem || !issuer) return null;
    const { createSign, randomUUID } = await import("node:crypto");
    const nowSec = Math.floor(this.now() / 1000);
    const header = { alg: "RS256", typ: "JWT" };
    const payload: Record<string, unknown> = {
      iss: issuer,
      sub: subject ?? issuer,
      aud,
      iat: nowSec,
      exp: nowSec + 300,
      jti: randomUUID(),
    };
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const signingInput = `${enc(header)}.${enc(payload)}`;
    const sig = createSign("RSA-SHA256").update(signingInput).sign(pem).toString("base64url");
    return `${signingInput}.${sig}`;
  }

  /** POST a form-encoded grant and parse the token response. */
  private async post(
    tokenEndpoint: string,
    fields: Record<string, string>,
    headers: Record<string, string> = {},
    approvedHosts?: readonly string[],
  ): Promise<TokenResponse> {
    const { response, json } = await fetchPublicJson(
      tokenEndpoint,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
        body: new URLSearchParams(fields).toString(),
      },
      { ...this.httpOptions, ...(approvedHosts ? { allowedHosts: approvedHosts } : {}) },
    );
    if (!response.ok) throw new SecretRefError(`token endpoint failed: ${response.status}`);
    if (typeof json !== "object" || json === null) {
      throw new SecretRefError("token endpoint returned an invalid JSON object");
    }
    const token = (json as Record<string, unknown>).access_token;
    const expires = (json as Record<string, unknown>).expires_in;
    if (token !== undefined && typeof token !== "string") {
      throw new SecretRefError("token endpoint returned an invalid access_token");
    }
    if (expires !== undefined && (typeof expires !== "number" || !Number.isFinite(expires))) {
      throw new SecretRefError("token endpoint returned an invalid expires_in");
    }
    return {
      ...(typeof token === "string" ? { access_token: token } : {}),
      ...(typeof expires === "number" ? { expires_in: expires } : {}),
    };
  }

  /** Serve a cached token until exp-leeway, else mint via `fn` and cache it. */
  private async cached(key: string, fn: () => Promise<TokenResponse>): Promise<string | null> {
    this.pruneCache();
    const hit = this.cache.get(key);
    if (hit && this.now() < hit.expEpochMs) {
      // Refresh insertion order for LRU eviction without exposing the key.
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit.token;
    }
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const acquisition = (async () => {
      const resp = await fn();
      if (!resp.access_token) return null;
      const ttl = (resp.expires_in ?? 3600) * 1000 - EXP_LEEWAY_MS;
      if (ttl > 0) {
        while (this.cache.size >= this.maxCacheEntries) {
          const oldest = this.cache.keys().next().value;
          if (oldest === undefined) break;
          this.cache.delete(oldest);
        }
        this.cache.set(key, { token: resp.access_token, expEpochMs: this.now() + ttl });
      }
      return resp.access_token;
    })();
    this.inFlight.set(key, acquisition);
    try {
      return await acquisition;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private pruneCache(): void {
    const now = this.now();
    for (const [key, value] of this.cache) {
      if (now >= value.expEpochMs) this.cache.delete(key);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* 3. Composite router + fail-closed selector (mirrors resolveLedger)          */
/* -------------------------------------------------------------------------- */

/**
 * Routes each resolve() to the right backend by the AuthRequirement, because one
 * service exposes operations with DIFFERENT auth (some static api_key, some OBO)
 * — the choice is per-operation, not global.
 */
export class CompositeCredentialResolver implements CredentialResolver {
  constructor(
    private readonly staticCredentials: CredentialResolver,
    private readonly secretManager: () => CredentialResolver,
    private readonly exchange: () => CredentialResolver,
    private readonly forVault: (source: string) => CredentialResolver,
  ) {}

  private route(auth: AuthRequirement): CredentialResolver {
    // A declared external vault owns the complete auth resolution path. Check it
    // before grant routing so an OAuth operation cannot silently ignore its
    // configured secret source.
    if (auth.secretSource === "vault") return this.forVault("vault");
    if (auth.type === "oauth2_on_behalf_of") {
      return this.exchange();
    }
    if (
      auth.type === "oauth2_client_credentials" ||
      (auth.type === "jwt_bearer" && auth.provider?.grant === "jwt_bearer") ||
      auth.type === "workload_identity"
    ) {
      return this.exchange();
    }
    if (auth.secretSource === "secret_manager") return this.secretManager();
    return this.staticCredentials;
  }

  resolve(
    profileName: string,
    auth: AuthRequirement,
    callCtx?: CredentialCallContext,
  ): Promise<AuthMaterial | null> {
    if (authCoherenceIssues(auth).length > 0) return Promise.resolve(null);
    return this.route(auth).resolve(profileName, auth, callCtx);
  }

  expectedCredentials(profileName: string, auth: AuthRequirement): string[] {
    if (authCoherenceIssues(auth).length > 0) return [];
    return this.route(auth).expectedCredentials?.(profileName, auth) ?? [];
  }
}

/** Builds a credential resolver from runtime config. */
export type CredentialResolverFactory = (
  config: RuntimeConfig,
  opts?: CredentialBackendOptions,
) => CredentialResolver;

const credentialBackends = new Map<string, CredentialResolverFactory>();

/**
 * Register a credential backend under a key (`secret_manager`, `vault`, …).
 * Mirrors `registerLedgerBackend`: the deployed image may register cloud
 * adapters at boot; the core pre-registers env / secret_manager / delegated.
 * `vault` is intentionally unregistered so requesting it fails closed.
 */
export function registerCredentialBackend(key: string, factory: CredentialResolverFactory): void {
  credentialBackends.set(key, factory);
}

// Core, dependency-light backends (Secret Manager is pure REST, so it ships in
// core — unlike the Firestore ledger, which needs a cloud SDK).
registerCredentialBackend("env", (_c, o) => new EnvCredentialResolver(o?.env));
registerCredentialBackend("secret_manager", (_c, o) => new SecretManagerCredentialResolver(o));
registerCredentialBackend("delegated", (_c, o) => new TokenExchangeResolver(o));

/**
 * Resolve the outbound credential resolver for a runtime instance. Precedence:
 *   1. `ANVIL_CREDENTIALS=env|secret_manager` selects storage for static
 *      api-key/basic/bearer values. It never overrides OAuth grant routing.
 *   2. a composite routes grants per-operation by AuthRequirement and defaults
 *      static values to the Secret Manager pass-through decorator.
 * A `vault` secretSource with no registered backend throws at resolve time.
 */
export function resolveCredentials(
  config: RuntimeConfig,
  opts: CredentialBackendOptions = {},
): CredentialResolver {
  const { allowLoopbackHttp: requestedLoopback, ...rest } = opts;
  const backendOpts: CredentialBackendOptions = {
    secretProject: config.secretProject,
    ...rest,
    // Local OAuth/STS emulators are useful for generated-bundle self-tests and
    // developer sandboxes. The exception is exact-loopback only and cannot be
    // enabled in staging/prod through the injected options seam.
    allowLoopbackHttp: config.env === "dev" && requestedLoopback !== false,
  };
  if (
    config.credentials &&
    config.credentials !== "env" &&
    config.credentials !== "secret_manager"
  ) {
    throw new Error(
      `ANVIL_CREDENTIALS="${config.credentials}" is invalid. Use env or secret_manager; ` +
        "OAuth grants and delegated identity are always selected per operation.",
    );
  }
  const need = (key: string): CredentialResolver => {
    const factory = credentialBackends.get(key);
    if (!factory) {
      throw new Error(
        `No credential backend registered for secretSource "${key}". ` +
          `Register one with registerCredentialBackend("${key}", …) before boot.`,
      );
    }
    return factory(config, backendOpts);
  };
  const staticCredentials = config.credentials === "env" ? need("env") : need("secret_manager");
  return new CompositeCredentialResolver(
    staticCredentials,
    () => need("secret_manager"),
    () => need("delegated"),
    (source) => need(source),
  );
}
