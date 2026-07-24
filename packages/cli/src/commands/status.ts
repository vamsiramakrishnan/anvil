import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { type AirDocument, airFromJson, airFromYaml, airToJson, airToYaml } from "@anvil/air";
import { type SourceDiagnostic, surfaceSignatureFor } from "@anvil/compiler";
import {
  bundleHash,
  CERTIFICATION_FILE,
  Certification as CertificationSchema,
  certifyBundle,
  compiledOperations,
  type ExecutableEvidenceStatus,
  executableEvidenceStatuses,
  operationCatalog,
  PUBLICATION_FILE,
  PublicationRecord,
  readBundleDir,
  verifyCertification,
} from "@anvil/generators";
import {
  GEMINI_ENTERPRISE_PROFILE,
  type TargetKitIntegrityFinding,
  verifyTargetKit,
} from "@anvil/targets";
import type { Command } from "commander";
import type { CliIO } from "../io.js";
import { resolveBundleDir } from "./certify.js";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";
import { sourceService } from "./source.js";

export type ProjectionState = "fresh" | "missing" | "corrupt" | "misaligned" | "unverifiable";
export type RecordState = "fresh" | "missing" | "corrupt" | "failed" | "stale";
export type DeploymentPlanState = "planned" | "missing" | "corrupt" | "stale";

export interface StatusDiagnostic {
  code: string;
  severity: "error" | "warning";
  detail: string;
  path?: string;
}

export interface ProjectionStatus {
  id:
    | "canonical"
    | "canonical-json"
    | "cli"
    | "mcp"
    | "runtime-air"
    | "catalog"
    | "runtime-manifest";
  path: string;
  state: ProjectionState;
  detail: string;
}

export interface TargetSetupStatus {
  targetId: string;
  path: string;
  state: "fresh" | "stale" | "corrupt" | "unverifiable";
  recordedSurfaceSignature: string | null;
  currentSurfaceSignature: string | null;
  config: Record<string, unknown> | null;
  integrity: {
    expectedDigest: string | null;
    actualDigest: string | null;
    findings: TargetKitIntegrityFinding[];
  } | null;
  detail: string;
}

export interface NextSafeAction {
  code:
    | "repair-core"
    | "resolve-blocked"
    | "inspect-approve"
    | "certify"
    | "selftest"
    | "conformance"
    | "simulate"
    | "retarget"
    | "release"
    | "operator-action-required"
    /** @deprecated Local plan records can never produce this state. */
    | "complete";
  command: string | null;
  reason: string;
}

export interface StatusReport {
  schemaVersion: 1;
  serviceId: string | null;
  paths: {
    input: string;
    bundle: string;
    canonicalAir: string | null;
  };
  source: {
    kind: string;
    uri: string | null;
    snapshotId: string | null;
    sourceHash: string | null;
    origin: { kind: string; uri: string } | null;
    entrypoint: string | null;
    root: string | null;
    expectedLockedSource: {
      snapshotRecord: string;
      entrypointBytes: string | null;
    } | null;
    integrity: {
      state: "fresh" | "corrupt" | "missing" | "unverifiable";
      detail: string;
      diagnostics: SourceDiagnostic[];
    };
  } | null;
  operations: {
    total: number;
    generated: number;
    approved: number;
    review_required: number;
    deprecated: number;
    blocked: number;
    awaitingApproval: number;
  } | null;
  core: {
    state: "aligned" | "misaligned";
    bundleHash: string;
    projections: ProjectionStatus[];
    contractChecks: Array<{
      code: string;
      state: "passed" | "failed";
      detail: string;
    }>;
  };
  certification: {
    state: RecordState;
    path: string;
    bundleHash: string | null;
    certifiedAt: string | null;
    detail: string;
  };
  executableEvidence: {
    selftest: ExecutableEvidenceStatus & { path: string };
    conformance: ExecutableEvidenceStatus & { path: string };
    simulation: ExecutableEvidenceStatus & { path: string };
  };
  publication: {
    /** Compatibility field name; this describes a local deployment plan. */
    state: DeploymentPlanState;
    path: string;
    bundleHash: string | null;
    plannedAt: string | null;
    /** Legacy timestamp from older publication records. */
    publishedAt: string | null;
    target: string | null;
    environment: string | null;
    cloudCallsMade: false | null;
    operatorActionRequired: boolean;
    executableEvidenceGate: "passed" | "waived" | "unrecorded" | null;
    evidenceWaiverReason: string | null;
    detail: string;
  };
  targets: TargetSetupStatus[];
  nextAction: NextSafeAction;
  diagnostics: StatusDiagnostic[];
}

interface CanonicalLoad {
  path: string | null;
  relativePath: string | null;
  text?: string;
  air?: AirDocument;
  error?: string;
}

interface StatusOptions {
  json?: boolean;
  root?: string;
}

