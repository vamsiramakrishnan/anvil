import { hashCanonical } from "@anvil/air";
import {
  capabilityMatrix,
  GATEWAY_UNSCOPED_ENVIRONMENT,
  GATEWAY_UNVERSIONED_REVISION,
  type GatewayAdapter,
  type GatewayApiSummary,
  type GatewayArtifactEvidence,
  type GatewayConnection,
  type GatewayDiagnostic,
  type GatewayInventorySnapshot,
} from "@anvil/compiler";
import {
  gatewayDiagnosticAppliesToSelection,
  gatewayDiagnosticAuditSeverity,
} from "./gateway-diagnostic-policy.js";

export type EstateAuditSeverity = "blocking" | "warning" | "info";
export type EstateAuditDisposition = "candidate" | "needs_evidence" | "blocked";

export interface EstateAuditFinding {
  id: string;
  taxonomy: string;
  severity: EstateAuditSeverity;
  confidence: "high" | "medium";
  category: "adapter_capability" | "contract" | "route" | "identity" | "gateway_policy";
  code: string;
  scope: { kind: "estate" | "artifact" | "api" | "route"; id: string };
  evidence: Array<{ origin: string; pointer?: string }>;
  deterministicVerdict: string;
  investigationRequired: boolean;
  message: string;
  impact: string;
  owner: "anvil_adapter" | "api_owner" | "identity_owner" | "gateway_owner";
  action: string;
  remediationArtifact: string;
  verificationGate: string;
  lifecycle: "open";
}

export interface EstateApiAudit {
  id: string;
  apiVersion?: string;
  revision: string;
  environment: string;
  coordinateKey: string;
  name: string;
  lifecycle?: string;
  owner?: string;
  routes: number;
  contract: "full" | "route_only" | "missing";
  authentication: "described" | "unproven";
  disposition: EstateAuditDisposition;
  reasons: string[];
}

export interface EstateApiCoordinate {
  id: string;
  apiVersion?: string;
  revision: string;
  environment: string;
  coordinateKey: string;
  artifacts?: GatewayArtifactEvidence[];
}

function coordinatePart(value: string): string {
  return encodeURIComponent(value);
}

export function estateApiCoordinate(
  api: {
    id: string;
    apiVersion?: string;
    version?: string;
    revision?: string;
    artifacts?: GatewayArtifactEvidence[];
  },
  revision: string,
  environment: string,
): EstateApiCoordinate {
  const apiVersion =
    api.apiVersion ??
    (meaningfulCoordinate(api.revision) ? semanticApiVersion(api.version) : undefined);
  return {
    id: api.id,
    ...(apiVersion ? { apiVersion } : {}),
    revision,
    environment,
    coordinateKey:
      `${coordinatePart(api.id)}` +
      `${apiVersion ? `:${coordinatePart(apiVersion)}` : ""}` +
      `@${coordinatePart(revision)}#${coordinatePart(environment)}`,
    ...(api.artifacts ? { artifacts: api.artifacts } : {}),
  };
}

function meaningfulCoordinate(value: string | undefined): string | undefined {
  const coordinate = value?.trim();
  return coordinate && coordinate !== "0.0.0" && coordinate !== GATEWAY_UNVERSIONED_REVISION
    ? coordinate
    : undefined;
}

function semanticApiVersion(value: string | undefined): string | undefined {
  const version = value?.trim();
  return version || undefined;
}

export function estateApiCoordinates(api: GatewayApiSummary): EstateApiCoordinate[] {
  const revision =
    meaningfulCoordinate(api.revision) ??
    meaningfulCoordinate(api.version) ??
    GATEWAY_UNVERSIONED_REVISION;
  const environments = [
    ...new Set(api.environmentIds.map((value) => value.trim()).filter(Boolean)),
  ].sort();
  return (environments.length > 0 ? environments : [GATEWAY_UNSCOPED_ENVIRONMENT]).map(
    (environment) => estateApiCoordinate(api, revision, environment),
  );
}

