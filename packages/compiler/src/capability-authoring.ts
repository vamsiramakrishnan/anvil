import type { Capability, Operation } from "@anvil/air";
import { capabilityState } from "./capabilities.js";
import { CapabilityReviewError } from "./capability-review.js";
import type { AnvilManifest } from "./manifest.js";
import { operationMatchesKey } from "./manifest.js";

/**
 * Capability authoring — the write path for `CapabilitySource: "manifest"`.
 *
 * Discovery (capabilities.ts) can only propose the groupings the spec's own
 * taxonomy suggests: tags, resources, the service bucket. The groupings that
 * matter for routing accuracy routinely cut across that taxonomy — the
 * traffic-observed proposals from `anvil capability propose --from-records`
 * are the measured proof — and until this module existed they had nowhere to
 * go: `CapabilityReviewManifest` could approve or reject a discovered
 * grouping, never author a new one, so `"manifest"` sat in `CapabilitySource`
 * with nothing in the workspace ever setting it.
 *
 * The boundary this module keeps: authoring is DECLARATION, not approval. An
 * authored capability is born `lifecycle: "proposed"` — exactly where a
 * discovered grouping is born — and reaches `approved` only through
 * `approveCapability`, which enforces the same disclosure budget for both.
 * Authoring also grants nothing to member operations: they keep their own
 * approval lifecycle, and `capabilityView` still refuses to build a
 * capability none of whose members are approved.
 *
 * Validation is hard, in the review-error shape the rest of the capability
 * lifecycle already throws: an id colliding with an existing grouping is a
 * structured error (a silent merge would let a manifest quietly rewrite what
 * discovery produced and review already saw), and a member reference that
 * resolves to no operation is a structured error (a capability over phantom
 * members would review as something it can never serve). The empty member
 * list is refused earlier still, by the manifest schema itself.
 */
export function authorCapabilities(
  manifest: AnvilManifest,
  operations: readonly Operation[],
  existing: readonly Capability[],
): Capability[] {
  const authored: Capability[] = [];
  const entries = Object.entries(manifest.capabilities)
    .filter(([, entry]) => entry.operations !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));

  for (const [id, entry] of entries) {
    if (existing.some((c) => c.id === id) || authored.some((c) => c.id === id)) {
      throw new CapabilityReviewError(
        "capability_author_id_collision",
        `Manifest capability entry '${id}' authors a grouping (operations present), but a ` +
          `capability with that id already exists. Authoring never merges into an existing ` +
          `grouping — pick a new id, or drop 'operations' to make this entry a review of the ` +
          `existing capability.`,
      );
    }

    const memberIds: string[] = [];
    const unresolved: string[] = [];
    for (const reference of entry.operations ?? []) {
      const op = operations.find((candidate) => operationMatchesKey(candidate, reference));
      if (!op) {
        unresolved.push(reference);
        continue;
      }
      if (!memberIds.includes(op.id)) memberIds.push(op.id);
    }
    if (unresolved.length > 0) {
      throw new CapabilityReviewError(
        "capability_author_member_unresolved",
        `Manifest capability '${id}' names ${unresolved.length} operation(s) this document does ` +
          `not carry: ${unresolved.map((r) => `'${r}'`).join(", ")}. Members resolve by AIR id, ` +
          `canonical name, or the source operationId; a capability over phantom members would ` +
          `review as something it can never serve.`,
      );
    }

    const members = memberIds.map(
      (memberId) => operations.find((op) => op.id === memberId) as Operation,
    );
    authored.push({
      id,
      displayName: entry.display_name ?? id.split(".").pop() ?? id,
      description: entry.description ?? "",
      source: "manifest",
      resources: [
        ...new Set(members.map((op) => op.effect.resource).filter((r): r is string => Boolean(r))),
      ].sort(),
      operationIds: [...memberIds].sort(),
      workflowIds: [],
      intentExamples: entry.intent_examples ?? [],
      // Derived member-state summary, same rule as discovery — never a review
      // decision.
      state: capabilityState(members),
      // Authored, not approved. The review decision — `state: approved` on the
      // same entry, or `anvil capability approve` later — goes through
      // `approveCapability` and its disclosure budget, exactly like a
      // discovered grouping. Nothing here may shortcut that.
      lifecycle: "proposed",
      evidence: {
        claims: [
          {
            subject: id,
            predicate: "grouping",
            value: "manifest",
            source: "spec",
            sourceRef: "anvil-manifest",
            method: "manifest",
            note:
              `Authored by the supplemental Anvil manifest: the operator declared ` +
              `${memberIds.length} member operation(s). Authoring is a declaration, not an ` +
              `approval — the grouping still goes through capability review.`,
            confidence: 0.95,
            review: "accepted",
          },
        ],
      },
    });
  }

  return authored;
}