/** `anvil status` — one read-only answer for where a bundle is in its journey. */
export function registerStatus(parent: Command, ctx: CommandContext): void {
  annotate(
    parent
      .command("status")
      .summary("Show source, projection, approval, assurance, target, and release-plan status.")
      .description(
        "Read-only. Resolves the canonical AIR and locked-source coordinate, verifies generated CLI/MCP/catalog/runtime projections against it, checks static assurance plus current-hash selftest/conformance/simulation evidence, checks deployment-plan freshness, detects stale target setup signatures, and chooses one deterministic next safe action. A local publication.json means only that a plan was prepared; it never means deployed or live. Exit is non-zero only when a core projection is missing, corrupt, or misaligned.",
      )
      .argument("<path>", "generated bundle directory or AIR file")
      .option("--root <dir>", "workspace root containing .anvil/sources")
      .option("--json", "emit one StatusReport JSON document")
      .action(async (path: string, opts: StatusOptions) => {
        ctx.code = await runStatus(path, opts, ctx.io);
      }),
    { mutates: false },
  );
}

export async function runStatus(path: string, opts: StatusOptions, io: CliIO): Promise<number> {
  const report = await buildStatusReport(path, opts);
  io.out(opts.json === true ? JSON.stringify(report, null, 2) : renderStatusReport(report));
  return report.core.state === "aligned" ? 0 : 1;
}

export async function buildStatusReport(
  path: string,
  opts: Pick<StatusOptions, "root"> = {},
): Promise<StatusReport> {
  const input = resolve(path);
  const bundle = resolve(resolveBundleDir(input));
  const files = readBundleDir(bundle);
  const currentBundleHash = bundleHash(files);
  const canonical = loadCanonical(input, bundle, files);
  const diagnostics: StatusDiagnostic[] = [];
  const source = canonical.air ? await sourceStatus(canonical.air, bundle, opts.root) : null;
  if (source && source.integrity.state !== "fresh") {
    diagnostics.push({
      code: `status.source.${source.integrity.state}`,
      severity: source.integrity.state === "unverifiable" ? "warning" : "error",
      detail: source.integrity.detail,
      path: source.expectedLockedSource?.snapshotRecord,
    });
  }

  const projections = buildProjectionStatus(bundle, files, canonical);
  for (const projection of projections) {
    if (projection.state === "fresh" || projection.state === "unverifiable") continue;
    diagnostics.push({
      code: `status.core.${projection.id.replaceAll("-", "_")}.${projection.state}`,
      severity: "error",
      detail: projection.detail,
      path: projection.path,
    });
  }

  const contractChecks = canonical.air
    ? certifyBundle(files, canonical.air)
        .checks.filter((check) => check.gate === "contract")
        .map((check) => ({
          code: check.id,
          state: check.status === "failed" ? ("failed" as const) : ("passed" as const),
          detail: check.detail,
        }))
    : [];
  for (const check of contractChecks) {
    if (check.state === "failed") {
      diagnostics.push({ code: check.code, severity: "error", detail: check.detail });
    }
  }

  const coreAligned =
    canonical.air !== undefined &&
    projections.every((projection) => projection.state === "fresh") &&
    contractChecks.every((check) => check.state === "passed") &&
    (source === null ||
      source.integrity.state === "fresh" ||
      source.integrity.state === "unverifiable");
  const certification = certificationStatus(bundle, files, currentBundleHash);
  if (certification.state !== "fresh") {
    diagnostics.push({
      code: `status.certification.${certification.state}`,
      severity: "warning",
      detail: certification.detail,
      path: certification.path,
    });
  }
  const evidence = executableEvidenceStatuses(files, currentBundleHash);
  const executableEvidence = {
    selftest: { ...evidence.selftest, path: join(bundle, evidence.selftest.file) },
    conformance: { ...evidence.conformance, path: join(bundle, evidence.conformance.file) },
    simulation: { ...evidence.simulation, path: join(bundle, evidence.simulation.file) },
  };
  for (const status of Object.values(executableEvidence)) {
    if (status.state === "fresh" && status.passed === true) continue;
    diagnostics.push({
      code: `status.evidence.${status.lane}.${status.state}`,
      severity: "warning",
      detail: status.detail,
      path: status.path,
    });
  }
  const publication = publicationStatus(bundle, files, currentBundleHash, canonical.air);
  if (publication.state !== "planned") {
    diagnostics.push({
      code: `status.publication.${publication.state}`,
      severity: "warning",
      detail: publication.detail,
      path: publication.path,
    });
  }

  const currentSurfaceSignature = canonical.air
    ? surfaceSignatureFor(canonical.air).digest
    : undefined;
  const targets = targetStatuses(bundle, files, currentSurfaceSignature, canonical.air);
  for (const target of targets) {
    if (target.state === "fresh") continue;
    diagnostics.push({
      code:
        target.state === "stale"
          ? "status.target.kit_stale"
          : target.state === "corrupt"
            ? "status.target.setup_corrupt"
            : "status.target.unverifiable",
      severity: "warning",
      detail: target.detail,
      path: target.path,
    });
  }

  const operations = canonical.air ? operationCounts(canonical.air) : null;
  const reportBase = {
    schemaVersion: 1 as const,
    serviceId: canonical.air?.service.id ?? null,
    paths: { input, bundle, canonicalAir: canonical.path },
    source,
    operations,
    core: {
      state: coreAligned ? ("aligned" as const) : ("misaligned" as const),
      bundleHash: currentBundleHash,
      projections,
      contractChecks,
    },
    certification,
    executableEvidence,
    publication,
    targets,
  };
  const nextAction = nextSafeAction(reportBase);
  diagnostics.sort(compareDiagnostics);
  return { ...reportBase, nextAction, diagnostics };
}

