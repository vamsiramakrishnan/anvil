import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AirDocument, Operation } from "@anvil/air";
import { AirDocument as AirDocumentSchema } from "@anvil/air";
import { runDetectors, targetOperationId } from "@anvil/refinement";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * Capability certification (Layer 5). A certification is a *judgement over a
 * generated bundle*: deterministic gates re-check that the artifacts on disk
 * still embody the safety and alignment contract AIR promised at compile time.
 * The core is pure — `(bundle files, AirDocument) → Certification` — so gates
 * can never depend on ambient state; only the thin shell (`readBundleDir`)
 * touches the filesystem. Certification lives in generators because it judges
 * what generators emit.
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

/** Injectable clock so certification/publication records are testable. */
export type Clock = () => string;
const systemClock: Clock = () => new Date().toISOString();

/* -------------------------------------------------------------------------- */
/* Bundle identity                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Files that are *records about* the bundle, not part of its generated content.
 * They are excluded from the hash so writing a certification (or publication)
 * into the bundle does not invalidate the very identity it attests to.
 */
const RECORD_FILES: ReadonlySet<string> = new Set([
  CERTIFICATION_FILE,
  PUBLICATION_FILE,
  SELFTEST_REPORT_FILE,
]);

/**
 * Content-derived identity of a bundle: sha256 over the sorted relative paths
 * and per-file content hashes of every generated file. Deterministic, so an
 * unchanged bundle always re-hashes to the same value and any tamper — content
 * or file set — changes it.
 */
export function bundleHash(files: Record<string, string>): string {
  const hash = createHash("sha256");
  for (const rel of Object.keys(files).sort()) {
    if (RECORD_FILES.has(rel)) continue;
    const content = createHash("sha256")
      .update(files[rel] ?? "")
      .digest("hex");
    hash.update(`${rel}\0${content}\0`);
  }
  return hash.digest("hex");
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

  // The MCP server and CLI entrypoints both project their surface from the
  // air.json copy they ship with — certify the copy they actually load.
  for (const rel of ["mcp/air.json", "cli/air.json"]) {
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
      `MCP tools, CLI catalog, and runtime manifest all expose exactly the ${expected.length} approved operation(s)`,
    ),
  );
  return checks;
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
  // contract the refinement loop measures against.
  const evalFiles = Object.keys(files).filter(
    (rel) => rel.startsWith("skill/evals/") && rel.endsWith(".yaml"),
  );
  const evalFailures: string[] = [];
  if (evalFiles.length === 0) evalFailures.push("no generated eval suites under skill/evals/");
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
    check("runtime.evals-present", "runtime", evalFailures, "generated eval suites parse"),
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
    status: checks.some((c) => c.status === "failed") ? "failed" : "passed",
    checks,
    certifiedAt: (options.now ?? systemClock)(),
  };
}

/* -------------------------------------------------------------------------- */
/* Publication gating (PR 8)                                                   */
/* -------------------------------------------------------------------------- */

export const PublicationRecord = z.object({
  schemaVersion: z.literal(1),
  serviceId: z.string(),
  target: z.literal("cloud-run"),
  env: z.string(),
  /** Identity of the exact bundle content that was published. */
  bundleHash: z.string(),
  /** How the gate was satisfied: a verified cert, or an explicit non-prod waiver. */
  certification: z.union([
    z.object({ status: z.literal("passed"), certifiedAt: z.string() }),
    z.object({ status: z.literal("waived"), reason: z.string() }),
  ]),
  publishedAt: z.string(),
  /** The deploy artifacts this publication points at. */
  artifacts: z.array(z.string()),
});
export type PublicationRecord = z.infer<typeof PublicationRecord>;

export type CertificationVerdict =
  | { ok: true; certification: Certification }
  | { ok: false; reason: string; certification?: Certification };

/**
 * Verify that a bundle carries a PASSING certification whose bundleHash matches
 * the bundle's *current* content — a cert issued for different bytes is stale
 * and must not gate a publish.
 */
export function verifyCertification(files: Record<string, string>): CertificationVerdict {
  const raw = parseJson(files, CERTIFICATION_FILE);
  if (raw === undefined) {
    return {
      ok: false,
      reason: `no ${CERTIFICATION_FILE} in the bundle — run \`anvil certify\` first`,
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
      reason: `certification status is "${cert.status}", not "passed"`,
      certification: cert,
    };
  }
  const current = bundleHash(files);
  if (cert.bundleHash !== current) {
    return {
      ok: false,
      reason: `certification is stale: certified ${cert.bundleHash.slice(0, 12)}… but the bundle now hashes to ${current.slice(0, 12)}…`,
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
 * install, or linked in by `anvil selftest`) and symlinks are skipped so the
 * certification binds to the generated files only.
 */
export function readBundleDir(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.isSymbolicLink()) continue;
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(childRel);
      else files[childRel] = readFileSync(join(dir, childRel), "utf8");
    }
  };
  walk("");
  return files;
}
