import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type AuthRequirement, effectiveAuthCarrier, type TlsClientMaterialRefs } from "@anvil/air";
import type { InboundIdentity } from "./inbound-identity.js";
import type { HttpRequest, TlsClientMaterial } from "./transport.js";

/**
 * Resolved auth material. Secrets live here only transiently and are never
 * written to execution records or logs (spec §13, §18). Agents never see them.
 */
export interface AuthMaterial {
  /** Headers to merge into the outbound request (e.g. Authorization). */
  headers?: Record<string, string>;
  /** Query params to merge (e.g. api_key for query-key APIs). */
  query?: Record<string, string>;
  /**
   * Client-certificate material for an `mtls` operation. PEM text, resolved
   * from the environment by the exact names `auth.tls` declares — never
   * written to an execution record or log. Carried onto the outbound request
   * by `applyAuth` so the transport can hand it to `node:https` (Node's global
   * `fetch` cannot present a client certificate).
   */
  tls?: TlsClientMaterial;
}

/**
 * Per-call context a resolver may need beyond the static profile: the validated
 * inbound caller identity, for delegated / on-behalf-of (RFC 8693) exchange.
 * Optional and additive — static resolvers ignore it, so the interface stays
 * backward compatible.
 */
export interface CredentialCallContext {
  inbound?: InboundIdentity;
}

/**
 * Resolves a named auth profile into material. Implementations read from
 * approved stores only (Secret Manager, workload identity) — never from
 * agent-provided input, and never returning the raw secret to the caller.
 */
export interface CredentialResolver {
  resolve(
    profileName: string,
    auth: AuthRequirement,
    callCtx?: CredentialCallContext,
  ): Promise<AuthMaterial | null>;
  /**
   * Optional: the credential *locations* this resolver would read for a
   * profile (env var names, secret ids) — NAMES ONLY, never values. Surfaced
   * in auth_required errors so a stranded caller learns exactly what to set.
   */
  expectedCredentials?(profileName: string, auth: AuthRequirement): string[];
}

/** Injectable knobs for {@link EnvCredentialResolver} so tests never hit the network or the clock. */
export interface EnvCredentialResolverOptions {
  /** Injectable fetch for the authorization-code refresh grant — defaults to the global. */
  fetchImpl?: typeof fetch;
  /** Injectable clock (epoch ms) — defaults to Date.now. */
  now?: () => number;
  /** Override the refresh-token store directory (tests only); defaults to `~/.anvil/credentials`. */
  refreshTokenDir?: string;
}

/**
 * Default resolver: reads a bearer token / api key from the process
 * environment by convention, e.g. profile `prod` -> ANVIL_PROD_TOKEN. Intended
 * for local dev; production binds Secret Manager behind this same interface.
 */
