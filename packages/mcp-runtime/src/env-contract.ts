import type { RuntimeEnvVar } from "@anvil/runtime";

/**
 * The variables the serving path itself reads, beyond `@anvil/runtime`'s
 * contract: the listener port, the inbound OAuth resource-server family
 * (`inbound-auth.ts`), and the business-gateway serving inputs
 * (`business-serving.ts`). Declared beside the code that reads them so the
 * generated `deploy/env.schema.json` is derived, not transcribed — see the
 * drift guard in `@anvil/generators`.
 */
export const SERVING_ENV_CONTRACT: readonly RuntimeEnvVar[] = [
  {
    name: "PORT",
    description: "HTTP listener port for runtime/server.js. Cloud Run sets it; defaults to 8080.",
    default: "8080",
    pattern: "^[1-9][0-9]*$",
  },
  {
    name: "ANVIL_INBOUND_AUTH_MODE",
    description:
      'Inbound bearer verification for every tool route: "none" (default; local runs behind other controls), "oidc" (RS256 JWT against ANVIL_INBOUND_JWKS_URI), or "google_service_account" (Google-issued tokens; issuer and certs fixed unless overridden). Business gateways refuse "none" outside dev.',
    enum: ["none", "oidc", "google_service_account"],
  },
  {
    name: "ANVIL_INBOUND_ISSUER",
    description: "Expected `iss` claim of inbound tokens. Required when the mode is oidc.",
  },
  {
    name: "ANVIL_INBOUND_AUDIENCE",
    description: "Expected `aud` claim of inbound tokens. Required when inbound auth is enabled.",
  },
  {
    name: "ANVIL_INBOUND_RESOURCE",
    description:
      "The protected resource identifier advertised at /.well-known/oauth-protected-resource (RFC 9728).",
  },
  {
    name: "ANVIL_INBOUND_JWKS_URI",
    description:
      "Public HTTPS JWKS endpoint used to verify inbound token signatures. Required when the mode is oidc.",
  },
  {
    name: "ANVIL_INBOUND_REQUIRED_SCOPES",
    description: "Space- or comma-separated scopes an inbound token must carry.",
  },
  {
    name: "ANVIL_INBOUND_LEEWAY_SECONDS",
    description: "Clock-skew leeway applied to inbound token time claims.",
    pattern: "^[0-9]+$",
  },
  {
    name: "ANVIL_BUSINESS_SOURCES",
    description:
      "Business gateway only: JSON object of source bindings (base URLs, credential profiles) the private execution plan resolves against.",
  },
  {
    name: "ANVIL_BUSINESS_CONTEXT",
    description:
      "Business gateway, dev only: a JSON BusinessContext used when no verified inbound identity is present.",
  },
  {
    name: "ANVIL_BUSINESS_TENANT",
    description:
      "Business gateway: tenant used when the inbound token carries neither `tid` nor `tenant`.",
  },
  {
    name: "ANVIL_BUSINESS_POLICY_VERSION",
    description: "Business gateway: the policy version stamped on every execution record.",
  },
  {
    name: "ANVIL_BUSINESS_JOURNAL_DIR",
    description:
      "Business gateway: directory for the file-backed execution journal (attempted effects and reconciliation evidence).",
  },
  {
    name: "ANVIL_BUSINESS_APPROVAL_FILE",
    description:
      "Business gateway: path to the reviewed approval record the gateway checks before executing an action.",
  },
];
