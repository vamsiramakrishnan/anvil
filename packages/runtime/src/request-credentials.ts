import type { IdempotencyCarrierBinding, Operation } from "@anvil/air";
import {
  type AuthMaterial,
  applyAuth,
  authMaterialOverwritesIdempotencyCarrier,
  type CredentialCallContext,
  type CredentialResolver,
} from "./auth.js";
import { AnvilError } from "./errors.js";
import { assertInvocationCredentialHeaders, type InvocationEdit } from "./invocation.js";
import type { HttpRequest } from "./transport.js";
import { CredentialUnavailableError } from "./vault.js";

interface RequestCredentialBinding {
  request: HttpRequest;
  operation: Operation;
  profile: string;
  resolver: CredentialResolver | undefined;
  caller: CredentialCallContext;
  invocation: InvocationEdit;
  carrier: IdempotencyCarrierBinding | undefined;
  idempotencyKey: string | undefined;
  traceId: string;
}

/** Resolves credentials for this request without letting a credential override
 * its idempotency carrier or a policy-supplied header override a credential.
 * Callers choose the moment of resolution (including each use of a revocable grant). */
export async function bindRequestCredentials(
  options: RequestCredentialBinding,
): Promise<HttpRequest> {
  const { request, operation, resolver, profile, traceId, carrier } = options;
  const { auth, id } = operation;
  let material: AuthMaterial | null | undefined;
  try {
    material = await resolver?.resolve(profile, auth, options.caller);
  } catch (error) {
    if (error instanceof CredentialUnavailableError) throw error.toAnvilError(id, traceId);
    throw error;
  }
  if (!material) {
    // Only names of credential locations are returned. Resolved values stay in the request.
    const expected = resolver?.expectedCredentials?.(profile, auth) ?? [];
    throw new AnvilError({
      code: "auth_required",
      message:
        `Auth profile '${profile}' could not be resolved for scopes [${auth.scopes.join(", ")}].` +
        (expected.length > 0 ? ` Set ${expected.join(" and ")} and retry.` : ""),
      operation: id,
      traceId,
      details: expected.length > 0 ? { expected_env: expected } : undefined,
    });
  }
  if (options.idempotencyKey && authMaterialOverwritesIdempotencyCarrier(material, carrier)) {
    throw new AnvilError({
      code: "unsupported_operation",
      message:
        "The resolved credential carrier conflicts with this operation's idempotency carrier. " +
        "Configure distinct header or query coordinates before retrying.",
      operation: id,
      traceId,
      retryable: false,
      details: { idempotency_carrier: carrier?.mechanism, credential_carrier_conflict: true },
    });
  }
  assertInvocationCredentialHeaders(options.invocation, material.headers, id, traceId);
  return applyAuth(request, material);
}
