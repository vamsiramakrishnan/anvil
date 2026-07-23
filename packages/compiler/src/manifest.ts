import {
  type AuthProvider,
  AuthType,
  authCoherenceIssues,
  type Capability,
  type Diagnostic,
  type Operation,
  type RetryCondition,
  snakeCase,
  type Workflow,
} from "@anvil/air";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { classifyAuth, classifyConfirmation, classifyRetry } from "./classify.js";
import { projectRoutingNames, singularize } from "./naming.js";

const ManifestAuthProvider = z.object({
  token_endpoint: z.string().url().optional(),
  grant: z.enum(["token_exchange", "client_credentials", "jwt_bearer"]).optional(),
  client_auth: z.enum(["client_secret_basic", "client_secret_post", "private_key_jwt"]).optional(),
  resource: z.string().optional(),
  subject_token_type: z.enum(["access_token", "jwt", "id_token"]).optional(),
  requested_token_type: z.enum(["access_token", "jwt", "id_token"]).optional(),
  api_key: z.object({ in: z.enum(["header", "query"]), name: z.string() }).optional(),
});
type ManifestAuthProvider = z.infer<typeof ManifestAuthProvider>;

const ManifestOperationAuth = z.object({
  type: AuthType.optional(),
  credential_profile: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z](?:[a-z0-9_]{0,62}[a-z0-9])?$/)
    .optional(),
  principal: z.enum(["anonymous", "service", "end_user", "delegated", "impersonation"]).optional(),
  audience: z.string().optional(),
  secret_source: z.enum(["none", "env", "secret_manager", "workload_identity", "vault"]).optional(),
  tenant: z.string().optional(),
  actor: z.string().optional(),
  subject: z.string().optional(),
  provider: ManifestAuthProvider.optional(),
});

export function manifestAuthProviderToAir(provider: ManifestAuthProvider): AuthProvider {
  return {
    ...(provider.token_endpoint ? { tokenEndpoint: provider.token_endpoint } : {}),
    ...(provider.grant ? { grant: provider.grant } : {}),
    ...(provider.client_auth ? { clientAuth: provider.client_auth } : {}),
    ...(provider.resource ? { resource: provider.resource } : {}),
    ...(provider.subject_token_type ? { subjectTokenType: provider.subject_token_type } : {}),
    ...(provider.requested_token_type ? { requestedTokenType: provider.requested_token_type } : {}),
    ...(provider.api_key ? { apiKey: provider.api_key } : {}),
  };
}

export function airAuthProviderToManifest(provider: AuthProvider): ManifestAuthProvider {
  return {
    ...(provider.tokenEndpoint ? { token_endpoint: provider.tokenEndpoint } : {}),
    ...(provider.grant ? { grant: provider.grant } : {}),
    ...(provider.clientAuth ? { client_auth: provider.clientAuth } : {}),
    ...(provider.resource ? { resource: provider.resource } : {}),
    ...(provider.subjectTokenType ? { subject_token_type: provider.subjectTokenType } : {}),
    ...(provider.requestedTokenType ? { requested_token_type: provider.requestedTokenType } : {}),
    ...(provider.apiKey ? { api_key: provider.apiKey } : {}),
  };
}

/**
 * The supplemental Anvil manifest (spec §4). Specs are incomplete; this is how
 * humans or classifiers enrich the model. Enrichment is explicit, diffable, and
 * overrides inference. Matching is by operationId, canonicalName, or AIR id.
 */
