import { type Operation, operationInputSchema, validateBusinessValue } from "@anvil/air";
import { AnvilError } from "./errors.js";
import type { EnterprisePrincipal, IdentityRuntime } from "./identity.js";
import type { InboundIdentity } from "./inbound-identity.js";

/** Shared identity authorization gate. Called before credentials, replay lookup or wire effects. */
export async function enforceIdentityAuthorization(
  identity: IdentityRuntime | undefined,
  enterprisePrincipal: EnterprisePrincipal | undefined,
  op: Operation,
  input: Record<string, unknown>,
  serviceId: string,
  confirm: boolean,
  traceId: string,
  decide: (record: string) => void,
): Promise<void> {
  if (identity) {
    if (!validateBusinessValue({ ...operationInputSchema(op), required: [] }, input))
      throw new AnvilError({
        code: "validation_error",
        message: "Identity authorization requires valid operation inputs.",
        operation: op.id,
        traceId,
      });
    if (!enterprisePrincipal)
      throw new AnvilError({
        code: "policy_denied",
        message: "Verified identity is required.",
        operation: op.id,
        traceId,
      });
    const decision = await identity.authorize({
      principal: enterprisePrincipal,
      service: serviceId,
      operation: op,
      input,
      confirmed: confirm,
      traceId,
    });
    decide(`identity:${identity.digest}:${decision.policyVersion}:${decision.reason}`);
    if (!decision.allowed)
      throw new AnvilError({
        code: "policy_denied",
        message: "Identity policy denied this operation.",
        operation: op.id,
        traceId,
      });
    if (decision.obligations?.some((obligation) => obligation.kind === "confirmation") && !confirm)
      throw new AnvilError({
        code: "confirmation_required",
        message: "Identity policy requires confirmation.",
        operation: op.id,
        traceId,
      });
  }
}

function textClaim(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Stable replay scope from verified identity claims. Raw bearer bytes, email,
 * and other mutable/display claims are deliberately excluded.
 */
export function ledgerPrincipalScope(inbound: InboundIdentity | undefined): unknown | undefined {
  if (!inbound) return { kind: "anonymous" };
  const claims = inbound.claims ?? {};
  const issuer = textClaim(claims.iss);
  const subject = textClaim(claims.sub) ?? textClaim(inbound.sub);
  const objectId = textClaim(claims.oid);
  const authorizedParty = textClaim(claims.azp) ?? textClaim(claims.client_id);
  if (!issuer || (!subject && !objectId && !authorizedParty)) return undefined;
  return {
    issuer,
    subject: subject ?? null,
    objectId: objectId ?? null,
    authorizedParty: authorizedParty ?? null,
    tenant: textClaim(claims.tid) ?? textClaim(claims.tenant) ?? null,
  };
}

export function canonicalUpstream(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    // Scheme, host and path only: userinfo, query and fragment never reach the
    // fingerprint. Trailing slashes are dropped, but the root path stays "/".
    const path = url.pathname.replace(/\/+$/, "") || "/";
    return `${url.protocol}//${url.host}${path}`;
  } catch {
    // Request construction and host pinning will reject an invalid URL later.
    // Keeping the exact value here still gives that malformed target a stable,
    // isolated fingerprint rather than collapsing it into another upstream.
    return baseUrl;
  }
}
