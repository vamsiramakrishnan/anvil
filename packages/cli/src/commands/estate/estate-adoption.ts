import { hashCanonical, ServiceId } from "@anvil/air";
import {
  type GatewayApiSummary,
  type GatewayInventorySnapshot,
  gatewayAgentServiceId,
  resolveGatewayApiSelection,
} from "@anvil/compiler";
import { z } from "zod";
import {
  type EstateApiAudit,
  type EstateAuditFinding,
  type EstateAuditReport,
  estateApiCoordinate,
  estateApiCoordinates,
} from "./estate-audit.js";

const GatewayVendor = z.enum(["kong", "apigee", "wso2", "mulesoft", "api_connect"]);

const nonempty = z.string().trim().min(1);
const scopedGatewayId = nonempty.refine(
  (value) => value.toLowerCase() !== "unscoped",
  "'unscoped' is reserved for compatibility lineage whose gateway identity is not proven",
);
const httpsUrl = z
  .string()
  .url()
  .refine((value) => new URL(value).protocol === "https:", "gatewayUrl must use HTTPS");

export const EstateSelectionEntry = z
  .object({
    id: nonempty,
    apiVersion: nonempty.optional(),
    revision: nonempty.optional(),
    environment: nonempty.optional(),
    decision: z.enum(["triage", "selected", "deferred"]).default("triage"),
    semanticLane: z
      .enum(["deterministic_only", "agent_assisted", "manual_review"])
      .default("deterministic_only"),
    service: ServiceId.optional(),
    intent: nonempty.optional(),
    owner: nonempty.optional(),
    contract: nonempty.optional(),
    gatewayUrl: httpsUrl.optional(),
    manifest: nonempty.optional(),
    bundle: nonempty.optional(),
  })
  .strict();
export type EstateSelectionEntry = z.infer<typeof EstateSelectionEntry>;

export const EstateSelectionDocument = z
  .object({
    schemaVersion: z.literal(1),
    apis: z.array(EstateSelectionEntry),
  })
  .strict();
export type EstateSelectionDocument = z.infer<typeof EstateSelectionDocument>;

const ResolvedSelectionEntry = EstateSelectionEntry.extend({
  revision: nonempty,
  environment: nonempty,
  coordinateKey: nonempty,
});

const BaselineApi = z.object({
  coordinateKey: z.string(),
  id: z.string(),
  apiVersion: z.string().optional(),
  revision: z.string(),
  environment: z.string(),
  fingerprint: z.string(),
  owner: z.string().optional(),
  lifecycle: z.string().optional(),
  disposition: z.enum(["candidate", "needs_evidence", "blocked"]),
  contract: z.enum(["full", "route_only", "missing"]),
  authentication: z.enum(["described", "unproven"]),
});

const BaselineFinding = z.object({
  id: z.string(),
  fingerprint: z.string(),
  severity: z.enum(["blocking", "warning", "info"]),
  code: z.string(),
  owner: z.string(),
  scope: z.object({ kind: z.enum(["estate", "artifact", "api", "route"]), id: z.string() }),
});

const EstateBaseline = z.object({
  fingerprint: z.string(),
  adapterFingerprint: z.string(),
  apis: z.array(BaselineApi),
  findings: z.array(BaselineFinding),
});

const ChangeSet = z.object({
  added: z.array(z.string()),
  removed: z.array(z.string()),
  changed: z.array(z.string()),
});

const EstateChangeReport = z.object({
  status: z.enum(["initial", "unchanged", "changed"]),
  previousPlanHash: z.string().optional(),
  previousInventoryDigest: z.string().optional(),
  sourceChanged: z.boolean(),
  gatewayChanged: z.boolean(),
  adapterChanged: z.boolean(),
  selectionChanged: z.boolean(),
  hasChanges: z.boolean(),
  apis: ChangeSet,
  findings: ChangeSet,
});

const PlanStage = z.object({
  id: z.string(),
  lane: z.enum(["deterministic", "agent_assisted", "human_review"]),
  status: z.enum([
    "passed",
    "review_required",
    "blocked",
    "initial",
    "unchanged",
    "changed",
    "action_required",
    "ready",
    "pending",
    "optional",
  ]),
  owner: z.string(),
  dependsOn: z.array(z.string()),
  optional: z.boolean(),
  repeatable: z.boolean(),
  output: z.string(),
  nextCommand: z.string(),
  guard: z.string(),
});

const PlannedApi = z.object({
  coordinateKey: z.string(),
  id: z.string(),
  apiVersion: z.string().optional(),
  revision: z.string(),
  environment: z.string(),
  name: z.string(),
  nativeOwner: z.string().optional(),
  owner: z.string().optional(),
  ownerSource: z.enum(["selection", "gateway", "unassigned"]),
  decision: z.enum(["selected", "deferred", "triage"]),
  semanticLane: z.enum(["deterministic_only", "agent_assisted", "manual_review"]),
  intent: z.string().optional(),
  disposition: z.enum(["candidate", "needs_evidence", "blocked"]),
  contract: z.enum(["full", "route_only", "missing"]),
  authentication: z.enum(["described", "unproven"]),
  reasons: z.array(z.string()),
  status: z.enum([
    "triage_required",
    "deferred",
    "blocked",
    "gateway_identity_required",
    "owner_required",
    "intent_required",
    "contract_required",
    "ready_for_import",
  ]),
  nextGate: z.enum([
    "selection",
    "none",
    "gateway_remediation",
    "gateway_identity",
    "ownership",
    "intent_evidence",
    "contract_evidence",
    "receipt_bound_import",
  ]),
  nextCommand: z.string(),
  investigation: z.object({
    rail: z.enum(["anvil case", "manual review", "none"]),
    status: z.enum([
      "not_selected",
      "not_requested",
      "blocked_until_import",
      "available_after_import",
      "manual_review_required",
    ]),
    nextCommand: z.string(),
    authority: z.string(),
  }),
});