export const OperationManifest = z.object({
  side_effect: z.enum(["read", "mutation"]).optional(),
  risk: z.enum(["none", "low", "medium", "high", "financial", "destructive"]).optional(),
  reversible: z.boolean().optional(),
  display_name: z.string().optional(),
  description: z.string().optional(),
  idempotency: z
    .object({
      strategy: z
        .enum(["natural", "required_request_key", "key_supported", "client_id", "none"])
        .optional(),
      key_location: z.enum(["header", "query", "body", "path"]).optional(),
      /** Exact HTTP header name when key_location is header. */
      header: z.string().optional(),
      /** Exact source parameter name when key_location is query or path. */
      parameter: z.string().optional(),
      /**
       * Exact JSON body field. A leading slash is a JSON Pointer for a nested
       * field (for example /input/idempotencyKey).
       */
      field: z.string().optional(),
    })
    .optional(),
  confirmation: z
    .object({
      required: z.boolean().optional(),
      risk: z.enum(["none", "low", "medium", "high", "financial", "destructive"]).optional(),
      reason: z.string().optional(),
      /**
       * Require explicit HUMAN sign-off, not just a model-supplied `confirm`.
       * Implies `required`. Harness hooks escalate these to the human dialog;
       * the runtime still gates on `confirm`.
       */
      human_approval: z.boolean().optional(),
    })
    .optional(),
  /** Override the descriptive action verb (list/get/create/send/…). */
  action: z
    .enum([
      "list",
      "get",
      "search",
      "export",
      "simulate",
      "validate",
      "poll",
      "create",
      "update",
      "replace",
      "delete",
      "send",
      "execute",
      "approve",
      "cancel",
      "reserve",
      "other",
    ])
    .optional(),
  /**
   * Re-home the AGENT-FACING routing name — canonical name, CLI command, MCP
   * tool. This is the remediation for a name a router cannot follow (the
   * `weak_operation_name` deficiency): `do_transition` → `transition_issue`,
   * `get_object` → `get_customer`. Distinct from `action`, which reclassifies
   * the *effect* and is constrained to the effect-verb enum — `verb` here is a
   * free string, because a real fix ("transition") often is not an effect verb.
   * Every surface re-projects together via one `projectRoutingNames`, so the
   * CLI / MCP / code names cannot drift, and the stable operation `id` is kept
   * as identity. Set either axis; the other is read from the current name.
   */
  name: z
    .object({
      resource: z.string().optional(),
      verb: z.string().optional(),
    })
    .optional(),
  /** Whose authority the call runs under, and how it is credentialed. */
  auth: ManifestOperationAuth.optional(),
  retries: z
    .object({
      enabled: z.boolean().optional(),
      only_on: z.array(z.string()).optional(),
      max_attempts: z.number().int().optional(),
    })
    .optional(),
  state: z.enum(["generated", "review_required", "approved", "deprecated", "blocked"]).optional(),
});
export type OperationManifest = z.infer<typeof OperationManifest>;

/** Project the carrier-specific manifest spelling onto AIR's single key field. */
export function manifestIdempotencyKey(
  idempotency: NonNullable<OperationManifest["idempotency"]>,
): string | undefined {
  switch (idempotency.key_location) {
    case "header":
      return idempotency.header;
    case "query":
    case "path":
      return idempotency.parameter;
    case "body":
      return idempotency.field;
    default:
      return idempotency.header ?? idempotency.parameter ?? idempotency.field;
  }
}

/**
 * A workflow authored in the manifest. Anvil never *guesses* multi-step
 * business logic; this is how a human/harness declares it. Each step names an
 * operation (by operationId / canonicalName / AIR id).
 */
export const WorkflowManifest = z.object({
  display_name: z.string().optional(),
  description: z.string().optional(),
  /** Capability id/name to attach to. Defaults to the first step's capability. */
  capability: z.string().optional(),
  intent_examples: z.array(z.string()).optional(),
  human_approval: z.boolean().optional(),
  rollback: z.string().optional(),
  state: z.enum(["generated", "review_required", "approved", "deprecated", "blocked"]).optional(),
  steps: z
    .array(
      z.object({
        operation: z.string(),
        description: z.string().optional(),
        optional: z.boolean().optional(),
        bindings: z.record(z.string(), z.string()).optional(),
      }),
    )
    .default([]),
});
export type WorkflowManifest = z.infer<typeof WorkflowManifest>;

export const AnvilManifest = z.object({
  service: z
    .object({
      name: z.string().optional(),
      display_name: z.string().optional(),
      owner: z.string().optional(),
      environment: z.string().optional(),
    })
    .optional(),
  auth: ManifestOperationAuth.extend({
    // `oauth2` is retained only as a legacy, scope-only declaration. It is too
    // ambiguous to select client credentials versus end-user/OBO authority.
    type: z.union([AuthType, z.literal("oauth2")]).optional(),
    scopes: z.array(z.string()).optional(),
  }).optional(),
  operations: z.record(z.string(), OperationManifest).default({}),
  workflows: z.record(z.string(), WorkflowManifest).default({}),
});
export type AnvilManifest = z.infer<typeof AnvilManifest>;

export function parseManifest(text: string): AnvilManifest {
  return AnvilManifest.parse(parseYaml(text));
}

const STRATEGY_TO_MODE = {
  natural: "natural",
  required_request_key: "required",
  key_supported: "key_supported",
  client_id: "client_id",
  none: "none",
} as const;

