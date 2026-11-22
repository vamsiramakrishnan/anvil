import { z } from "zod";
import type { IdentityProfile } from "./identity-profile.js";
import { type AirDocument, type AuthRequirement, effectiveAuthCarrier } from "./schema.js";

import { wireProtocolFor } from "./wire.js";

const endpoint = z
  .string()
  .url()
  .max(2048)
  .refine((value) => {
    const url = URL.canParse(value) ? new URL(value) : undefined;
    return url?.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
  }, "Expected a reviewed HTTPS URL without credentials, query or fragment");

const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const scope = z
  .string()
  .regex(/^[\x21\x23-\x5b\x5d-\x7e]+$/)
  .max(256);

/** Customer-controlled OAuth coordinates for one enterprise principal, API and generated bundle. */
export const EnterpriseOAuthBinding = z.strictObject({
  service: z.string().min(1).max(256),
  operations: z.array(z.string().min(1).max(512)).min(1),
  upstreamBaseUrl: endpoint,
  issuer: endpoint,
  resource: endpoint,
  authorizationEndpoint: endpoint,
  tokenEndpoint: endpoint,
  introspectionEndpoint: endpoint,
  revocationEndpoint: endpoint.optional(),
  redirectUri: endpoint,
  scopes: z.array(scope).min(1),
  clientIdEnv: envName,
  clientSecretEnv: envName,
});
export type EnterpriseOAuthBinding = z.infer<typeof EnterpriseOAuthBinding>;

/** Check the same reviewed authority at target generation, bootstrap and credential dispatch. */
export function matchesEnterpriseOAuthAuth(
  binding: EnterpriseOAuthBinding,
  auth: AuthRequirement,
): boolean {
  const carrier = effectiveAuthCarrier(auth);
  const provider = auth.provider;
  return (
    auth.type === "oauth2_authorization_code" &&
    auth.principal === "end_user" &&
    auth.secretSource === "vault" &&
    carrier?.in === "header" &&
    carrier.name.toLowerCase() === "authorization" &&
    carrier.scheme?.toLowerCase() === "bearer" &&
    auth.scopes.every((s) => binding.scopes.includes(s)) &&
    (!auth.issuer || auth.issuer === binding.issuer) &&
    (!auth.audience || auth.audience === binding.resource) &&
    (!provider?.resource || provider.resource === binding.resource) &&
    (!provider?.authorizationEndpoint ||
      provider.authorizationEndpoint === binding.authorizationEndpoint) &&
    (!provider?.tokenEndpoint || provider.tokenEndpoint === binding.tokenEndpoint) &&
    (!provider?.redirectUri || provider.redirectUri === binding.redirectUri) &&
    (!provider?.clientAuth || provider.clientAuth === "client_secret_basic") &&
    provider?.pkce !== false
  );
}

/** Authority, tracing and routing headers belong to the deployment. */
export function reservedEnterpriseOAuthHeader(name: string): boolean {
  return /^(?:authorization|proxy-authorization|cookie|host|traceparent|tracestate|forwarded|x-forwarded-host|x-http-method-override)$/i.test(
    name,
  );
}

export const ENTERPRISE_OAUTH_CONTROL_SCOPE = "anvil.connect";

export function enterpriseOAuthControlAudience(redirectUri: string): string {
  return new URL("/connect", redirectUri).href;
}

export function validateEnterpriseOAuthBinding(
  binding: EnterpriseOAuthBinding,
  air: AirDocument,
  profile: IdentityProfile | undefined,
  baseUrl: string,
): void {
  if (
    !profile ||
    profile.authentication.provider === "google_iap" ||
    profile.authentication.provider === "google_service_account"
  )
    throw new Error("Enterprise OAuth requires a verified employee identity profile");
  if (profile.authentication.issuer !== binding.issuer)
    throw new Error(
      "Enterprise OAuth requires an issuer with the same stable user subject at both resources",
    );
  if (
    binding.resource === profile.authentication.audience ||
    binding.resource === profile.authentication.resource
  )
    throw new Error("Enterprise OAuth requires a distinct downstream resource");
  const callback = new URL(binding.redirectUri);
  const controlAudience = enterpriseOAuthControlAudience(binding.redirectUri);
  if (
    callback.pathname !== "/connect/callback" ||
    [profile.authentication.audience, profile.authentication.resource, binding.resource].includes(
      controlAudience,
    )
  )
    throw new Error(
      "Enterprise OAuth requires /connect/callback and distinct user control and data audiences",
    );
  if (binding.clientIdEnv === binding.clientSecretEnv)
    throw new Error("Enterprise OAuth requires separate client ID and client secret references");
  if (
    binding.scopes.some((s) => !profile.mapping.upstreamScopes.includes(s)) ||
    new Set(binding.scopes).size !== binding.scopes.length
  )
    throw new Error("Enterprise OAuth scopes must be unique and granted by the identity profile");
  if (
    air.business ||
    air.service.id !== binding.service ||
    new URL(baseUrl).href !== new URL(binding.upstreamBaseUrl).href
  )
    throw new Error("Enterprise OAuth requires a matching standalone service and upstream URL");
  const approved = air.operations.filter((op) => op.state === "approved");
  const operations = new Set(binding.operations);
  if (
    approved.length !== operations.size ||
    operations.size !== binding.operations.length ||
    approved.some(
      (op) =>
        !operations.has(op.id) ||
        !matchesEnterpriseOAuthAuth(binding, op.auth) ||
        wireProtocolFor(op.sourceRef) !== "http_json" ||
        !op.sourceRef.method ||
        !op.sourceRef.path?.startsWith("/") ||
        /[?#\\]/.test(op.sourceRef.path) ||
        op.input.params.some(
          (p) => p.in === "cookie" || (p.in === "header" && reservedEnterpriseOAuthHeader(p.name)),
        ),
    )
  )
    throw new Error(
      "Enterprise OAuth requires an exact set of approved operations with matching end-user vault OAuth",
    );
}
