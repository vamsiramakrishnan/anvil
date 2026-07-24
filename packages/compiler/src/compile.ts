import {
  type AirDocument,
  type AuthRequirement,
  type Diagnostic,
  type JsonSchema,
  loadAirDocument,
  type Operation,
  operationIdempotencyKeySchemaIssue,
  operationInputSchema,
  resolveIdempotencyCarrier,
  snakeCase,
} from "@anvil/air";
import { discoverCapabilities } from "./capabilities.js";
import { approveCapability, rejectCapability } from "./capability-review.js";
import { overlayDigest } from "./contract/digest.js";
import type { AppliedOverlay, PolicyOverlay, SemanticConflict } from "./contract/model.js";
import { manifestToOverlay } from "./contract/overlay.js";
import { applyResolved, resolveOverlays } from "./contract/resolution.js";
import { applyDialectAdjustment, detectNamingDialect } from "./dialect.js";
import {
  type AnvilManifest,
  airAuthProviderToManifest,
  applyOperationManifest,
  buildWorkflows,
  manifestAuthProviderToAir,
  parseManifest,
} from "./manifest.js";
import { critiqueNames, resolveNameCollisions } from "./naming.js";
import { normalize } from "./normalize.js";
import { type ParsedSpec, parseSource } from "./parse.js";
import { type CompilerSource, ephemeralCompilerSource } from "./source/compiler-source.js";
import { validate } from "./validate.js";

/**
 * How aggressively to require explicit HUMAN approval (not just a model-supplied
 * `confirm`) on gated operations. A coarse default that fills in where the
 * manifest didn't decide per-operation; tightening only:
 *   none   — no default (per-op manifest still applies). The default.
 *   unsafe — escalate irreversible / high / financial / destructive mutations.
 *   all    — escalate every confirmation-required operation.
 */
export type HumanApprovalPolicy = "none" | "unsafe" | "all";

export interface CompileInput {
  /** OpenAPI 3.x / Swagger 2.0 document text. */
  spec: string;
  /** Optional supplemental Anvil manifest text. */
  manifest?: string;
  /** Override the derived service id. */
  serviceId?: string;
  /** Provenance URI recorded in AIR. */
  sourceUri?: string;
  /** Coarse human-approval default; per-op manifest `human_approval` overrides. */
  humanApproval?: HumanApprovalPolicy;
}

export interface CompileSourceOptions {
  /** Optional supplemental Anvil manifest text. */
  manifest?: string;
  /** Override the derived service id. */
  serviceId?: string;
  /** Coarse human-approval default; per-op manifest `human_approval` overrides. */
  humanApproval?: HumanApprovalPolicy;
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
  return compileSource(source, {
    manifest: input.manifest,
    serviceId: input.serviceId,
    humanApproval: input.humanApproval,
  });
}

interface BuildAirOptions extends EffectiveCompileOptions {
  provenance: CompilerSource;
}