export class EnvCredentialResolver implements CredentialResolver {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly fileRefreshTokens: FileRefreshTokenSource;
  /** In-memory cache of tokens acquired via the authorization-code refresh grant. */
  private readonly authCodeCache = new Map<string, { token: string; expEpochMs: number }>();

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    opts: EnvCredentialResolverOptions = {},
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.fileRefreshTokens = new FileRefreshTokenSource(opts.refreshTokenDir);
  }

  /** The env var names this resolver reads for a profile — names only, never values. */
  expectedCredentials(profileName: string, auth: AuthRequirement): string[] {
    const prefix = envPrefix(profileName);
    switch (auth.type) {
      case "none":
        return [];
      case "api_key":
        return [`${prefix}_API_KEY`];
      case "basic":
        return [`${prefix}_USERNAME`, `${prefix}_PASSWORD`];
      case "mtls":
        return auth.tls
          ? [
              auth.tls.clientCertRef,
              auth.tls.clientKeyRef,
              ...(auth.tls.caRef ? [auth.tls.caRef] : []),
            ]
          : [];
      case "custom_header":
        return effectiveAuthCarrier(auth) ? [`${prefix}_HEADER_VALUE`] : [];
      case "oauth2_authorization_code":
        return [
          `one of: ${prefix}_TOKEN OR (${prefix}_REFRESH_TOKEN + ${prefix}_CLIENT_ID)`,
          `stored refresh token at ~/.anvil/credentials/${profileName}.json (from 'anvil auth login')`,
        ];
      default:
        return [`${prefix}_TOKEN`];
    }
  }

  async resolve(profileName: string, auth: AuthRequirement): Promise<AuthMaterial | null> {
    const prefix = envPrefix(profileName);
    const token = this.env[`${prefix}_TOKEN`];
    const apiKey = this.env[`${prefix}_API_KEY`];
    switch (auth.type) {
      case "none":
        return {};
      case "api_key":
        return apiKey ? apiKeyMaterial(apiKey, auth, prefix, this.env) : null;
      case "basic": {
        const user = this.env[`${prefix}_USERNAME`];
        const pass = this.env[`${prefix}_PASSWORD`];
        if (!user || !pass) return null;
        const b64 = Buffer.from(`${user}:${pass}`).toString("base64");
        return { headers: { Authorization: `Basic ${b64}` } };
      }
      case "mtls": {
        if (!auth.tls) return null;
        const tls = this.resolveTlsMaterial(auth.tls);
        return tls ? { tls } : null;
      }
      case "custom_header": {
        const carrier = effectiveAuthCarrier(auth);
        if (!carrier) return null;
        const value = this.env[`${prefix}_HEADER_VALUE`];
        if (!value) return null;
        // Placed verbatim under the DECLARED carrier — a vendor's own header
        // name and (optional) scheme prefix — never collapsed to a generic
        // `Authorization: Bearer` the way every OAuth/JWT variant is below.
        const carried = carrier.scheme ? `${carrier.scheme} ${value}` : value;
        return carrier.in === "query"
          ? { query: { [carrier.name]: value } }
          : { headers: { [carrier.name]: carried } };
      }
      case "oauth2_authorization_code":
        return this.resolveAuthorizationCode(profileName, prefix, auth);
      default:
        // All OAuth2 / JWT / bearer variants use a resolved bearer token here;
        // token acquisition/refresh is the resolver's responsibility upstream.
        return token ? { headers: { Authorization: `Bearer ${token}` } } : null;
    }
  }

  /**
   * Client-certificate material for `mtls`, read by the exact NAMES `auth.tls`
   * declares. Each name's env value is either the PEM text itself, or — when it
   * starts with `/` or `./` and the file exists — a path read as PEM. Nothing
   * here is ever logged; a missing or unreadable reference fails closed (null),
   * same as every other resolver branch.
   */
  private resolveTlsMaterial(tls: TlsClientMaterialRefs): TlsClientMaterial | null {
    const cert = this.readPemRef(tls.clientCertRef);
    const key = this.readPemRef(tls.clientKeyRef);
    if (!cert || !key) return null;
    if (!tls.caRef) return { cert, key };
    const ca = this.readPemRef(tls.caRef);
    return ca ? { cert, key, ca } : null;
  }

  private readPemRef(envName: string): string | undefined {
    const value = this.env[envName];
    if (!value) return undefined;
    if ((value.startsWith("/") || value.startsWith("./")) && existsSync(value)) {
      try {
        return readFileSync(value, "utf8");
      } catch {
        return undefined;
      }
    }
    return value;
  }

  /**
   * `oauth2_authorization_code`: replay a pre-issued `${prefix}_TOKEN` when
   * present (a caller-managed access token); otherwise refresh with
   * `${prefix}_REFRESH_TOKEN` (env, or the file `anvil auth login` wrote) plus
   * `${prefix}_CLIENT_ID` (+ optional `${prefix}_CLIENT_SECRET`) against
   * `provider.tokenEndpoint` (RFC 6749 §6). The interactive authorization step
   * that produced the refresh token never runs here — see the CLI broker
   * (`anvil auth login`). Acquired access tokens are cached in memory only,
   * until expiry.
   */
  private async resolveAuthorizationCode(
    profileName: string,
    prefix: string,
    auth: AuthRequirement,
  ): Promise<AuthMaterial | null> {
    const staticToken = this.env[`${prefix}_TOKEN`];
    if (staticToken) return { headers: { Authorization: `Bearer ${staticToken}` } };

    const cached = this.authCodeCache.get(profileName);
    if (cached && cached.expEpochMs > this.now()) {
      return { headers: { Authorization: `Bearer ${cached.token}` } };
    }

    const refreshToken =
      this.env[`${prefix}_REFRESH_TOKEN`] ?? this.fileRefreshTokens.read(profileName);
    const clientId = this.env[`${prefix}_CLIENT_ID`];
    const tokenEndpoint = this.env[`${prefix}_TOKEN_ENDPOINT`] ?? auth.provider?.tokenEndpoint;
    if (!refreshToken || !clientId || !tokenEndpoint) return null;

    const clientSecret = this.env[`${prefix}_CLIENT_SECRET`];
    const method = auth.provider?.clientAuth ?? "client_secret_basic";
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken });
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
    if (clientSecret && method === "client_secret_basic") {
      headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
    } else {
      body.set("client_id", clientId);
      if (clientSecret) body.set("client_secret", clientSecret);
    }

    try {
      const res = await this.fetchImpl(tokenEndpoint, {
        method: "POST",
        headers,
        body: body.toString(),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
      if (typeof json.access_token !== "string") return null;
      const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 3600;
      this.authCodeCache.set(profileName, {
        token: json.access_token,
        expEpochMs: this.now() + Math.max(expiresIn * 1000 - 60_000, 0),
      });
      return { headers: { Authorization: `Bearer ${json.access_token}` } };
    } catch {
      return null;
    }
  }
}

