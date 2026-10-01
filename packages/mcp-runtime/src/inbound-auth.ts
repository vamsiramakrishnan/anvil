/**
 * Inbound authentication for the served MCP endpoint — the piece a Gemini
 * Enterprise (or any platform) connector MUST have: the MCP server is an OAuth 2
 * *resource server*, and it validates the bearer token the platform presents on
 * every `/mcp` call rather than trusting the network. Gemini Enterprise is the
 * OAuth client; this is the other half of that handshake, which the platform
 * cannot do for us ("the MCP server must self-enforce it").
 *
 * Two credential shapes are supported, both RS256 JWTs validated against a JWKS:
 *   - `google_service_account` — a Google-issued access/ID token (machine
 *     identity); issuer `accounts.google.com`, keys from Google's certs.
 *   - `oidc` — a user-delegated token from your IdP (Google, Okta, Entra, …);
 *     issuer + JWKS come from the IdP's OpenID configuration.
 *
 * Dependency-free on purpose: the thin serving path stays deployable on its own,
 * so verification uses `node:crypto` (JWK → public key → RS256 verify), never a
 * JWT library. The JWKS fetch is injectable so the whole thing is unit-testable
 * offline, and keys are cached by URI.
 */
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { fetchPublicJson, type Principal, parseGrants } from "@anvil/runtime";

/**
 * `branchyard` (ADR-0029): a per-turn EdDSA (Ed25519) token minted by
 * Branchyard's access broker, verified against a JWKS given as an `https:` or
 * `file:` URL, carrying the caller's grant (`by_grants`). Only the fleet
 * gateway (`anvil serve mcp --fleet --http`) serves it, because only the
 * fleet enforces the grant; every other entrypoint refuses to boot with it.
 */
export type InboundAuthMode = "none" | "oidc" | "google_service_account" | "branchyard";

export interface InboundAuthConfig {
  mode: InboundAuthMode;
  /** Expected token issuer (`iss`). */
  issuer?: string;
  /** Expected audience (`aud`) — the connector's public URL / resource id. */
  audience?: string;
  /** Public HTTPS MCP resource URL used for OAuth protected-resource discovery. */
  resource?: string;
  /** JWKS endpoint. When absent, derived from the issuer's OIDC discovery. */
  jwksUri?: string;
  /** Scopes the token must ALL carry (from the `scope` / `scp` claim). */
  requiredScopes?: string[];
  /** Clock-skew leeway in seconds for `exp`/`nbf`. */
  leewaySeconds?: number;
}

export interface InboundClaims {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  scope?: string;
  scp?: string | string[];
  email?: string;
  [claim: string]: unknown;
}

export type InboundAuthResult =
  | { ok: true; claims: InboundClaims }
  | { ok: false; status: 401 | 403; error: string; description: string; wwwAuthenticate: string };

export interface Jwk {
  kid?: string;
  kty?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
}

/** Fetches a JWKS document. Injectable so verification is testable offline. */
export type JwksFetcher = (uri: string) => Promise<{ keys: Jwk[] }>;

const GOOGLE_ISSUER = "https://accounts.google.com";
const GOOGLE_JWKS = "https://www.googleapis.com/oauth2/v3/certs";

/**
 * Read the inbound-auth contract from the environment (secrets never live
 * here). `branchyard` is accepted only when the caller says it enforces the
 * grant (`allowBranchyard`): a server that verified the token but ignored
 * its grant would admit every caller to every tool.
 */