function normalizeCondition(entry: string): RetryCondition | null {
  const map: Record<string, RetryCondition> = {
    timeout: "timeout",
    connection_reset: "connection_reset",
    dns_failure: "dns_failure",
    unavailable: "grpc_unavailable",
    deadline_exceeded: "grpc_deadline_exceeded",
    soap_transport_fault: "soap_transport_fault",
  };
  const lower = entry.toLowerCase();
  if (map[lower]) return map[lower] as RetryCondition;
  if (/^\d{3}$/.test(entry)) return `http_${entry}` as RetryCondition;
  if (lower.startsWith("http_")) return lower as RetryCondition;
  return null;
}

/**
 * Which manifest keys match an operation: its AIR id, canonical name, or the
 * source's own operationId. Exported so the overlay layer resolves an operation
 * target with exactly the same rule the manifest uses (one matcher, no drift).
 */
export function operationMatchesKey(op: Operation, key: string): boolean {
  return op.id === key || op.canonicalName === key || op.sourceRef.operationId === key;
}
const matches = operationMatchesKey;

function providerAfterTypeChange(
  current: AuthProvider | undefined,
  type: Operation["auth"]["type"],
): AuthProvider | undefined {
  switch (type) {
    case "oauth2_client_credentials":
      return {
        ...(current?.tokenEndpoint ? { tokenEndpoint: current.tokenEndpoint } : {}),
        ...(current?.clientAuth ? { clientAuth: current.clientAuth } : {}),
        ...(current?.resource ? { resource: current.resource } : {}),
        grant: "client_credentials",
      };
    case "oauth2_on_behalf_of":
      return {
        ...(current?.tokenEndpoint ? { tokenEndpoint: current.tokenEndpoint } : {}),
        ...(current?.clientAuth ? { clientAuth: current.clientAuth } : {}),
        ...(current?.resource ? { resource: current.resource } : {}),
        ...(current?.subjectTokenType ? { subjectTokenType: current.subjectTokenType } : {}),
        ...(current?.requestedTokenType ? { requestedTokenType: current.requestedTokenType } : {}),
        grant: "token_exchange",
      };
    case "oauth2_authorization_code":
      return current?.tokenEndpoint ? { tokenEndpoint: current.tokenEndpoint } : undefined;
    case "api_key":
      return current?.apiKey ? { apiKey: current.apiKey } : undefined;
    case "jwt_bearer":
      return current?.grant === "jwt_bearer"
        ? {
            ...(current.tokenEndpoint ? { tokenEndpoint: current.tokenEndpoint } : {}),
            ...(current.clientAuth ? { clientAuth: current.clientAuth } : {}),
            ...(current.resource ? { resource: current.resource } : {}),
            grant: "jwt_bearer",
          }
        : undefined;
    default:
      return undefined;
  }
}

/**
 * Apply one operation's manifest entry, returning a new enriched operation.
 * Manifest values win over inference; anything left unset is recomputed so the
 * result stays internally consistent (idempotency/retry/confirmation coherent).
 *
 * This is the single semantic-override *application* path. The overlay layer
 * (`contract/`) resolves any number of policy overlays into one effective
 * `OperationManifest` per operation and applies it through exactly this
 * function, so a manifest override and a gateway/investigation overlay never
 * diverge in how they mutate an operation.
 */
