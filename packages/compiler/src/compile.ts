import {
  type AirDocument,
  type AuthRequirement,
  type JsonSchema,
  loadAirDocument,
  operationInputSchema,
  snakeCase,
} from "@anvil/air";
import { discoverCapabilities } from "./capabilities.js";
import { type AnvilManifest, buildWorkflows, enrich, parseManifest } from "./manifest.js";
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
 * The single compiler entry point: compile the chosen entrypoint of an
 * immutable source snapshot. Everything the compiler reads — the spec and every
 * local $ref — comes from `source.files`, and the resulting AIR is bound back
 * to the snapshot's identity via `service.source`. This is the real Layer 0 →
 * Layer 1 join.
 */
export async function compileSource(
  source: CompilerSource,
  options: CompileSourceOptions = {},
): Promise<AirDocument> {
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

interface BuildAirOptions extends CompileSourceOptions {
  provenance: CompilerSource;
}

/**
 * The compiler loop (spec §5): parse → normalize → enrich → validate → AIR.
 * This is the single canonical model every artifact is generated from.
 */
async function buildAir(parsed: ParsedSpec, options: BuildAirOptions): Promise<AirDocument> {
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
  operations = enrich(operations, manifest);

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
    diagnostics: [...diagnostics, ...namingDiagnostics, ...workflowDiagnostics],
  };

  return loadAirDocument(air);
}

/** Approve operations by id (spec §17 approval workflow). */
export function approveOperations(air: AirDocument, ids: string[]): AirDocument {
  const set = new Set(ids);
  for (const op of air.operations) {
    if (set.has(op.id) && op.state !== "blocked") op.state = "approved";
  }
  return air;
}