function loadCanonical(
  input: string,
  bundle: string,
  files: Record<string, string>,
): CanonicalLoad {
  let relativePath: string | undefined;
  if (files["air.yaml"] !== undefined) relativePath = "air.yaml";
  else if (files["air.json"] !== undefined) relativePath = "air.json";
  else if (!statSync(input).isDirectory()) relativePath = basename(input);
  if (!relativePath) {
    return { path: null, relativePath: null, error: `No air.yaml or air.json in ${bundle}.` };
  }

  const canonicalPath = join(bundle, relativePath);
  const text = files[relativePath] ?? readFileSync(canonicalPath, "utf8");
  try {
    const air = relativePath.endsWith(".json") ? airFromJson(text) : airFromYaml(text);
    return { path: canonicalPath, relativePath, text, air };
  } catch (error) {
    return {
      path: canonicalPath,
      relativePath,
      text,
      error: `Canonical AIR is corrupt: ${(error as Error).message}`,
    };
  }
}

function buildProjectionStatus(
  bundle: string,
  files: Record<string, string>,
  canonical: CanonicalLoad,
): ProjectionStatus[] {
  if (!canonical.air || !canonical.path || canonical.text === undefined) {
    const canonicalProjection: ProjectionStatus = {
      id: "canonical",
      path: canonical.path ?? join(bundle, "air.yaml"),
      state: canonical.path ? "corrupt" : "missing",
      detail: canonical.error ?? "Canonical AIR is unavailable.",
    };
    return [
      canonicalProjection,
      ...projectionDefinitions().map(({ id, relativePath }) => ({
        id,
        path: join(bundle, relativePath),
        state: "unverifiable" as const,
        detail: "Cannot verify this projection until canonical AIR is valid.",
      })),
    ];
  }

  const air = canonical.air;
  const canonicalExpected = canonical.relativePath?.endsWith(".json")
    ? airToJson(air)
    : airToYaml(air);
  const projections: ProjectionStatus[] = [
    compareProjection(
      "canonical",
      canonical.path,
      canonical.text,
      canonicalExpected,
      parseAir(canonical.relativePath?.endsWith(".json") === true),
    ),
  ];

  const definitions: Array<{
    id: Exclude<ProjectionStatus["id"], "canonical">;
    relativePath: string;
    expected: string;
    parse: (text: string) => void;
  }> = [
    {
      id: "canonical-json",
      relativePath: "air.json",
      expected: airToJson(air),
      parse: parseAir(true),
    },
    {
      id: "cli",
      relativePath: "cli/air.json",
      expected: airToJson(air),
      parse: parseAir(true),
    },
    {
      id: "mcp",
      relativePath: "mcp/air.json",
      expected: airToJson(air),
      parse: parseAir(true),
    },
    {
      id: "runtime-air",
      relativePath: "runtime/air.json",
      expected: airToJson(air),
      parse: parseAir(true),
    },
    {
      id: "catalog",
      relativePath: "catalog.json",
      expected: `${JSON.stringify(operationCatalog(air), null, 2)}\n`,
      parse: parseJson,
    },
    {
      id: "runtime-manifest",
      relativePath: "runtime/operations.manifest.json",
      expected: `${JSON.stringify(compiledOperations(air), null, 2)}\n`,
      parse: parseJson,
    },
  ];
  for (const definition of definitions) {
    if (
      definition.id === "canonical-json" &&
      resolve(canonical.path) === resolve(join(bundle, definition.relativePath))
    ) {
      continue;
    }
    projections.push(
      compareProjection(
        definition.id,
        join(bundle, definition.relativePath),
        files[definition.relativePath],
        definition.expected,
        definition.parse,
      ),
    );
  }
  return projections;
}

function projectionDefinitions(): Array<{
  id: Exclude<ProjectionStatus["id"], "canonical">;
  relativePath: string;
}> {
  return [
    { id: "canonical-json", relativePath: "air.json" },
    { id: "cli", relativePath: "cli/air.json" },
    { id: "mcp", relativePath: "mcp/air.json" },
    { id: "runtime-air", relativePath: "runtime/air.json" },
    { id: "catalog", relativePath: "catalog.json" },
    { id: "runtime-manifest", relativePath: "runtime/operations.manifest.json" },
  ];
}

