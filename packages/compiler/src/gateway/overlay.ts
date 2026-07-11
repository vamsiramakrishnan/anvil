/**
 * Building a `GatewayPolicyOverlay` — a `PolicyOverlay` whose every assertion is
 * an evidence-backed control-plane fact. The builder guarantees the conformance
 * invariant structurally: you cannot add an assertion without a coordinate, so a
 * normalized policy can never reach the resolver as an unsourced claim.
 */
import type { EvidenceKind } from "@anvil/air";
import type {
  EvidenceArtifact,
  SemanticOverlayAssertion,
  SemanticPredicate,
  SemanticTarget,
} from "../contract/model.js";
import { makeOverlay } from "../contract/overlay.js";
import { sha256Hex } from "../source/hash.js";
import type { EvidenceCoordinate, GatewayPolicyOverlay } from "./model.js";

/** A normalized gateway fact: one assertion plus the coordinate that justifies it. */
export interface GatewayFact {
  target: SemanticTarget;
  predicate: SemanticPredicate;
  operation: SemanticOverlayAssertion["operation"];
  value: unknown;
  coordinate: EvidenceCoordinate;
  /** Evidence kind; defaults to `source_impl` (a control-plane config is authoritative). */
  evidenceKind?: EvidenceKind;
  note?: string;
}

/** A deterministic evidence id from its coordinate (stable across runs). */
function evidenceId(coordinate: EvidenceCoordinate): string {
  const key = `${coordinate.origin}\0${coordinate.pointer ?? ""}\0${coordinate.span?.start ?? ""}\0${coordinate.span?.end ?? ""}`;
  return `gw-ev-${sha256Hex(new TextEncoder().encode(key)).slice(0, 12)}`;
}

/** A stringified locator kept on the evidence artifact for human tracing. */
function coordinateRef(coordinate: EvidenceCoordinate): string {
  const span = coordinate.span ? `@${coordinate.span.start}-${coordinate.span.end}` : "";
  return coordinate.pointer
    ? `${coordinate.origin}#${coordinate.pointer}${span}`
    : `${coordinate.origin}${span}`;
}

/**
 * Assemble a gateway overlay from normalized facts. Coordinates dedupe into a set
 * of evidence artifacts (by content), and each assertion references the artifact
 * for its coordinate — so `every assertion has evidence` holds by construction.
 */
export function buildGatewayOverlay(
  facts: readonly GatewayFact[],
  id?: string,
): GatewayPolicyOverlay {
  const evidenceById = new Map<string, EvidenceArtifact>();
  const assertions: SemanticOverlayAssertion[] = facts.map((fact) => {
    const evId = evidenceId(fact.coordinate);
    if (!evidenceById.has(evId)) {
      evidenceById.set(evId, {
        id: evId,
        kind: fact.evidenceKind ?? "source_impl",
        ref: coordinateRef(fact.coordinate),
        note: fact.note,
      });
    }
    return {
      target: fact.target,
      predicate: fact.predicate,
      operation: fact.operation,
      value: fact.value,
      evidenceRefs: [evId],
    };
  });
  return makeOverlay({ origin: "gateway", assertions, evidence: [...evidenceById.values()], id });
}
