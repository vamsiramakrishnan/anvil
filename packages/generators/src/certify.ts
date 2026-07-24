import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AirDocument, Operation } from "@anvil/air";
import { AirDocument as AirDocumentSchema, authCoherenceIssues, hashCanonical } from "@anvil/air";
import {
  GatewayImportReceiptView,
  GatewayKind,
  verifyGatewayImportIdentity,
  verifyGatewayImportOutputManifest,
} from "@anvil/compiler";
import { runDetectors, targetOperationId } from "@anvil/refinement";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  GENERATION_METADATA_FILE,
  generateBundle,
  resourceOptionsFromGenerationMetadata,
} from "./bundle.js";

/**
 * Static bundle assurance (Layer 5). This is a *judgement over generated
 * bytes*: deterministic gates re-check that the artifacts on disk still embody
 * the safety and alignment contract AIR promised at compile time. It does not
 * boot or exercise those artifacts; executable evidence is produced by
 * selftest, conformance, and simulation. The core is pure — `(bundle files,
 * AirDocument) → Certification` — so gates can never depend on ambient state;
 * only the thin shell (`readBundleDir`) touches the filesystem.
 */

/* -------------------------------------------------------------------------- */
/* Model                                                                       */
/* -------------------------------------------------------------------------- */

export const CertificationGate = z.enum(["contract", "semantic", "safety", "runtime"]);
export type CertificationGate = z.infer<typeof CertificationGate>;

export const CertificationCheckStatus = z.enum(["passed", "failed", "skipped"]);
export type CertificationCheckStatus = z.infer<typeof CertificationCheckStatus>;

export const CertificationCheck = z.object({
  /** Stable check id, e.g. "contract.surfaces-agree". */
  id: z.string(),
  gate: CertificationGate,
  status: CertificationCheckStatus,
  /** Human-facing explanation: what was checked, and (on failure) what drifted. */
  detail: z.string(),
});
export type CertificationCheck = z.infer<typeof CertificationCheck>;

export const CertificationStatus = z.enum(["passed", "failed", "expired"]);
export type CertificationStatus = z.infer<typeof CertificationStatus>;

export const Certification = z.object({
  schemaVersion: z.literal(1),
  serviceId: z.string(),
  /** Set when the bundle serves exactly one capability; a judgement names its subject. */
  capabilityId: z.string().optional(),
  /** Content hash of the bundle's generated files — the identity the cert binds to. */
  bundleHash: z.string(),
  /** This record proves deterministic byte/contract coherence, not execution. */
  assuranceLevel: z.literal("static").default("static"),
  /**
   * Optional bridge to the canonical @anvil/certification attestation model.
   * Older records omit it and remain readable.
   */
  assurance: z
    .object({
      level: z.literal("static"),
      engine: z.literal("@anvil/certification"),
      engineStatus: z.enum(["failed", "static_passed"]),
      recordDigest: z.string(),
      attestation: z.object({
        packDigest: z.string(),
        contractDigest: z.string(),
        capabilityDigests: z.array(z.string()),
        surfaceSignatureDigest: z.string(),
        targetProfileVersion: z.string().optional(),
        certificationVersion: z.string(),
      }),
    })
    .optional(),
  status: CertificationStatus,
  checks: z.array(CertificationCheck),
  certifiedAt: z.string(),
});
export type Certification = z.infer<typeof Certification>;

/** Where the certification is written inside a bundle. */
export const CERTIFICATION_FILE = "certification.json";
/** Where the publication record is written inside a bundle (PR 8). */
export const PUBLICATION_FILE = "publication.json";
/** Where `anvil selftest` writes its loopback report inside a bundle. */
export const SELFTEST_REPORT_FILE = "selftest.report.json";
/** Where `anvil conformance` writes its hermetic tri-surface report. */
export const CONFORMANCE_REPORT_FILE = "conformance.report.json";
/** Where the opt-in live conformance lane writes its report. */
export const LIVE_CONFORMANCE_REPORT_FILE = "conformance.live.report.json";
/** Where `anvil simulate` writes mechanistic coverage evidence. */
export const SIMULATION_REPORT_FILE = "simulation.report.json";
/** Where `anvil review` writes model-review evidence. */
export const REVIEW_REPORT_FILE = "review.report.json";

/** Injectable clock so assurance/deployment-plan records are testable. */
export type Clock = () => string;
const systemClock: Clock = () => new Date().toISOString();

/** Executable proof lanes required before Anvil prepares an unwaived release plan. */
export const EXECUTABLE_EVIDENCE_FILES = {
  selftest: SELFTEST_REPORT_FILE,
  conformance: CONFORMANCE_REPORT_FILE,
  simulation: SIMULATION_REPORT_FILE,
} as const;
export type ExecutableEvidenceLane = keyof typeof EXECUTABLE_EVIDENCE_FILES;
export type ExecutableEvidenceState = "fresh" | "missing" | "corrupt" | "failed" | "stale";

/**
 * One report's relationship to the current generated-content digest. `fresh`
 * deliberately describes digest freshness independently of `passed`: a current
 * failing report is fresh evidence of a failure, not stale evidence.
 */
export interface ExecutableEvidenceStatus {
  lane: ExecutableEvidenceLane;
  file: (typeof EXECUTABLE_EVIDENCE_FILES)[ExecutableEvidenceLane];
  state: ExecutableEvidenceState;
  fresh: boolean;
  passed: boolean | null;
  bundleHash: string | null;
  detail: string;
}

export type ExecutableEvidenceStatusFor<Lane extends ExecutableEvidenceLane> = Omit<
  ExecutableEvidenceStatus,
  "lane" | "file"
> & {
  lane: Lane;
  file: (typeof EXECUTABLE_EVIDENCE_FILES)[Lane];
};

export interface ExecutableEvidenceStatuses {
  selftest: ExecutableEvidenceStatusFor<"selftest">;
  conformance: ExecutableEvidenceStatusFor<"conformance">;
  simulation: ExecutableEvidenceStatusFor<"simulation">;
}