function compareProjection(
  id: ProjectionStatus["id"],
  path: string,
  actual: string | undefined,
  expected: string,
  parse: (text: string) => void,
): ProjectionStatus {
  if (actual === undefined) {
    return { id, path, state: "missing", detail: `${id} projection is missing.` };
  }
  try {
    parse(actual);
  } catch (error) {
    return {
      id,
      path,
      state: "corrupt",
      detail: `${id} projection is corrupt: ${(error as Error).message}`,
    };
  }
  return actual === expected
    ? { id, path, state: "fresh", detail: `${id} matches canonical AIR.` }
    : {
        id,
        path,
        state: "misaligned",
        detail: `${id} parses but does not match the canonical generated projection.`,
      };
}

function parseAir(json: boolean): (text: string) => void {
  return (text) => {
    if (json) airFromJson(text);
    else airFromYaml(text);
  };
}

function parseJson(text: string): void {
  JSON.parse(text);
}

function operationCounts(air: AirDocument): NonNullable<StatusReport["operations"]> {
  const count = (state: string) =>
    air.operations.filter((operation) => operation.state === state).length;
  return {
    total: air.operations.length,
    generated: count("generated"),
    approved: count("approved"),
    review_required: count("review_required"),
    deprecated: count("deprecated"),
    blocked: count("blocked"),
    awaitingApproval: air.operations.filter(
      (operation) => operation.state === "generated" || operation.state === "review_required",
    ).length,
  };
}

async function sourceStatus(
  air: AirDocument,
  bundle: string,
  requestedRoot?: string,
): Promise<NonNullable<StatusReport["source"]>> {
  const source = air.service.source;
  const snapshotId = source.snapshotId ?? null;
  const entrypoint = source.entrypoint ?? null;
  const root = snapshotId ? resolveSourceRoot(bundle, snapshotId, requestedRoot) : null;
  const snapshotDir = root && snapshotId ? join(root, ".anvil", "sources", snapshotId) : null;
  const expectedLockedSource = snapshotDir
    ? {
        snapshotRecord: join(snapshotDir, "source.json"),
        entrypointBytes: entrypoint ? anchoredRawPath(snapshotDir, entrypoint) : null,
      }
    : null;
  const base = {
    kind: source.kind,
    uri: source.uri ?? null,
    snapshotId,
    sourceHash: source.sourceHash ?? null,
    origin: source.origin ?? null,
    entrypoint,
    root,
    expectedLockedSource,
  };
  if (!snapshotId) {
    return {
      ...base,
      integrity: {
        state: "unverifiable",
        detail: "Canonical AIR does not record a locked source snapshot id.",
        diagnostics: [
          {
            level: "warning",
            code: "source/no_snapshot",
            message: "Canonical AIR does not record a locked source snapshot id.",
          },
        ],
      },
    };
  }
  if (!root) {
    return {
      ...base,
      integrity: {
        state: "unverifiable",
        detail: `Could not locate ${snapshotId}; pass --root <workspace> to anchor and verify its locked bytes.`,
        diagnostics: [
          {
            level: "warning",
            code: "source/root_unresolved",
            message: `Could not locate ${snapshotId}; pass --root <workspace>.`,
          },
        ],
      },
    };
  }

  const service = sourceService({ root });
  const [validation, loaded] = await Promise.all([
    service.validate(snapshotId),
    service.show(snapshotId),
  ]);
  const integrityDiagnostics = [...validation.diagnostics, ...loaded.diagnostics];
  const snapshot = loaded.snapshot;
  if (snapshot) {
    if (snapshot.sourceHash !== source.sourceHash) {
      integrityDiagnostics.push({
        level: "error",
        code: "source/air_hash_mismatch",
        message: `AIR records sourceHash ${source.sourceHash ?? "<missing>"}, but the locked snapshot records ${snapshot.sourceHash}.`,
      });
    }
    if (!entrypoint || !snapshot.entrypoints.some((candidate) => candidate.path === entrypoint)) {
      integrityDiagnostics.push({
        level: "error",
        code: "source/air_entrypoint_mismatch",
        path: entrypoint ?? undefined,
        message: `AIR entrypoint ${entrypoint ?? "<missing>"} is not an entrypoint in the locked snapshot.`,
      });
    }
    const portableLockedOrigin =
      entrypoint === null ? null : `source://${snapshot.snapshotId}/${entrypoint}`;
    const originMatches =
      source.origin !== undefined &&
      snapshot.origin.kind === source.origin.kind &&
      (snapshot.origin.uri === source.origin.uri ||
        (snapshot.origin.kind !== "filesystem" && source.origin.uri === portableLockedOrigin));
    if (!originMatches) {
      integrityDiagnostics.push({
        level: "error",
        code: "source/air_origin_mismatch",
        message:
          "AIR source origin matches neither the locked snapshot origin nor its portable gateway coordinate.",
      });
    }
  }
  const diagnostics = uniqueSourceDiagnostics(integrityDiagnostics);
  const missing = diagnostics.some((diagnostic) => diagnostic.code === "source/not_found");
  const state =
    validation.ok && diagnostics.length === 0 ? "fresh" : missing ? "missing" : "corrupt";
  return {
    ...base,
    integrity: {
      state,
      detail:
        state === "fresh"
          ? `Locked source bytes and AIR provenance match at ${expectedLockedSource?.snapshotRecord}.`
          : `Locked source verification failed at ${expectedLockedSource?.snapshotRecord}.`,
      diagnostics,
    },
  };
}

