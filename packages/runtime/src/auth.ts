import { type AuthRequirement, effectiveAuthCarrier } from "@anvil/air";
import type { InboundIdentity } from "./inbound-identity.js";
import type { HttpRequest } from "./transport.js";

/**
 * Resolved auth material. Secrets live here only transiently and are never
 * written to execution records or logs (spec §13, §18). Agents never see them.
 */
export interface AuthMaterial {
  /** Headers to merge into the outbound request (e.g. Authorization). */
  headers?: Record<string, string>;
  /** Query params to merge (e.g. api_key for query-key APIs). */
  query?: Record<string, string>;
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

/**
 * Default resolver: reads a bearer token / api key from the process
 * environment by convention, e.g. profile `prod` -> ANVIL_PROD_TOKEN. Intended
 * for local dev; production binds Secret Manager behind this same interface.
 */
export class EnvCredentialResolver implements CredentialResolver {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

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
      case "custom_header":
      case "oauth2_authorization_code":
        return [];
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
      case "mtls":
      case "custom_header":
      case "oauth2_authorization_code":
        // These schemes need explicit transport/carrier models that AIR does
        // not yet express. Never collapse them into a bearer token.
        return null;
      default:
        // All OAuth2 / JWT / bearer variants use a resolved bearer token here;
        // token acquisition/refresh is the resolver's responsibility upstream.
        return token ? { headers: { Authorization: `Bearer ${token}` } } : null;
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

  if (
    auth.type === "mtls" ||
    auth.type === "custom_header" ||
    auth.type === "oauth2_authorization_code"
  ) {
    return {
      auth: `${auth.type} (unsupported)`,
      resolver: "unsupported",
      required: [],
      optional: [],
      note: "Anvil does not model the required transport or carrier. Runtime and certification fail closed.",
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
  return { ...req, headers, url };
}