/* -------------------------------------------------------------------------- */
/* Bundle identity                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Files that are *records about* the bundle, not part of its generated content.
 * They are excluded from the hash so recording assurance, executable evidence,
 * or a deployment plan does not invalidate the identity each record attests to.
 */
export const DERIVED_RECORD_FILES: ReadonlySet<string> = new Set([
  CERTIFICATION_FILE,
  PUBLICATION_FILE,
  SELFTEST_REPORT_FILE,
  CONFORMANCE_REPORT_FILE,
  LIVE_CONFORMANCE_REPORT_FILE,
  SIMULATION_REPORT_FILE,
  REVIEW_REPORT_FILE,
]);

/**
 * Evidence is about generated content, never part of that content's identity.
 * Only known root record paths are excluded. Deliberately do not ignore
 * arbitrary `*.report.json` names: adding a new evidence kind requires an
 * explicit review of this identity boundary.
 */
export function isDerivedRecordFile(relativePath: string): boolean {
  return DERIVED_RECORD_FILES.has(relativePath);
}

/**
 * Content-derived identity of a bundle: sha256 over the sorted relative paths
 * and per-file content hashes of every generated file. Deterministic, so an
 * unchanged bundle always re-hashes to the same value and any tamper — content
 * or file set — changes it.
 */
export function bundleHash(files: Record<string, string>): string {
  const hash = createHash("sha256");
  for (const rel of Object.keys(files).sort()) {
    if (isDerivedRecordFile(rel)) continue;
    const content = createHash("sha256")
      .update(files[rel] ?? "")
      .digest("hex");
    hash.update(`${rel}\0${content}\0`);
  }
  return hash.digest("hex");
}

const CheckEvidenceReport = z.object({
  schemaVersion: z.literal(1),
  bundleHash: z.string().regex(/^[0-9a-f]{64}$/),
  summary: z.object({
    pass: z.number().int().nonnegative(),
    fail: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
  }),
});

const SimulationEvidenceReport = z.object({
  schemaVersion: z.literal(1),
  bundleHash: z.string().regex(/^[0-9a-f]{64}$/),
  summary: z.object({
    coverageCells: z.number().int().nonnegative(),
    coveragePassed: z.number().int().nonnegative(),
    mutantsKilled: z.number().int().nonnegative(),
    ok: z.boolean(),
  }),
});

/**
 * Read the three local executable reports as evidence about the exact current
 * bundle content. This intentionally validates only the stable report envelope
 * needed by release policy; each producing command owns its detailed schema.
 */
export function executableEvidenceStatuses(
  files: Record<string, string>,
  currentBundleHash = bundleHash(files),
): ExecutableEvidenceStatuses {
  return {
    selftest: checkEvidenceStatus("selftest", files, currentBundleHash),
    conformance: checkEvidenceStatus("conformance", files, currentBundleHash),
    simulation: simulationEvidenceStatus(files, currentBundleHash),
  };
}

/** True only when every executable lane passed against the current digest. */
export function executableEvidenceReady(statuses: ExecutableEvidenceStatuses): boolean {
  return Object.values(statuses).every(
    (status) => status.state === "fresh" && status.fresh && status.passed === true,
  );
}

function checkEvidenceStatus<Lane extends "selftest" | "conformance">(
  lane: Lane,
  files: Record<string, string>,
  currentBundleHash: string,
): ExecutableEvidenceStatusFor<Lane> {
  const file = EXECUTABLE_EVIDENCE_FILES[lane];
  const decoded = parseEvidenceJson(files, lane, file);
  if (!decoded.ok) return decoded.status;
  const parsed = CheckEvidenceReport.safeParse(decoded.value);
  if (!parsed.success) {
    return corruptEvidence(lane, file, `${file} does not match its report schema.`);
  }
  const report = parsed.data;
  const passed = report.summary.fail === 0 && report.summary.pass > 0;
  const summary = `${report.summary.pass} passed, ${report.summary.fail} failed, ${report.summary.skipped} skipped`;
  return boundEvidenceStatus(lane, file, report.bundleHash, currentBundleHash, passed, summary);
}

function simulationEvidenceStatus(
  files: Record<string, string>,
  currentBundleHash: string,
): ExecutableEvidenceStatusFor<"simulation"> {
  const lane = "simulation" as const;
  const file = EXECUTABLE_EVIDENCE_FILES[lane];
  const decoded = parseEvidenceJson(files, lane, file);
  if (!decoded.ok) return decoded.status;
  const parsed = SimulationEvidenceReport.safeParse(decoded.value);
  if (!parsed.success) {
    return corruptEvidence(lane, file, `${file} does not match its report schema.`);
  }
  const report = parsed.data;
  const summary =
    `${report.summary.coveragePassed}/${report.summary.coverageCells} coverage cells passed, ` +
    `${report.summary.mutantsKilled} mutants killed`;
  return boundEvidenceStatus(
    lane,
    file,
    report.bundleHash,
    currentBundleHash,
    report.summary.ok &&
      report.summary.coverageCells > 0 &&
      report.summary.coveragePassed === report.summary.coverageCells,
    summary,
  );
}

function parseEvidenceJson<Lane extends ExecutableEvidenceLane>(
  files: Record<string, string>,
  lane: Lane,
  file: (typeof EXECUTABLE_EVIDENCE_FILES)[Lane],
): { ok: true; value: unknown } | { ok: false; status: ExecutableEvidenceStatusFor<Lane> } {
  const raw = files[file];
  if (raw === undefined) {
    return {
      ok: false,
      status: {
        lane,
        file,
        state: "missing",
        fresh: false,
        passed: null,
        bundleHash: null,
        detail: `No ${file} is present.`,
      },
    };
  }
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return {
      ok: false,
      status: corruptEvidence(lane, file, `${file} is not valid JSON.`),
    };
  }
}

function corruptEvidence<Lane extends ExecutableEvidenceLane>(
  lane: Lane,
  file: (typeof EXECUTABLE_EVIDENCE_FILES)[Lane],
  detail: string,
): ExecutableEvidenceStatusFor<Lane> {
  return {
    lane,
    file,
    state: "corrupt",
    fresh: false,
    passed: null,
    bundleHash: null,
    detail,
  };
}

