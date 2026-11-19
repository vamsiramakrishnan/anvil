import {
  type AirDocument,
  EnterpriseOAuthBinding,
  hashCanonical,
  type IdentityProfile,
  matchesEnterpriseOAuthAuth,
  reservedEnterpriseOAuthHeader,
  validateEnterpriseOAuthBinding,
} from "@anvil/air";
import type { CredentialResolver } from "./auth.js";
import { EnterpriseOAuthError, type EnterpriseOAuthFlow } from "./enterprise-oauth-flow.js";
import type { EnterprisePrincipal } from "./identity.js";
import { createTokenIntrospector, InvalidIntrospectionGrant } from "./oauth-introspection.js";
import { CredentialUnavailableError } from "./vault.js";

export { EnterpriseOAuthBinding };

export function loadEnterpriseOAuthBinding(
  env: NodeJS.ProcessEnv,
  air: AirDocument,
  profile: IdentityProfile | undefined,
  baseUrl: string,
): EnterpriseOAuthBinding | undefined {
  const raw = env.ANVIL_ENTERPRISE_OAUTH_JSON;
  if (raw === undefined) return undefined;
  if (Buffer.byteLength(raw) > 1024 * 1024)
    throw new Error("Enterprise OAuth binding exceeds 1 MiB");
  const binding = EnterpriseOAuthBinding.parse(JSON.parse(raw));
  validateEnterpriseOAuthBinding(binding, air, profile, baseUrl);
  return binding;
}

/** Stable storage coordinates also isolate grants after a client or authority change. */
export function enterpriseOAuthNamespace(
  binding: EnterpriseOAuthBinding,
  profile: IdentityProfile,
  clientId: string,
): string {
  const tenant = profile.mapping.tenant;
  return hashCanonical({
    service: binding.service,
    upstream: new URL(binding.upstreamBaseUrl).href,
    issuer: binding.issuer,
    resource: binding.resource,
    scopes: [...binding.scopes].sort(),
    clientId,
    mcpAudience: profile.authentication.audience,
    // Amending an authorization rule or tenant allowlist does not transfer a
    // subject between tenants. Reuse the grant for its original owner.
    tenant: tenant.source === "fixed" ? { fixed: tenant.value } : { claim: tenant.claim },
    redirectUri: binding.redirectUri,
    authorizationEndpoint: binding.authorizationEndpoint,
    tokenEndpoint: binding.tokenEndpoint,
    revocationEndpoint: binding.revocationEndpoint,
    introspectionEndpoint: binding.introspectionEndpoint,
  });
}

export function createEnterpriseTokenVerifier(
  binding: EnterpriseOAuthBinding,
  profile: IdentityProfile,
  env: NodeJS.ProcessEnv,
  fetchImpl?: typeof fetch,
): (accessToken: string, principal: EnterprisePrincipal) => Promise<{ expiresAt: number }> {
  const clientId = env[binding.clientIdEnv];
  const introspect = createTokenIntrospector(
    {
      provider: "oauth2_introspection",
      issuer: binding.issuer,
      audience: binding.resource,
      requiredScopes: binding.scopes,
      introspection: {
        endpoint: binding.introspectionEndpoint,
        clientIdEnv: binding.clientIdEnv,
        clientSecretEnv: binding.clientSecretEnv,
        clientAuth: "client_secret_basic",
        timeoutMs: 3000,
        audienceSource: "response",
      },
    },
    env,
  );
  return async (accessToken, principal) => {
    let claims: Record<string, unknown>;
    try {
      claims = (await introspect(accessToken, fetchImpl)) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof InvalidIntrospectionGrant)
        throw new EnterpriseOAuthError(403, "invalid_user_grant");
      throw new EnterpriseOAuthError(503, "dependency_unavailable");
    }
    // Compare coordinates in the same identity authority. Pairwise or foreign
    // subjects need an authority-backed mapping and cannot be joined by email.
    const expected = principal.identity;
    const mapping = profile.mapping.tenant;
    const tenant = mapping.source === "claim" ? claims[mapping.claim] : mapping.value;
    const scopes =
      typeof claims.scope === "string" ? claims.scope.split(/\s+/).filter(Boolean) : [];
    const audience =
      Array.isArray(claims.aud) && claims.aud.length === 1 ? claims.aud[0] : claims.aud;
    const now = Date.now();
    if (
      expected.issuer !== binding.issuer ||
      expected.expiresAt <= now ||
      claims.sub !== expected.subject ||
      tenant !== expected.tenant ||
      claims.client_id !== clientId ||
      audience !== binding.resource ||
      !binding.scopes.every((s) => scopes.includes(s)) ||
      !scopes.every((s) => binding.scopes.includes(s)) ||
      typeof claims.exp !== "number" ||
      claims.exp * 1000 <= now ||
      (typeof claims.nbf === "number" && claims.nbf * 1000 > now)
    )
      throw new EnterpriseOAuthError(403, "invalid_user_grant");
    return { expiresAt: claims.exp * 1000 };
  };
}