export function applyOperationManifest(original: Operation, m: OperationManifest): Operation {
  const op: Operation = structuredClone(original);

  if (m.side_effect) op.effect.kind = m.side_effect;
  if (m.risk) op.effect.risk = m.risk;
  if (m.reversible !== undefined) op.effect.reversible = m.reversible;
  if (m.action) op.effect.action = m.action;
  if (m.display_name) op.displayName = m.display_name;
  if (m.description) op.description = m.description;

  // Re-home the agent-facing routing names from one (service, resource, verb)
  // triple, so canonicalName / CLI command / MCP tool cannot drift apart. Only
  // these three change — the operation `id` stays as its stable identity (an
  // authored rename is not a new operation), and callers keep matching it. Any
  // re-projection can reintroduce a name collision the pre-overlay resolver
  // already settled, so `compile` re-runs `resolveNameCollisions` afterwards.
  if (m.name?.resource || m.name?.verb) {
    const serviceId = op.id.split(".")[0] ?? "";
    const resource = m.name.resource ?? op.effect.resource ?? serviceId;
    const verb = m.name.verb ?? (op.canonicalName.split("_")[0] as string) ?? "other";
    const projected = projectRoutingNames(serviceId, resource, verb);
    op.canonicalName = projected.canonicalName;
    op.cli.command = projected.cliCommand;
    op.mcp.toolName = projected.toolName;
    if (m.name.resource) op.effect.resource = singularize(resource);
    // The name is now operator-authored — clear the low-confidence naming signal
    // so `critiqueNames` no longer flags an operation the human just fixed.
    const nq = op.evidence.claims.find((c) => c.predicate === "name.quality");
    if (nq) {
      nq.value = op.canonicalName;
      nq.confidence = 0.95;
      nq.note = "name re-homed by manifest";
    }
  }

  if (m.auth) {
    const typeChanged = Boolean(m.auth.type && m.auth.type !== op.auth.type);
    if (m.auth.type) {
      op.auth.type = m.auth.type;
      const defaults = classifyAuth(m.auth.type);
      op.auth.principal = m.auth.principal ?? defaults.principal;
      op.auth.secretSource = m.auth.secret_source ?? defaults.secretSource;
      if (typeChanged) {
        op.auth.provider = providerAfterTypeChange(op.auth.provider, m.auth.type);
        if (m.auth.type === "none") {
          op.auth.audience = undefined;
          op.auth.delegation = undefined;
          op.auth.tenant = undefined;
        } else if (m.auth.type !== "oauth2_on_behalf_of") {
          op.auth.delegation = undefined;
        }
      }
    }
    if (m.auth.credential_profile) op.auth.credentialProfile = m.auth.credential_profile;
    if (m.auth.principal) op.auth.principal = m.auth.principal;
    if (m.auth.audience) op.auth.audience = m.auth.audience;
    if (m.auth.secret_source) op.auth.secretSource = m.auth.secret_source;
    if (m.auth.tenant) op.auth.tenant = m.auth.tenant;
    if (m.auth.actor || m.auth.subject) {
      op.auth.delegation = { actor: m.auth.actor, subject: m.auth.subject };
    }
    if (m.auth.provider) {
      op.auth.provider = {
        ...op.auth.provider,
        ...manifestAuthProviderToAir(m.auth.provider),
      };
    }
  }

  if (m.idempotency?.strategy) {
    op.idempotency.mode = STRATEGY_TO_MODE[m.idempotency.strategy];
    if (m.idempotency.key_location) op.idempotency.mechanism = m.idempotency.key_location;
    const key = manifestIdempotencyKey(m.idempotency);
    if (key) op.idempotency.key = key;
    if (op.idempotency.mode === "required" || op.idempotency.mode === "key_supported") {
      op.idempotency.keyDerivation = "request_fingerprint";
    }
  }

  // Recompute derived policy so idempotency/retry/confirmation stay coherent,
  // then let explicit manifest values override.
  op.retries = classifyRetry(op.effect, op.idempotency);
  op.confirmation = classifyConfirmation(op.effect, op.idempotency);

  if (m.retries) {
    if (m.retries.enabled === false) {
      op.retries = { ...op.retries, mode: "none", maxAttempts: 1, backoff: "none", retryOn: [] };
    } else if (m.retries.enabled === true) {
      op.retries.mode = "safe";
      if (op.retries.backoff === "none") op.retries.backoff = "exponential_jitter";
    }
    if (m.retries.only_on) {
      const conds = m.retries.only_on
        .map(normalizeCondition)
        .filter((c): c is RetryCondition => c !== null);
      if (conds.length) op.retries.retryOn = conds;
    }
    if (m.retries.max_attempts) op.retries.maxAttempts = m.retries.max_attempts;
  }

  if (m.confirmation) {
    if (m.confirmation.required !== undefined) op.confirmation.required = m.confirmation.required;
    if (m.confirmation.risk) op.confirmation.risk = m.confirmation.risk;
    if (m.confirmation.reason) op.confirmation.reason = m.confirmation.reason;
    if (m.confirmation.human_approval !== undefined) {
      op.confirmation.humanApproval = m.confirmation.human_approval;
      // A human-approval gate is meaningless without a gate: escalating implies
      // the operation confirms. Tightening only, so this is always safe.
      if (m.confirmation.human_approval) {
        op.confirmation.required = true;
        if (!op.confirmation.reason) {
          op.confirmation.reason = "This operation requires explicit human approval.";
        }
      }
    }
  }

  if (m.state) op.state = m.state;

  const authIssues = authCoherenceIssues(op.auth);
  if (
    op.auth.type === "oauth2_authorization_code" ||
    op.auth.type === "mtls" ||
    op.auth.type === "custom_header"
  ) {
    authIssues.push(`${op.auth.type} is not executable by the current runtime`);
  }
  if (authIssues.length > 0) {
    op.state = "blocked";
    for (const issue of authIssues) {
      const note = `Auth contract blocked: ${issue}.`;
      if (!op.reviewNotes.includes(note)) op.reviewNotes.push(note);
    }
  }

  op.evidence.claims.push({
    subject: op.id,
    predicate: "enriched",
    value: true,
    source: "spec",
    sourceRef: "anvil-manifest",
    method: "manifest",
    note: "enriched by supplemental Anvil manifest",
    confidence: 0.95,
    review: "accepted",
  });

  return op;
}