function boundEvidenceStatus<Lane extends ExecutableEvidenceLane>(
  lane: Lane,
  file: (typeof EXECUTABLE_EVIDENCE_FILES)[Lane],
  recordedBundleHash: string,
  currentBundleHash: string,
  passed: boolean,
  summary: string,
): ExecutableEvidenceStatusFor<Lane> {
  if (recordedBundleHash !== currentBundleHash) {
    return {
      lane,
      file,
      state: "stale",
      fresh: false,
      passed,
      bundleHash: recordedBundleHash,
      detail: `${file} is stale: exercised ${recordedBundleHash.slice(0, 12)}… but the bundle now hashes to ${currentBundleHash.slice(0, 12)}… (${summary}).`,
    };
  }
  return {
    lane,
    file,
    state: passed ? "fresh" : "failed",
    fresh: true,
    passed,
    bundleHash: recordedBundleHash,
    detail: passed
      ? `Passing evidence matches bundle ${currentBundleHash.slice(0, 12)}… (${summary}).`
      : `Current evidence failed for bundle ${currentBundleHash.slice(0, 12)}… (${summary}).`,
  };
}

/* -------------------------------------------------------------------------- */
/* Gate helpers                                                                */
/* -------------------------------------------------------------------------- */

/** The exposed surface projection every artifact must agree on. */
interface SurfaceOp {
  id: string;
  toolName: string;
  cli: string;
}

function surfaceKey(op: SurfaceOp): string {
  return `${op.id} → mcp:${op.toolName} cli:"${op.cli}"`;
}