export interface EstateAuditReport {
  schemaVersion: 1;
  reportType: "anvil.gateway-estate-audit";
  vendor: string;
  inventoryDigest: string;
  gate: "pass" | "review_required" | "blocked";
  summary: {
    apis: number;
    routes: number;
    candidates: number;
    needsEvidence: number;
    blocked: number;
    fullContracts: number;
    routeOnlyContracts: number;
    missingContracts: number;
    authenticationUnproven: number;
    diagnostics: { error: number; warning: number; info: number };
    findings: { blocking: number; warning: number; info: number };
  };
  adapter: {
    capabilities: ReturnType<typeof capabilityMatrix>;
    limitations: string[];
  };
  findings: EstateAuditFinding[];
  apis: EstateApiAudit[];
  nextActions: string[];
}

const capabilityAction: Record<
  string,
  { severity: EstateAuditSeverity; owner: EstateAuditFinding["owner"]; action: string }
> = {
  apiSpecs: {
    severity: "warning",
    owner: "api_owner",
    action:
      "Locate the selected API's original OpenAPI/Swagger contract and pass it with --spec during import.",
  },
  authentication: {
    severity: "warning",
    owner: "anvil_adapter",
    action: "Review authentication in the native export and enrich the contract before exposure.",
  },
  authorization: {
    severity: "warning",
    owner: "anvil_adapter",
    action: "Review scopes/roles against gateway policy; do not infer authorization from routes.",
  },
  transformations: {
    severity: "warning",
    owner: "gateway_owner",
    action:
      "Review request/response transformations and model or explicitly resolve every opaque policy.",
  },
  faultPolicies: {
    severity: "warning",
    owner: "gateway_owner",
    action: "Review gateway fault handling before relying on retry or error semantics.",
  },
  drift: {
    severity: "info",
    owner: "gateway_owner",
    action: "Re-export and compare inventory digests; this adapter has no live drift reader.",
  },
  publish: {
    severity: "info",
    owner: "gateway_owner",
    action:
      "Use the vendor's deployment workflow; Anvil's estate adapters are intentionally read-only.",
  },
};

type FindingCore = Omit<
  EstateAuditFinding,
  | "taxonomy"
  | "confidence"
  | "evidence"
  | "deterministicVerdict"
  | "investigationRequired"
  | "impact"
  | "remediationArtifact"
  | "verificationGate"
  | "lifecycle"
> &
  Partial<
    Pick<
      EstateAuditFinding,
      | "confidence"
      | "evidence"
      | "deterministicVerdict"
      | "investigationRequired"
      | "impact"
      | "remediationArtifact"
      | "verificationGate"
    >
  >;

function finding(core: FindingCore): EstateAuditFinding {
  const defaults = {
    adapter_capability: {
      taxonomy: "GW.ADAPTER.CAPABILITY",
      impact: "The export cannot prove this control-plane dimension.",
      artifact: "adapter capability implementation or independent evidence record",
      gate: "gateway adapter conformance",
    },
    contract: {
      taxonomy: "GW.CONTRACT.FIDELITY",
      impact: "An agent tool could expose behavior whose wire or business contract is unproven.",
      artifact: "locked API contract and supplemental manifest",
      gate: "estate import, inspect, lint, and receipt verification",
    },
    route: {
      taxonomy: "GW.ROUTE.AMBIGUITY",
      impact: "Synthesizing a callable coordinate would fabricate gateway behavior.",
      artifact: "corrected gateway export",
      gate: "estate audit --check",
    },
    identity: {
      taxonomy: "GW.IDENTITY.EVIDENCE",
      impact: "The runtime could disagree with the identity policy enforced by the gateway.",
      artifact: "identity reconciliation record and contract security scheme",
      gate: "lint, certification, and live identity readiness",
    },
    gateway_policy: {
      taxonomy: "GW.POLICY.OPAQUE",
      impact: "An unmodeled policy may change requests, responses, errors, or authorization.",
      artifact: "adapter mapping or reviewed gateway-policy evidence",
      gate: "contract.gateway-blockers-resolved",
    },
  }[core.category];
  return {
    ...core,
    taxonomy: defaults.taxonomy,
    confidence: core.confidence ?? "high",
    evidence: core.evidence ?? [],
    deterministicVerdict: core.deterministicVerdict ?? core.message,
    investigationRequired: core.investigationRequired ?? core.severity !== "info",
    impact: core.impact ?? defaults.impact,
    remediationArtifact: core.remediationArtifact ?? defaults.artifact,
    verificationGate: core.verificationGate ?? defaults.gate,
    lifecycle: "open",
  };
}