export function loadInboundAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
  opts: { allowBranchyard?: boolean } = {},
): InboundAuthConfig {
  const mode = normalizeMode(env.ANVIL_INBOUND_AUTH_MODE);
  if (mode === "branchyard" && !opts.allowBranchyard) {
    throw new Error(
      "ANVIL_INBOUND_AUTH_MODE=branchyard is served only by the fleet gateway (`anvil serve mcp <workspace> --fleet --http <port>`), which enforces the token's grant; this entrypoint does not.",
    );
  }
  const leeway = parseLeeway(env.ANVIL_INBOUND_LEEWAY_SECONDS);
  if (mode === "google_service_account") {
    // Google-issued tokens: fixed issuer + certs unless explicitly overridden.
    const config: InboundAuthConfig = {
      mode,
      issuer: env.ANVIL_INBOUND_ISSUER ?? GOOGLE_ISSUER,
      audience: env.ANVIL_INBOUND_AUDIENCE,
      resource: env.ANVIL_INBOUND_RESOURCE,
      jwksUri: env.ANVIL_INBOUND_JWKS_URI ?? GOOGLE_JWKS,
      requiredScopes: splitScopes(env.ANVIL_INBOUND_REQUIRED_SCOPES),
      leewaySeconds: leeway,
    };
    validateEnabledConfig(config);
    return config;
  }
  const config: InboundAuthConfig = {
    mode,
    issuer: env.ANVIL_INBOUND_ISSUER,
    audience: env.ANVIL_INBOUND_AUDIENCE,
    resource: env.ANVIL_INBOUND_RESOURCE,
    jwksUri: env.ANVIL_INBOUND_JWKS_URI,
    requiredScopes: splitScopes(env.ANVIL_INBOUND_REQUIRED_SCOPES),
    leewaySeconds: leeway,
  };
  validateEnabledConfig(config);
  return config;
}

function normalizeMode(raw: string | undefined): InboundAuthMode {
  if (raw === undefined || raw.trim() === "" || raw === "none") return "none";
  if (raw === "oidc" || raw === "google_service_account" || raw === "branchyard") return raw;
  throw new Error(
    `Invalid ANVIL_INBOUND_AUTH_MODE=${JSON.stringify(raw)}; expected none, oidc, google_service_account, or branchyard.`,
  );
}

function splitScopes(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const scopes = raw.split(/[\s,]+/).filter(Boolean);
  return scopes.length > 0 ? scopes : undefined;
}

function parseLeeway(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 300) {
    throw new Error("ANVIL_INBOUND_LEEWAY_SECONDS must be an integer from 0 to 300.");
  }
  return value;
}

const JWKS_CACHE_TTL_MS = 5 * 60_000;
const jwksCache = new Map<string, { keys: Jwk[]; expiresAt: number }>();

const JWKS_MAX_BYTES = 256 * 1024;

const defaultFetchJwks: JwksFetcher = async (uri) => {
  if (uri.startsWith("file:")) {
    // A local yard's `.branchyard/gateway/jwks.json`: read afresh each time
    // (see getKeys), so a key Branchyard rotates is seen immediately.
    const text = await readFile(fileURLToPath(uri), "utf8");
    if (Buffer.byteLength(text) > JWKS_MAX_BYTES) throw new Error("JWKS file is too large");
    const json: unknown = JSON.parse(text);
    if (typeof json !== "object" || json === null) throw new Error("JWKS file is not an object");
    return json as { keys: Jwk[] };
  }
  const { response, json } = await fetchPublicJson(uri, {}, { maxBytes: JWKS_MAX_BYTES });
  if (!response.ok) throw new Error(`JWKS fetch failed (${response.status})`);
  if (typeof json !== "object" || json === null) throw new Error("JWKS response is not an object");
  return json as { keys: Jwk[] };
};

