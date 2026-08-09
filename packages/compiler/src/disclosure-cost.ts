import type { AirDocument, AsyncContract, DisclosureCost, JsonSchema, Operation } from "@anvil/air";
import {
  asyncContractSentence,
  mcpToolAnnotations,
  mcpToolDescription,
  operationInputSchema,
  resolveAsyncContract,
} from "@anvil/air";
import { countTokens as encodeAndCount } from "gpt-tokenizer/encoding/o200k_base";

/**
 * Measuring what an operation costs an agent *before it is useful*.
 *
 * Every tool an agent can call is paid for twice: once in the listing it must
 * read to route at all, and again in the payload it gets back. Anvil already
 * certifies what an operation is allowed to *do*; this module makes the first
 * of those two costs a measured fact of the same kind — exact, deterministic,
 * and derived from the very bytes the serving surface publishes rather than
 * from a rule of thumb about "roughly how big a tool is".
 *
 * The discipline that makes the figure worth certifying is that we tokenize the
 * *wire form*, not a summary of it. A description is not measured on its own; it
 * is measured inside the JSON envelope that carries it, with its escaping, its
 * key, and the schema it travels with — because that is what actually lands in
 * the agent's context window. Approximating here would produce a number that is
 * cheap to compute, plausible-looking, and wrong in exactly the direction that
 * matters (JSON structure is a large fraction of a small tool's cost).
 *
 * Only the tool surface is measured here; see `withResponseMeasurement` for why
 * the response half of `DisclosureCost` cannot be — and must not be faked.
 */

/**
 * The tokenizer identity stamped into every figure this module produces.
 *
 * Token counts are model-specific. A disclosure figure with no recorded
 * estimator is a number without a unit: it would keep looking authoritative
 * while silently describing a different tokenizer than the one that produced
 * it, and a certified budget would drift with an unrelated model release. Every
 * surface that tokenizes anything comparable to these figures — notably
 * `@anvil/certification` measuring simulator responses — must count with this
 * same encoding, which is why `countTokens` is exported rather than kept private.
 */
export const TOKEN_ESTIMATOR_ID = "o200k_base";

/**
 * Never let a hostile or merely unlucky spec break a build. `gpt-tokenizer`
 * refuses by default to encode text containing control tokens (`<|endoftext|>`
 * and friends), which is the right posture when you are assembling a prompt —
 * and the wrong one here. We are measuring a *payload*, where such a sequence is
 * inert data that some upstream happened to put in a description; treating it as
 * ordinary text is both safe and what a real client would do with it.
 */
const ENCODE_OPTIONS = { disallowedSpecial: new Set<string>() } as const;

/** Exact token count under {@link TOKEN_ESTIMATOR_ID}. Pure; no I/O, no state. */
export function countTokens(text: string): number {
  return encodeAndCount(text, ENCODE_OPTIONS);
}

/**
 * The reserved dry-run control, duplicated from `@anvil/mcp-runtime`'s
 * `MCP_RESERVED`/`reservedSafetyShape` rather than imported.
 *
 * The dependency direction forbids the import: mcp-runtime is the deployed
 * serving unit and depends on the model, not on the compiler that built it. A
 * two-line duplication is the cheaper of two bad options, so the drift risk is
 * paid down where it can be: this is a *measurement* input, so if the runtime
 * ever renames the control the only consequence is a disclosure figure off by
 * ~20 tokens — never a wrong safety decision.
 */
const RESERVED_DRY_RUN_KEY = "anvil_dry_run";
const RESERVED_DRY_RUN_SCHEMA: JsonSchema = {
  description: "Preview the wire request without executing it (no upstream call).",
  type: "boolean",
};

/**
 * The projection control, mirrored from `@anvil/mcp-runtime`'s `projectionShape`
 * for the same reason as the dry-run key: the compiler must not depend on the
 * serving unit, so the bytes it measures are reconstructed rather than imported.
 *
 * This one is worth its own note because it is by far the largest reserved
 * control — its description is ~70 tokens of prose published on *every* tool.
 * Omitting it, as this reconstruction previously did, made the certified
 * per-tool figure understate every operation on the surface by that much, which
 * is precisely the "certifying a surface nobody serves" failure the measurement
 * exists to rule out.
 */
const RESERVED_PROJECTION_KEY = "anvil_projection";
const RESERVED_PROJECTION_SCHEMA: JsonSchema = {
  description:
    "JMESPath expression (as in `aws --query`) applied to a successful response " +
    "before it is measured against the context budget, e.g. " +
    "`items[].{id: id, name: name}`. Selecting fewer fields lowers the cost per " +
    "item, which raises the number of items that fit in one page. It may only " +
    "narrow the response, never expand it; an invalid expression fails the call " +
    "rather than returning the unprojected payload.",
  type: "string",
};