function applyServiceAuthDefaults(
  operations: Operation[],
  config: NonNullable<AnvilManifest["auth"]> | undefined,
): { operations: Operation[]; diagnostics: Diagnostic[] } {
  if (!config) return { operations, diagnostics: [] };
  const diagnostics: Diagnostic[] = [];
  const scopes = config.scopes ?? [];

  return {
    operations: operations.map((operation) => {
      let next = operation;
      if (config.type === "oauth2") {
        if (operation.auth.type === "none") {
          next = applyOperationManifest(operation, {
            auth: { type: "custom_header" },
          });
          const note =
            "Legacy service auth type oauth2 is ambiguous; select jwt_bearer, " +
            "oauth2_client_credentials, oauth2_on_behalf_of, or authorization-code explicitly.";
          if (!next.reviewNotes.includes(note)) next.reviewNotes.push(note);
          diagnostics.push({
            level: "error",
            code: "auth/service_oauth2_ambiguous",
            message: note,
            operationId: operation.id,
          });
        }
      } else if (config.type && operation.auth.type === "none") {
        const { scopes: _scopes, type: _type, ...auth } = config;
        next = applyOperationManifest(operation, {
          auth: { ...auth, type: config.type },
        });
      } else if (config.type && operation.auth.type !== config.type) {
        diagnostics.push({
          level: "info",
          code: "auth/service_default_not_applied",
          message:
            `Service auth default ${config.type} did not override the source-declared ` +
            `${operation.auth.type} contract.`,
          operationId: operation.id,
        });
      } else {
        // Explicit principal/storage fields are service policy and therefore
        // apply when the declared type is compatible (or omitted). Provider
        // mechanics remain defaults: preserve source token endpoints/carriers
        // and fill only fields the source did not supply.
        const provider = config.provider
          ? Object.fromEntries(
              Object.entries(manifestAuthProviderToAir(config.provider)).filter(
                ([key]) =>
                  operation.auth.provider?.[
                    key as keyof NonNullable<Operation["auth"]["provider"]>
                  ] === undefined,
              ),
            )
          : undefined;
        const auth = {
          ...(!operation.auth.credentialProfile && config.credential_profile
            ? { credential_profile: config.credential_profile }
            : {}),
          ...(config.principal ? { principal: config.principal } : {}),
          ...(config.secret_source ? { secret_source: config.secret_source } : {}),
          ...(!operation.auth.issuer && config.issuer ? { issuer: config.issuer } : {}),
          ...(config.audience ? { audience: config.audience } : {}),
          ...(!operation.auth.carrier && config.carrier ? { carrier: config.carrier } : {}),
          ...(config.tenant ? { tenant: config.tenant } : {}),
          ...(config.actor ? { actor: config.actor } : {}),
          ...(config.subject ? { subject: config.subject } : {}),
          ...(provider && Object.keys(provider).length > 0
            ? { provider: airAuthProviderToManifest(provider) }
            : {}),
        };
        if (Object.keys(auth).length > 0) next = applyOperationManifest(operation, { auth });
      }

      if (next.auth.type !== "none" && next.auth.scopes.length === 0 && scopes.length > 0) {
        next = { ...next, auth: { ...next.auth, scopes: [...scopes] } };
      }
      return next;
    }),
    diagnostics,
  };
}

/**
 * Apply the coarse human-approval default in place. Only touches confirmation-
 * required operations whose `humanApproval` is still undefined — an explicit
 * per-op manifest value (true OR false) always wins. Escalating is a tightening,
 * so no conflict machinery is involved.
 */
