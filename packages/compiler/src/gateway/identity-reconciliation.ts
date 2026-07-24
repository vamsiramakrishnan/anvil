import { type AuthCredentialCarrier, type AuthRequirement, effectiveAuthCarrier } from "@anvil/air";
import { z } from "zod";
import { EvidenceCoordinate, type GatewayIdentityEvidence } from "./model.js";

export const IdentityDimensionName = z.enum([
  "type",
  "principal",
  "issuer",
  "audience",
  "carrier",
  "scopes",
]);
export type IdentityDimensionName = z.infer<typeof IdentityDimensionName>;

export const IdentityDimensionState = z.enum([
  "match",
  "missing_contract",
  "missing_gateway",
  "missing_both",
  "contradictory",
]);
export type IdentityDimensionState = z.infer<typeof IdentityDimensionState>;

export const IdentityReconciliationDimension = z.object({
  dimension: IdentityDimensionName,
  state: IdentityDimensionState,
  contractValue: z.unknown().optional(),
  gatewayValues: z.array(z.unknown()),
  coordinates: z.array(
    z.object({
      origin: z.string(),
      pointer: z.string().optional(),
      span: z.object({ start: z.number().int(), end: z.number().int() }).optional(),
    }),
  ),
  detail: z.string(),
  remediation: z.string().optional(),
});
export type IdentityReconciliationDimension = z.infer<typeof IdentityReconciliationDimension>;

export const IdentityReconciliationReport = z.object({
  status: z.enum(["not_applicable", "reconciled", "needs_evidence", "blocked"]),
  dimensions: z.array(IdentityReconciliationDimension),
  findings: z.array(
    z.object({
      code: z.string(),
      severity: z.enum(["error", "warning"]),
      dimension: IdentityDimensionName,
      state: IdentityDimensionState,
      message: z.string(),
      remediation: z.string(),
      coordinates: z.array(EvidenceCoordinate),
    }),
  ),
});
export type IdentityReconciliationReport = z.infer<typeof IdentityReconciliationReport>;

const DIMENSIONS = IdentityDimensionName.options;

function normalizedCarrier(carrier: AuthCredentialCarrier): AuthCredentialCarrier {
  return carrier.in === "header"
    ? {
        in: "header",
        name: carrier.name.toLowerCase(),
        ...(carrier.scheme ? { scheme: carrier.scheme.toLowerCase() } : {}),
      }
    : { in: "query", name: carrier.name };
}