/** Resolve the JWKS URI, discovering it from the issuer's OIDC config if needed. */
async function resolveJwksUri(config: InboundAuthConfig, fetchJwks: JwksFetcher): Promise<string> {
  if (config.jwksUri) return config.jwksUri;
  if (!config.issuer) throw new Error("inbound auth: neither jwksUri nor issuer configured");
  const discoveryUrl = `${config.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
  // Discovery is fetched through the same injectable path (it returns JSON too),
  // then the real JWKS is fetched from the advertised `jwks_uri`.
  const doc = (await fetchJwks(discoveryUrl)) as unknown as { jwks_uri?: string };
  if (!doc.jwks_uri) throw new Error(`inbound auth: no jwks_uri in ${discoveryUrl}`);
  return doc.jwks_uri;
}

async function getKeys(uri: string, fetchJwks: JwksFetcher, refresh = false): Promise<Jwk[]> {
  const cached = uri.startsWith("file:") ? undefined : jwksCache.get(uri);
  if (!refresh && cached && Date.now() < cached.expiresAt) return cached.keys;
  const doc = await fetchJwks(uri);
  if (!doc || !Array.isArray(doc.keys)) throw new Error("JWKS response has no keys array");
  jwksCache.set(uri, { keys: doc.keys, expiresAt: Date.now() + JWKS_CACHE_TTL_MS });
  return doc.keys;
}

function b64urlToString(part: string): string {
  return Buffer.from(part, "base64url").toString("utf8");
}

/**
 * Validate the inbound `Authorization` header. `mode: "none"` passes everything
 * (local/dev). Otherwise the bearer JWT must have a JWKS-verifiable RS256
 * signature and satisfy issuer / audience / expiry / required-scope checks.
 * Never throws for an untrusted token — a bad token is a structured 401/403.
 */
export async function verifyInboundToken(
  authorizationHeader: string | undefined,
  config: InboundAuthConfig,
  opts: { now?: number; fetchJwks?: JwksFetcher } = {},
): Promise<InboundAuthResult> {
  if (config.mode === "none") return { ok: true, claims: {} };
  if (
    config.mode !== "oidc" &&
    config.mode !== "google_service_account" &&
    config.mode !== "branchyard"
  ) {
    return deny(401, "invalid_token", "Inbound authentication mode is invalid.", config);
  }
  try {
    validateEnabledConfig(config);
  } catch {
    return deny(401, "invalid_token", "Inbound authentication is not fully configured.", config);
  }
  const fetchJwks = opts.fetchJwks ?? defaultFetchJwks;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const leeway = config.leewaySeconds ?? 60;

  const token = bearerToken(authorizationHeader);
  if (!token) return deny(401, "invalid_request", "No bearer token was presented.", config);

  const parts = token.split(".");
  if (parts.length !== 3) return deny(401, "invalid_token", "Malformed JWT.", config);
  const [rawHeader, rawPayload, rawSig] = parts as [string, string, string];

  let header: { alg?: string; kid?: string };
  let claims: InboundClaims;
  try {
    const parsedHeader: unknown = JSON.parse(b64urlToString(rawHeader));
    const parsedClaims: unknown = JSON.parse(b64urlToString(rawPayload));
    if (!isPlainRecord(parsedHeader) || !isPlainRecord(parsedClaims)) {
      return deny(401, "invalid_token", "JWT header/payload must be JSON objects.", config);
    }
    if (
      (parsedHeader.alg !== undefined && typeof parsedHeader.alg !== "string") ||
      (parsedHeader.kid !== undefined && typeof parsedHeader.kid !== "string") ||
      !validClaimsShape(parsedClaims)
    ) {
      return deny(401, "invalid_token", "JWT header/payload claim types are invalid.", config);
    }
    header = parsedHeader;
    claims = parsedClaims;
  } catch {
    return deny(401, "invalid_token", "JWT header/payload is not valid JSON.", config);
  }
  // Branchyard signs with Ed25519 and nothing else; the IdP modes keep
  // RS256/ES256. Each mode accepts only its own algorithms, so a key of one
  // kind can never be replayed under another.
  const branchyard = config.mode === "branchyard";
  if (branchyard ? header.alg !== "EdDSA" : header.alg !== "RS256" && header.alg !== "ES256") {
    return deny(
      401,
      "invalid_token",
      `Unsupported JWT alg "${header.alg}" (expected ${branchyard ? "EdDSA" : "RS256 or ES256"}).`,
      config,
    );
  }

  // Signature: JWK → public key → verify over "header.payload". RS256 is
  // RSA-SHA256; ES256 is ECDSA-P256 whose JWT signature is raw r||s (IEEE
  // P1363), NOT DER — so it needs `dsaEncoding: "ieee-p1363"`.
  let verified = false;
  try {
    const uri = await resolveJwksUri(config, fetchJwks);
    let keys = await getKeys(uri, fetchJwks);
    let jwk = header.kid
      ? keys.find((key) => key.kid === header.kid)
      : keys.length === 1
        ? keys[0]
        : undefined;
    // Key rotation: a new kid must trigger one immediate refresh rather than
    // failing for the full cache TTL.
    if (!jwk) {
      keys = await getKeys(uri, fetchJwks, true);
      jwk = header.kid
        ? keys.find((key) => key.kid === header.kid)
        : keys.length === 1
          ? keys[0]
          : undefined;
    }
    if (!jwk) return deny(401, "invalid_token", "No JWKS key matches the token `kid`.", config);
    if (jwk.alg && jwk.alg !== header.alg) {
      return deny(401, "invalid_token", "JWKS key algorithm does not match the token.", config);
    }
    if (branchyard && (jwk.kty !== "OKP" || jwk.crv !== "Ed25519")) {
      return deny(401, "invalid_token", "JWKS key is not an Ed25519 key.", config);
    }
    // Node accepts a JWK directly via `format: "jwk"`; the cast avoids naming the
    // DOM-only `JsonWebKey` type in this node-only package.
    const key = createPublicKey({ key: jwk, format: "jwk" } as unknown as Parameters<
      typeof createPublicKey
    >[0]);
    const data = Buffer.from(`${rawHeader}.${rawPayload}`);
    const sig = Buffer.from(rawSig, "base64url");
    verified =
      header.alg === "EdDSA"
        ? cryptoVerify(null, data, key, sig)
        : header.alg === "RS256"
          ? cryptoVerify("RSA-SHA256", data, key, sig)
          : cryptoVerify("sha256", data, { key, dsaEncoding: "ieee-p1363" }, sig);
  } catch {
    // A JWKS fetch/parse failure is a server-side inability to verify — fail
    // closed as an invalid token rather than admitting an unverified caller.
    return deny(401, "invalid_token", "Token signature could not be verified.", config);
  }
  if (!verified) return deny(401, "invalid_token", "Token signature is invalid.", config);

  // Claims.
  if (config.issuer && claims.iss !== config.issuer) {
    return deny(401, "invalid_token", "Token issuer does not match.", config);
  }
  if (config.audience && !audienceMatches(claims.aud, config.audience)) {
    return deny(401, "invalid_token", "Token audience does not match this connector.", config);
  }
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) {
    return deny(401, "invalid_token", "Token has no valid expiration.", config);
  }
  if (now >= claims.exp + leeway) {
    return deny(401, "invalid_token", "Token has expired.", config);
  }
  if (typeof claims.nbf === "number" && now < claims.nbf - leeway) {
    return deny(401, "invalid_token", "Token is not yet valid.", config);
  }
  if (branchyard) {
    const problem = branchyardClaimsProblem(claims, now, leeway);
    if (problem) return deny(401, "invalid_token", problem, config);
  }
  const missing = missingScopes(claims, config.requiredScopes);
  if (missing.length > 0) {
    return deny(
      403,
      "insufficient_scope",
      `Missing required scope(s): ${missing.join(" ")}.`,
      config,
    );
  }

  return { ok: true, claims };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function validClaimsShape(claims: Record<string, unknown>): claims is InboundClaims {
  const optionalStrings = ["iss", "sub", "scope", "email"] as const;
  if (optionalStrings.some((key) => claims[key] !== undefined && typeof claims[key] !== "string")) {
    return false;
  }
  for (const key of ["exp", "nbf"] as const) {
    if (
      claims[key] !== undefined &&
      (typeof claims[key] !== "number" || !Number.isFinite(claims[key]))
    ) {
      return false;
    }
  }
  const validStringArray = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((item) => typeof item === "string");
  if (claims.aud !== undefined && typeof claims.aud !== "string" && !validStringArray(claims.aud)) {
    return false;
  }
  if (claims.scp !== undefined && typeof claims.scp !== "string" && !validStringArray(claims.scp)) {
    return false;
  }
  return true;
}

function validateEnabledConfig(config: InboundAuthConfig): void {
  if (config.mode === "none") return;
  if (config.mode === "branchyard") {
    validateBranchyardConfig(config);
    return;
  }
  if (!config.issuer) throw new Error("inbound auth requires an issuer");
  if (!config.audience) throw new Error("inbound auth requires an audience");
  const resource =
    config.resource ?? (config.audience.startsWith("https://") ? config.audience : undefined);
  if (!resource) {
    throw new Error(
      "inbound auth requires ANVIL_INBOUND_RESOURCE when the JWT audience is not an HTTPS URL",
    );
  }
  for (const [label, raw] of [
    ["issuer", config.issuer],
    ["JWKS URI", config.jwksUri],
    ["resource", resource],
  ] as const) {
    if (!raw) continue;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error(`inbound auth ${label} is invalid`);
    }
    if (url.protocol !== "https:" || url.username || url.password || url.hash) {
      throw new Error(`inbound auth ${label} must be an HTTPS URL without userinfo or fragment`);
    }
  }
}

function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer[ ]+(.+)$/i.exec(header.trim());
  return match ? (match[1] as string).trim() : undefined;
}

function audienceMatches(aud: string | string[] | undefined, expected: string): boolean {
  if (aud === undefined) return false;
  return Array.isArray(aud) ? aud.includes(expected) : aud === expected;
}

function tokenScopes(claims: InboundClaims): Set<string> {
  const out = new Set<string>();
  if (typeof claims.scope === "string")
    for (const s of claims.scope.split(/\s+/)) if (s) out.add(s);
  if (Array.isArray(claims.scp)) for (const s of claims.scp) out.add(s);
  else if (typeof claims.scp === "string")
    for (const s of claims.scp.split(/\s+/)) if (s) out.add(s);
  return out;
}

function missingScopes(claims: InboundClaims, required: string[] | undefined): string[] {
  if (!required || required.length === 0) return [];
  const have = tokenScopes(claims);
  return required.filter((s) => !have.has(s));
}

function deny(
  status: 401 | 403,
  error: string,
  description: string,
  config: InboundAuthConfig,
): InboundAuthResult {
  return {
    ok: false,
    status,
    error,
    description,
    wwwAuthenticate: challenge(config, error, description),
  };
}

/**
 * The `WWW-Authenticate` challenge. Advertises the protected-resource metadata
 * URL (the MCP Authorization spec's discovery document) so a compliant client
 * can find the authorization server, alongside the standard error fields.
 */
function challenge(config: InboundAuthConfig, error: string, description: string): string {
  const parts = ['Bearer realm="mcp"'];
  const resource = config.resource ?? config.audience;
  if (resource?.startsWith("https://")) {
    const metadata = new URL("/.well-known/oauth-protected-resource", resource).toString();
    parts.push(`resource_metadata="${metadata}"`);
  }
  parts.push(`error="${error}"`, `error_description="${description.replace(/"/g, "'")}"`);
  return parts.join(", ");
}

