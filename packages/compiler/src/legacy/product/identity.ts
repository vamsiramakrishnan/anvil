import { hashCanonical } from "@anvil/air";
import type {
  LegacyCapabilityCandidate,
  LegacyInventorySnapshot,
  LegacyInvocation,
} from "../core/index.js";

export type LegacyOccurrenceId = `lco_${string}`;
export type LegacyLogicalCapabilityId = `lcl_${string}`;

/**
 * An occurrence identifies one exact deployed coordinate and invocation.
 * Changing the deployment digest, environment, binding, or invocation changes
 * the identity.
 */
export function legacyOccurrenceId(
  candidate: Pick<LegacyCapabilityCandidate, "coordinate" | "invocation">,
): LegacyOccurrenceId {
  return `lco_${hashCanonical({
    coordinate: candidate.coordinate,
    invocation: candidate.invocation,
  })}`;
}

/**
 * Logical invocation identity deliberately excludes deployment-local routing
 * coordinates. It is narrow enough to avoid matching unrelated operations but
 * stable across ordinary redeployments and endpoint rebinding.
 */
function logicalInvocation(invocation: LegacyInvocation): object {
  switch (invocation.kind) {
    case "message":
      return {
        kind: invocation.kind,
        protocol: invocation.protocol,
        destination: invocation.destination,
        ...(invocation.messageType ? { messageType: invocation.messageType } : {}),
      };
    case "remote_method":
      return {
        kind: invocation.kind,
        protocol: invocation.protocol,
        interface: invocation.interface,
        ...(invocation.method ? { method: invocation.method } : {}),
      };
    case "resource_adapter":
      return {
        kind: invocation.kind,
        adapterRef: invocation.adapterRef,
        ...(invocation.interactionSpec ? { interactionSpec: invocation.interactionSpec } : {}),
      };
    case "stored_procedure":
      return { kind: invocation.kind, procedure: invocation.procedure };
    case "batch_job":
      return { kind: invocation.kind, job: invocation.job };
  }
}

/**
 * A logical identity tracks the same capability across environments,
 * deployment digests, platforms, and physical endpoint changes. It does not
 * claim that two occurrences are semantically equivalent; the diff reports
 * their evidence and assertion changes separately.
 */
export function legacyLogicalCapabilityId(
  estate: LegacyInventorySnapshot["estate"],
  candidate: Pick<LegacyCapabilityCandidate, "coordinate" | "invocation">,
): LegacyLogicalCapabilityId {
  return `lcl_${hashCanonical({
    estateId: estate.id,
    application: candidate.coordinate.application,
    module: candidate.coordinate.module,
    component: candidate.coordinate.component,
    invocation: logicalInvocation(candidate.invocation),
  })}`;
}