function normalizedValue(dimension: IdentityDimensionName, value: unknown): unknown {
  if (dimension === "carrier") {
    return normalizedCarrier(value as AuthCredentialCarrier);
  }
  if (dimension === "scopes") {
    return [...new Set(value as string[])].sort();
  }
  return value;
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function contractValue(auth: AuthRequirement, dimension: IdentityDimensionName): unknown {
  switch (dimension) {
    case "type":
      return auth.type;
    case "principal":
      return auth.principal;
    case "issuer":
      return auth.issuer;
    case "audience":
      return auth.audience;
    case "carrier":
      return effectiveAuthCarrier(auth);
    case "scopes":
      // AIR structurally defaults scopes to []. That default means no scope
      // evidence was supplied; it is not proof that the IdP requires no scopes.
      return auth.scopes.length > 0 ? auth.scopes : undefined;
  }
}

function evidenceValue(
  evidence: GatewayIdentityEvidence,
  dimension: IdentityDimensionName,
): unknown {
  return evidence[dimension];
}

function remediationFor(
  dimension: IdentityDimensionName,
  state: IdentityDimensionState,
): string | undefined {
  if (state === "match") return undefined;
  if (state === "contradictory") {
    return `Resolve the conflicting ${dimension} values at their cited gateway coordinates before approving or deploying the operation.`;
  }
  if (state === "missing_contract") {
    return `Add the gateway-proven ${dimension} to AIR through an evidence-backed manifest or gateway overlay.`;
  }
  if (state === "missing_gateway") {
    return `Export or query gateway policy that explicitly proves ${dimension}; do not infer it from a token endpoint or route.`;
  }
  return `Declare ${dimension} in the contract and obtain explicit gateway evidence before treating identity as reconciled.`;
}

/**
 * Reconcile the identity an AIR operation expects with facts the gateway export
 * actually proves. Missing evidence and contradictions are different outcomes:
 * the former requires collection/enrichment, while the latter blocks approval.
 *
 * `auth.provider.tokenEndpoint` is deliberately absent from this function. A
 * token acquisition URL is not proof of which issuer signed an inbound token.
 */
export function reconcileGatewayIdentity(
  auth: AuthRequirement,
  evidence: readonly GatewayIdentityEvidence[],
  options: { operationRef?: string; operationRefs?: readonly string[] } = {},
): IdentityReconciliationReport {
  // API-wide evidence applies to every operation. Route/operation-scoped
  // evidence applies only to the exact requested operation; without a target,
  // ignore it rather than flattening different route scopes into a false
  // contradiction.
  const operationRefs = new Set([
    ...(options.operationRef ? [options.operationRef] : []),
    ...(options.operationRefs ?? []),
  ]);
  const applicableEvidence = evidence.filter(
    (entry) => entry.operationRef === undefined || operationRefs.has(entry.operationRef),
  );
  if (auth.type === "none") {
    if (applicableEvidence.length === 0) {
      return IdentityReconciliationReport.parse({
        status: "not_applicable",
        dimensions: [],
        findings: [],
      });
    }
    const coordinates = [
      ...new Map(
        applicableEvidence.map((entry) => [JSON.stringify(entry.coordinate), entry.coordinate]),
      ).values(),
    ];
    const gatewayTypes = [
      ...new Set(
        applicableEvidence.flatMap((entry) => (entry.type === undefined ? [] : [entry.type])),
      ),
    ];
    const remediation =
      "Declare the gateway-required authentication scheme and identity contract in AIR, or correct the cited gateway evidence; an anonymous operation cannot be exposed behind explicit identity enforcement.";
    return IdentityReconciliationReport.parse({
      status: "blocked",
      dimensions: [
        {
          dimension: "type",
          state: "contradictory",
          contractValue: "none",
          gatewayValues: gatewayTypes,
          coordinates,
          detail:
            "The contract declares anonymous access while applicable gateway evidence explicitly configures identity enforcement.",
          remediation,
        },
      ],
      findings: [
        {
          code: "identity/anonymous_contract",
          severity: "error",
          dimension: "type",
          state: "contradictory",
          message:
            "Authentication conflicts: the contract declares auth type none/anonymous, but the gateway has cited identity configuration for this operation.",
          remediation,
          coordinates,
        },
      ],
    });
  }
  const dimensions = DIMENSIONS.map((dimension): IdentityReconciliationDimension => {
    const contractRaw = contractValue(auth, dimension);
    const contract =
      contractRaw === undefined ? undefined : normalizedValue(dimension, contractRaw);
    const present = applicableEvidence
      .map((entry) => ({
        raw: evidenceValue(entry, dimension),
        coordinate: entry.coordinate,
      }))
      .filter(
        (entry): entry is { raw: Exclude<unknown, undefined>; coordinate: EvidenceCoordinate } =>
          entry.raw !== undefined,
      );
    const values: unknown[] = [];
    const coordinates: EvidenceCoordinate[] = [];
    for (const entry of present) {
      const value = normalizedValue(dimension, entry.raw);
      if (!values.some((candidate) => same(candidate, value))) values.push(value);
      coordinates.push(entry.coordinate);
    }

    let state: IdentityDimensionState;
    if (values.length > 1) state = "contradictory";
    else if (contract === undefined && values.length === 0) state = "missing_both";
    else if (contract === undefined) state = "missing_contract";
    else if (values.length === 0) state = "missing_gateway";
    else state = same(contract, values[0]) ? "match" : "contradictory";

    const detail =
      state === "match"
        ? `${dimension} matches the contract and gateway evidence.`
        : state === "contradictory"
          ? `${dimension} conflicts between the contract and/or cited gateway evidence.`
          : state === "missing_contract"
            ? `${dimension} is present in gateway evidence but absent from the contract.`
            : state === "missing_gateway"
              ? `${dimension} is present in the contract but absent from gateway evidence.`
              : `${dimension} is absent from both the contract and gateway evidence.`;
    return {
      dimension,
      state,
      ...(contract === undefined ? {} : { contractValue: contract }),
      gatewayValues: values,
      coordinates,
      detail,
      ...(remediationFor(dimension, state)
        ? { remediation: remediationFor(dimension, state) }
        : {}),
    };
  });

  const findings = dimensions
    .filter((dimension) => dimension.state !== "match")
    .map((dimension) => ({
      code: `identity/${dimension.state}`,
      severity: dimension.state === "contradictory" ? ("error" as const) : ("warning" as const),
      dimension: dimension.dimension,
      state: dimension.state,
      message: dimension.detail,
      remediation: dimension.remediation as string,
      coordinates: dimension.coordinates,
    }));
  return IdentityReconciliationReport.parse({
    status: dimensions.some((dimension) => dimension.state === "contradictory")
      ? "blocked"
      : dimensions.some((dimension) => dimension.state !== "match")
        ? "needs_evidence"
        : "reconciled",
    dimensions,
    findings,
  });
}