/** The MCP tool descriptor as it appears in a `tools/list` result. */
interface ToolSurface {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: ReturnType<typeof mcpToolAnnotations>;
  _meta: Record<string, unknown>;
}

/**
 * Rebuild the published input schema for an operation.
 *
 * `@anvil/mcp-runtime` hands the SDK a Zod shape built from this same AIR
 * schema (`operationZodShape`), and the SDK re-emits it as JSON Schema. That
 * round-trip is shape-preserving for the constructs AIR emits — every property
 * and every description survives verbatim, which is where essentially all of the
 * tokens live — but it rewrites the *envelope*: the AIR-level `title` and root
 * `description` do not survive the shape conversion, while `$schema` and
 * `additionalProperties: false` are re-added by Zod. So we reconstruct the
 * envelope the runtime actually publishes instead of measuring AIR's own,
 * which would count a title and a description the agent never receives.
 *
 * We reconstruct rather than call the runtime because the compiler must not
 * depend on the serving unit (see `RESERVED_DRY_RUN_KEY`).
 */
function publishedInputSchema(operation: Operation): JsonSchema {
  const source = operation.input.schema ?? operationInputSchema(operation);
  const properties = (source.properties as Record<string, JsonSchema> | undefined) ?? {};
  const required = (source.required as string[] | undefined) ?? [];
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    // Insertion order is the AIR order (params, body, safety keys) with the
    // reserved control appended last — exactly the order the runtime builds its
    // shape in, so the serialization matches key for key.
    properties: {
      ...properties,
      [RESERVED_DRY_RUN_KEY]: RESERVED_DRY_RUN_SCHEMA,
      [RESERVED_PROJECTION_KEY]: RESERVED_PROJECTION_SCHEMA,
    },
    required: [...required],
    additionalProperties: false,
  };
}

/**
 * Everything an agent reads about one operation before it can decide to call it.
 * Field for field what `@anvil/mcp-runtime`'s `registerTool` publishes: the
 * routing name, the human title, the compiled safety prose, the input schema,
 * the standard annotation hints, and Anvil's `_meta` posture block. Nothing here
 * is optional from the agent's point of view — it is all context it must hold.
 */
function toolSurface(
  operation: Operation,
  operationsById?: ReadonlyMap<string, Operation>,
): ToolSurface {
  // The serving path appends the polling instructions and a block of
  // `anvil/async_*` coordinates, but only for a contract that RESOLVES — which
  // needs the whole document, not one operation. Without an index we cannot
  // resolve, so we measure the operation alone and accept an understated figure
  // for that case rather than guessing at bytes.
  const asyncResolution = operationsById
    ? resolveAsyncContract(operation, operationsById)
    : undefined;
  // Webhook-only contracts resolve with no `statusOperation` to describe here;
  // their own `_meta` shape lands with the rest of the webhook wiring rather
  // than half-populating the poll-shaped keys below.
  const asyncMeta =
    asyncResolution?.ok === true && asyncResolution.statusOperation
      ? asyncMetaFor(asyncResolution.contract, asyncResolution.statusOperation)
      : {};
  const asyncSentence =
    asyncResolution?.ok === true ? asyncContractSentence(asyncResolution) : undefined;
  const description = asyncSentence
    ? `${mcpToolDescription(operation)} ${asyncSentence}`
    : mcpToolDescription(operation);
  return {
    name: operation.mcp.toolName,
    title: operation.displayName,
    description,
    inputSchema: publishedInputSchema(operation),
    annotations: mcpToolAnnotations(operation),
    _meta: {
      "anvil/effect": operation.effect.kind,
      "anvil/action": operation.effect.action,
      "anvil/risk": operation.effect.risk,
      "anvil/retry_safe": operation.retries.mode === "safe",
      "anvil/retry_basis": operation.retries.basis,
      "anvil/idempotency": operation.idempotency.mode,
      "anvil/principal": operation.auth.principal,
      "anvil/operation_id": operation.id,
      ...asyncMeta,
    },
  };
}

/**
 * The `anvil/async_*` block, mirrored key-for-key from what `@anvil/mcp-runtime`
 * publishes for a resolved contract. Same mirroring rationale as the reserved
 * controls above: the compiler cannot import the serving unit, so it reconstructs
 * the bytes. Drift here costs an under- or over-stated figure, never a wrong
 * safety decision.
 */