/**
 * The interactive `anvil auth login` broker writes `{ refresh_token,
 * obtained_at }` to `~/.anvil/credentials/<profile>.json` (mode 0600) after
 * completing the PKCE authorization-code exchange once. This resolver-side
 * seam reads it back as a fallback ONLY when `${prefix}_REFRESH_TOKEN` is
 * unset — a local-operator convenience, not a requirement: a deployed runtime
 * with no such directory (or no HOME) simply finds nothing here and falls
 * through to `auth_required`, exactly like a missing env var. Never throws;
 * never logs the value it reads.
 */
export class FileRefreshTokenSource {
  private readonly dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? join(homedir(), ".anvil", "credentials");
  }

  /** The refresh token stored for `profileName`, or undefined. */
  read(profileName: string): string | undefined {
    try {
      const path = join(this.dir, `${profileName}.json`);
      if (!existsSync(path)) return undefined;
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { refresh_token?: unknown };
      return typeof parsed.refresh_token === "string" ? parsed.refresh_token : undefined;
    } catch {
      return undefined;
    }
  }
}

/** ANVIL_<PROFILE> env prefix for a profile name (shared by resolve/expectedCredentials). */
export function envPrefix(profileName: string): string {
  return `ANVIL_${profileName.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

/**
 * Select the concrete credential namespace for one operation. The deployment
 * profile remains the outer boundary (`prod`, `staging`, ...); a source security
 * scheme adds a stable suffix so two upstream identities cannot alias the same
 * secret variables.
 */
export function credentialProfileName(deploymentProfile: string, auth: AuthRequirement): string {
  return auth.credentialProfile
    ? `${deploymentProfile}_${auth.credentialProfile}`
    : deploymentProfile;
}

/** One auth shape's exact, secret-free runtime credential contract. */
export interface AuthCredentialRequirement {
  /** Human-readable auth/grant description. */
  auth: string;
  /** Runtime resolver selected for this shape. */
  resolver: "env" | "delegated" | "workload_identity" | "unsupported";
  /** Every variable that must be present. */
  required: string[];
  /** Alternative complete groups; at least one group must be present. */
  requiredOneOf?: string[][];
  /** Variables that refine a valid configuration when present. */
  optional: string[];
  note?: string;
}

/**
 * The canonical env-name contract shared by runtime errors, generated setup
 * guidance, deployment artifacts, and `anvil deploy credentials`. Keeping this
 * beside the resolver conventions prevents those surfaces from teaching a
 * static bearer token when the runtime actually performs an OAuth grant.
 */
export function credentialRequirement(
  profileName: string,
  auth: AuthRequirement,
): AuthCredentialRequirement {
  const p = envPrefix(profileName);
  const importedEndpoint = Boolean(auth.provider?.tokenEndpoint);
  const endpointRequired = importedEndpoint ? [] : [`${p}_TOKEN_ENDPOINT`];
  const endpointAlternatives = importedEndpoint
    ? [["ANVIL_CREDENTIAL_HOSTS"], [`${p}_TOKEN_ENDPOINT`]]
    : undefined;
  const endpointOptional = importedEndpoint
    ? ["ANVIL_CREDENTIAL_HOSTS", `${p}_TOKEN_ENDPOINT`]
    : [];

  if (auth.type === "workload_identity") {
    return {
      auth: "workload_identity",
      resolver: "workload_identity",
      required: [],
      optional: [`${p}_AUDIENCE`],
      note: "Mints a GCP ID token (for the audience) or access token from the metadata server — no client secret. The runtime service account is the identity.",
    };
  }

  if (auth.type === "oauth2_on_behalf_of") {
    const method = auth.provider?.clientAuth ?? "client_secret_basic";
    const clientCredential =
      method === "private_key_jwt" ? `${p}_CLIENT_ASSERTION_KEY` : `${p}_CLIENT_SECRET`;
    const actorRequired = auth.delegation?.actor ? [`${p}_ACTOR_TOKEN`] : [];
    return {
      auth:
        `${auth.type} (on-behalf-of, principal=${auth.principal ?? "delegated"}, ` +
        `client_auth=${method}, token_endpoint=${auth.provider?.tokenEndpoint ?? `${p}_TOKEN_ENDPOINT`})`,
      resolver: "delegated",
      required: [...endpointRequired, `${p}_CLIENT_ID`, clientCredential, ...actorRequired],
      ...(endpointAlternatives ? { requiredOneOf: endpointAlternatives } : {}),
      optional: [...endpointOptional, `${p}_AUDIENCE`, `${p}_RESOURCE`, `${p}_SCOPES`],
      note: "RFC 8693 token exchange. Needs a validated inbound caller token. For an imported token endpoint, admit its exact host with ANVIL_CREDENTIAL_HOSTS or override *_TOKEN_ENDPOINT.",
    };
  }

  if (auth.type === "jwt_bearer" && auth.provider?.grant === "jwt_bearer") {
    return {
      auth: `jwt_bearer (RFC 7523 assertion, token_endpoint=${auth.provider?.tokenEndpoint ?? `${p}_TOKEN_ENDPOINT`})`,
      resolver: "delegated",
      required: [...endpointRequired, `${p}_CLIENT_ID`, `${p}_CLIENT_ASSERTION_KEY`],
      ...(endpointAlternatives ? { requiredOneOf: endpointAlternatives } : {}),
      optional: [...endpointOptional, `${p}_AUDIENCE`, `${p}_SCOPES`],
      note: "The runtime signs a JWT assertion with *_CLIENT_ASSERTION_KEY. For an imported token endpoint, admit its exact host with ANVIL_CREDENTIAL_HOSTS or override *_TOKEN_ENDPOINT.",
    };
  }

  if (auth.type === "oauth2_client_credentials") {
    const method = auth.provider?.clientAuth ?? "client_secret_basic";
    const clientCredential =
      method === "private_key_jwt" ? `${p}_CLIENT_ASSERTION_KEY` : `${p}_CLIENT_SECRET`;
    return {
      auth: `oauth2_client_credentials (${method}, token_endpoint=${auth.provider?.tokenEndpoint ?? `${p}_TOKEN_ENDPOINT`})`,
      resolver: "delegated",
      required: [...endpointRequired, `${p}_CLIENT_ID`, clientCredential],
      ...(endpointAlternatives ? { requiredOneOf: endpointAlternatives } : {}),
      optional: [...endpointOptional, `${p}_AUDIENCE`, `${p}_SCOPES`],
      note: "RFC 6749 client credentials. For an imported token endpoint, admit its exact host with ANVIL_CREDENTIAL_HOSTS or override *_TOKEN_ENDPOINT.",
    };
  }

  if (auth.type === "api_key") {
    return {
      auth: "api_key",
      resolver: "env",
      required: [`${p}_API_KEY`],
      optional: [`${p}_API_KEY_HEADER`, `${p}_API_KEY_QUERY`],
      note: "Carrier comes from AIR or *_API_KEY_HEADER / *_API_KEY_QUERY and otherwise defaults to X-API-Key.",
    };
  }

  if (auth.type === "basic") {
    return {
      auth: "basic",
      resolver: "env",
      required: [`${p}_USERNAME`, `${p}_PASSWORD`],
      optional: [],
    };
  }

  if (auth.type === "none") {
    return { auth: "none", resolver: "env", required: [], optional: [] };
  }

  if (auth.type === "mtls") {
    if (!auth.tls) {
      return {
        auth: "mtls (incomplete)",
        resolver: "unsupported",
        required: [],
        optional: [],
        note: "mtls must name its client certificate and key references (auth.tls) before the runtime can execute it. Runtime and certification fail closed.",
      };
    }
    return {
      auth: "mtls (client certificate)",
      resolver: "env",
      required: [
        auth.tls.clientCertRef,
        auth.tls.clientKeyRef,
        ...(auth.tls.caRef ? [auth.tls.caRef] : []),
      ],
      optional: [],
      note: "Each name is an env var holding PEM text, or a path (starting with / or ./) to a PEM file that exists. The runtime presents the client certificate over a node:https connection (the global fetch cannot).",
    };
  }

  if (auth.type === "custom_header") {
    const carrier = effectiveAuthCarrier(auth);
    if (!carrier) {
      return {
        auth: "custom_header (incomplete)",
        resolver: "unsupported",
        required: [],
        optional: [],
        note: "custom_header must declare a credential carrier (auth.carrier) before the runtime can execute it. Runtime and certification fail closed.",
      };
    }
    return {
      auth: `custom_header (${carrier.in} '${carrier.name}')`,
      resolver: "env",
      required: [`${p}_HEADER_VALUE`],
      optional: [],
      note:
        `Sent verbatim under the ${carrier.in} '${carrier.name}'` +
        (carrier.scheme ? ` with the '${carrier.scheme}' scheme prefix` : "") +
        ", never collapsed to a bearer token.",
    };
  }

  if (auth.type === "oauth2_authorization_code") {
    return {
      auth: `oauth2_authorization_code (PKCE, token_endpoint=${auth.provider?.tokenEndpoint ?? `${p}_TOKEN_ENDPOINT`})`,
      resolver: "env",
      required: [],
      requiredOneOf: [[`${p}_TOKEN`], [`${p}_REFRESH_TOKEN`, `${p}_CLIENT_ID`]],
      optional: [`${p}_CLIENT_SECRET`],
      note:
        `Run \`anvil auth login <bundle> --profile <profile>\` once to complete the interactive ` +
        `PKCE step; it stores a refresh token at ~/.anvil/credentials/<profile>.json (mode 0600), ` +
        `which the runtime reads when ${p}_REFRESH_TOKEN is unset. End-user authority means this ` +
        "stays review_required regardless of material completeness.",
    };
  }

  return {
    auth: `${auth.type} (static bearer)`,
    resolver: "env",
    required: [`${p}_TOKEN`],
    optional: [],
    note: "A pre-issued bearer token read from the selected credential backend.",
  };
}