function capabilityFinding(vendor: string, dimension: string, support: string): EstateAuditFinding {
  const policy = capabilityAction[dimension] ?? {
    severity: "info" as const,
    owner: "anvil_adapter" as const,
    action: `Treat ${dimension} as unavailable from this export and obtain independent evidence if it matters.`,
  };
  return finding({
    id: `adapter:${dimension}`,
    severity: policy.severity,
    category: "adapter_capability",
    code: `gateway/adapter_${dimension}_${support}`,
    scope: { kind: "estate", id: vendor },
    message: `${vendor} adapter support for ${dimension} is ${support}.`,
    owner: policy.owner,
    action: policy.action,
  });
}

function portableEvidenceOrigin(origin: string): string {
  return origin.replace(
    /^gateway-export:\/\/sha256:[0-9a-f]{64}/,
    "gateway-export://<content-digest>",
  );
}

interface DiagnosticFindingProjection {
  finding: EstateAuditFinding;
  /** Present only when the subject can be bound to a real inventory coordinate. */
  coordinateKey?: string;
  /** Truly global diagnostics apply to every API; unmatched subjects do not. */
  global: boolean;
}

function sourceApiScopeId(diagnostic: GatewayDiagnostic): string {
  const subject = diagnostic.subject;
  if (!subject?.api) throw new Error("A source API scope requires an API diagnostic subject.");
  const revision =
    subject.api.revision === "0.0.0" ? GATEWAY_UNVERSIONED_REVISION : subject.api.revision;
  return [
    coordinatePart(subject.api.id),
    ...(subject.api.apiVersion === undefined ? [] : [`:${coordinatePart(subject.api.apiVersion)}`]),
    ...(revision === undefined ? [] : [`@${coordinatePart(revision)}`]),
    ...(subject.api.environment === undefined
      ? []
      : [`#${coordinatePart(subject.api.environment)}`]),
  ].join("");
}

function diagnosticRouteScopeId(
  apiScopeId: string,
  route: NonNullable<NonNullable<GatewayDiagnostic["subject"]>["route"]>,
): string {
  const selector = [
    route.id === undefined ? undefined : `id=${route.id}`,
    route.method === undefined ? undefined : `method=${route.method.toUpperCase()}`,
    route.path === undefined ? undefined : `path=${route.path}`,
    route.operationRef === undefined ? undefined : `operationRef=${route.operationRef}`,
  ]
    .filter((part): part is string => part !== undefined)
    .join("|");
  return `${apiScopeId}/route/${coordinatePart(selector)}`;
}

function diagnosticScope(
  gatewayScope: string,
  diagnostic: GatewayDiagnostic,
  coordinate?: EstateApiCoordinate,
): EstateAuditFinding["scope"] {
  if (!diagnostic.subject) return { kind: "estate", id: gatewayScope };
  if (!diagnostic.subject.api && diagnostic.subject.artifact) {
    return {
      kind: "artifact",
      id:
        `${gatewayScope}/artifact/` +
        `${portableEvidenceOrigin(diagnostic.subject.artifact.origin)}@${diagnostic.subject.artifact.digest}`,
    };
  }
  const apiScopeId = `${gatewayScope}/${coordinate?.coordinateKey ?? sourceApiScopeId(diagnostic)}`;
  return diagnostic.subject.route
    ? {
        kind: "route",
        id: diagnosticRouteScopeId(apiScopeId, diagnostic.subject.route),
      }
    : { kind: "api", id: apiScopeId };
}

function diagnosticCategory(diagnostic: GatewayDiagnostic): EstateAuditFinding["category"] {
  const opaque = diagnostic.code.includes("opaque");
  if (opaque) return "gateway_policy";
  if (
    diagnostic.code.includes("identity") ||
    diagnostic.code.includes("authentication") ||
    diagnostic.code.includes("auth_contract") ||
    diagnostic.code.includes("duplicate_api") ||
    diagnostic.code.includes("reserved_api")
  ) {
    return "identity";
  }
  if (diagnostic.subject?.route) return "route";
  return "contract";
}

