import {
  type AirDocument,
  type AuthRequirement,
  type Diagnostic,
  type JsonSchema,
  loadAirDocument,
  operationInputSchema,
  snakeCase,
} from "@anvil/air";
import { discoverCapabilities } from "./capabilities.js";
import { overlayDigest } from "./contract/digest.js";
import type { AppliedOverlay, PolicyOverlay, SemanticConflict } from "./contract/model.js";
import { manifestToOverlay } from "./contract/overlay.js";
import { applyResolved, resolveOverlays } from "./contract/resolution.js";
import { applyDialectAdjustment, detectNamingDialect } from "./dialect.js";
import { type AnvilManifest, buildWorkflows, parseManifest } from "./manifest.js";
import { critiqueNames, resolveNameCollisions } from "./naming.js";
import { normalize } from "./normalize.js";
import { type ParsedSpec, parseSource } from "./parse.js";
import { type CompilerSource, ephemeralCompilerSource } from "./source/compiler-source.js";
import { validate } from "./validate.js";

export interface CompileInput {
  /** OpenAPI 3.x / Swagger 2.0 document text. */
  spec: string;
  /** Optional supplemental Anvil manifest text. */
  manifest?: string;
  /** Override the derived service id. */
  serviceId?: string;
  /** Provenance URI recorded in AIR. */
  sourceUri?: string;
}

export interface CompileSourceOptions {
  /** Optional supplemental Anvil manifest text. */
  manifest?: string;
  /** Override the derived service id. */
  serviceId?: string;
}

/**
 * Options for the overlay-aware compile. Separate from `CompileSourceOptions` so
 * the AIR-only `compileSource` *cannot* accept overlays and therefore can never
 * silently discard a semantic conflict (#1) — the only overlay path is
 * `compileContract`, which returns a typed `EffectiveContractResult`.
 */
export interface EffectiveCompileOptions extends CompileSourceOptions {
  overlays?: readonly PolicyOverlay[];
}

/**
 * The full result of compiling a source with overlays: the effective AIR, any
 * safety-sensitive conflicts overlay resolution refused to decide, the operations
 * blocked by those conflicts, and the applied overlay identities. Internal to the
 * contract layer; callers use `compileContract`.
 */
export interface EffectiveCompileResult {
  air: AirDocument;
  conflicts: SemanticConflict[];
  blockedOperationIds: string[];
  appliedOverlays: AppliedOverlay[];
}

/**
 * The single compiler entry point: compile the chosen entrypoint of an
 * immutable source snapshot. Everything the compiler reads — the spec and every
 * local $ref — comes from `source.files`, and the resulting AIR is bound back
 * to the snapshot's identity via `service.source`. This is the real Layer 0 →
 * Layer 1 join. It accepts no overlays; use `compileContract` for the overlay
 * path so conflicts are surfaced as data.
 */
export async function compileSource(
  source: CompilerSource,
  options: CompileSourceOptions = {},
): Promise<AirDocument> {
  return (await compileSourceEffective(source, options)).air;
}

/**
 * Compile a source (optionally with overlays) and return the whole effective
 * result. The contract layer builds a `ContractSnapshot`/`EffectiveContractResult`
 * from this; it is not a general public API (see `compileContract`).
 */
export async function compileSourceEffective(
  source: CompilerSource,
  options: EffectiveCompileOptions = {},
): Promise<EffectiveCompileResult> {
  const parsed = await parseSource(source);
  return buildAir(parsed, { ...options, provenance: source });
}

/**
 * Compile raw spec text. Compatibility convenience: wraps the text in an
 * ephemeral one-file source and runs the one `compileSource` pipeline, so a
 * string caller produces AIR byte-identical to a snapshot caller.
 */
export async function compile(input: CompileInput): Promise<AirDocument> {
  const source = ephemeralCompilerSource(input.spec, input.sourceUri);
  return compileSource(source, { manifest: input.manifest, serviceId: input.serviceId });
}

interface BuildAirOptions extends EffectiveCompileOptions {
  provenance: CompilerSource;
}

/**
 * The compiler loop (spec §5): parse → normalize → refine → validate → AIR.
 * This is the single canonical model every artifact is generated from. The
 * "refine" slot applies policy overlays (the canonical channel) or, in the
 * legacy convenience path, the manifest — both through one application function.
 */