const OwnerWorkstream = z.object({
  owner: z.string(),
  apis: z.array(z.string()),
  readyForImport: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
  actionRequired: z.number().int().nonnegative(),
  nextCommand: z.string(),
});

const PlannedGatewayIdentity = z.discriminatedUnion("source", [
  z.object({ id: scopedGatewayId, source: z.literal("operator") }).strict(),
  z.object({ id: z.literal("unscoped"), source: z.literal("unscoped") }).strict(),
]);

export const EstateAdoptionPlan = z
  .object({
    schemaVersion: z.literal(1),
    reportType: z.literal("anvil.gateway-estate-adoption-plan"),
    planHash: z.string(),
    reportHash: z.string(),
    vendor: GatewayVendor,
    gateway: PlannedGatewayIdentity,
    inventoryDigest: z.string(),
    auditGate: z.enum(["pass", "review_required", "blocked"]),
    baseline: EstateBaseline,
    change: EstateChangeReport,
    selection: z.object({
      source: z.enum(["none", "cli", "file", "baseline"]),
      fingerprint: z.string(),
      entries: z.array(ResolvedSelectionEntry),
    }),
    summary: z.object({
      apis: z.number().int().nonnegative(),
      selected: z.number().int().nonnegative(),
      deferred: z.number().int().nonnegative(),
      triage: z.number().int().nonnegative(),
      gatewayIdentityReady: z.boolean(),
      unownedSelected: z.number().int().nonnegative(),
      blockedSelected: z.number().int().nonnegative(),
      readyForImport: z.number().int().nonnegative(),
      ownerWorkstreams: z.number().int().nonnegative(),
    }),
    workflow: z.object({
      authority: z.string(),
      stages: z.array(PlanStage),
    }),
    apis: z.array(PlannedApi),
    workstreams: z.array(OwnerWorkstream),
    nextActions: z.array(z.string()),
  })
  .strict();
export type EstateAdoptionPlan = z.infer<typeof EstateAdoptionPlan>;

export class EstateAdoptionPlanError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "EstateAdoptionPlanError";
  }
}

export function parseEstateSelection(input: unknown): EstateSelectionDocument {
  const parsed = EstateSelectionDocument.safeParse(input);
  if (!parsed.success) {
    throw new EstateAdoptionPlanError(
      "estate/invalid_selection",
      `Invalid estate selection: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; ")}`,
    );
  }
  return parsed.data;
}

/**
 * Materialize the complete inventory as an explicitly undecided selection
 * document. This is deliberately a triage queue, not a recommendation engine:
 * every coordinate starts deterministic-only and must be changed by a reviewer.
 */
export function buildEstateSelectionTemplate(
  snapshot: GatewayInventorySnapshot,
): EstateSelectionDocument {
  const apis = snapshot.apis
    .flatMap((api) =>
      estateApiCoordinates(api).map((coordinate) => ({
        id: api.id,
        ...(coordinate.apiVersion ? { apiVersion: coordinate.apiVersion } : {}),
        revision: coordinate.revision,
        environment: coordinate.environment,
        decision: "triage" as const,
        semanticLane: "deterministic_only" as const,
        ...(api.owner ? { owner: api.owner } : {}),
      })),
    )
    .sort((left, right) => {
      const leftKey = estateApiCoordinate(left, left.revision, left.environment).coordinateKey;
      const rightKey = estateApiCoordinate(right, right.revision, right.environment).coordinateKey;
      return leftKey.localeCompare(rightKey);
    });
  const seenCoordinates = new Set<string>();
  const duplicateCoordinates = new Set<string>();
  for (const api of apis) {
    const coordinate = estateApiCoordinate(api, api.revision, api.environment).coordinateKey;
    if (seenCoordinates.has(coordinate)) duplicateCoordinates.add(coordinate);
    seenCoordinates.add(coordinate);
  }
  if (duplicateCoordinates.size > 0) {
    throw new EstateAdoptionPlanError(
      "estate/duplicate_inventory_coordinate",
      `Cannot initialize selection: inventory contains duplicate API coordinate(s): ${[...duplicateCoordinates].sort().join(", ")}.`,
    );
  }
  return EstateSelectionDocument.parse({ schemaVersion: 1, apis });
}

export function parseEstateAdoptionPlan(input: unknown): EstateAdoptionPlan {
  const parsed = EstateAdoptionPlan.safeParse(input);
  if (!parsed.success) {
    throw new EstateAdoptionPlanError(
      "estate/invalid_baseline",
      `Invalid estate adoption baseline: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; ")}`,
    );
  }
  const expected = planHashOf(parsed.data);
  if (parsed.data.planHash !== expected) {
    throw new EstateAdoptionPlanError(
      "estate/baseline_hash_mismatch",
      `Estate adoption baseline hash mismatch: recorded ${parsed.data.planHash}, computed ${expected}.`,
    );
  }
  const expectedReport = reportHashOf(parsed.data);
  if (parsed.data.reportHash !== expectedReport) {
    throw new EstateAdoptionPlanError(
      "estate/baseline_report_hash_mismatch",
      `Estate adoption baseline report hash mismatch: recorded ${parsed.data.reportHash}, computed ${expectedReport}.`,
    );
  }
  return parsed.data;
}

interface BuildPlanOptions {
  selectionEntries?: readonly EstateSelectionEntry[];
  selectionSource?: "cli" | "file";
  prior?: EstateAdoptionPlan;
  gatewayId?: string;
  exportEntry?: string;
}

function withoutOrigin(api: GatewayApiSummary): unknown {
  const portableOrigin = (origin: string): string =>
    origin.replace(/^gateway-export:\/\/sha256:[0-9a-f]{64}/, "gateway-export://<content-digest>");
  return {
    ...api,
    contract: api.contract
      ? {
          ...api.contract,
          location: {
            ...api.contract.location,
            origin: portableOrigin(api.contract.location.origin),
          },
        }
      : undefined,
    identityEvidence: api.identityEvidence?.map((evidence) => ({
      ...evidence,
      coordinate: {
        ...evidence.coordinate,
        origin: portableOrigin(evidence.coordinate.origin),
      },
    })),
    artifacts: api.artifacts?.map((artifact) => ({
      kind: artifact.kind,
      role: artifact.role,
      path: artifact.path,
      digest: artifact.digest,
      bytes: artifact.bytes,
      origin: portableOrigin(artifact.origin),
      parent: artifact.parent
        ? {
            ...artifact.parent,
            origin: portableOrigin(artifact.parent.origin),
          }
        : undefined,
    })),
  };
}