/**
 * The MCP Authorization spec's protected-resource metadata document
 * (`/.well-known/oauth-protected-resource`). Lets a client discover which
 * authorization server issues tokens for this connector. Returns `null` when
 * auth is disabled or the resource identity is unknown.
 */
export function protectedResourceMetadata(
  config: InboundAuthConfig,
): { resource: string; authorization_servers: string[]; scopes_supported?: string[] } | null {
  if (config.mode === "none" || !config.audience) return null;
  const resource = config.resource ?? config.audience;
  return {
    resource,
    authorization_servers: config.issuer ? [config.issuer] : [],
    ...(config.requiredScopes ? { scopes_supported: config.requiredScopes } : {}),
  };
}

/** Stable session identity from already-verified claims; token rotation preserves it. */
export function verifiedPrincipalFingerprint(claims: unknown): string | undefined {
  if (!claims || typeof claims !== "object" || Array.isArray(claims)) return undefined;
  const record = claims as Record<string, unknown>;
  const issuer = typeof record.iss === "string" ? record.iss : undefined;
  // sub is the standard principal. oid covers app-only Entra tokens, while
  // azp / client_id identify a verified machine caller when no subject claim
  // is issued. The verifier has already checked signature, issuer and audience.
  const textClaim = (value: unknown) =>
    typeof value === "string" && value.length > 0 ? value : undefined;
  const sub = textClaim(record.sub);
  const oid = textClaim(record.oid);
  const authorizedParty = textClaim(record.azp) ?? textClaim(record.client_id);
  if (!issuer || (!sub && !oid && !authorizedParty)) return undefined;
  const tenant =
    typeof record.tid === "string"
      ? record.tid
      : typeof record.tenant === "string"
        ? record.tenant
        : undefined;
  return createHash("sha256")
    .update(JSON.stringify({ issuer, sub, oid, authorizedParty, tenant }))
    .digest("base64url");
}

