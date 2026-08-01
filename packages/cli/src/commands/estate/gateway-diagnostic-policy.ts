import { hashCanonical } from "@anvil/air";
import type { GatewayDiagnostic } from "@anvil/compiler";

export interface GatewayDiagnosticSelection {
  id: string;
  apiVersion?: string;
  revision: string;
  environment: string;
  artifacts?: readonly {
    origin: string;
    digest: string;
    parent?: { origin: string; digest: string };
  }[];
}

function normalizedRevision(value: string): string {
  return value === "0.0.0" ? "unversioned" : value;
}

/**
 * A missing subject is deliberately global. A partial API coordinate applies
 * to every selected revision/environment it does not explicitly constrain.
 */
export function gatewayDiagnosticAppliesToSelection(
  diagnostic: GatewayDiagnostic,
  selection: GatewayDiagnosticSelection,
): boolean {
  const subject = diagnostic.subject;
  if (!subject) return true;
  if (subject.api) {
    if (subject.api.id !== selection.id) return false;
    if (subject.api.apiVersion !== undefined && subject.api.apiVersion !== selection.apiVersion) {
      return false;
    }
    if (
      subject.api.revision !== undefined &&
      normalizedRevision(subject.api.revision) !== normalizedRevision(selection.revision)
    ) {
      return false;
    }
    if (
      subject.api.environment !== undefined &&
      subject.api.environment !== selection.environment
    ) {
      return false;
    }
  }
  if (subject.artifact) {
    const subjectArtifact = subject.artifact;
    const artifactMatches = selection.artifacts?.some((artifact) => {
      if (
        artifact.origin === subjectArtifact.origin &&
        artifact.digest === subjectArtifact.digest
      ) {
        return true;
      }
      const parent = artifact.parent;
      return (
        parent !== undefined &&
        parent.origin === subjectArtifact.origin &&
        parent.digest === subjectArtifact.digest
      );
    });
    if (artifactMatches !== true) return false;
  }
  return true;
}

/** Import/certification policy shared by selection-aware import and estate audit. */
export function blocksGatewayImport(diagnostic: GatewayDiagnostic): boolean {
  return (
    diagnostic.level === "error" ||
    diagnostic.code === "gateway/route_only_contract" ||
    diagnostic.code === "gateway/missing_runtime_coordinate" ||
    diagnostic.code === "gateway/auth_contract_incomplete" ||
    diagnostic.code === "gateway/opaque_policy" ||
    diagnostic.code === "gateway/policy_target_unmatched" ||
    diagnostic.code === "gateway/route_set_missing" ||
    diagnostic.code === "gateway/route_set_extra" ||
    diagnostic.code === "gateway/route_set_ambiguous" ||
    diagnostic.code === "gateway/identity_contradictory"
  );
}

/** Audit severity reflects whether the same finding blocks a selected import. */
export function gatewayDiagnosticAuditSeverity(
  diagnostic: GatewayDiagnostic,
): "blocking" | "warning" | "info" {
  if (blocksGatewayImport(diagnostic)) return "blocking";
  return diagnostic.level === "warning" ? "warning" : "info";
}

/**
 * Inventory and extraction intentionally traverse the same source evidence.
 * Collapse exact semantic repeats with canonical hashing (not property-order-
 * sensitive JSON.stringify), while retaining distinct subjects and coordinates.
 */
export function dedupeGatewayDiagnostics(
  diagnostics: readonly GatewayDiagnostic[],
): GatewayDiagnostic[] {
  return [
    ...new Map(
      diagnostics.map((diagnostic) => [hashCanonical(diagnostic), diagnostic] as const),
    ).values(),
  ];
}
