import type { OperationState } from "@anvil/air";

/**
 * The one place that decides whether a manifest may move an
 * `oauth2_authorization_code` operation to `approved`. Every other auth type
 * reaches `approved` on `state: approved` alone — a manifest-set state is
 * itself the reviewer's decision (see manifest.ts's own note on `m.state`).
 * Authorization-code is different: the manifest is delegating an END USER's
 * authority, and a bare `state:` names no one. `reviewed_by` and
 * `review_reason` must both be non-empty — naming who decided and why — or
 * the operation stays `review_required` regardless of what `state:` asked
 * for. This exists because receipt-bound gateway bundles (`anvil estate
 * import`) refuse in-place `anvil approve` by design (see
 * `packages/generators/src/bundle-reproject.ts`'s `assertImmutableGatewayLineage`)
 * and so have no other approval path for this auth type: the supplemental
 * manifest plus a re-import IS the review. One small module owning one
 * coherence rule, mirroring `@anvil/air`'s `auth-mechanics.ts` — so the
 * mutation suite has exactly one guard to kill.
 */

const REVIEW_UNBLOCK_NOTE =
  "Authorization-code auth stays review_required: end-user authority is a human decision, " +
  "never a material-completeness one. Run `anvil auth login <bundle> --profile <profile>` " +
  "to complete the interactive PKCE step and store a refresh token, then approve explicitly.";

const isNamed = (value: string | undefined): value is string =>
  typeof value === "string" && value.trim().length > 0;

export interface AuthorizationCodeApprovalDecision {
  state: Extract<OperationState, "approved" | "review_required">;
  note: string;
}

/**
 * Decide the state and review note for an `oauth2_authorization_code`
 * operation given the manifest's requested `state` and its `reviewed_by` /
 * `review_reason` companions. `requestedState` is the raw manifest value —
 * anything other than `"approved"` (including `undefined`) leaves today's
 * unconditional review_required note untouched, byte for byte.
 */
export function decideAuthorizationCodeApproval(
  operationId: string,
  requestedState: string | undefined,
  reviewedBy: string | undefined,
  reviewReason: string | undefined,
): AuthorizationCodeApprovalDecision {
  if (requestedState !== "approved") {
    return { state: "review_required", note: REVIEW_UNBLOCK_NOTE };
  }
  const hasReviewer = isNamed(reviewedBy);
  const hasReason = isNamed(reviewReason);
  if (hasReviewer && hasReason) {
    return {
      state: "approved",
      note:
        `Authorization-code end-user authority granted by manifest: reviewed by ${reviewedBy}, ` +
        `reason: ${reviewReason}.`,
    };
  }
  const missing = [
    ...(hasReviewer ? [] : ["reviewed_by"]),
    ...(hasReason ? [] : ["review_reason"]),
  ];
  return {
    state: "review_required",
    note:
      `${REVIEW_UNBLOCK_NOTE} Manifest state: approved also needs both ` +
      `operations.${operationId}.reviewed_by and operations.${operationId}.review_reason to name ` +
      `who granted end-user authority and why (missing: ${missing.join(", ")}).`,
  };
}

/**
 * Fold a manifest's `reviewed_by`/`review_reason` into a review note for any
 * auth type OTHER than `oauth2_authorization_code`, where the pair carries no
 * gating power — accepted and recorded, never enforced. Returns `undefined`
 * when neither field is present, so a caller never pushes an empty note.
 */
export function manifestReviewAnnotation(
  reviewedBy: string | undefined,
  reviewReason: string | undefined,
): string | undefined {
  if (!isNamed(reviewedBy) && !isNamed(reviewReason)) return undefined;
  const parts = [
    isNamed(reviewedBy) ? `reviewed by ${reviewedBy}` : undefined,
    isNamed(reviewReason) ? `reason: ${reviewReason}` : undefined,
  ].filter((part): part is string => part !== undefined);
  return `Manifest review recorded (${parts.join(", ")}); this auth type does not require it.`;
}