/** One hour: Branchyard mints a token per turn that expires with it, and never later than this. */
const BRANCHYARD_MAX_LIFETIME_SECONDS = 3600;

/** Ten minutes: a connect token lives only as long as one connect flow takes to start. */
const BRANCHYARD_CONNECT_MAX_LIFETIME_SECONDS = 600;

/**
 * The `by_purpose` value of the person-only token Branchyard mints for
 * `by connect` (and nothing else): it names the person and grants nothing.
 */
const BRANCHYARD_CONNECT_PURPOSE = "connect";

/**
 * True when verified branchyard claims are a connect token
 * (`by_purpose: "connect"`). Only a connect token may start a connection,
 * store a key, or read the person's connections at `/connect/*`; a connect
 * token may never list or call tools. A turn token (no `by_purpose`) is the
 * reverse — a harness holds it, so it must never change the person's
 * connections.
 */
export function isBranchyardConnectToken(claims: InboundClaims): boolean {
  return claims.by_purpose === BRANCHYARD_CONNECT_PURPOSE;
}

/**
 * `branchyard` configuration: the yard's issuer (a URL, or
 * `branchyard:local:<yard id>`), the gateway's canonical `/mcp` URL as the
 * audience (HTTPS, or HTTP on a loopback host for a local yard), and the
 * JWKS as an `https:` or `file:` URL.
 */