function asyncMetaFor(
  contract: AsyncContract,
  statusOperation: Operation,
): Record<string, unknown> {
  return {
    "anvil/async_status_tool": statusOperation.mcp.toolName,
    "anvil/async_job_id_field": contract.jobIdField,
    "anvil/async_status_job_id_param": contract.statusJobIdParam,
    "anvil/async_terminal_states": contract.terminalStates,
    ...(contract.stateField ? { "anvil/async_state_field": contract.stateField } : {}),
    ...(contract.pendingStates.length > 0
      ? { "anvil/async_pending_states": contract.pendingStates }
      : {}),
    ...(contract.pollIntervalSeconds !== undefined
      ? { "anvil/async_poll_interval_seconds": contract.pollIntervalSeconds }
      : {}),
  };
}

/**
 * The exact string the token count is taken over — compact JSON, as it travels
 * on the JSON-RPC wire. Exported so a report, a test, or a reviewer arguing with
 * a number can see the measured bytes rather than trusting the total.
 */
export function toolSurfaceJson(
  operation: Operation,
  operationsById?: ReadonlyMap<string, Operation>,
): string {
  return JSON.stringify(toolSurface(operation, operationsById));
}

/**
 * Characters per token observed during a measurement, rounded to three places.
 *
 * This is the calibration the deployed serving unit uses in place of a BPE
 * table (see `DisclosureCost` in `@anvil/air`): it estimates from string length
 * because shipping a multi-megabyte vocabulary into the hot path to decide when
 * to truncate a payload would be absurd. Rounding keeps a serialized AIR free of
 * float noise that would otherwise churn a content hash for no semantic reason.
 */
function charsPerToken(chars: number, tokens: number): number {
  if (tokens <= 0 || chars <= 0) return 4;
  return Math.round((chars / tokens) * 1000) / 1000;
}

/**
 * Measure one operation's tool surface exactly.
 *
 * Pure and total: same operation in, same figure out, forever — which is the
 * property that lets the result be certified and diffed across builds at all.
 * Response figures are left at zero because this layer genuinely cannot know
 * them; see {@link withResponseMeasurement}.
 */
export function measureToolSurface(
  operation: Operation,
  operationsById?: ReadonlyMap<string, Operation>,
): DisclosureCost {
  const payload = toolSurfaceJson(operation, operationsById);
  const toolTokens = countTokens(payload);
  return {
    toolTokens,
    responseItemTokens: 0,
    responseTokens: 0,
    charsPerToken: charsPerToken(payload.length, toolTokens),
    estimator: TOKEN_ESTIMATOR_ID,
  };
}

/**
 * Fold a response measurement into a tool-surface measurement.
 *
 * The seam exists because the two halves of `DisclosureCost` are different
 * kinds of claim. `toolTokens` is a fact about the contract, knowable here.
 * `responseTokens` / `responseItemTokens` are a prediction about *data*: what a
 * page actually costs depends on a tenant's records, so the only honest way to
 * obtain them is to drive the contract-faithful simulator under a recorded seed
 * and tokenize what comes back. `@anvil/simulator` already depends on this
 * package, so measuring responses here would close a dependency cycle — hence
 * `@anvil/certification` performs that measurement and merges it back through
 * this function, using {@link countTokens} so both halves share one estimator.
 *
 * The recorded `seed` is what keeps a prediction reproducible instead of merely
 * plausible: a response figure with no seed cannot be re-derived, and a figure
 * that cannot be re-derived cannot be certified.
 *
 * `charsPerToken` is deliberately *not* recomputed — the caller supplies token
 * counts but no character count, and inventing a calibration from figures we did
 * not measure characters for is precisely the guessing this module exists to
 * remove. The tool-surface calibration stands; both are JSON from the same API.
 */
export function withResponseMeasurement(
  cost: DisclosureCost,
  m: { responseTokens: number; responseItemTokens: number; seed: number },
): DisclosureCost {
  return {
    ...cost,
    responseTokens: m.responseTokens,
    responseItemTokens: m.responseItemTokens,
    seed: m.seed,
  };
}

/**
 * Attach a tool-surface measurement to every operation in a document.
 *
 * Returns a new document; the input is never mutated, so a caller can measure a
 * loaded model without disturbing it. Any response figures a previous run left
 * behind are dropped rather than carried forward: they were measured against a
 * contract that may no longer be this one, and a stale prediction wearing a
 * fresh measurement's clothes is worse than no prediction at all. Certification
 * re-drives the simulator and merges through {@link withResponseMeasurement} —
 * measurement is cheap; a silently stale certified number is not.
 */
export function measureAirDisclosure(air: AirDocument): AirDocument {
  // Built once and shared: a resolved async contract adds a sentence and a
  // coordinate block to the published surface, and resolving needs to see every
  // operation. Measuring each in isolation would understate exactly the
  // operations carrying the most extra prose.
  const operationsById = new Map(air.operations.map((operation) => [operation.id, operation]));
  return {
    ...air,
    operations: air.operations.map((operation) => ({
      ...operation,
      disclosureCost: measureToolSurface(operation, operationsById),
    })),
  };
}
