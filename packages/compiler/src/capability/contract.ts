/**
 * Compile `CapabilityContract`s from an effective contract's AIR. A capability
 * contract is a *view* over approved operations — its auth/safety profiles,
 * disclosure plan, and digest are all derived, so the same AIR always yields the
 * same contract. Membership is the one thing a reviewer edits (see `edit.ts`);
 * everything else recomputes from it.
 */
import {
  type AirDocument,
  type CapabilityLifecycle,
  type Evidence,
  hashCanonical,
  type Operation,
  type RiskLevel,
} from "@anvil/air";
import { disclosurePlanFor } from "./disclosure.js";
import type { AuthProfile, CapabilityContract, OwnerRef, SafetyProfile } from "./model.js";

const RISK_ORDER: RiskLevel[] = ["none", "low", "medium", "high", "financial", "destructive"];

/** Everything needed to build a contract; membership is explicit and editable. */
export interface CapabilitySpec {
  id: string;
  version: string;
  displayName: string;
  description?: string;
  intents?: string[];
  counterIntents?: string[];
  operationIds: string[];
  procedureRefs?: string[];
  lifecycle?: CapabilityContract["lifecycle"];
  owner?: OwnerRef;
  evidence?: Evidence;
}

function aggregateAuth(members: Operation[]): AuthProfile {
  const uniq = (xs: string[]) => [...new Set(xs)].sort();
  return {
    types: uniq(members.map((op) => op.auth.type)),
    principals: uniq(members.map((op) => op.auth.principal)),
    scopes: uniq(members.flatMap((op) => op.auth.scopes)),
    secretSources: uniq(members.map((op) => op.auth.secretSource)),
  };
}

function aggregateSafety(members: Operation[]): SafetyProfile {
  const highestRisk = members.reduce<RiskLevel>(
    (acc, op) =>
      RISK_ORDER.indexOf(op.effect.risk) > RISK_ORDER.indexOf(acc) ? op.effect.risk : acc,
    "none",
  );
  return {
    confirmationRequiredOps: members
      .filter((op) => op.confirmation.required)
      .map((op) => op.id)
      .sort(),
    nonIdempotentMutationOps: members
      .filter((op) => op.effect.kind === "mutation" && op.idempotency.mode === "none")
      .map((op) => op.id)
      .sort(),
    highestRisk,
  };
}

/** The digest of a contract: everything but the digest field itself. */
function contractDigest(contract: Omit<CapabilityContract, "digest">): string {
  return hashCanonical({ ...contract, evidence: undefined });
}

/** Map a discovered capability's lifecycle onto the contract lifecycle. */
function mapLifecycle(lifecycle: CapabilityLifecycle): CapabilityContract["lifecycle"] {
  if (lifecycle === "approved") return "approved";
  if (lifecycle === "deprecated") return "deprecated";
  return "proposed";
}

/** Build a capability contract from an explicit membership spec. */
export function buildCapabilityContract(
  air: AirDocument,
  spec: CapabilitySpec,
): CapabilityContract {
  const memberIds = new Set(spec.operationIds);
  const members = air.operations
    .filter((op) => memberIds.has(op.id) && op.state === "approved")
    .sort((a, b) => a.id.localeCompare(b.id));

  const withoutDigest: Omit<CapabilityContract, "digest"> = {
    schemaVersion: 1,
    id: spec.id,
    version: spec.version,
    displayName: spec.displayName,
    description: spec.description ?? "",
    intents: spec.intents ?? [],
    counterIntents: spec.counterIntents ?? [],
    operationIds: members.map((op) => op.id),
    procedureRefs: spec.procedureRefs ?? [],
    authProfile: aggregateAuth(members),
    safetyProfile: aggregateSafety(members),
    disclosure: disclosurePlanForSpec(air, spec, members),
    lifecycle: spec.lifecycle ?? "proposed",
    owner: spec.owner,
    evidence: spec.evidence ?? { claims: [] },
  };
  return { ...withoutDigest, digest: contractDigest(withoutDigest) };
}

/**
 * Disclosure for an explicit spec: if the members are exactly a discovered
 * capability's, reuse the whole-capability plan; otherwise project only the
 * member operations (an edited membership still discloses coherently).
 */
function disclosurePlanForSpec(air: AirDocument, spec: CapabilitySpec, members: Operation[]) {
  const plan = disclosurePlanFor(air, spec.id);
  const memberIds = new Set(members.map((op) => op.id));
  return {
    summary: plan.summary,
    operations: Object.fromEntries(
      Object.entries(plan.operations).filter(([id]) => memberIds.has(id)),
    ),
  };
}

/** Build the contract for one discovered capability. */
export function capabilityContractFor(air: AirDocument, capabilityId: string): CapabilityContract {
  const capability = air.capabilities.find((c) => c.id === capabilityId);
  if (!capability) throw new Error(`No capability '${capabilityId}'.`);
  return buildCapabilityContract(air, {
    id: capability.id,
    version: air.service.version,
    displayName: capability.displayName,
    description: capability.description,
    intents: capability.intentExamples,
    operationIds: capability.operationIds,
    procedureRefs: capability.workflowIds,
    lifecycle: mapLifecycle(capability.lifecycle),
    evidence: capability.evidence,
  });
}

/** Build contracts for every discovered capability, sorted by id. */
export function capabilityContractsFor(air: AirDocument): CapabilityContract[] {
  return air.capabilities
    .map((c) => capabilityContractFor(air, c.id))
    .sort((a, b) => a.id.localeCompare(b.id));
}