function diagnosticOwner(diagnostic: GatewayDiagnostic): EstateAuditFinding["owner"] {
  if (diagnostic.subject?.artifact && !diagnostic.subject.api) {
    return "gateway_owner";
  }
  if (
    diagnostic.code.includes("opaque") ||
    diagnostic.code.includes("duplicate_api") ||
    diagnostic.code.includes("reserved_api") ||
    diagnostic.subject?.route
  ) {
    return "gateway_owner";
  }
  if (
    diagnostic.code.includes("identity") ||
    diagnostic.code.includes("authentication") ||
    diagnostic.code.includes("auth_contract")
  ) {
    return "identity_owner";
  }
  return diagnostic.subject ? "api_owner" : "anvil_adapter";
}

function diagnosticFinding(
  gatewayScope: string,
  diagnostic: GatewayDiagnostic,
  coordinate?: EstateApiCoordinate,
): EstateAuditFinding {
  const scope = diagnosticScope(gatewayScope, diagnostic, coordinate);
  const stableDiagnostic = {
    ...diagnostic,
    subject: diagnostic.subject
      ? {
          ...diagnostic.subject,
          artifact: diagnostic.subject.artifact
            ? {
                ...diagnostic.subject.artifact,
                origin: portableEvidenceOrigin(diagnostic.subject.artifact.origin),
              }
            : undefined,
        }
      : undefined,
    coordinate: diagnostic.coordinate
      ? {
          ...diagnostic.coordinate,
          origin: portableEvidenceOrigin(diagnostic.coordinate.origin),
        }
      : undefined,
  };
  return finding({
    id: `diagnostic:${diagnostic.code}:${hashCanonical({
      diagnostic: stableDiagnostic,
      scope,
    }).slice(0, 20)}`,
    severity: gatewayDiagnosticAuditSeverity(diagnostic),
    category: diagnosticCategory(diagnostic),
    code: diagnostic.code,
    scope,
    evidence: diagnostic.coordinate ? [diagnostic.coordinate] : [],
    message: diagnostic.message,
    owner: diagnosticOwner(diagnostic),
    action: diagnostic.code.includes("opaque")
      ? "Resolve this policy from the cited export evidence before certification."
      : diagnostic.level === "error"
        ? "Correct or re-export the affected gateway definition, then rerun the audit."
        : "Review the cited gateway evidence and record the decision before adoption.",
  });
}

function diagnosticFindingProjections(
  gatewayScope: string,
  diagnostic: GatewayDiagnostic,
  coordinates: readonly EstateApiCoordinate[],
): DiagnosticFindingProjection[] {
  if (!diagnostic.subject) {
    return [{ finding: diagnosticFinding(gatewayScope, diagnostic), global: true }];
  }
  const matchingCoordinates = [
    ...new Map(
      coordinates
        .filter((coordinate) => gatewayDiagnosticAppliesToSelection(diagnostic, coordinate))
        .map((coordinate) => [coordinate.coordinateKey, coordinate] as const),
    ).values(),
  ];
  if (matchingCoordinates.length === 0) {
    // Preserve the source-owned API/route scope even when malformed inventory
    // data prevented a complete normalized coordinate from being materialized.
    return [{ finding: diagnosticFinding(gatewayScope, diagnostic), global: false }];
  }
  return matchingCoordinates.map((coordinate) => ({
    finding: diagnosticFinding(gatewayScope, diagnostic, coordinate),
    coordinateKey: coordinate.coordinateKey,
    global: false,
  }));
}

function contractFidelity(api: GatewayApiSummary): EstateApiAudit["contract"] {
  if (api.contract?.fidelity === "full") return "full";
  if (api.contract?.fidelity === "route_only") return "route_only";
  return "missing";
}

function contractRemediation(api: GatewayApiSummary): {
  action: string;
  evidence: Array<{ origin: string; pointer?: string }>;
} {
  const candidates = (api.artifacts ?? []).filter(
    (artifact) =>
      artifact.role === "formal_definition" &&
      /(^|\/)Definitions\/(?:swagger|openapi)\.(?:ya?ml|json)$/i.test(artifact.path),
  );
  if (candidates.length === 1) {
    const artifact = candidates[0] as GatewayArtifactEvidence;
    return {
      action:
        `Use the native formal definition '${artifact.path}' from '${artifact.origin}' as ` +
        "`--spec <extracted-definition>`; inspect it and attest the public --gateway-url.",
      evidence: [{ origin: artifact.origin, pointer: artifact.path }],
    };
  }
  if (candidates.length > 1) {
    return {
      action:
        `Review the ${candidates.length} native formal-definition candidates under Definitions/ ` +
        "and select the contract for this API deliberately; do not auto-pick one. Then import it with --spec and an operator-attested --gateway-url.",
      evidence: candidates.map((artifact) => ({
        origin: artifact.origin,
        pointer: artifact.path,
      })),
    };
  }
  return {
    action:
      "Locate the original OpenAPI/Swagger contract; import with --spec and an operator-attested --gateway-url.",
    evidence: [],
  };
}