function applyHumanApprovalPolicy(ops: Operation[], policy: HumanApprovalPolicy | undefined): void {
  if (!policy || policy === "none") return;
  for (const op of ops) {
    if (!op.confirmation.required) continue;
    if (op.confirmation.humanApproval !== undefined) continue;
    const unsafe =
      op.effect.reversible === false ||
      op.effect.risk === "high" ||
      op.effect.risk === "financial" ||
      op.effect.risk === "destructive";
    if (policy === "all" || (policy === "unsafe" && unsafe)) {
      op.confirmation.humanApproval = true;
      if (!op.confirmation.reason) {
        op.confirmation.reason = "This operation requires explicit human approval.";
      }
    }
  }
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
    : { operations: {}, workflows: {}, capabilities: {} };

  const title = (doc.info?.title as string | undefined) ?? "service";
  const serviceId = options.serviceId ?? manifest.service?.name ?? snakeCase(title) ?? "service";

  const normalized = normalize(serviceId, parsed);
  const serviceAuthDefaults = applyServiceAuthDefaults(normalized.operations, manifest.auth);
  let operations = serviceAuthDefaults.operations;
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
    // A `name.resource`/`name.verb` override re-projects an operation's routing
    // names DURING application — after the pre-overlay collision pass already ran.
    // A re-homed name can land on another operation's, so remember the surfaces
    // and re-resolve collisions if any changed. The resolver is a no-op when
    // nothing moved, so overlays that touch no name stay byte-identical.
    const nameSurface = (op: (typeof operations)[number]) =>
      `${op.canonicalName}\0${op.cli.command}\0${op.mcp.toolName}`;
    const before = new Map(operations.map((op) => [op.id, nameSurface(op)]));
    const outcome = resolveOverlays(operations, overlays);
    operations = applyResolved(operations, outcome);
    conflicts = outcome.conflicts;
    blockedOperationIds = outcome.blockedOperationIds;
    overlayDiagnostics.push(...outcome.diagnostics);
    const namesChanged = operations.some((op) => before.get(op.id) !== nameSurface(op));
    if (namesChanged) overlayDiagnostics.push(...resolveNameCollisions(operations));
    appliedOverlays = overlays.map((o) => ({
      id: o.id,
      digest: o.digest || overlayDigest(o),
      origin: o.origin,
    }));
  }

  // A source-level AND requirement cannot be reduced to one credential by an
  // operation override: that would silently remove a required factor. Keep it
  // blocked until AIR grows an explicit composite-auth model.
  const compositeAuthOperations = new Set(
    normalized.diagnostics
      .filter((diagnostic) => diagnostic.code === "auth/composite_unmodeled")
      .map((diagnostic) => diagnostic.operationId)
      .filter((id): id is string => Boolean(id)),
  );
  for (const operation of operations) {
    if (!compositeAuthOperations.has(operation.id)) continue;
    operation.state = "blocked";
    const note =
      "Source requires multiple security schemes together; a single-credential manifest override cannot remove a required factor.";
    if (!operation.reviewNotes.includes(note)) operation.reviewNotes.push(note);
  }
  blockedOperationIds = [
    ...new Set([
      ...blockedOperationIds,
      ...operations.filter((op) => compositeAuthOperations.has(op.id)).map((op) => op.id),
    ]),
  ].sort();

  // Attach the assembled input JSON Schema to each operation.
  for (const op of operations) {
    op.input.schema = operationInputSchema(op);
  }

  const { operations: validated, diagnostics } = validate(operations);

  // Human-approval policy: a coarse default that escalates already-gated ops to
  // explicit human sign-off. Tightening only (it never removes a gate), so it
  // needs no conflict resolution and respects any explicit per-op manifest value.
  applyHumanApprovalPolicy(validated, options.humanApproval);

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

  const air = loadAirDocument({
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
      ...normalized.diagnostics,
      ...serviceAuthDefaults.diagnostics,
      ...diagnostics,
      ...namingDiagnostics,
      ...workflowDiagnostics,
      ...overlayDiagnostics,
    ],
  });

  // Capability review is declarative compiler input when it appears in the
  // supplemental manifest. Apply it only after deterministic discovery and
  // authored workflow attachment, using exact capability ids and the same
  // typed tool-budget gate as the interactive review command. This lets a
  // gateway import mint an immutable receipt whose initial output is already
  // both reviewed and bound, rather than approving after import and necessarily
  // making that receipt stale.
  const reviewedAir = loadAirDocument(structuredClone(air));
  const capabilityReviews = Object.entries(manifest.capabilities).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  for (const [capabilityId, review] of capabilityReviews) {
    if (review.state === "approved") {
      approveCapability(reviewedAir, capabilityId, {
        allowLarge: review.allow_large === true,
        note: review.note,
      });
    } else {
      rejectCapability(reviewedAir, capabilityId, review.note);
    }
  }

  return { air: loadAirDocument(reviewedAir), conflicts, blockedOperationIds, appliedOverlays };
}

/** Approve operations by id (spec §17 approval workflow). */
export function approveOperations(air: AirDocument, ids: string[]): AirDocument {
  const set = new Set(ids);
  for (const op of air.operations) {
    if (!set.has(op.id) || op.state === "blocked") continue;
    const carrier = resolveIdempotencyCarrier(op);
    const schemaIssue = carrier.ok ? operationIdempotencyKeySchemaIssue(op) : undefined;
    if (!carrier.ok || schemaIssue) {
      op.state = "blocked";
      const note = `Approval refused: ${carrier.ok ? schemaIssue : carrier.issue}.`;
      if (!op.reviewNotes.includes(note)) op.reviewNotes.push(note);
      continue;
    }
    op.state = "approved";
  }
  return air;
}
