import type { Operation } from "@anvil/air";
import type { OperationManifest } from "@anvil/compiler";
import type { HarnessFinding, OperationClaim } from "./agent.js";
import { reliabilityOf } from "./evidence.js";

/**
 * Asymmetric trust (the safety centerpiece). Enrichment that *loosens* safety
 * — e.g. marking a POST idempotent so retries turn on — needs high-reliability
 * evidence (implementation / contract tests / recorded traffic). Enrichment
 * that *tightens* safety is cheap. On conflict, the safer claim wins.
 */
export const LOOSEN_THRESHOLD = 0.85;
export const TIGHTEN_THRESHOLD = 0.4;

export interface ReconcileDecision {
  claim: OperationClaim;
  accepted: boolean;
  reason: string;
  evidenceReliability: number;
}

export interface ReconcileResult {
  patch: OperationManifest;
  decisions: ReconcileDecision[];
}

function claimKey(c: OperationClaim): string {
  return c.type;
}

/** Reconcile a set of findings for one operation into a proposed manifest patch. */
export function reconcile(op: Operation, findings: HarnessFinding[]): ReconcileResult {
  const patch: OperationManifest = {};
  const decisions: ReconcileDecision[] = [];

  // Group claim-bearing findings by claim type.
  const groups = new Map<string, HarnessFinding[]>();
  for (const f of findings) {
    if (!f.claim) continue;
    const key = claimKey(f.claim);
    const list = groups.get(key) ?? [];
    list.push(f);
    groups.set(key, list);
  }

  for (const group of groups.values()) {
    // Safety-first: if the group contains both loosen and tighten claims, keep
    // only the tightening ones.
    const hasTighten = group.some((f) => f.claim?.direction === "tighten");
    const considered = hasTighten ? group.filter((f) => f.claim?.direction === "tighten") : group;

    const best = considered.reduce((acc, f) => Math.max(acc, reliabilityOf(f.evidence)), 0);
    const claim = considered[0]?.claim;
    if (!claim) continue;

    const threshold = claim.direction === "loosen" ? LOOSEN_THRESHOLD : TIGHTEN_THRESHOLD;
    const accepted = best >= threshold;
    const reason = accepted
      ? `accepted: ${claim.direction} backed by evidence at reliability ${best.toFixed(2)} ≥ ${threshold}`
      : `rejected: ${claim.direction} needs reliability ≥ ${threshold}; best available was ${best.toFixed(2)} (supply an Anvil manifest to override deliberately)`;
    decisions.push({ claim, accepted, reason, evidenceReliability: best });

    if (!accepted) continue;
    applyClaim(patch, claim, op);
  }

  return { patch, decisions };
}

function applyClaim(patch: OperationManifest, claim: OperationClaim, op: Operation): void {
  switch (claim.type) {
    case "idempotency":
      patch.idempotency = {
        strategy: strategyFor(claim.mode),
        ...(claim.mechanism ? { key_location: claim.mechanism } : {}),
        ...(claim.header ? { header: claim.header } : {}),
      };
      // Tightening to non-idempotent also forces confirmation for a mutation.
      if (claim.mode === "none" && op.effect.kind === "mutation") {
        patch.confirmation = { required: true };
      }
      break;
    case "confirmation":
      patch.confirmation = { required: claim.required };
      break;
    case "deprecated":
      if (claim.value) patch.state = "deprecated";
      break;
    case "description":
      patch.description = claim.text;
      break;
  }
}

function strategyFor(mode: string): NonNullable<OperationManifest["idempotency"]>["strategy"] {
  switch (mode) {
    case "required":
      return "required_request_key";
    case "natural":
      return "natural";
    case "key_supported":
      return "key_supported";
    case "client_id":
      return "client_id";
    default:
      return "none";
  }
}
