import type { SdkPlan } from "./plan.js";

/**
 * Which token grants a generated client carries — the one decision the four
 * per-language grant emitters (`oauth-grants-<language>.ts`) all read, so no
 * language can emit a helper the contract did not call for or drop one it did.
 *
 * Three grants, one module per language, one shared token-endpoint call:
 *   - refresh (RFC 6749 §6) for `oauth2_authorization_code` — replays or
 *     refreshes a token a human-driven broker already produced;
 *   - client credentials (RFC 6749 §4.4) for `oauth2_client_credentials` —
 *     mints the service's own bearer, the way the runtime does;
 *   - token exchange (RFC 8693) for `oauth2_on_behalf_of` — exchanges the
 *     inbound caller's subject token (and an actor token, when the contract
 *     names an actor) for an upstream token, cached per subject.
 * Each is present only when the contract names a token endpoint; a client
 * cannot mint against an endpoint it does not know, and guessing one would
 * be a credential sent to an unreviewed host.
 */
export interface SdkOauthGrants {
  refresh: boolean;
  clientCredentials: boolean;
  tokenExchange: boolean;
}

export function oauthGrantsOf(plan: SdkPlan): SdkOauthGrants {
  return {
    refresh: plan.auth.tokenRefresh !== undefined,
    clientCredentials: plan.auth.clientCredentials !== undefined,
    tokenExchange: plan.auth.tokenExchange !== undefined,
  };
}

/** Whether the language's OAuth module is emitted at all. */
export function needsOauth(plan: SdkPlan): boolean {
  const grants = oauthGrantsOf(plan);
  return grants.refresh || grants.clientCredentials || grants.tokenExchange;
}

/** The RFC 8693 grant type, spelled once; the runtime's `GRANT_TOKEN_EXCHANGE`. */
export const GRANT_TOKEN_EXCHANGE = "urn:ietf:params:oauth:grant-type:token-exchange";

/** The RFC 8693 token-type URNs, the runtime's `TOKEN_TYPE` table. */
export const TOKEN_TYPE_URN = {
  access_token: "urn:ietf:params:oauth:token-type:access_token",
  jwt: "urn:ietf:params:oauth:token-type:jwt",
  id_token: "urn:ietf:params:oauth:token-type:id_token",
} as const;
