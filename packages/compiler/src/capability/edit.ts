/**
 * Declarative capability editing. A reviewer moves one operation between
 * capabilities, tightens intents, or names an owner without touching AIR or any
 * generated file — the edit adjusts membership and metadata, and everything
 * derived (auth/safety profile, disclosure, signature, digest) recomputes.
 */
import type { AirDocument } from "@anvil/air";
import { buildCapabilityContract } from "./contract.js";
import type { CapabilityContract, OwnerRef, SafetyProfile } from "./model.js";

/** A declarative edit to one capability contract. */
export interface CapabilityEdit {
  /** Operation ids to add to this capability. */
  include?: string[];
  /** Operation ids to remove from this capability. */
  exclude?: string[];
  intents?: string[];
  counterIntents?: string[];
  owner?: OwnerRef;
  displayName?: string;
  description?: string;
  lifecycle?: CapabilityContract["lifecycle"];
  /** Override the derived safety profile (e.g. an explicit tighter posture). */
  safetyProfile?: Partial<SafetyProfile>;
}

/** Apply an edit to one contract, recomputing everything derived from membership. */
export function editCapabilityContract(
  air: AirDocument,
  contract: CapabilityContract,
  edit: CapabilityEdit,
): CapabilityContract {
  const members = new Set(contract.operationIds);
  for (const id of edit.include ?? []) members.add(id);
  for (const id of edit.exclude ?? []) members.delete(id);

  // The safety-profile override is an *input* to the build, so it participates in
  // the digest — never applied after (#6). Membership drives everything else.
  return buildCapabilityContract(air, {
    id: contract.id,
    version: contract.version,
    displayName: edit.displayName ?? contract.displayName,
    description: edit.description ?? contract.description,
    intents: edit.intents ?? contract.intents,
    counterIntents: edit.counterIntents ?? contract.counterIntents,
    operationIds: [...members],
    procedureRefs: contract.procedureRefs,
    lifecycle: edit.lifecycle ?? contract.lifecycle,
    owner: edit.owner ?? contract.owner,
    evidence: contract.evidence,
    safetyProfileOverride: edit.safetyProfile,
  });
}

/**
 * Move one operation from a source capability contract to a destination one, in a
 * single call — the common review action. Returns both updated contracts.
 */
export function moveOperation(
  air: AirDocument,
  from: CapabilityContract,
  to: CapabilityContract,
  operationId: string,
): { from: CapabilityContract; to: CapabilityContract } {
  return {
    from: editCapabilityContract(air, from, { exclude: [operationId] }),
    to: editCapabilityContract(air, to, { include: [operationId] }),
  };
}