function validateBranchyardConfig(config: InboundAuthConfig): void {
  if (!config.issuer) throw new Error("branchyard inbound auth requires ANVIL_INBOUND_ISSUER");
  if (!config.audience) throw new Error("branchyard inbound auth requires ANVIL_INBOUND_AUDIENCE");
  if (!config.jwksUri) throw new Error("branchyard inbound auth requires ANVIL_INBOUND_JWKS_URI");
  let audience: URL;
  try {
    audience = new URL(config.audience);
  } catch {
    throw new Error("branchyard inbound auth audience must be the gateway's /mcp URL");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(audience.hostname);
  if (
    !(audience.protocol === "https:" || (audience.protocol === "http:" && loopback)) ||
    audience.username ||
    audience.password ||
    audience.hash
  ) {
    throw new Error(
      "branchyard inbound auth audience must be an HTTPS URL (or HTTP on a loopback host) without userinfo or fragment",
    );
  }
  let jwks: URL;
  try {
    jwks = new URL(config.jwksUri);
  } catch {
    throw new Error("branchyard inbound auth JWKS URI is invalid");
  }
  if ((jwks.protocol !== "https:" && jwks.protocol !== "file:") || jwks.username || jwks.password) {
    throw new Error("branchyard inbound auth JWKS URI must be an https: or file: URL");
  }
}

function optionalText(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && value.length <= 256);
}