function approvedSurface(air: AirDocument): SurfaceOp[] {
  return air.operations
    .filter((op) => op.state === "approved")
    .map((op) => ({ id: op.id, toolName: op.mcp.toolName, cli: op.cli.command }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Parse a JSON artifact, returning undefined (not throwing) when absent/corrupt. */
function parseJson(files: Record<string, string>, rel: string): unknown | undefined {
  const text = files[rel];
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Compare two surface sets; returns human-readable drift lines (empty = agree). */
function surfaceDrift(expected: SurfaceOp[], actual: SurfaceOp[], artifact: string): string[] {
  const want = new Map(expected.map((o) => [o.id, surfaceKey(o)]));
  const got = new Map(actual.map((o) => [o.id, surfaceKey(o)]));
  const drift: string[] = [];
  for (const [id, key] of want) {
    const found = got.get(id);
    if (found === undefined) drift.push(`${artifact}: missing ${id}`);
    else if (found !== key) drift.push(`${artifact}: ${found} ≠ ${key}`);
  }
  for (const id of got.keys()) {
    if (!want.has(id)) drift.push(`${artifact}: exposes unapproved ${id}`);
  }
  return drift;
}

function check(
  id: string,
  gate: CertificationGate,
  failures: string[],
  passDetail: string,
): CertificationCheck {
  return failures.length === 0
    ? { id, gate, status: "passed", detail: passDetail }
    : { id, gate, status: "failed", detail: failures.join("; ") };
}

const CapabilityParentGatewayImport = z.object({
  importId: z.string().regex(/^gwi-[0-9a-f]{16}$/),
  receiptDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  receiptViewDigest: z.string().regex(/^[0-9a-f]{64}$/),
  outputDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  lineage: z.enum(["bound", "stale"]),
  blockerCount: z.number().int().nonnegative(),
});

const CapabilityBundleWithParentGatewayImport = z.object({
  parentGatewayImport: CapabilityParentGatewayImport,
});

/**
 * A derived capability must not turn its copied gateway receipt into decorative
 * provenance. The manifest declaration, the copied receipt view, and every
 * content-bearing coordinate between them must agree.
 */
function capabilityParentGatewayChecks(files: Record<string, string>): CertificationCheck[] {
  const manifestText = files["bundle.json"];
  if (manifestText === undefined) return [];

  let decodedManifest: unknown;
  try {
    decodedManifest = JSON.parse(manifestText);
  } catch {
    return [
      check(
        "contract.capability-parent-gateway-provenance",
        "contract",
        ["bundle.json is not valid JSON; parent gateway lineage cannot be verified"],
        "Capability parent gateway lineage is schema-valid and digest-bound",
      ),
    ];
  }
  if (
    decodedManifest === null ||
    typeof decodedManifest !== "object" ||
    !Object.hasOwn(decodedManifest, "parentGatewayImport")
  ) {
    return [];
  }

  const failures: string[] = [];
  const parsedManifest = CapabilityBundleWithParentGatewayImport.safeParse(decodedManifest);
  if (!parsedManifest.success) {
    failures.push(
      `bundle.json parentGatewayImport fails schema validation: ${parsedManifest.error.issues[0]?.message ?? "invalid"}`,
    );
  } else {
    const expected = parsedManifest.data.parentGatewayImport;
    const receiptPath = "provenance/parent-gateway-import.receipt.json";
    const receipt = parseJson(files, receiptPath);
    if (receipt === undefined) {
      failures.push(`${receiptPath} is missing or not valid JSON`);
    } else {
      const parsedReceipt = GatewayImportReceiptView.safeParse(receipt);
      if (!parsedReceipt.success) {
        failures.push(
          `${receiptPath} fails the gateway receipt-view schema: ${parsedReceipt.error.issues[0]?.message ?? "invalid"}`,
        );
      } else {
        const actual = parsedReceipt.data;
        const compare = (
          label: string,
          declared: string | number,
          copied: string | number,
        ): void => {
          if (declared !== copied) {
            failures.push(
              `${label} mismatch: bundle.json declares ${declared}, receipt has ${copied}`,
            );
          }
        };
        compare("importId", expected.importId, actual.importId);
        compare("receiptDigest", expected.receiptDigest, actual.receiptDigest);
        compare("receiptViewDigest", expected.receiptViewDigest, hashCanonical(actual));
        compare("outputDigest", expected.outputDigest, actual.output.digest);
        compare("lineage", expected.lineage, actual.lineage.status);
        compare("blockerCount", expected.blockerCount, actual.blockers.length);

        const canonicalOutputDigest = `sha256:${hashCanonical(actual.output.files)}`;
        if (actual.output.digest !== canonicalOutputDigest) {
          failures.push(
            `copied parent output manifest hashes to ${canonicalOutputDigest}, not ${actual.output.digest}`,
          );
        }
        if (actual.lineage.status !== "bound") {
          failures.push(`copied parent gateway lineage is stale: ${actual.lineage.reason}`);
        }
        for (const blocker of actual.blockers) {
          failures.push(
            `unresolved parent gateway blocker ${blocker.code}${blocker.coordinate ? ` at ${blocker.coordinate.origin}` : ""}: ${blocker.message}`,
          );
        }
      }
    }
  }

  return [
    check(
      "contract.capability-parent-gateway-provenance",
      "contract",
      failures,
      "Capability parent gateway receipt is schema-valid, bound, blocker-free, and exactly matches bundle.json",
    ),
  ];
}

/* -------------------------------------------------------------------------- */
/* CONTRACT gate — every generated surface agrees with canonical AIR           */
/* -------------------------------------------------------------------------- */

function contractChecks(files: Record<string, string>, air: AirDocument): CertificationCheck[] {
  const checks: CertificationCheck[] = [];

  // AIR itself must re-validate through Zod — a bundle whose canonical model no
  // longer parses has no contract to certify against.
  const airJson = parseJson(files, "air.json");
  const parsed = airJson === undefined ? undefined : AirDocumentSchema.safeParse(airJson);
  checks.push(
    check(
      "contract.air-valid",
      "contract",
      !parsed
        ? ["air.json is missing or not valid JSON"]
        : !parsed.success
          ? [
              `air.json fails AIR schema validation: ${parsed.error.issues[0]?.message ?? "invalid"}`,
            ]
          : parsed.data.service.id !== air.service.id
            ? [`air.json service "${parsed.data.service.id}" ≠ canonical "${air.service.id}"`]
            : [],
      "air.json re-validates through the AIR Zod schema",
    ),
  );

  // Every surface must expose exactly the approved operation set, with the same
  // tool/CLI names. This is the product's core promise: no artifact drifts.
  const expected = approvedSurface(air);
  const drift: string[] = [];

  const catalog = parseJson(files, "catalog.json") as
    | { operations?: Array<{ id: string; mcpTool: string; cli: string; state: string }> }
    | undefined;
  if (!catalog?.operations) drift.push("catalog.json missing or unreadable");
  else
    drift.push(
      ...surfaceDrift(
        expected,
        catalog.operations
          .filter((o) => o.state === "approved")
          .map((o) => ({ id: o.id, toolName: o.mcpTool, cli: o.cli })),
        "catalog.json",
      ),
    );

  const manifest = parseJson(files, "runtime/operations.manifest.json") as
    | { operations?: Array<{ id: string; toolName: string; cli: string }> }
    | undefined;
  if (!manifest?.operations) drift.push("runtime/operations.manifest.json missing or unreadable");
  else
    drift.push(
      ...surfaceDrift(
        expected,
        manifest.operations.map((o) => ({ id: o.id, toolName: o.toolName, cli: o.cli })),
        "runtime/operations.manifest.json",
      ),
    );

  // Each executable entrypoint projects its surface from the AIR copy it ships
  // with. Certify the exact copies loaded by MCP, CLI, and the deployed runtime.
  for (const rel of ["mcp/air.json", "cli/air.json", "runtime/air.json"]) {
    const copy = parseJson(files, rel);
    const copyParsed = copy === undefined ? undefined : AirDocumentSchema.safeParse(copy);
    if (!copyParsed?.success) drift.push(`${rel} missing or fails AIR schema validation`);
    else drift.push(...surfaceDrift(expected, approvedSurface(copyParsed.data), rel));
  }

  checks.push(
    check(
      "contract.surfaces-agree",
      "contract",
      drift,
      `MCP, CLI, deployed runtime AIR, catalog, and runtime manifest all expose exactly the ${expected.length} approved operation(s)`,
    ),
  );

  const generationDrift = generatedProjectionDrift(files, air);
  checks.push(
    check(
      "contract.generated-bytes-agree",
      "contract",
      generationDrift,
      "Every compiler-owned file is the exact deterministic projection of canonical AIR and its persisted generation inputs",
    ),
  );

  const gatewayReceiptText = files["import.receipt.json"];
  const capabilityManifest = parseJson(files, "bundle.json");
  const declaresParentGatewayImport =
    capabilityManifest !== null &&
    typeof capabilityManifest === "object" &&
    Object.hasOwn(capabilityManifest, "parentGatewayImport");
  const gatewayOrigin = GatewayKind.safeParse(air.service.source.origin?.kind);
  if (gatewayReceiptText === undefined && gatewayOrigin.success && !declaresParentGatewayImport) {
    checks.push(
      check(
        "contract.gateway-lineage-current",
        "contract",
        [
          `AIR records gateway origin ${gatewayOrigin.data}, but import.receipt.json is missing and no derived-capability parent receipt is declared`,
        ],
        "Gateway import receipt view is schema-valid and every recorded output byte still matches its manifest",
      ),
    );
    checks.push(
      check(
        "contract.gateway-blockers-resolved",
        "contract",
        ["gateway blockers cannot be verified because import.receipt.json is missing"],
        "Gateway import receipt carries no unresolved route, auth, or opaque-policy blockers",
      ),
    );
  } else if (gatewayReceiptText !== undefined) {
    const failures: string[] = [];
    const blockerFailures: string[] = [];
    const gatewayReceipt = parseJson(files, "import.receipt.json");
    if (gatewayReceipt === undefined) {
      const detail = "import.receipt.json is not valid JSON";
      failures.push(detail);
      blockerFailures.push(`gateway blockers cannot be verified: ${detail}`);
    } else {
      const parsedReceipt = GatewayImportReceiptView.safeParse(gatewayReceipt);
      if (!parsedReceipt.success) {
        const detail = `import.receipt.json fails the gateway receipt-view schema: ${parsedReceipt.error.issues[0]?.message ?? "invalid"}`;
        failures.push(detail);
        blockerFailures.push(`gateway blockers cannot be verified: ${detail}`);
      } else {
        const identity = parsedReceipt.data.selection.identity;
        if (identity) {
          const identityIntegrity = verifyGatewayImportIdentity(identity);
          if (!identityIntegrity.ok) {
            failures.push(
              `gateway import identity digest is invalid: recorded ${identity.digest}/${identity.lineageDigest}, expected ${identityIntegrity.expectedDigest}/${identityIntegrity.expectedLineageDigest}`,
            );
          }
          if (identity.serviceId !== air.service.id) {
            failures.push(
              `gateway import identity belongs to service ${identity.serviceId}, not canonical AIR service ${air.service.id}`,
            );
          }
        }
        for (const blocker of parsedReceipt.data.blockers) {
          const coordinate = blocker.coordinate
            ? ` at ${blocker.coordinate.origin}${blocker.coordinate.pointer ? `#${blocker.coordinate.pointer}` : ""}`
            : "";
          blockerFailures.push(`${blocker.code}${coordinate}: ${blocker.message}`);
        }
        if (parsedReceipt.data.lineage.status !== "bound") {
          failures.push(
            `gateway import output lineage is stale: ${parsedReceipt.data.lineage.reason}`,
          );
        } else {
          const encoded = new Map<string, Uint8Array>();
          const encoder = new TextEncoder();
          for (const expected of parsedReceipt.data.output.files) {
            const contents = files[expected.path];
            if (contents !== undefined) encoded.set(expected.path, encoder.encode(contents));
          }
          failures.push(
            ...verifyGatewayImportOutputManifest(
              parsedReceipt.data.output,
              encoded,
            ).diagnostics.map(
              (diagnostic) =>
                `${diagnostic.path ? `${diagnostic.path}: ` : ""}${diagnostic.message}`,
            ),
          );
        }
      }
    }
    checks.push(
      check(
        "contract.gateway-lineage-current",
        "contract",
        failures,
        "Gateway import receipt view is schema-valid and every recorded output byte still matches its manifest",
      ),
    );
    checks.push(
      check(
        "contract.gateway-blockers-resolved",
        "contract",
        blockerFailures,
        "Gateway import receipt carries no unresolved route, auth, or opaque-policy blockers",
      ),
    );
  }
  checks.push(...capabilityParentGatewayChecks(files));
  return checks;
}

/**
 * Re-run the deterministic generator and compare every compiler-owned byte.
 * Generated target kits, receipts, evidence records, and operator top-level
 * notes are separate lifecycle artifacts; files inside generator-owned roots
 * may not survive as untracked executable/configuration ghosts.
 */
function generatedProjectionDrift(files: Record<string, string>, air: AirDocument): string[] {
  const options = resourceOptionsFromGenerationMetadata(files[GENERATION_METADATA_FILE]);
  if (!options) {
    return [
      `${GENERATION_METADATA_FILE} is missing or invalid; recompile to persist generator inputs`,
    ];
  }
  const expected = generateBundle(air, options).files;
  const drift: string[] = [];
  for (const [path, contents] of Object.entries(expected)) {
    const actual = files[path];
    if (actual === undefined) drift.push(`${path}: missing compiler-owned file`);
    else if (actual !== contents) drift.push(`${path}: bytes differ from deterministic projection`);
  }

  const ownedRoots = new Set(
    Object.keys(expected)
      .filter((path) => path.includes("/"))
      .map((path) => path.slice(0, path.indexOf("/"))),
  );
  for (const path of Object.keys(files).sort()) {
    const slash = path.indexOf("/");
    if (slash < 0) continue;
    if (ownedRoots.has(path.slice(0, slash)) && expected[path] === undefined) {
      drift.push(`${path}: unexpected file inside compiler-owned root`);
    }
  }
  return drift;
}

/* -------------------------------------------------------------------------- */
/* SAFETY gate — the deployed policy must enforce what AIR classified          */
/* -------------------------------------------------------------------------- */

/** The safety-relevant projection of one operation, from AIR or the runtime manifest. */
interface SafetyView {
  id: string;
  where: string;
  kind: string;
  risk: string;
  reversible: boolean;
  idempotencyMode: string;
  retryMode: string;
  retryBasis?: string;
  confirmationRequired: boolean;
  authType: string;
  secretSource?: string;
}

const HIGH_RISK: ReadonlySet<string> = new Set(["high", "financial", "destructive"]);
const UNSUPPORTED_AUTH: ReadonlySet<string> = new Set([
  "mtls",
  "custom_header",
  "oauth2_authorization_code",
]);

function safetyViewFromAir(op: Operation): SafetyView {
  return {
    id: op.id,
    where: "air",
    kind: op.effect.kind,
    risk: op.effect.risk,
    reversible: op.effect.reversible,
    idempotencyMode: op.idempotency.mode,
    retryMode: op.retries.mode,
    retryBasis: op.retries.basis,
    confirmationRequired: op.confirmation.required,
    authType: op.auth.type,
    secretSource: op.auth.secretSource,
  };
}

function safetyViews(files: Record<string, string>, air: AirDocument): SafetyView[] {
  const views = air.operations.filter((op) => op.state === "approved").map(safetyViewFromAir);
  // The runtime manifest is what the deployed hot path enforces — judge it too,
  // so a tampered manifest cannot pass on the strength of a clean AIR.
  const manifest = parseJson(files, "runtime/operations.manifest.json") as
    | {
        operations?: Array<{
          id: string;
          effect?: { kind?: string; risk?: string; reversible?: boolean };
          idempotency?: { mode?: string };
          retries?: { mode?: string; basis?: string };
          confirmation?: { required?: boolean };
          auth?: { type?: string; secretSource?: string };
        }>;
      }
    | undefined;
  for (const op of manifest?.operations ?? []) {
    views.push({
      id: op.id,
      where: "runtime manifest",
      kind: op.effect?.kind ?? "mutation",
      risk: op.effect?.risk ?? "high",
      reversible: op.effect?.reversible ?? false,
      idempotencyMode: op.idempotency?.mode ?? "none",
      retryMode: op.retries?.mode ?? "none",
      retryBasis: op.retries?.basis,
      confirmationRequired: op.confirmation?.required ?? false,
      authType: op.auth?.type ?? "none",
      secretSource: op.auth?.secretSource,
    });
  }
  return views;
}

function safetyChecks(files: Record<string, string>, air: AirDocument): CertificationCheck[] {
  const views = safetyViews(files, air);
  const at = (v: SafetyView) => `${v.id} (${v.where})`;

  // Non-idempotent, irreversible, or high-risk mutations must gate on --confirm.
  const unconfirmed = views
    .filter(
      (v) =>
        v.kind === "mutation" &&
        (v.idempotencyMode === "none" || !v.reversible || HIGH_RISK.has(v.risk)) &&
        !v.confirmationRequired,
    )
    .map((v) => `${at(v)} is a ${v.risk}-risk mutation without required confirmation`);

  // A retry posture must be justified: never "safe" on an unproven basis.
  const unprovenRetry = views
    .filter((v) => v.retryMode === "safe" && (v.retryBasis ?? "unproven") === "unproven")
    .map((v) => `${at(v)} auto-retries on an unproven basis`);

  // The hard rule of the repo: a non-idempotent operation is never auto-retried.
  const retryNonIdempotent = views
    .filter((v) => v.idempotencyMode === "none" && v.retryMode === "safe")
    .map((v) => `${at(v)} has idempotency mode "none" yet is retry-enabled`);

  // Secret handling must be coherent: authenticated calls need a credential
  // source; unauthenticated calls must not claim one (a phantom secret path).
  const secrets = views
    .filter((v) =>
      v.authType === "none"
        ? v.secretSource !== undefined && v.secretSource !== "none"
        : v.secretSource === "none",
    )
    .map(
      (v) =>
        `${at(v)} auth type "${v.authType}" is incoherent with secret source "${v.secretSource}"`,
    );
  const unsupportedAuth = views
    .filter((view) => UNSUPPORTED_AUTH.has(view.authType))
    .map(
      (view) =>
        `${at(view)} uses unsupported auth type "${view.authType}"; no safe transport/carrier is modeled`,
    );
  const incoherentAuthority = air.operations
    .filter((operation) => operation.state === "approved")
    .flatMap((operation) =>
      authCoherenceIssues(operation.auth).map((issue) => `${operation.id}: ${issue}`),
    );

  return [
    check(
      "safety.confirmation-required",
      "safety",
      unconfirmed,
      "every non-idempotent/irreversible/high-risk mutation requires confirmation",
    ),
    check(
      "safety.retry-basis-proven",
      "safety",
      unprovenRetry,
      "no retry-enabled operation rests on an unproven basis",
    ),
    check(
      "safety.no-retry-without-idempotency",
      "safety",
      retryNonIdempotent,
      'no approved operation with idempotency mode "none" is retried',
    ),
    check(
      "safety.secret-handling-coherent",
      "safety",
      secrets,
      "auth type and secret source are coherent on every approved operation",
    ),
    check(
      "safety.auth-runtime-supported",
      "safety",
      unsupportedAuth,
      "every approved operation has an auth scheme the runtime can faithfully enforce",
    ),
    check(
      "safety.auth-authority-coherent",
      "safety",
      incoherentAuthority,
      "every approved operation's auth type, principal, grant, and secret source agree",
    ),
  ];
}

/* -------------------------------------------------------------------------- */
/* SEMANTIC gate — approved operations must be understandable and routable     */
/* -------------------------------------------------------------------------- */

function semanticChecks(air: AirDocument): CertificationCheck[] {
  // Reuse the refinement detectors — certification must never re-invent what a
  // deficiency means, or the two judgements would drift.
  const deficiencies = runDetectors(air);
  const approved = new Map(
    air.operations.filter((op) => op.state === "approved").map((op) => [op.id, op]),
  );
  const onApproved = (code: string) =>
    deficiencies.filter((d) => {
      const opId = targetOperationId(d.target);
      return d.code === code && opId !== undefined && approved.has(opId);
    });

  const missingDesc = onApproved("missing_operation_description").map(
    (d) => `${targetOperationId(d.target)} has no description`,
  );

  const indistinct = onApproved("indistinct_operation_descriptions").map(
    (d) => `${targetOperationId(d.target)}: ${d.message}`,
  );

  // Routability: an agent must be able to reach the operation by intent. Intent
  // examples on the operation satisfy this directly; when the compiler left them
  // empty, routing phrases on the owning capability still make it reachable.
  const capabilities = new Map(air.capabilities.map((c) => [c.id, c]));
  const unroutable = onApproved("operation_lacks_intent_examples")
    .map((d) => targetOperationId(d.target) as string)
    .filter((opId) => {
      const op = approved.get(opId);
      const cap = op?.capabilityId ? capabilities.get(op.capabilityId) : undefined;
      return (cap?.intentExamples.length ?? 0) === 0;
    })
    .map((opId) => `${opId} has no intent examples and its capability has no routing phrases`);

  // A blocking disposition on an exposed operation is a certification stop: the
  // detectors have said this operation should not ship as-is.
  const blocked = deficiencies
    .filter((d) => {
      const opId = targetOperationId(d.target);
      return d.severity === "blocking" && opId !== undefined && approved.has(opId);
    })
    .map((d) => `${targetOperationId(d.target)}: ${d.code} — ${d.message}`);

  return [
    check(
      "semantic.descriptions-present",
      "semantic",
      missingDesc,
      "every approved operation has a description",
    ),
    check(
      "semantic.sibling-descriptions-distinct",
      "semantic",
      indistinct,
      "sibling operations within a capability have distinct descriptions",
    ),
    check(
      "semantic.intent-routable",
      "semantic",
      unroutable,
      "every approved operation is reachable by intent (operation or capability routing phrases)",
    ),
    check(
      "semantic.no-blocked-disposition",
      "semantic",
      blocked,
      "no approved operation carries a blocking disposition",
    ),
  ];
}

/* -------------------------------------------------------------------------- */
/* RUNTIME gate — mocks, evals, conformance, and deploy artifacts are present  */
/* -------------------------------------------------------------------------- */

const DEPLOY_FILES = [
  "deploy/Dockerfile",
  "deploy/cloudbuild.yaml",
  "deploy/terraform/main.tf",
  "deploy/terraform/variables.tf",
  "deploy/idempotency-store.json",
  "deploy/env.schema.json",
  "deploy/secrets.required.yaml",
  "deploy/README.md",
] as const;

function runtimeChecks(files: Record<string, string>, air: AirDocument): CertificationCheck[] {
  const approvedIds = air.operations.filter((op) => op.state === "approved").map((op) => op.id);

  // Mocks: present, parseable, and covering every approved operation — a mock
  // surface that silently drops an operation cannot exercise the bundle.
  const mockFailures: string[] = [];
  if (files["mock/server.mjs"] === undefined) mockFailures.push("mock/server.mjs is missing");
  const scenarios = parseJson(files, "mock/scenarios.json") as
    | Array<{ operationId?: string }>
    | undefined;
  if (!Array.isArray(scenarios)) {
    mockFailures.push("mock/scenarios.json is missing or unreadable");
  } else {
    const covered = new Set(scenarios.map((s) => s.operationId));
    for (const id of approvedIds) {
      if (!covered.has(id)) mockFailures.push(`no mock scenario covers ${id}`);
    }
  }

  // Evals: the generated suites must exist and parse — they are the behavior
  // contract the refinement loop measures against. Suites that derive zero
  // cases are legitimately omitted (an empty file reads as phantom coverage),
  // but a bundle with NO suites must carry the README documenting the omission.
  const evalFiles = Object.keys(files).filter(
    (rel) => rel.startsWith("skill/evals/") && rel.endsWith(".yaml"),
  );
  const evalFailures: string[] = [];
  if (evalFiles.length === 0 && files["skill/evals/README.md"] === undefined)
    evalFailures.push(
      "no generated eval suites under skill/evals/ and no skill/evals/README.md documenting their omission",
    );
  for (const rel of evalFiles) {
    try {
      const doc = parseYaml(files[rel] ?? "") as { suite?: unknown };
      if (typeof doc?.suite !== "string") evalFailures.push(`${rel} has no suite name`);
    } catch {
      evalFailures.push(`${rel} is not valid YAML`);
    }
  }

  // Conformance: the generated test must exist and point at the runtime
  // manifest it is supposed to verify.
  const conformance = files["tests/conformance.test.ts"];
  const conformanceFailures: string[] = [];
  if (conformance === undefined) conformanceFailures.push("tests/conformance.test.ts is missing");
  else if (!conformance.includes("runtime/operations.manifest.json"))
    conformanceFailures.push("tests/conformance.test.ts does not verify the runtime manifest");

  const deployFailures = DEPLOY_FILES.filter((rel) => files[rel] === undefined).map(
    (rel) => `${rel} is missing`,
  );

  return [
    check(
      "runtime.mocks-consistent",
      "runtime",
      mockFailures,
      "mock server and scenarios are present and cover every approved operation",
    ),
    check(
      "runtime.evals-present",
      "runtime",
      evalFailures,
      evalFiles.length === 0
        ? "every eval suite derived zero cases; skill/evals/README.md documents the omission"
        : "generated eval suites parse",
    ),
    check(
      "runtime.conformance-present",
      "runtime",
      conformanceFailures,
      "generated conformance test verifies the runtime manifest",
    ),
    check(
      "runtime.deploy-present",
      "runtime",
      deployFailures,
      "Cloud Run deploy artifacts present",
    ),
  ];
}

/* -------------------------------------------------------------------------- */
/* Certification                                                               */
/* -------------------------------------------------------------------------- */

export interface CertifyOptions {
  /** Injectable clock; only `certifiedAt` depends on it. */
  now?: Clock;
}

/**
 * Run every certification gate over a bundle. Pure: identical inputs produce an
 * identical certification except for `certifiedAt` — the check results and the
 * bundle hash carry no timestamp, so re-certifying an unchanged bundle is
 * reproducible by construction.
 */
export function certifyBundle(
  files: Record<string, string>,
  air: AirDocument,
  options: CertifyOptions = {},
): Certification {
  const checks: CertificationCheck[] = [
    ...contractChecks(files, air),
    ...safetyChecks(files, air),
    ...semanticChecks(air),
    ...runtimeChecks(files, air),
  ];
  // A bundle serving exactly one capability is certified *as* that capability.
  const capabilityId = air.capabilities.length === 1 ? air.capabilities[0]?.id : undefined;
  return {
    schemaVersion: 1,
    serviceId: air.service.id,
    capabilityId,
    bundleHash: bundleHash(files),
    assuranceLevel: "static",
    status: checks.some((c) => c.status === "failed") ? "failed" : "passed",
    checks,
    certifiedAt: (options.now ?? systemClock)(),
  };
}

/* -------------------------------------------------------------------------- */
/* Publication gating (PR 8)                                                   */
/* -------------------------------------------------------------------------- */

const PublicationGate = z.union([
  z.object({
    status: z.literal("passed"),
    certifiedAt: z.string(),
    assuranceLevel: z.literal("static").default("static"),
  }),
  z.object({ status: z.literal("waived"), reason: z.string().min(1) }),
]);

const BundleDigest = z.string().regex(/^[0-9a-f]{64}$/);

const PublicationEvidenceSnapshotBase = z.object({
  state: z.enum(["fresh", "missing", "corrupt", "failed", "stale"]),
  fresh: z.boolean(),
  passed: z.boolean().nullable(),
  bundleHash: BundleDigest.nullable(),
  detail: z.string().min(1),
});

const SelftestPublicationEvidenceSnapshot = PublicationEvidenceSnapshotBase.extend({
  lane: z.literal("selftest"),
  file: z.literal(SELFTEST_REPORT_FILE),
});
const ConformancePublicationEvidenceSnapshot = PublicationEvidenceSnapshotBase.extend({
  lane: z.literal("conformance"),
  file: z.literal(CONFORMANCE_REPORT_FILE),
});
const SimulationPublicationEvidenceSnapshot = PublicationEvidenceSnapshotBase.extend({
  lane: z.literal("simulation"),
  file: z.literal(SIMULATION_REPORT_FILE),
});

const PassingEvidenceFields = {
  state: z.literal("fresh"),
  fresh: z.literal(true),
  passed: z.literal(true),
  bundleHash: BundleDigest,
} as const;

const PublicationEvidenceRecords = z.object({
  selftest: SelftestPublicationEvidenceSnapshot,
  conformance: ConformancePublicationEvidenceSnapshot,
  simulation: SimulationPublicationEvidenceSnapshot,
});

const PassingPublicationEvidenceRecords = z.object({
  selftest: SelftestPublicationEvidenceSnapshot.extend(PassingEvidenceFields),
  conformance: ConformancePublicationEvidenceSnapshot.extend(PassingEvidenceFields),
  simulation: SimulationPublicationEvidenceSnapshot.extend(PassingEvidenceFields),
});

/** Snapshot of the current executable proof gate when a deployment plan was prepared. */
export const PublicationExecutableEvidence = z.union([
  z.object({
    status: z.literal("passed"),
    records: PassingPublicationEvidenceRecords,
  }),
  z.object({
    status: z.literal("waived"),
    records: PublicationEvidenceRecords,
    waiver: z.object({
      flag: z.literal("--allow-incomplete-evidence"),
      reason: z.string().min(1),
    }),
  }),
]);
export type PublicationExecutableEvidence = z.infer<typeof PublicationExecutableEvidence>;

const DeploymentPlanRecord = z
  .object({
    schemaVersion: z.literal(2),
    recordKind: z.literal("deployment_plan"),
    serviceId: z.string().min(1),
    target: z.literal("cloud-run"),
    env: z.enum(["dev", "staging", "prod"]),
    /** Identity of the exact bundle content the plan was prepared for. */
    bundleHash: BundleDigest,
    /** How the gate was satisfied: current static assurance, or a non-prod waiver. */
    certification: PublicationGate,
    /** Fresh executable proof, or an explicit non-prod-only waiver. */
    executableEvidence: PublicationExecutableEvidence,
    plannedAt: z.string(),
    cloudCallsMade: z.literal(false),
    operatorActionRequired: z.literal(true),
    /** The deploy artifacts this plan points at. */
    artifacts: z.array(z.string().min(1)).min(1),
  })
  .superRefine((record, ctx) => {
    if (record.env === "prod" && record.certification.status === "waived") {
      ctx.addIssue({
        code: "custom",
        path: ["certification"],
        message: "production deployment plans cannot waive static assurance",
      });
    }
    if (record.env === "prod" && record.executableEvidence.status === "waived") {
      ctx.addIssue({
        code: "custom",
        path: ["executableEvidence"],
        message: "production deployment plans cannot waive executable evidence",
      });
    }
    if (record.executableEvidence.status === "passed") {
      for (const lane of ["selftest", "conformance", "simulation"] as const) {
        const evidenceHash = record.executableEvidence.records[lane].bundleHash;
        if (evidenceHash === record.bundleHash) continue;
        ctx.addIssue({
          code: "custom",
          path: ["executableEvidence", "records", lane, "bundleHash"],
          message: `${lane} evidence hash must equal the deployment plan bundleHash`,
        });
      }
    }
  });

/** Legacy plan record written before the command's plan-only semantics were explicit. */
const LegacyPublicationRecord = z.object({
  schemaVersion: z.literal(1),
  serviceId: z.string(),
  target: z.literal("cloud-run"),
  env: z.string(),
  bundleHash: z.string(),
  certification: PublicationGate,
  publishedAt: z.string(),
  artifacts: z.array(z.string()),
});

/** New honest plan records plus read compatibility for legacy publication.json. */
export const PublicationRecord = z.union([DeploymentPlanRecord, LegacyPublicationRecord]);
export type PublicationRecord = z.infer<typeof PublicationRecord>;

export type CertificationVerdict =
  | { ok: true; certification: Certification }
  | { ok: false; reason: string; certification?: Certification };

/**
 * Verify that a bundle carries PASSING static assurance whose bundleHash matches
 * the bundle's *current* content — a record issued for different bytes is stale
 * and must not gate a deployment plan.
 */
export function verifyCertification(files: Record<string, string>): CertificationVerdict {
  const raw = parseJson(files, CERTIFICATION_FILE);
  if (raw === undefined) {
    return {
      ok: false,
      reason: `no ${CERTIFICATION_FILE} in the bundle — run \`anvil certify\` for static assurance first`,
    };
  }
  const parsed = Certification.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: `${CERTIFICATION_FILE} does not match the certification schema` };
  }
  const cert = parsed.data;
  if (cert.status !== "passed") {
    return {
      ok: false,
      reason: `static assurance status is "${cert.status}", not "passed"`,
      certification: cert,
    };
  }
  const current = bundleHash(files);
  if (cert.bundleHash !== current) {
    return {
      ok: false,
      reason: `static assurance is stale: assured ${cert.bundleHash.slice(0, 12)}… but the bundle now hashes to ${current.slice(0, 12)}…`,
      certification: cert,
    };
  }
  return { ok: true, certification: cert };
}

/* -------------------------------------------------------------------------- */
/* Thin fs shell                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Read a bundle directory into the pure core's input shape: relative POSIX
 * paths → file contents. The only filesystem-touching entry to certification.
 * Install artifacts are not bundle content: `node_modules` (created by an
 * install, or linked in by `anvil selftest`) is skipped. Any other symlink is
 * refused so mutable or external link targets cannot sit outside the identity
 * that certification binds.
 */
export function readBundleDir(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.name === "node_modules") continue;
      if (entry.isSymbolicLink()) {
        throw new Error(
          `Unexpected symlink in bundle at ${childRel}; certification cannot bind external or mutable link targets.`,
        );
      }
      if (entry.isDirectory()) walk(childRel);
      else files[childRel] = readFileSync(join(dir, childRel), "utf8");
    }
  };
  walk("");
  return files;
}