function findingWithoutOrigin(finding: EstateAuditFinding): unknown {
  return {
    ...finding,
    evidence: finding.evidence.map((coordinate) => ({ ...coordinate, origin: undefined })),
  };
}

function compareRecords<T extends { fingerprint: string }>(
  previous: readonly T[],
  current: readonly T[],
  keyOf: (record: T) => string,
): z.infer<typeof ChangeSet> {
  const before = new Map(previous.map((record) => [keyOf(record), record.fingerprint]));
  const after = new Map(current.map((record) => [keyOf(record), record.fingerprint]));
  return {
    added: [...after.keys()].filter((id) => !before.has(id)).sort(),
    removed: [...before.keys()].filter((id) => !after.has(id)).sort(),
    changed: [...after.keys()]
      .filter((id) => before.has(id) && before.get(id) !== after.get(id))
      .sort(),
  };
}

function hasRecordChanges(changes: z.infer<typeof ChangeSet>): boolean {
  return changes.added.length + changes.removed.length + changes.changed.length > 0;
}

function shell(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function importCommand(
  vendor: string,
  api: EstateApiAudit,
  entry: EstateSelectionEntry | undefined,
  gatewayId: string | undefined,
  exportEntry: string | undefined,
): { command: string; bundle: string } {
  const bundle = entry?.bundle ?? "<bundle-from-import-report>";
  const service =
    entry?.service ??
    (gatewayId
      ? gatewayAgentServiceId({
          vendor: GatewayVendor.parse(vendor),
          gatewayId,
          apiId: api.id,
          ...(api.apiVersion ? { apiVersion: api.apiVersion } : {}),
          revision: api.revision,
          environment: api.environment,
        })
      : undefined);
  const args = [
    "anvil",
    "estate",
    "import",
    "<export>",
    "--vendor",
    vendor,
    ...(exportEntry ? ["--entry", shell(exportEntry)] : []),
    "--api",
    shell(api.id),
    ...(api.apiVersion ? ["--api-version", shell(api.apiVersion)] : []),
    "--revision",
    shell(api.revision),
    "--environment",
    shell(api.environment),
    "--gateway-id",
    gatewayId ? shell(gatewayId) : "<stable-gateway-id>",
    "--strict-identity",
    ...(service ? ["--service", shell(service)] : []),
    "--spec",
    entry?.contract ? shell(entry.contract) : "<contract.openapi.yaml>",
    "--gateway-url",
    entry?.gatewayUrl ? shell(entry.gatewayUrl) : "<https://gateway.example/base>",
    ...(entry?.manifest ? ["--manifest", shell(entry.manifest)] : []),
    ...(entry?.bundle ? ["--out", shell(entry.bundle)] : []),
    "--json",
  ];
  return { command: args.join(" "), bundle };
}

function caseCommand(bundle: string): string {
  return `anvil distill ${shell(bundle)} --as-enrich-plan --write ${shell(`${bundle}/enrich-plan.json`)} && anvil case list ${shell(bundle)}`;
}

function stageStatusForAudit(gate: EstateAuditReport["gate"]): z.infer<typeof PlanStage>["status"] {
  return gate === "pass" ? "passed" : gate === "blocked" ? "blocked" : "review_required";
}

function planHashOf(
  plan: Omit<EstateAdoptionPlan, "planHash" | "reportHash"> | EstateAdoptionPlan,
): string {
  return hashCanonical({
    schemaVersion: plan.schemaVersion,
    reportType: plan.reportType,
    vendor: plan.vendor,
    gateway: plan.gateway,
    inventoryDigest: plan.inventoryDigest,
    auditGate: plan.auditGate,
    baseline: plan.baseline,
    selection: {
      fingerprint: plan.selection.fingerprint,
      entries: plan.selection.entries,
    },
    summary: plan.summary,
    workflow: {
      authority: plan.workflow.authority,
      stages: plan.workflow.stages.map(({ status: _dynamicStatus, ...stableStage }) => stableStage),
    },
    apis: plan.apis.map(({ nextCommand: _nextCommand, ...api }) => api),
    workstreams: plan.workstreams.map(({ nextCommand: _nextCommand, ...workstream }) => workstream),
    nextActions: plan.nextActions,
  });
}

function reportHashOf(plan: Omit<EstateAdoptionPlan, "reportHash"> | EstateAdoptionPlan): string {
  const { reportHash: _reportHash, ...report } = plan as EstateAdoptionPlan;
  return hashCanonical(report);
}

export function buildEstateAdoptionPlan(
  snapshot: GatewayInventorySnapshot,
  audit: EstateAuditReport,
  options: BuildPlanOptions = {},
): EstateAdoptionPlan {
  if (audit.vendor !== snapshot.gateway.kind) {
    throw new EstateAdoptionPlanError(
      "estate/vendor_mismatch",
      `Audit vendor '${audit.vendor}' does not match inventory vendor '${snapshot.gateway.kind}'.`,
    );
  }
  if (options.prior && options.prior.vendor !== audit.vendor) {
    throw new EstateAdoptionPlanError(
      "estate/baseline_vendor_mismatch",
      `Baseline vendor '${options.prior.vendor}' does not match current vendor '${audit.vendor}'.`,
    );
  }

  const inherited = options.selectionEntries === undefined && options.prior !== undefined;
  const inventoryCoordinates = snapshot.apis.flatMap((api) =>
    estateApiCoordinates(api).map((coordinate) => ({ api, coordinate })),
  );
  const coordinateIndex = new Map(
    inventoryCoordinates.map((entry) => [entry.coordinate.coordinateKey, entry]),
  );
  const currentCoordinates = new Set(coordinateIndex.keys());
  const rawSelectionEntries = [
    ...(options.selectionEntries ?? options.prior?.selection.entries ?? []),
  ].filter((entry) => {
    if (!inherited || !entry.revision || !entry.environment) return true;
    return currentCoordinates.has(
      estateApiCoordinate(entry, entry.revision, entry.environment).coordinateKey,
    );
  });
  const selectionEntries = rawSelectionEntries
    .map((entry) => {
      const requestedCoordinate =
        entry.revision && entry.environment
          ? estateApiCoordinate(entry, entry.revision, entry.environment).coordinateKey
          : undefined;
      const indexed = requestedCoordinate ? coordinateIndex.get(requestedCoordinate) : undefined;
      let resolvedApi: GatewayApiSummary;
      let resolvedRevision: string;
      let resolvedEnvironment: string;
      if (indexed) {
        resolvedApi = indexed.api;
        resolvedRevision = indexed.coordinate.revision;
        resolvedEnvironment = indexed.coordinate.environment;
      } else {
        const resolved = resolveGatewayApiSelection(snapshot.apis, {
          apiId: entry.id,
          apiVersion: entry.apiVersion,
          revision: entry.revision,
          environment: entry.environment,
        });
        if (!resolved.ok) {
          throw new EstateAdoptionPlanError(resolved.failure.code, resolved.failure.message);
        }
        resolvedApi = resolved.selection.api;
        resolvedRevision = resolved.selection.revision;
        resolvedEnvironment = resolved.selection.environment;
      }
      const coordinate = estateApiCoordinate(resolvedApi, resolvedRevision, resolvedEnvironment);
      return ResolvedSelectionEntry.parse({
        ...entry,
        ...(coordinate.apiVersion ? { apiVersion: coordinate.apiVersion } : {}),
        revision: coordinate.revision,
        environment: coordinate.environment,
        coordinateKey: coordinate.coordinateKey,
      });
    })
    .sort((a, b) => a.coordinateKey.localeCompare(b.coordinateKey));
  const seenSelections = new Set<string>();
  const duplicateSelections = new Set<string>();
  for (const entry of selectionEntries) {
    if (seenSelections.has(entry.coordinateKey)) duplicateSelections.add(entry.coordinateKey);
    seenSelections.add(entry.coordinateKey);
  }
  if (duplicateSelections.size > 0) {
    throw new EstateAdoptionPlanError(
      "estate/duplicate_selection",
      `Selection contains duplicate API coordinate(s): ${[...duplicateSelections].sort().join(", ")}.`,
    );
  }
  const explicitBundles = new Map<string, string[]>();
  const explicitServices = new Map<string, string[]>();
  for (const entry of selectionEntries) {
    if (entry.bundle) {
      explicitBundles.set(entry.bundle, [
        ...(explicitBundles.get(entry.bundle) ?? []),
        entry.coordinateKey,
      ]);
    }
    if (entry.decision === "selected" && entry.service) {
      explicitServices.set(entry.service, [
        ...(explicitServices.get(entry.service) ?? []),
        entry.coordinateKey,
      ]);
    }
  }
  const bundleCollisions = [...explicitBundles.entries()].filter(
    ([, coordinates]) => coordinates.length > 1,
  );
  if (bundleCollisions.length > 0) {
    throw new EstateAdoptionPlanError(
      "estate/duplicate_bundle_target",
      `Selection routes distinct API coordinates to the same explicit bundle: ${bundleCollisions
        .map(([bundle, coordinates]) => `${bundle} <= ${coordinates.sort().join(", ")}`)
        .join("; ")}. Omit bundle to use the importer's coordinate-safe default.`,
    );
  }
  const serviceCollisions = [...explicitServices.entries()].filter(
    ([, coordinates]) => coordinates.length > 1,
  );
  if (serviceCollisions.length > 0) {
    throw new EstateAdoptionPlanError(
      "estate/duplicate_service_target",
      `Selection assigns distinct API coordinates the same agent-facing service id: ${serviceCollisions
        .map(([service, coordinates]) => `${service} <= ${coordinates.sort().join(", ")}`)
        .join(
          "; ",
        )}. Choose unique service values so CLI, MCP, skill, and package names cannot collide when composed.`,
    );
  }
  const selectionByCoordinate = new Map(
    selectionEntries.map((entry) => [entry.coordinateKey, entry]),
  );
  const selectionFingerprint = hashCanonical(selectionEntries);
  const selectionSource =
    selectionEntries.length === 0
      ? "none"
      : inherited
        ? "baseline"
        : (options.selectionSource ?? "cli");
  const explicitGatewayId = options.gatewayId?.trim();
  if (explicitGatewayId?.toLowerCase() === "unscoped") {
    throw new EstateAdoptionPlanError(
      "estate/invalid_gateway_id",
      "Gateway id 'unscoped' is reserved for compatibility lineage whose identity is not proven.",
    );
  }
  const inheritedGatewayId =
    options.gatewayId === undefined && options.prior?.gateway.source === "operator"
      ? options.prior.gateway.id
      : undefined;
  if (inheritedGatewayId?.toLowerCase() === "unscoped") {
    throw new EstateAdoptionPlanError(
      "estate/invalid_gateway_id",
      "Baseline gateway id 'unscoped' cannot be operator-proven; supply the real stable gateway identity.",
    );
  }
  const gatewayId = explicitGatewayId || inheritedGatewayId;
  const gateway: z.infer<typeof PlannedGatewayIdentity> = gatewayId
    ? { id: gatewayId, source: "operator" }
    : { id: "unscoped", source: "unscoped" };

  const auditByCoordinate = new Map(audit.apis.map((api) => [api.coordinateKey, api]));
  const baselineApis = inventoryCoordinates
    .map(({ api, coordinate }) => {
      const apiAudit = auditByCoordinate.get(coordinate.coordinateKey);
      if (!apiAudit) {
        throw new EstateAdoptionPlanError(
          "estate/audit_inventory_mismatch",
          `Audit omitted inventory API coordinate '${coordinate.coordinateKey}'.`,
        );
      }
      return {
        coordinateKey: coordinate.coordinateKey,
        id: api.id,
        ...(coordinate.apiVersion ? { apiVersion: coordinate.apiVersion } : {}),
        revision: coordinate.revision,
        environment: coordinate.environment,
        fingerprint: hashCanonical({ inventory: withoutOrigin(api), audit: apiAudit }),
        owner: apiAudit.owner,
        lifecycle: apiAudit.lifecycle,
        disposition: apiAudit.disposition,
        contract: apiAudit.contract,
        authentication: apiAudit.authentication,
      };
    })
    .sort((a, b) => a.coordinateKey.localeCompare(b.coordinateKey));
  const baselineFindings = audit.findings
    .map((finding) => ({
      id: finding.id,
      fingerprint: hashCanonical(findingWithoutOrigin(finding)),
      severity: finding.severity,
      code: finding.code,
      owner: finding.owner,
      scope: finding.scope,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const adapterFingerprint = hashCanonical(audit.adapter);
  const baselineCore = {
    adapterFingerprint,
    apis: baselineApis,
    findings: baselineFindings,
  };
  const baseline = {
    fingerprint: hashCanonical(baselineCore),
    ...baselineCore,
  };

  const apiChanges = compareRecords(
    options.prior?.baseline.apis ?? [],
    baseline.apis,
    (record) => record.coordinateKey,
  );
  const findingChanges = compareRecords(
    options.prior?.baseline.findings ?? [],
    baseline.findings,
    (record) => record.id,
  );
  const sourceChanged =
    options.prior !== undefined && options.prior.inventoryDigest !== snapshot.digest;
  const adapterChanged =
    options.prior !== undefined &&
    options.prior.baseline.adapterFingerprint !== baseline.adapterFingerprint;
  const gatewayChanged =
    options.prior !== undefined &&
    (options.prior.gateway.id !== gateway.id || options.prior.gateway.source !== gateway.source);
  const selectionChanged =
    options.prior !== undefined && options.prior.selection.fingerprint !== selectionFingerprint;
  const hasChanges =
    options.prior !== undefined &&
    (sourceChanged ||
      gatewayChanged ||
      adapterChanged ||
      selectionChanged ||
      hasRecordChanges(apiChanges) ||
      hasRecordChanges(findingChanges));
  const change = {
    status:
      options.prior === undefined
        ? ("initial" as const)
        : hasChanges
          ? ("changed" as const)
          : ("unchanged" as const),
    previousPlanHash: options.prior?.planHash,
    previousInventoryDigest: options.prior?.inventoryDigest,
    sourceChanged,
    gatewayChanged,
    adapterChanged,
    selectionChanged,
    hasChanges,
    apis: apiChanges,
    findings: findingChanges,
  };

  const inventoryByCoordinate = new Map(
    inventoryCoordinates.map(({ api, coordinate }) => [coordinate.coordinateKey, api]),
  );
  const plannedApis = audit.apis
    .map((api) => {
      if (!inventoryByCoordinate.has(api.coordinateKey)) {
        throw new EstateAdoptionPlanError(
          "estate/audit_inventory_mismatch",
          `Inventory omitted audited API coordinate '${api.coordinateKey}'.`,
        );
      }
      const selection = selectionByCoordinate.get(api.coordinateKey);
      const decision: z.infer<typeof PlannedApi>["decision"] = selection?.decision ?? "triage";
      const semanticLane: z.infer<typeof PlannedApi>["semanticLane"] =
        selection?.semanticLane ?? "deterministic_only";
      const owner = selection?.owner ?? api.owner;
      const ownerSource = selection?.owner
        ? ("selection" as const)
        : api.owner
          ? ("gateway" as const)
          : ("unassigned" as const);
      const { command: importNext, bundle } = importCommand(
        audit.vendor,
        api,
        selection,
        gatewayId,
        options.exportEntry,
      );
      const importPrerequisites =
        decision === "selected" &&
        api.disposition !== "blocked" &&
        gateway.source === "operator" &&
        Boolean(owner && selection?.intent && selection.contract && selection.gatewayUrl);
      const investigation =
        semanticLane === "agent_assisted"
          ? {
              rail: "anvil case" as const,
              status: importPrerequisites
                ? ("available_after_import" as const)
                : ("blocked_until_import" as const),
              nextCommand: caseCommand(bundle),
              authority:
                "CASE and distill/enrich may gather evidence and propose a manifest patch only. They cannot approve operations, edit AIR, satisfy lint, or replace receipt-bound re-import and verification.",
            }
          : semanticLane === "manual_review"
            ? {
                rail: "manual review" as const,
                status:
                  decision === "selected"
                    ? ("manual_review_required" as const)
                    : ("not_selected" as const),
                nextCommand: `anvil inspect ${shell(bundle)} && anvil distill ${shell(bundle)} --as-enrich-plan`,
                authority:
                  "A reviewer may accept evidence into a supplemental manifest, but cannot bypass receipt-bound re-import, lint, approval policy, or verification.",
              }
            : {
                rail: "none" as const,
                status:
                  decision === "selected" ? ("not_requested" as const) : ("not_selected" as const),
                nextCommand: `anvil inspect ${shell(bundle)} && anvil lint ${shell(bundle)}`,
                authority:
                  "No agent or manual semantic lane was requested. Deterministic checks report gaps but do not pretend to resolve them.",
              };
      const common = {
        coordinateKey: api.coordinateKey,
        id: api.id,
        ...(api.apiVersion ? { apiVersion: api.apiVersion } : {}),
        revision: api.revision,
        environment: api.environment,
        name: api.name,
        nativeOwner: api.owner,
        owner,
        ownerSource,
        decision,
        semanticLane,
        intent: selection?.intent,
        disposition: api.disposition,
        contract: api.contract,
        authentication: api.authentication,
        reasons: api.reasons,
        investigation,
      };

      if (decision === "triage") {
        return {
          ...common,
          status: "triage_required" as const,
          nextGate: "selection" as const,
          nextCommand: `Record '${api.coordinateKey}' as selected or deferred in <selection.yaml>, with business intent and accountable owner when selected.`,
        };
      }
      if (decision === "deferred") {
        return {
          ...common,
          status: "deferred" as const,
          nextGate: "none" as const,
          nextCommand: "No action. Re-select only when a concrete agent intent exists.",
        };
      }
      if (api.disposition === "blocked") {
        return {
          ...common,
          status: "blocked" as const,
          nextGate: "gateway_remediation" as const,
          nextCommand: `anvil estate audit <export> --vendor ${audit.vendor} --json`,
        };
      }
      if (gateway.source !== "operator") {
        return {
          ...common,
          status: "gateway_identity_required" as const,
          nextGate: "gateway_identity" as const,
          nextCommand: `Re-run this plan with --gateway-id <stable-gateway-id>; import will use --strict-identity for '${api.coordinateKey}'.`,
        };
      }
      if (!owner) {
        return {
          ...common,
          status: "owner_required" as const,
          nextGate: "ownership" as const,
          nextCommand: `Add an accountable owner for '${api.coordinateKey}' to <selection.yaml>.`,
        };
      }
      if (!selection?.intent) {
        return {
          ...common,
          status: "intent_required" as const,
          nextGate: "intent_evidence" as const,
          nextCommand: `Record the concrete agent intent for '${api.coordinateKey}' in <selection.yaml>; do not infer it from route names.`,
        };
      }
      if (!selection.contract || !selection.gatewayUrl) {
        return {
          ...common,
          status: "contract_required" as const,
          nextGate: "contract_evidence" as const,
          nextCommand: importNext,
        };
      }
      return {
        ...common,
        status: "ready_for_import" as const,
        nextGate: "receipt_bound_import" as const,
        nextCommand: importNext,
      };
    })
    .sort((a, b) => a.coordinateKey.localeCompare(b.coordinateKey));

  const selected = plannedApis.filter((api) => api.decision === "selected");
  const ownerGroups = new Map<string, typeof selected>();
  for (const api of selected) {
    const owner = api.owner ?? "unassigned";
    ownerGroups.set(owner, [...(ownerGroups.get(owner) ?? []), api]);
  }
  const workstreams = [...ownerGroups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([owner, apis]) => ({
      owner,
      apis: apis.map((api) => api.coordinateKey),
      readyForImport: apis.filter((api) => api.status === "ready_for_import").length,
      blocked: apis.filter((api) => api.status === "blocked").length,
      actionRequired: apis.filter((api) =>
        [
          "gateway_identity_required",
          "owner_required",
          "intent_required",
          "contract_required",
        ].includes(api.status),
      ).length,
      nextCommand: apis[0]?.nextCommand ?? "No selected APIs.",
    }));
  const summary = {
    apis: plannedApis.length,
    selected: selected.length,
    deferred: plannedApis.filter((api) => api.decision === "deferred").length,
    triage: plannedApis.filter((api) => api.decision === "triage").length,
    gatewayIdentityReady: gateway.source === "operator",
    unownedSelected: selected.filter((api) => !api.owner).length,
    blockedSelected: selected.filter((api) => api.status === "blocked").length,
    readyForImport: selected.filter((api) => api.status === "ready_for_import").length,
    ownerWorkstreams: workstreams.length,
  };

  const workflow = {
    authority:
      "Deterministic Anvil gates decide what may be exposed. Agent-assisted stages are proposal-only and may be mixed in or repeated after import; they cannot self-approve, mutate AIR, approve a deployment, register a platform target, or bypass inspect, lint, receipt-bound re-import, and verify.",
    stages: [
      {
        id: "inventory",
        lane: "deterministic" as const,
        status: "passed" as const,
        owner: "anvil",
        dependsOn: [],
        optional: false,
        repeatable: true,
        output: "content-addressed gateway inventory",
        nextCommand: `anvil estate audit <export> --vendor ${audit.vendor} --check`,
        guard:
          "The adapter-supported document boundary is authoritative; archives are containers, not native-artifact translators.",
      },
      {
        id: "audit",
        lane: "deterministic" as const,
        status: stageStatusForAudit(audit.gate),
        owner: "anvil",
        dependsOn: ["inventory"],
        optional: false,
        repeatable: true,
        output: "gateway estate audit findings",
        nextCommand: `anvil estate audit <export> --vendor ${audit.vendor} --json`,
        guard: "Blocking routes and opaque policies remain blockers; a plan never waives them.",
      },
      {
        id: "baseline",
        lane: "deterministic" as const,
        status: change.status,
        owner: "platform_owner",
        dependsOn: ["inventory", "audit"],
        optional: false,
        repeatable: true,
        output: "checked-in adoption plan and semantic/source change report",
        nextCommand: `anvil estate plan <export> --vendor ${audit.vendor} --baseline <reviewed-plan.json> --check`,
        guard:
          "Promote a new baseline only after reviewing source, API, finding, adapter, and selection changes.",
      },
      {
        id: "selection",
        lane: "human_review" as const,
        status: summary.triage > 0 ? ("action_required" as const) : ("passed" as const),
        owner: "api_owner",
        dependsOn: ["audit"],
        optional: false,
        repeatable: true,
        output: "selected/deferred decisions with business intent and accountable owner",
        nextCommand: `anvil estate plan <export> --vendor ${audit.vendor} --gateway-id <stable-gateway-id> --selection <selection.yaml> --out <adoption-plan.json>`,
        guard:
          "No route name, traffic count, or coding agent may invent business intent or select the whole estate automatically.",
      },
      {
        id: "gateway_identity",
        lane: "human_review" as const,
        status: gateway.source === "operator" ? ("passed" as const) : ("action_required" as const),
        owner: "gateway_owner",
        dependsOn: ["inventory"],
        optional: false,
        repeatable: false,
        output: "stable gateway control-plane identity",
        nextCommand: `anvil estate plan <export> --vendor ${audit.vendor} --gateway-id <stable-gateway-id> --baseline <reviewed-plan.json>`,
        guard:
          "Offline bytes do not prove the control-plane identity. Every generated import command uses --gateway-id and --strict-identity.",
      },
      {
        id: "receipt_bound_import",
        lane: "deterministic" as const,
        status:
          summary.readyForImport > 0
            ? ("ready" as const)
            : summary.blockedSelected > 0
              ? ("blocked" as const)
              : ("pending" as const),
        owner: "api_owner",
        dependsOn: ["selection", "gateway_identity"],
        optional: false,
        repeatable: true,
        output: "one receipt-bound Anvil bundle per selected API",
        nextCommand: "Run each selected API's nextCommand; import remains API-by-API.",
        guard:
          "A real contract and attested gateway URL are required; route-only synthesis is assessment-only.",
      },
      {
        id: "case_investigation",
        lane: "agent_assisted" as const,
        status: "optional" as const,
        owner: "api_owner",
        dependsOn: ["receipt_bound_import"],
        optional: true,
        repeatable: true,
        output: "CASE evidence, claims, critique, tests, and proposal",
        nextCommand:
          "anvil distill <bundle> --as-enrich-plan --write <bundle>/enrich-plan.json && anvil case list <bundle>",
        guard:
          "Runs only for APIs whose selection explicitly sets semanticLane: agent_assisted. Use only implemented CASE skills. Agent output is a proposal and cannot approve operations, edit AIR, or satisfy a deterministic gate.",
      },
      {
        id: "manifest_review",
        lane: "human_review" as const,
        status: "pending" as const,
        owner: "api_owner",
        dependsOn: ["case_investigation"],
        optional: true,
        repeatable: true,
        output: "reviewed supplemental manifest",
        nextCommand: "anvil case close <case-dir> <bundle> --json",
        guard:
          "Review the proposal, encode accepted semantics in the manifest, then re-run the original estate import; never post-approve receipt-backed AIR.",
      },
      {
        id: "verify",
        lane: "deterministic" as const,
        status: "pending" as const,
        owner: "anvil",
        dependsOn: ["receipt_bound_import"],
        optional: false,
        repeatable: true,
        output: "inspect, lint, and immutable import verification evidence",
        nextCommand:
          "anvil inspect <bundle> && anvil lint <bundle> && anvil estate verify <import-id> --bundle <bundle>",
        guard:
          "Only deterministic gates authorize exposure; investigation and baseline acceptance never do.",
      },
      {
        id: "capability_composition",
        lane: "agent_assisted" as const,
        status: "pending" as const,
        owner: "api_owner",
        dependsOn: ["verify"],
        optional: false,
        repeatable: true,
        output: "evidence-backed, budgeted capability proposals over verified operations",
        nextCommand: "anvil capability propose <bundle>",
        guard:
          "A coding agent may suggest how operations compose around a user job, but may not invent business intent, add operations, approve a capability, or exceed the disclosed tool budget.",
      },
      {
        id: "capability_review",
        lane: "human_review" as const,
        status: "pending" as const,
        owner: "api_owner",
        dependsOn: ["capability_composition"],
        optional: false,
        repeatable: true,
        output: "approved or rejected capability boundary with an accountable review note",
        nextCommand:
          "anvil capability show <bundle> <capability-id> --operations --auth --evidence && anvil capability approve <bundle> <capability-id> --note <review-note>",
        guard:
          "Approval is a human decision over exact operation IDs, workflow dependencies, identity groups, and disclosure budget; agent proposals carry no authority.",
      },
      {
        id: "capability_build",
        lane: "deterministic" as const,
        status: "pending" as const,
        owner: "anvil",
        dependsOn: ["capability_review"],
        optional: false,
        repeatable: true,
        output: "narrow capability bundle retaining gateway and deployment lineage",
        nextCommand: "anvil build <bundle> <approved-capability-id>",
        guard:
          "Only an approved capability builds. The child bundle must preserve the parent gateway receipt, deployment namespace, auth contract, and write posture.",
      },
      {
        id: "release_configuration",
        lane: "human_review" as const,
        status: "pending" as const,
        owner: "platform_owner",
        dependsOn: ["capability_build"],
        optional: false,
        repeatable: true,
        output:
          "reviewed environment, Gemini Enterprise surface/location, connector IdP, upstream credentials, and durable-ledger plan",
        nextCommand:
          "anvil target gemini-enterprise <capability-bundle> --surface <custom-mcp|agent-gateway> --server-auth <oauth|no-auth> --endpoint <https-mcp-url> --project <project-id> --project-number <number> --location <ge-location> --engine <engine> --idp <provider> ... && anvil deploy credentials <capability-bundle> --env <environment> --project <project-id> && anvil deploy ledger <capability-bundle> --project <project-id> --database <firestore-database>",
        guard:
          "Gemini sign-in, connector OAuth, and upstream API identity are separate planes. Locations, issuer, audience, credential carrier, secrets, database mode, and immutable dedicated-database location require explicit operator evidence.",
      },
      {
        id: "executable_proof",
        lane: "deterministic" as const,
        status: "pending" as const,
        owner: "anvil",
        dependsOn: ["release_configuration"],
        optional: false,
        repeatable: true,
        output: "current-hash static assurance and executable loopback evidence",
        nextCommand:
          "anvil certify <capability-bundle> && anvil selftest <capability-bundle> && anvil conformance <capability-bundle> && anvil simulate <capability-bundle>",
        guard:
          "Every report must pass against the exact bundle bytes. Offline wiring, target generation, and a deployment plan are not live readiness.",
      },
      {
        id: "deployment_approval",
        lane: "human_review" as const,
        status: "pending" as const,
        owner: "platform_owner",
        dependsOn: ["executable_proof"],
        optional: false,
        repeatable: true,
        output: "reviewed immutable production deployment plan",
        nextCommand: "anvil publish <capability-bundle> --target cloud-run --env <environment>",
        guard:
          "Publish prepares a plan only. A platform owner reviews and applies the exact plan; neither Anvil nor a coding agent silently creates cloud resources or registers Gemini Enterprise.",
      },
      {
        id: "live_proof",
        lane: "deterministic" as const,
        status: "pending" as const,
        owner: "platform_owner",
        dependsOn: ["deployment_approval"],
        optional: false,
        repeatable: true,
        output:
          "exact-runtime attestation, live IdP coverage, safe-read proof per identity group, and write-ledger readiness",
        nextCommand:
          "anvil conformance <capability-bundle> --live <live-config.json> && curl --fail <https-service-url>/readyz",
        guard:
          "Live proof never invokes a mutation to manufacture evidence. Delegated/OBO groups need successful opted-in reads; write-only groups remain unverified, and /readyz must prove the configured ledger before writes are enabled.",
      },
    ],
  };
  const nextActions = [
    summary.triage > 0
      ? `Classify ${summary.triage} API(s) as selected or deferred in one versioned selection file.`
      : undefined,
    summary.unownedSelected > 0
      ? `Assign accountable owners to ${summary.unownedSelected} selected API(s).`
      : undefined,
    !summary.gatewayIdentityReady
      ? "Set one stable --gateway-id; every planned import then uses --strict-identity."
      : undefined,
    summary.blockedSelected > 0
      ? `Resolve deterministic gateway blockers for ${summary.blockedSelected} selected API(s).`
      : undefined,
    selected.some((api) => api.status === "intent_required")
      ? "Record concrete agent intents; do not infer them from view/BFF route names."
      : undefined,
    selected.some((api) => api.status === "contract_required")
      ? "Locate each selected API's real contract and public gateway URL."
      : undefined,
    summary.readyForImport > 0
      ? `Run ${summary.readyForImport} receipt-bound import command(s), one API at a time.`
      : undefined,
    options.prior && change.hasChanges
      ? "Review the baseline change report before promoting this plan."
      : undefined,
  ].filter((action): action is string => action !== undefined);

  const withoutHashes: Omit<EstateAdoptionPlan, "planHash" | "reportHash"> = {
    schemaVersion: 1,
    reportType: "anvil.gateway-estate-adoption-plan",
    vendor: GatewayVendor.parse(audit.vendor),
    gateway,
    inventoryDigest: snapshot.digest,
    auditGate: audit.gate,
    baseline,
    change,
    selection: {
      source: selectionSource,
      fingerprint: selectionFingerprint,
      entries: selectionEntries,
    },
    summary,
    workflow,
    apis: plannedApis,
    workstreams,
    nextActions,
  };
  const withoutReportHash: Omit<EstateAdoptionPlan, "reportHash"> = {
    ...withoutHashes,
    planHash: planHashOf(withoutHashes),
  };
  return EstateAdoptionPlan.parse({
    ...withoutReportHash,
    reportHash: reportHashOf(withoutReportHash),
  });
}

export function renderEstateAdoptionPlan(plan: EstateAdoptionPlan): string[] {
  const lines = [
    `Estate adoption plan: ${plan.vendor} · ${plan.summary.apis} APIs · audit ${plan.auditGate} · baseline ${plan.change.status}`,
    `  plan: ${plan.planHash}`,
    `  report: ${plan.reportHash}`,
    `  inventory: ${plan.inventoryDigest}`,
    `  gateway identity: ${plan.gateway.id} (${plan.gateway.source})`,
    `  decisions: ${plan.summary.selected} selected · ${plan.summary.deferred} deferred · ${plan.summary.triage} need triage`,
    `  selected: ${plan.summary.readyForImport} ready for import · ${plan.summary.blockedSelected} blocked · ${plan.summary.unownedSelected} unowned`,
    `  workstreams: ${plan.summary.ownerWorkstreams}`,
  ];
  if (plan.change.hasChanges) {
    const changed = [
      ...plan.change.apis.added.map((id) => `+${id}`),
      ...plan.change.apis.removed.map((id) => `-${id}`),
      ...plan.change.apis.changed.map((id) => `~${id}`),
    ];
    lines.push(
      `Changes: source=${plan.change.sourceChanged ? "changed" : "same"} · gateway=${plan.change.gatewayChanged ? "changed" : "same"} · adapter=${plan.change.adapterChanged ? "changed" : "same"} · selection=${plan.change.selectionChanged ? "changed" : "same"}`,
    );
    if (changed.length > 0) {
      lines.push(
        `  APIs (first ${Math.min(10, changed.length)}): ${changed.slice(0, 10).join(", ")}`,
      );
    }
    const findingCount =
      plan.change.findings.added.length +
      plan.change.findings.removed.length +
      plan.change.findings.changed.length;
    lines.push(`  findings changed: ${findingCount}`);
  }
  if (plan.workstreams.length > 0) {
    lines.push(`Owner workstreams${plan.workstreams.length > 10 ? " (first 10)" : ""}:`);
    for (const workstream of plan.workstreams.slice(0, 10)) {
      lines.push(
        `  ${workstream.owner}: ${workstream.apis.length} API(s) · ${workstream.readyForImport} ready · ${workstream.blocked} blocked · ${workstream.actionRequired} action`,
      );
    }
  }
  const selected = plan.apis.filter((api) => api.decision === "selected");
  if (selected.length > 0) {
    lines.push(`Selected APIs${selected.length > 20 ? " (first 20)" : ""}:`);
    for (const api of selected.slice(0, 20)) {
      lines.push(
        `  ${api.coordinateKey} · ${api.status} · ${api.semanticLane} · owner ${api.owner ?? "unassigned"}`,
      );
      lines.push(`    next: ${api.nextCommand}`);
    }
  }
  if (plan.nextActions.length > 0) {
    lines.push("Next actions:");
    for (const action of plan.nextActions.slice(0, 8)) lines.push(`  - ${action}`);
  }
  lines.push("Use --json or --out <plan.json> for the complete resumable plan and baseline.");
  return lines;
}