function auditApi(
  api: GatewayApiSummary,
  coordinate: EstateApiCoordinate,
  applicableDiagnostics: readonly EstateAuditFinding[] = [],
): {
  audit: EstateApiAudit;
  findings: EstateAuditFinding[];
} {
  const findings: EstateAuditFinding[] = [];
  const reasons: string[] = [];
  const contract = contractFidelity(api);
  if (contract !== "full") {
    const remediation = contractRemediation(api);
    const code =
      contract === "route_only" ? "gateway/route_only_contract" : "gateway/missing_contract";
    reasons.push(code);
    findings.push(
      finding({
        id: `api:${coordinate.coordinateKey}:contract`,
        severity: "warning",
        category: "contract",
        code,
        scope: { kind: "api", id: coordinate.coordinateKey },
        message:
          contract === "route_only"
            ? `${api.id} has gateway routes, not a full request/response contract.`
            : `${api.id} has no usable API contract in this export.`,
        owner: "api_owner",
        action: remediation.action,
        evidence: remediation.evidence,
      }),
    );
  }
  if (!api.authSummary) {
    reasons.push("gateway/authentication_unproven");
    findings.push(
      finding({
        id: `api:${coordinate.coordinateKey}:identity`,
        severity: "warning",
        category: "identity",
        code: "gateway/authentication_unproven",
        scope: { kind: "api", id: coordinate.coordinateKey },
        message: `${api.id} has no authentication summary proven by the adapter.`,
        owner: "identity_owner",
        action:
          "Reconcile the contract security scheme with gateway issuer, audience, carrier, and scopes before exposure.",
      }),
    );
  }
  for (const route of api.routes) {
    if (route.methods.length === 0) {
      const code = "gateway/route_method_unproven";
      reasons.push(code);
      findings.push(
        finding({
          id: `route:${coordinate.coordinateKey}:${route.id}:method`,
          severity: "blocking",
          category: "route",
          code,
          scope: { kind: "route", id: `${coordinate.coordinateKey}/${route.id}` },
          message: `Route ${route.id} does not declare a callable HTTP method.`,
          owner: "gateway_owner",
          action:
            "Add an explicit method in the export or exclude the route; never synthesize one.",
        }),
      );
    }
    if (route.paths.length === 0) {
      const code = "gateway/route_path_unproven";
      reasons.push(code);
      findings.push(
        finding({
          id: `route:${coordinate.coordinateKey}:${route.id}:path`,
          severity: "blocking",
          category: "route",
          code,
          scope: { kind: "route", id: `${coordinate.coordinateKey}/${route.id}` },
          message: `Route ${route.id} does not declare a callable path.`,
          owner: "gateway_owner",
          action: "Add an explicit path in the export or exclude the route; never synthesize '/'.",
        }),
      );
    }
  }
  for (const diagnostic of applicableDiagnostics) {
    if (diagnostic.severity !== "info") reasons.push(diagnostic.code);
  }
  const dispositionEvidence = [...findings, ...applicableDiagnostics];
  const disposition: EstateAuditDisposition = dispositionEvidence.some(
    (finding) => finding.severity === "blocking",
  )
    ? "blocked"
    : dispositionEvidence.some((finding) => finding.severity === "warning")
      ? "needs_evidence"
      : "candidate";
  return {
    audit: {
      id: api.id,
      ...(coordinate.apiVersion ? { apiVersion: coordinate.apiVersion } : {}),
      revision: coordinate.revision,
      environment: coordinate.environment,
      coordinateKey: coordinate.coordinateKey,
      name: api.name,
      lifecycle: api.lifecycle,
      owner: api.owner,
      routes: api.routes.length,
      contract,
      authentication: api.authSummary ? "described" : "unproven",
      disposition,
      reasons: [...new Set(reasons)].sort(),
    },
    findings,
  };
}

/**
 * Deterministic, read-only whole-estate triage. The inventory digest remains the
 * baseline identity; this report adds ownership and next actions without
 * pretending route tables are callable contracts.
 */