/** Why verified branchyard claims are still unacceptable, or undefined when they are fine. */
function branchyardClaimsProblem(
  claims: InboundClaims,
  now: number,
  leeway: number,
): string | undefined {
  if (typeof claims.sub !== "string" || claims.sub.length === 0 || claims.sub.length > 256) {
    return "Token has no subject.";
  }
  if (
    typeof claims.exp === "number" &&
    claims.exp - now > BRANCHYARD_MAX_LIFETIME_SECONDS + leeway
  ) {
    return "Token lifetime exceeds one hour.";
  }
  if (claims.iat !== undefined) {
    if (typeof claims.iat !== "number" || !Number.isFinite(claims.iat))
      return "Token iat is invalid.";
    if (claims.iat > now + leeway) return "Token was issued in the future.";
  }
  if (!optionalText(claims.jti)) return "Token jti is invalid.";
  for (const key of ["by_tenant", "by_branch", "by_turn"] as const) {
    if (!optionalText(claims[key])) return `Token ${key} is invalid.`;
  }
  if (parseGrants(claims.by_grants) === undefined) return "Token grant (by_grants) is malformed.";
  if (claims.by_purpose !== undefined) {
    // Fail closed on a purpose this gateway does not know.
    if (claims.by_purpose !== BRANCHYARD_CONNECT_PURPOSE) return "Token by_purpose is unknown.";
    if (
      typeof claims.exp === "number" &&
      claims.exp - (typeof claims.iat === "number" ? Math.min(claims.iat, now) : now) >
        BRANCHYARD_CONNECT_MAX_LIFETIME_SECONDS + leeway
    ) {
      return "Connect token lifetime exceeds ten minutes.";
    }
  }
  return undefined;
}

/**
 * The principal a verified branchyard token names: `id` is `sub`, the grant
 * is `by_grants`, and `by_tenant`/`by_branch`/`by_turn` ride along for audit.
 * Scopes are every scope: the grant, not a scope list, is what limits this
 * caller, and it is checked per operation before any upstream call. A token
 * with a `by_purpose` (a connect token) names no tool caller: undefined.
 */
export function branchyardPrincipal(claims: InboundClaims): Principal | undefined {
  // A connect token is the person at the connect routes, never a caller of tools.
  if (claims.by_purpose !== undefined) return undefined;
  const grants = parseGrants(claims.by_grants);
  if (typeof claims.sub !== "string" || claims.sub.length === 0 || grants === undefined) {
    return undefined;
  }
  const text = (value: unknown) => (typeof value === "string" ? value : undefined);
  const attribution = {
    ...(text(claims.by_tenant) ? { tenant: text(claims.by_tenant) } : {}),
    ...(text(claims.by_branch) ? { branch: text(claims.by_branch) } : {}),
    ...(text(claims.by_turn) ? { turn: text(claims.by_turn) } : {}),
  };
  return { id: claims.sub, scopes: ["*"], grants, attribution };
}

/**
 * A session key for one branchyard token: its issuer, subject, `jti`, turn,
 * and grant. A new turn's token opens a new session rather than inheriting
 * the previous turn's grant.
 */
export function branchyardSessionFingerprint(claims: InboundClaims): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        iss: claims.iss,
        sub: claims.sub,
        jti: claims.jti,
        turn: claims.by_turn,
        exp: claims.exp,
        grants: claims.by_grants,
      }),
    )
    .digest("base64url");
}