/**
 * Place an API key on the wire under the correct carrier. Real gateways vary
 * (Apigee/Kong `apikey` often as a QUERY param, Azure `Ocp-Apim-Subscription-Key`,
 * AWS `x-api-key`, …), so the carrier is configurable: `auth.provider.apiKey`
 * from AIR, or per-profile env overrides `ANVIL_<PFX>_API_KEY_HEADER` /
 * `_API_KEY_QUERY`. Default stays `X-API-Key` header so existing kits are
 * byte-identical.
 */
export function apiKeyMaterial(
  key: string,
  auth: AuthRequirement,
  prefix: string,
  env: NodeJS.ProcessEnv,
): AuthMaterial {
  const headerName = env[`${prefix}_API_KEY_HEADER`];
  const queryName = env[`${prefix}_API_KEY_QUERY`];
  if (queryName) return { query: { [queryName]: key } };
  if (headerName) return { headers: { [headerName]: key } };
  const carrier = effectiveAuthCarrier(auth);
  if (carrier?.in === "query") return { query: { [carrier.name]: key } };
  if (carrier?.in === "header") return { headers: { [carrier.name]: key } };
  return { headers: { "X-API-Key": key } };
}

/** Apply resolved material to a request. Never logs the material. */
export function applyAuth(req: HttpRequest, material: AuthMaterial): HttpRequest {
  const headers = { ...req.headers, ...(material.headers ?? {}) };
  let url = req.url;
  if (material.query && Object.keys(material.query).length > 0) {
    const u = new URL(url);
    for (const [k, v] of Object.entries(material.query)) u.searchParams.set(k, v);
    url = u.toString();
  }
  return { ...req, headers, url, ...(material.tls ? { tls: material.tls } : {}) };
}