export function buildEstateAudit<T extends GatewayConnection>(
  adapter: GatewayAdapter<T>,
  snapshot: GatewayInventorySnapshot,
): EstateAuditReport {
  const capabilities = capabilityMatrix(adapter);
  const gatewayScope = `${adapter.kind}/${coordinatePart(snapshot.gateway.id)}`;
  const adapterFindings = capabilities
    .filter((row) => !["yes", "full"].includes(row.support))
    .map((row) => capabilityFinding(adapter.kind, row.dimension, row.support));
  const coordinates = snapshot.apis.flatMap((api) => estateApiCoordinates(api));
  const diagnosticProjections = [
    ...new Map(
      snapshot.diagnostics
        .flatMap((diagnostic) =>
          diagnosticFindingProjections(gatewayScope, diagnostic, coordinates),
        )
        .map((projection) => [projection.finding.id, projection] as const),
    ).values(),
  ];
  const globalDiagnostics = diagnosticProjections
    .filter((projection) => projection.global)
    .map((projection) => projection.finding);
  const apiResults = snapshot.apis
    .flatMap((api) =>
      estateApiCoordinates(api).map((coordinate) =>
        auditApi(api, coordinate, [
          ...globalDiagnostics,
          ...diagnosticProjections
            .filter((projection) => projection.coordinateKey === coordinate.coordinateKey)
            .map((projection) => projection.finding),
        ]),
      ),
    )
    .sort((a, b) => a.audit.coordinateKey.localeCompare(b.audit.coordinateKey));
  const diagnostics = diagnosticProjections.map((projection) => projection.finding);
  const findings = [
    ...adapterFindings,
    ...diagnostics,
    ...apiResults.flatMap((result) => result.findings),
  ].sort((a, b) => a.id.localeCompare(b.id));
  const apis = apiResults.map((result) => result.audit);
  const count = (severity: EstateAuditSeverity) =>
    findings.filter((finding) => finding.severity === severity).length;
  const diagnosticCount = (level: GatewayDiagnostic["level"]) =>
    snapshot.diagnostics.filter((diagnostic) => diagnostic.level === level).length;
  const gate =
    count("blocking") > 0 ? "blocked" : count("warning") > 0 ? "review_required" : "pass";
  const nextActions = [
    apis.some((api) => api.contract !== "full")
      ? "For each selected API, locate its real contract and import with --spec plus --gateway-url."
      : undefined,
    findings.some((finding) => finding.category === "gateway_policy")
      ? "Resolve every opaque gateway policy from its evidence coordinate before certification."
      : undefined,
    apis.some((api) => api.authentication === "unproven")
      ? "Reconcile IdP issuer, audience, credential carrier, and scopes with the API contract."
      : undefined,
    apis.some((api) => api.disposition === "candidate")
      ? "Import only candidate APIs that serve an agent intent; do not mirror the whole estate."
      : undefined,
  ].filter((action): action is string => action !== undefined);

  return {
    schemaVersion: 1,
    reportType: "anvil.gateway-estate-audit",
    vendor: adapter.kind,
    inventoryDigest: snapshot.digest,
    gate,
    summary: {
      apis: apis.length,
      routes: apis.reduce((sum, api) => sum + api.routes, 0),
      candidates: apis.filter((api) => api.disposition === "candidate").length,
      needsEvidence: apis.filter((api) => api.disposition === "needs_evidence").length,
      blocked: apis.filter((api) => api.disposition === "blocked").length,
      fullContracts: apis.filter((api) => api.contract === "full").length,
      routeOnlyContracts: apis.filter((api) => api.contract === "route_only").length,
      missingContracts: apis.filter((api) => api.contract === "missing").length,
      authenticationUnproven: apis.filter((api) => api.authentication === "unproven").length,
      diagnostics: {
        error: diagnosticCount("error"),
        warning: diagnosticCount("warning"),
        info: diagnosticCount("info"),
      },
      findings: {
        blocking: count("blocking"),
        warning: count("warning"),
        info: count("info"),
      },
    },
    adapter: {
      capabilities,
      limitations: capabilities
        .filter((row) => !["yes", "full"].includes(row.support))
        .map((row) => row.dimension),
    },
    findings,
    apis,
    nextActions,
  };
}