function resolveSourceRoot(
  bundle: string,
  snapshotId: string,
  requestedRoot?: string,
): string | null {
  if (requestedRoot) return resolve(requestedRoot);
  const candidates: string[] = [];
  let current = resolve(bundle);
  while (true) {
    candidates.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return (
    candidates.find((candidate) =>
      existsSync(join(candidate, ".anvil", "sources", snapshotId, "source.json")),
    ) ?? null
  );
}

function anchoredRawPath(snapshotDir: string, entrypoint: string): string | null {
  const rawRoot = resolve(snapshotDir, "raw");
  const candidate = resolve(rawRoot, entrypoint);
  return candidate.startsWith(`${rawRoot}/`) ? candidate : null;
}

function uniqueSourceDiagnostics(diagnostics: SourceDiagnostic[]): SourceDiagnostic[] {
  const unique = new Map<string, SourceDiagnostic>();
  for (const diagnostic of diagnostics) {
    const key = [diagnostic.level, diagnostic.code, diagnostic.path ?? "", diagnostic.message].join(
      "\0",
    );
    unique.set(key, diagnostic);
  }
  return [...unique.values()].sort(
    (left, right) =>
      left.code.localeCompare(right.code) ||
      (left.path ?? "").localeCompare(right.path ?? "") ||
      left.message.localeCompare(right.message),
  );
}

function certificationStatus(
  bundle: string,
  files: Record<string, string>,
  currentBundleHash: string,
): StatusReport["certification"] {
  const path = join(bundle, CERTIFICATION_FILE);
  const raw = files[CERTIFICATION_FILE];
  if (raw === undefined) {
    return {
      state: "missing",
      path,
      bundleHash: null,
      certifiedAt: null,
      detail: `No ${CERTIFICATION_FILE} is present.`,
    };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return {
      state: "corrupt",
      path,
      bundleHash: null,
      certifiedAt: null,
      detail: `${CERTIFICATION_FILE} is not valid JSON.`,
    };
  }
  const parsed = CertificationSchema.safeParse(decoded);
  if (!parsed.success) {
    return {
      state: "corrupt",
      path,
      bundleHash: null,
      certifiedAt: null,
      detail: `${CERTIFICATION_FILE} does not match the certification schema.`,
    };
  }

  const verdict = verifyCertification(files);
  if (verdict.ok) {
    return {
      state: "fresh",
      path,
      bundleHash: parsed.data.bundleHash,
      certifiedAt: parsed.data.certifiedAt,
      detail: `Passing static assurance matches bundle ${shortHash(currentBundleHash)}; executable evidence is tracked separately.`,
    };
  }
  return {
    state: parsed.data.status === "passed" ? "stale" : "failed",
    path,
    bundleHash: parsed.data.bundleHash,
    certifiedAt: parsed.data.certifiedAt,
    detail: verdict.reason,
  };
}

function publicationStatus(
  bundle: string,
  files: Record<string, string>,
  currentBundleHash: string,
  air: AirDocument | undefined,
): StatusReport["publication"] {
  const path = join(bundle, PUBLICATION_FILE);
  const raw = files[PUBLICATION_FILE];
  if (raw === undefined) {
    return {
      state: "missing",
      path,
      bundleHash: null,
      plannedAt: null,
      publishedAt: null,
      target: null,
      environment: null,
      cloudCallsMade: null,
      operatorActionRequired: false,
      executableEvidenceGate: null,
      evidenceWaiverReason: null,
      detail: `No ${PUBLICATION_FILE} is present.`,
    };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return {
      state: "corrupt",
      path,
      bundleHash: null,
      plannedAt: null,
      publishedAt: null,
      target: null,
      environment: null,
      cloudCallsMade: null,
      operatorActionRequired: false,
      executableEvidenceGate: null,
      evidenceWaiverReason: null,
      detail: `${PUBLICATION_FILE} is not valid JSON.`,
    };
  }
  const parsed = PublicationRecord.safeParse(decoded);
  if (!parsed.success) {
    return {
      state: "corrupt",
      path,
      bundleHash: null,
      plannedAt: null,
      publishedAt: null,
      target: null,
      environment: null,
      cloudCallsMade: null,
      operatorActionRequired: false,
      executableEvidenceGate: null,
      evidenceWaiverReason: null,
      detail: `${PUBLICATION_FILE} does not match the publication schema.`,
    };
  }

  const record = parsed.data;
  const serviceMatches = air === undefined || record.serviceId === air.service.id;
  const fresh = record.bundleHash === currentBundleHash && serviceMatches;
  const recordedEvidence = record.schemaVersion === 2 ? record.executableEvidence : undefined;
  const executableEvidenceGate = recordedEvidence?.status ?? "unrecorded";
  const evidenceWaiverReason =
    recordedEvidence?.status === "waived" ? recordedEvidence.waiver.reason : null;
  const evidenceDetail =
    executableEvidenceGate === "passed"
      ? " Fresh passing executable evidence was recorded."
      : executableEvidenceGate === "waived"
        ? ` Executable evidence was explicitly waived: ${evidenceWaiverReason}`
        : " This legacy plan does not record its executable-evidence gate.";
  return {
    state: fresh ? "planned" : "stale",
    path,
    bundleHash: record.bundleHash,
    plannedAt: record.schemaVersion === 2 ? record.plannedAt : record.publishedAt,
    publishedAt: record.schemaVersion === 1 ? record.publishedAt : null,
    target: record.target,
    environment: record.env,
    cloudCallsMade: false,
    operatorActionRequired: true,
    executableEvidenceGate,
    evidenceWaiverReason,
    detail: fresh
      ? `Deployment plan matches bundle ${shortHash(currentBundleHash)}; no cloud call was made and operator apply/verification remain.${evidenceDetail}`
      : !serviceMatches
        ? `Deployment plan service ${record.serviceId} does not match ${air?.service.id}.`
        : `Deployment plan is stale: planned ${shortHash(record.bundleHash)}, current ${shortHash(currentBundleHash)}.`,
  };
}

function targetStatuses(
  bundle: string,
  files: Record<string, string>,
  currentSignature: string | undefined,
  air: AirDocument | undefined,
): TargetSetupStatus[] {
  const targetIds = [
    ...new Set(
      Object.keys(files)
        .map((relativePath) => /^targets\/([^/]+)\//.exec(relativePath)?.[1])
        .filter((targetId): targetId is string => targetId !== undefined),
    ),
  ];
  return targetIds.sort().map((targetId) => {
    const relativePath = `targets/${targetId}/setup.json`;
    const path =
      files[relativePath] === undefined
        ? join(bundle, "targets", targetId)
        : join(bundle, relativePath);
    if (air && targetId === GEMINI_ENTERPRISE_PROFILE.id) {
      const verification = verifyTargetKit(air, GEMINI_ENTERPRISE_PROFILE, files);
      const setup = parseTargetSetup(files[relativePath]);
      const corruptSetup = verification.findings.some(
        (finding) =>
          finding.code === "target/missing_setup" || finding.code === "target/invalid_setup",
      );
      return {
        targetId,
        path,
        state: verification.ok
          ? ("fresh" as const)
          : corruptSetup
            ? ("corrupt" as const)
            : ("stale" as const),
        recordedSurfaceSignature: setup.surfaceSignature,
        currentSurfaceSignature: currentSignature ?? null,
        config: verification.config as unknown as Record<string, unknown> | null,
        integrity: {
          expectedDigest: verification.expectedDigest,
          actualDigest: verification.actualDigest,
          findings: verification.findings,
        },
        detail: verification.ok
          ? `${targetId} exactly regenerates from persisted setup config and canonical AIR (${verification.expectedFiles.length} files, ${shortHash(verification.expectedDigest ?? "")}).`
          : verification.findings.map((finding) => finding.detail).join("; "),
      };
    }

    const raw = files[relativePath];
    if (raw === undefined) {
      return {
        targetId,
        path,
        state: "corrupt" as const,
        recordedSurfaceSignature: null,
        currentSurfaceSignature: currentSignature ?? null,
        config: null,
        integrity: null,
        detail: `${relativePath} is missing.`,
      };
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      return {
        targetId,
        path,
        state: "corrupt" as const,
        recordedSurfaceSignature: null,
        currentSurfaceSignature: currentSignature ?? null,
        config: null,
        integrity: null,
        detail: `${relativePath} is not valid JSON.`,
      };
    }
    if (!isRecord(decoded) || typeof decoded.surfaceSignatureDigest !== "string") {
      return {
        targetId,
        path,
        state: "corrupt" as const,
        recordedSurfaceSignature: null,
        currentSurfaceSignature: currentSignature ?? null,
        config: isRecord(decoded) && isRecord(decoded.config) ? decoded.config : null,
        integrity: null,
        detail: `${relativePath} has no surfaceSignatureDigest.`,
      };
    }
    const config = isRecord(decoded.config) ? decoded.config : null;
    if (!currentSignature) {
      return {
        targetId,
        path,
        state: "unverifiable" as const,
        recordedSurfaceSignature: decoded.surfaceSignatureDigest,
        currentSurfaceSignature: null,
        config,
        integrity: null,
        detail: `${relativePath} cannot be checked until canonical AIR is valid.`,
      };
    }
    const fresh = decoded.surfaceSignatureDigest === currentSignature;
    return {
      targetId,
      path,
      state: fresh ? ("fresh" as const) : ("stale" as const),
      recordedSurfaceSignature: decoded.surfaceSignatureDigest,
      currentSurfaceSignature: currentSignature,
      config,
      integrity: null,
      detail: fresh
        ? `${relativePath} matches the current approved surface.`
        : `${relativePath} targets approved surface ${shortHash(decoded.surfaceSignatureDigest)}, current ${shortHash(currentSignature)}.`,
    };
  });
}

function parseTargetSetup(raw: string | undefined): {
  surfaceSignature: string | null;
} {
  if (raw === undefined) return { surfaceSignature: null };
  try {
    const decoded: unknown = JSON.parse(raw);
    return {
      surfaceSignature:
        isRecord(decoded) && typeof decoded.surfaceSignatureDigest === "string"
          ? decoded.surfaceSignatureDigest
          : null,
    };
  } catch {
    return { surfaceSignature: null };
  }
}

function nextSafeAction(report: {
  paths: StatusReport["paths"];
  source: StatusReport["source"];
  operations: StatusReport["operations"];
  core: StatusReport["core"];
  certification: StatusReport["certification"];
  executableEvidence: StatusReport["executableEvidence"];
  publication: StatusReport["publication"];
  targets: StatusReport["targets"];
}): NextSafeAction {
  const bundle = shellArg(report.paths.bundle);
  if (report.core.state !== "aligned") {
    const command = report.source?.snapshotId
      ? [
          "anvil",
          "source",
          "show",
          report.source.snapshotId,
          ...(report.source.root ? ["--root", report.source.root] : []),
        ]
          .map(shellArg)
          .join(" ")
      : "anvil compile --help";
    return {
      code: "repair-core",
      command,
      reason:
        "Core projections are corrupt or misaligned; verify the locked source before recompiling.",
    };
  }
  if ((report.operations?.blocked ?? 0) > 0) {
    return {
      code: "resolve-blocked",
      command: `anvil inspect ${bundle}`,
      reason: "Resolve blocked operation diagnostics before exposing or certifying anything.",
    };
  }
  if ((report.operations?.awaitingApproval ?? 0) > 0) {
    return {
      code: "inspect-approve",
      command: `anvil inspect ${bundle}`,
      reason: "Inspect operation risk, then approve only the intended operation ids.",
    };
  }
  const staleTarget = report.targets.find((target) => target.state !== "fresh");
  if (staleTarget) {
    return {
      code: "retarget",
      command: targetCommand(staleTarget, report.paths.bundle),
      reason: `${staleTarget.targetId} does not exactly regenerate from persisted setup config and canonical AIR.`,
    };
  }
  if (report.certification.state !== "fresh") {
    return {
      code: "certify",
      command: `anvil certify ${bundle}`,
      reason: "The current bundle bytes do not carry fresh passing static assurance.",
    };
  }
  const evidenceOrder = [
    { lane: "selftest", command: "selftest" },
    { lane: "conformance", command: "conformance" },
    { lane: "simulation", command: "simulate" },
  ] as const;
  for (const step of evidenceOrder) {
    const evidence = report.executableEvidence[step.lane];
    if (evidence.state === "fresh" && evidence.passed === true) continue;
    return {
      code: step.command,
      command: `anvil ${step.command} ${bundle}`,
      reason: `Fresh passing ${step.lane} evidence for the current bundle is required before preparing a deployment plan.`,
    };
  }
  if (report.publication.state !== "planned") {
    return {
      code: "release",
      command: `anvil publish ${bundle}`,
      reason:
        "Core, static assurance, executable evidence, and discovered target setup are current; prepare the operator deployment plan next.",
    };
  }
  return {
    code: "operator-action-required",
    command: null,
    reason:
      "A current local deployment plan exists, but Anvil made no cloud call. Operator review/apply and live verification are still required.",
  };
}

function targetCommand(target: TargetSetupStatus, bundle: string): string {
  const config = target.config;
  if (!config) return `anvil target ${shellArg(target.targetId)} ${shellArg(bundle)} --help`;
  const args = ["anvil", "target", target.targetId, bundle];
  pushOption(args, "--surface", config.surface);
  pushOption(args, "--server-auth", config.serverAuth);
  pushOption(args, "--endpoint", config.endpoint);
  pushOption(args, "--project", config.project);
  pushOption(args, "--project-number", config.projectNumber);
  pushOption(args, "--location", config.appLocation);
  pushOption(args, "--engine", config.engine);
  pushOption(args, "--gateway-location", config.gatewayLocation);
  pushOption(args, "--registry-location", config.registryLocation);
  pushOption(args, "--agent-identity-principal-set", config.agentIdentityPrincipalSet);
  pushOption(args, "--gateway-authorization-policy", config.gatewayAuthorizationPolicy);
  pushOption(args, "--wif", config.workforcePool);
  if (config.allowUnauthenticatedMcp === true) args.push("--allow-unauthenticated-mcp");
  if (config.confirmEngineEgressReroute === true) args.push("--confirm-engine-egress-reroute");
  if (isRecord(config.connectorOAuth)) {
    pushOption(args, "--idp", config.connectorOAuth.provider);
    pushOption(args, "--tenant", config.connectorOAuth.tenant);
    pushOption(args, "--oauth-authorization-url", config.connectorOAuth.authorizationUrl);
    pushOption(args, "--oauth-token-url", config.connectorOAuth.tokenUrl);
    pushOption(args, "--inbound-issuer", config.connectorOAuth.inboundIssuer);
    pushOption(args, "--inbound-audience", config.connectorOAuth.inboundAudience);
    if (Array.isArray(config.connectorOAuth.scopes)) {
      for (const scope of config.connectorOAuth.scopes) pushOption(args, "--oauth-scope", scope);
    }
  }
  return args.map(shellArg).join(" ");
}

function pushOption(args: string[], option: string, value: unknown): void {
  if (typeof value === "string" && value.length > 0) args.push(option, value);
}

function shellArg(value: string): string {
  return /^[A-Za-z0-9_./:@=+-]+$/.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shortHash(hash: string): string {
  return `${hash.slice(0, 12)}…`;
}

function compareDiagnostics(a: StatusDiagnostic, b: StatusDiagnostic): number {
  const severity = { error: 0, warning: 1 };
  return (
    severity[a.severity] - severity[b.severity] ||
    a.code.localeCompare(b.code) ||
    (a.path ?? "").localeCompare(b.path ?? "")
  );
}

function targetCoordinates(config: Record<string, unknown> | null): string | null {
  if (!config) return null;
  const text = (value: unknown) =>
    typeof value === "string" && value.length > 0 ? value : undefined;
  const surface = text(config.surface);
  const appLocation = text(config.appLocation);
  const gatewayLocation = text(config.gatewayLocation);
  const registryLocation = text(config.registryLocation);
  const serverAuth = text(config.serverAuth);
  const connectorOAuth = isRecord(config.connectorOAuth) ? config.connectorOAuth : {};
  const idp = text(connectorOAuth.provider);
  const parts = [
    surface,
    appLocation ? `GE ${appLocation}` : undefined,
    surface === "agent-gateway" || surface === "both"
      ? gatewayLocation
        ? `gateway ${gatewayLocation}`
        : undefined
      : undefined,
    surface === "agent-gateway" || surface === "both"
      ? registryLocation
        ? `registry ${registryLocation}`
        : undefined
      : undefined,
    serverAuth ? `${serverAuth}${idp ? `/${idp}` : ""}` : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function renderStatusReport(report: StatusReport): string {
  const lines = [
    `Anvil status — ${report.serviceId ?? "unknown service"}`,
    `  bundle: ${report.paths.bundle}`,
    `  AIR: ${report.paths.canonicalAir ?? "missing"}`,
  ];
  if (report.source) {
    lines.push(
      "",
      "Source",
      `  snapshot: ${report.source.snapshotId ?? "unknown"}`,
      `  hash: ${report.source.sourceHash ?? "unknown"}`,
      `  origin: ${report.source.origin ? `${report.source.origin.kind}:${report.source.origin.uri}` : (report.source.uri ?? "unknown")}`,
      `  entrypoint: ${report.source.entrypoint ?? "unknown"}`,
      `  root: ${report.source.root ?? "unresolved (pass --root)"}`,
      `  locked: ${report.source.expectedLockedSource?.entrypointBytes ?? report.source.expectedLockedSource?.snapshotRecord ?? "not derivable"}`,
      `  integrity: ${report.source.integrity.state} — ${report.source.integrity.detail}`,
    );
  }
  if (report.operations) {
    lines.push(
      "",
      "Operations",
      `  ${report.operations.generated} generated · ${report.operations.approved} approved · ${report.operations.review_required} review_required · ${report.operations.deprecated} deprecated · ${report.operations.blocked} blocked · ${report.operations.total} total`,
    );
  }
  lines.push("", `Core projections — ${report.core.state.toUpperCase()}`);
  for (const projection of report.core.projections) {
    lines.push(`  ${projection.id.padEnd(18)} ${projection.state.padEnd(12)} ${projection.path}`);
  }
  lines.push(
    "",
    "Evidence",
    `  static assurance: ${report.certification.state} — ${report.certification.detail}`,
    `  selftest:         ${report.executableEvidence.selftest.state} — ${report.executableEvidence.selftest.detail}`,
    `  conformance:      ${report.executableEvidence.conformance.state} — ${report.executableEvidence.conformance.detail}`,
    `  simulation:       ${report.executableEvidence.simulation.state} — ${report.executableEvidence.simulation.detail}`,
    `  deployment plan:  ${report.publication.state} — ${report.publication.detail}`,
    "",
    "Targets",
  );
  if (report.targets.length === 0) lines.push("  none discovered");
  else {
    for (const target of report.targets) {
      lines.push(`  ${target.targetId.padEnd(20)} ${target.state.padEnd(12)} ${target.path}`);
      const coordinates = targetCoordinates(target.config);
      if (coordinates) lines.push(`    ${coordinates}`);
    }
  }
  lines.push("", `Next safe action — ${report.nextAction.code}`, `  ${report.nextAction.reason}`);
  if (report.nextAction.command) lines.push(`  ${report.nextAction.command}`);
  if (report.diagnostics.length > 0) {
    lines.push("", "Diagnostics");
    for (const diagnostic of report.diagnostics) {
      lines.push(
        `  [${diagnostic.severity.toUpperCase()}] ${diagnostic.code}: ${diagnostic.detail}`,
      );
    }
  }
  return lines.join("\n");
}