/**
 * Apply a manifest to a set of operations, returning the enriched operations.
 * Thin wrapper over {@link applyOperationManifest}: the first manifest entry that
 * matches an operation wins, and non-matching operations pass through untouched.
 */
export function enrich(operations: Operation[], manifest: AnvilManifest): Operation[] {
  return operations.map((original) => {
    const entry = Object.entries(manifest.operations).find(([key]) => matches(original, key));
    if (!entry) return original;
    return applyOperationManifest(original, entry[1]);
  });
}

/**
 * Build first-class workflows from the manifest, resolving each step's operation
 * reference to an AIR operation id and attaching the workflow to a capability.
 * Steps that reference an unknown operation are dropped with a diagnostic — a
 * workflow is only as trustworthy as the operations it names. Returns the
 * workflows plus any diagnostics, and mutates capabilities to record ownership.
 */
export function buildWorkflows(
  manifest: AnvilManifest,
  operations: Operation[],
  capabilities: Capability[],
): { workflows: Workflow[]; diagnostics: Diagnostic[] } {
  const workflows: Workflow[] = [];
  const diagnostics: Diagnostic[] = [];
  const capById = new Map(capabilities.map((c) => [c.id, c]));

  for (const [name, wf] of Object.entries(manifest.workflows)) {
    const steps: Workflow["steps"] = [];
    for (const step of wf.steps) {
      const op = operations.find((o) => matches(o, step.operation));
      if (!op) {
        diagnostics.push({
          level: "warning",
          code: "workflow_step_unresolved",
          message: `Workflow "${name}" references unknown operation "${step.operation}"; step dropped.`,
        });
        continue;
      }
      steps.push({
        operationId: op.id,
        description: step.description ?? op.displayName,
        optional: step.optional ?? false,
        bindings: step.bindings ?? {},
      });
    }

    // Resolve the owning capability: explicit, else the first step's capability.
    const firstOpCap = steps.length
      ? operations.find((o) => o.id === steps[0]?.operationId)?.capabilityId
      : undefined;
    const capabilityId = resolveCapabilityId(wf.capability, firstOpCap, capabilities);
    if (!capabilityId) {
      diagnostics.push({
        level: "warning",
        code: "workflow_capability_unresolved",
        message: `Workflow "${name}" could not be attached to a capability; skipped.`,
      });
      continue;
    }

    const id = `${capabilityId}.${snakeCase(name)}`;
    workflows.push({
      id,
      capabilityId,
      displayName: wf.display_name ?? titleCase(name),
      description: wf.description ?? "",
      intentExamples: wf.intent_examples ?? [],
      steps,
      humanApproval: wf.human_approval ?? false,
      rollbackStrategy: wf.rollback,
      state: wf.state ?? "generated",
      evidence: {
        claims: [
          {
            subject: id,
            predicate: "authored",
            value: true,
            source: "spec",
            sourceRef: "anvil-manifest",
            method: "manifest",
            note: "authored workflow",
            confidence: 0.95,
            review: "accepted",
          },
        ],
      },
    });
    capById.get(capabilityId)?.workflowIds.push(id);
  }

  return { workflows, diagnostics };
}

function resolveCapabilityId(
  explicit: string | undefined,
  fallback: string | undefined,
  capabilities: Capability[],
): string | undefined {
  if (explicit) {
    const hit = capabilities.find(
      (c) => c.id === explicit || c.id.endsWith(`.${explicit}`) || c.displayName === explicit,
    );
    if (hit) return hit.id;
  }
  return fallback;
}

const titleCase = (s: string): string =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