/** AIR HTTP route literals are escaped, while each template variable occupies a path segment. */
function routePattern(path: string): RegExp {
  const pieces = path.split(/(\{[^{}/]+\})/);
  const escaped = pieces.map((piece) =>
    piece.startsWith("{") && piece.endsWith("}")
      ? "[^/]+"
      : piece.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  return new RegExp(`^${escaped.join("")}$`);
}

function matchesRoute(raw: string, origin: string, path: RegExp): boolean {
  if (!URL.canParse(raw)) return false;
  const url = new URL(raw);
  if (url.origin !== origin || url.username || url.password || url.hash) return false;
  // HTTP libraries and gateways may normalize a path at different stages. Refuse
  // ambiguous delimiters, double escaping and traversal before exposing a bearer.
  const beforeQuery = raw.split("?", 1)[0] ?? "";
  if (
    /[\\\p{Cc}]|%(?:25|2f|5c|00)/iu.test(beforeQuery) ||
    /\/(?:\.|%2e){1,2}(?:\/|$)/i.test(beforeQuery)
  )
    return false;
  return path.test(url.pathname);
}

export function enterpriseCredentialResolver(
  binding: EnterpriseOAuthBinding,
  flow: Pick<EnterpriseOAuthFlow, "accessToken">,
  air: AirDocument,
): CredentialResolver {
  const base = new URL(binding.upstreamBaseUrl);
  const prefix = base.pathname.replace(/\/$/, "");
  const allowed = new Set(binding.operations);
  const routes = new Map(
    air.operations
      .filter((op) => op.state === "approved" && allowed.has(op.id))
      .map((op) => [
        op.id,
        {
          method: op.sourceRef.method?.toUpperCase(),
          path: routePattern(prefix + op.sourceRef.path),
        },
      ]),
  );
  return {
    resolveAtUse: true,
    async resolve(_profile, auth, context) {
      const call = context?.enterprise;
      const route = call && routes.get(call.operation);
      if (
        !call ||
        !route ||
        route.method !== call.method ||
        call.headerNames.some(reservedEnterpriseOAuthHeader) ||
        call.service !== binding.service ||
        call.principal.identity.issuer !== binding.issuer ||
        call.principal.identity.expiresAt <= Date.now() ||
        !matchesRoute(call.url, base.origin, route.path) ||
        !matchesEnterpriseOAuthAuth(binding, auth)
      )
        return null;
      try {
        const token = await flow.accessToken(call.principal);
        return {
          headers: {
            Authorization: `Bearer ${token}`,
            ...(call.traceparent ? { traceparent: call.traceparent } : {}),
          },
        };
      } catch (err) {
        if (err instanceof EnterpriseOAuthError && (err.status === 409 || err.status === 403))
          throw new CredentialUnavailableError(
            "Reconnect the employee's downstream OAuth account.",
            {
              code: "connector/needs_reconnect",
              connector: binding.service,
            },
          );
        throw new CredentialUnavailableError(
          "The downstream OAuth credential service is unavailable.",
          {
            code: "connector/vault_unavailable",
            connector: binding.service,
          },
        );
      }
    },
  };
}