async function buildAir(
  parsed: ParsedSpec,
  options: BuildAirOptions,
): Promise<EffectiveCompileResult> {
  const provenance = options.provenance;
  const doc = parsed.document;
  const manifest: AnvilManifest = options.manifest
    ? parseManifest(options.manifest)
    : { operations: {}, workflows: {} };

  const title = (doc.info?.title as string | undefined) ?? "service";
  const serviceId = options.serviceId ?? manifest.service?.name ?? snakeCase(title) ?? "service";

  let operations = normalize(serviceId, parsed);
  // Naming pass: resolve any name collisions coherently across id/CLI/tool with
  // meaningful tokens (never a silent `_2`) before enrichment or validation.
  const namingDiagnostics = resolveNameCollisions(operations);

  // Whole-spec dialect inference: classify the corpus's naming house style ONCE
  // and fold it into every `name.quality` claim's confidence. Never changes a
  // derived name — it only tunes how much the declared ids are trusted.
  const dialect = detectNamingDialect(operations.map((op) => op.sourceRef));
  namingDiagnostics.push({
    level: "info",
    code: "naming_dialect",
    message:
      `Naming dialect "${dialect.dialect}" (casing: ${dialect.casing}, ` +
      `confidence ${dialect.confidence.toFixed(2)}, ${dialect.sampled} operations sampled) — ` +
      `${dialect.signals[0] ?? "no evidence"}.`,
  });
  applyDialectAdjustment(operations, dialect);

  // The override slot — a single resolution path (#5). The manifest's *operation*
  // overrides are converted to an `origin:"manifest"` overlay and resolved
  // alongside any supplied overlays, so the manifest is authoring syntax over the
  // one overlay mechanism and can never be a silently-ignored second channel.
  // (Manifest service metadata + authored workflows stay separate, below.)
  const manifestOverlay = manifestToOverlay(manifest);
  const overlays: PolicyOverlay[] = [
    ...(manifestOverlay.assertions.length > 0 ? [manifestOverlay] : []),
    ...(options.overlays ?? []),
  ];
  let conflicts: SemanticConflict[] = [];
  let blockedOperationIds: string[] = [];
  const overlayDiagnostics: Diagnostic[] = [];
  let appliedOverlays: AppliedOverlay[] = [];
  if (overlays.length > 0) {
    const outcome = resolveOverlays(operations, overlays);
    operations = applyResolved(operations, outcome);
    conflicts = outcome.conflicts;
    blockedOperationIds = outcome.blockedOperationIds;
    overlayDiagnostics.push(...outcome.diagnostics);
    appliedOverlays = overlays.map((o) => ({
      id: o.id,
      digest: o.digest || overlayDigest(o),
      origin: o.origin,
    }));
  }

  // Attach the assembled input JSON Schema to each operation.
  for (const op of operations) {
    op.input.schema = operationInputSchema(op);
  }

  const { operations: validated, diagnostics } = validate(operations);

  // Critique the final names for agent-friendliness (reviewable diagnostics).
  const nameConfidence = new Map(
    validated.map((op) => [
      op.id,
      op.evidence.claims.find((c) => c.predicate === "name.quality")?.confidence ?? 1,
    ]),
  );
  namingDiagnostics.push(...critiqueNames(validated, nameConfidence));

  // Group operations into capabilities (the primary abstraction), then attach
  // any authored workflows. Capability discovery stamps `capabilityId` on each
  // operation in place.
  const capabilities = discoverCapabilities(serviceId, validated);
  const { workflows, diagnostics: workflowDiagnostics } = buildWorkflows(
    manifest,
    validated,
    capabilities,
  );

  const serviceAuth: AuthRequirement = validated.find((o) => o.auth.type !== "none")?.auth ?? {
    type: "none",
    scopes: [],
    principal: "anonymous",
    secretSource: "none",
  };

  const air = {
    anvilVersion: "0.1.0",
    service: {
      id: serviceId,
      version: manifest.service?.environment
        ? `${(doc.info?.version as string) ?? "0.0.0"}-${manifest.service.environment}`
        : ((doc.info?.version as string) ?? "0.0.0"),
      displayName: manifest.service?.display_name ?? title,
      owner: manifest.service?.owner,
      environment: manifest.service?.environment,
      source: {
        kind: parsed.kind,
        uri: provenance.origin.uri,
        snapshotId: provenance.snapshotId,
        sourceHash: provenance.sourceHash,
        origin: { kind: provenance.origin.kind, uri: provenance.origin.uri },
        entrypoint: provenance.entrypoint.path,
      },
      auth: serviceAuth,
      servers: (doc.servers ?? []).map((s) => ({ url: s.url, description: s.description })),
    },
    operations: validated,
    capabilities,
    workflows,
    schemas: (doc.components?.schemas as Record<string, JsonSchema> | undefined) ?? {},
    diagnostics: [
      ...parsed.diagnostics,
      ...diagnostics,
      ...namingDiagnostics,
      ...workflowDiagnostics,
      ...overlayDiagnostics,
    ],
  };

  return { air: loadAirDocument(air), conflicts, blockedOperationIds, appliedOverlays };
}

/** Approve operations by id (spec §17 approval workflow). */
export function approveOperations(air: AirDocument, ids: string[]): AirDocument {
  const set = new Set(ids);
  for (const op of air.operations) {
    if (set.has(op.id) && op.state !== "blocked") op.state = "approved";
  }
  return air;
}
