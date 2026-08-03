/**
 * The deterministic simulator runtime. It serves a capability's approved
 * operations with contract-faithful behaviour: auth-scope gating, confirmation
 * refusal, required-idempotency enforcement and idempotent replay, stateful
 * mutations with a domain state machine, pagination, seeded fault injection —
 * and response bodies shaped by what the operation's contract declares.
 *
 * Everything is a pure function of (seed, call sequence): no clock, no
 * randomness beyond the seeded `Rng`, so a run reproduces exactly.
 */
import {
  type AirDocument,
  DEFAULT_RESPONSE_BUDGET_TOKENS,
  type ErrorCode,
  hashCanonical,
  type JsonSchema,
  type Operation,
  type PageSizeBasis,
  safePageSize,
} from "@anvil/air";
import { materializeSchema, type SurfaceSignature, surfaceSignatureFor } from "@anvil/compiler";
import type { SimulatorDefinition } from "./model.js";
import { Rng } from "./rng.js";

export interface InvokeContext {
  principalId?: string;
  /**
   * The tenant this call belongs to. Idempotent replay is scoped to
   * (principal, tenant) so one caller's key can never replay another's result.
   */
  tenantId?: string;
  confirm?: boolean;
  idempotencyKey?: string;
  /** Activate a named fault scenario for this call. */
  faultScenario?: string;
  /** Opaque pagination cursor from a prior page. */
  cursor?: string;
}

export type SimError = { code: ErrorCode; message: string };

export type SimResult =
  | { ok: true; output: unknown; replayed?: boolean; nextCursor?: string }
  | { ok: false; error: SimError };

interface Entity {
  [k: string]: unknown;
}

/**
 * The page size used when AIR declines to derive one — an operation whose
 * per-item cost was never measured, or one the contract never described as
 * paginated but whose action is `list`. Deliberately tiny: with the default
 * three fixtures it guarantees a second page, so cursor behaviour is actually
 * exercised rather than accidentally fitting in one page. It is a *fixture*
 * number, not a disclosure claim, which is why nothing may certify against it.
 */
const FALLBACK_PAGE_SIZE = 2;

/* -------------------------------------------------------------------------- */
/* Declared-shape response bodies                                              */
/* -------------------------------------------------------------------------- */

/**
 * WHY the store and the response are not the same object.
 *
 * The store holds *state*: an id and whatever the domain state machine and a
 * caller's mutations have written. That is the part of a response the simulator
 * is authoritative about, and the part its behavioural guarantees (transitions,
 * replay, pagination) rest on. It is deliberately tiny.
 *
 * The response an agent receives is a *representation* of that state, and the
 * only authority on its shape is the operation's own declared response schema.
 * Two operations on one resource routinely declare different representations of
 * it — a list that returns summaries and a get that returns the full record —
 * so a single stored body could not be faithful to both, and merging their
 * fields would invent a payload neither one serves. Each operation therefore
 * projects its own declared shape over the shared state at response time, with
 * stored fields winning so the state machine, the ids and a mutation's echo
 * remain authoritative over anything synthesis produced.
 *
 * This is not cosmetic. Response cost is a certified property, and it is
 * measured by driving this simulator (see `disclosureSample`). While every body
 * was `{id, status}` a page could not exceed any plausible context budget, so
 * the over-budget verdict was unreachable and a green row certified nothing.
 * The rule that keeps the fix honest: a payload's simulated size must track its
 * *declared* size. A thin contract stays cheap, a 400-field contract simulates
 * as expensive, and nothing is padded to make a budget fail — that would be the
 * same lie pointed the other way.
 *
 * When the contract declares nothing usable, projection is skipped entirely and
 * the response is byte-identical to what the simulator served before. Most
 * contracts are in exactly that state, and their numbers must not move.
 */

/** Whether `read` serves this operation as a page of items. */
function servesItems(op: Operation): boolean {
  return op.effect.action === "list" || op.pagination !== undefined;
}

/**
 * The declared shape of ONE item in an operation's response, `$ref`-free and
 * bounded, or `undefined` when the contract says nothing usable.
 *
 * `materializeSchema` (the compiler's, not a local copy) does the resolution:
 * it is already the function that turns a possibly-`$ref`-bearing schema into a
 * self-contained one, and it carries the two bounds a synthesizer needs anyway
 * — a ref-depth cap for deep chains and a node cap for broad ones. Reusing it
 * also means the simulator sees the *same* bounded schema the compiler recorded
 * on the operation, so a payload cannot be faithful to a schema no other part
 * of Anvil agrees exists.
 */
function declaredItemSchema(air: AirDocument, op: Operation): JsonSchema | undefined {
  const declared = declaredResponseSchema(air, op);
  if (!declared) return undefined;
  const { schema } = materializeSchema(declared, air.schemas);
  if (!isRecord(schema)) return undefined;
  // A paginated read's declared schema describes the *envelope*; `read` builds
  // the envelope itself, so what it needs is the element type inside it. A
  // single-entity read or a mutation declares the item directly.
  return nonEmpty(servesItems(op) ? unwrapItems(schema, op) : schema);
}

/** An operation's declared response schema: inline if present, else by named ref. */
function declaredResponseSchema(air: AirDocument, op: Operation): JsonSchema | undefined {
  const inline = nonEmpty(op.output.schema);
  if (inline) return inline;
  const ref = op.output.schemaRef;
  if (!ref) return undefined;
  // A ref is stored either as the bare component name or as a JSON pointer into
  // it; both name the same entry, and a lookup that only understood one of them
  // would silently drop half the documents that carry a ref at all.
  return nonEmpty(air.schemas[ref] ?? air.schemas[ref.split("/").pop() ?? ref]);
}

/**
 * The element schema inside a declared page envelope.
 *
 * `pagination.itemsField` is the contract's own answer and wins when it names a
 * declared property. Otherwise the first array-valued property in declared
 * order is the item array — declared order, not a guess ranked by name, so the
 * choice is a function of the document rather than of a vocabulary we invented.
 * A declared envelope with no array in it is not an envelope we can read, and
 * we return nothing rather than treat the envelope's own fields as an item's:
 * `read` repeats an item once per page slot, so a wrong item shape here is
 * multiplied into a wrong page cost.
 */
function unwrapItems(schema: JsonSchema, op: Operation): JsonSchema | undefined {
  if (schema.type === "array" || isRecord(schema.items)) {
    return isRecord(schema.items) ? (schema.items as JsonSchema) : undefined;
  }
  if (!isRecord(schema.properties)) return undefined;
  const props = schema.properties as Record<string, JsonSchema | undefined>;
  const named = op.pagination?.itemsField;
  const declaredArray = named !== undefined ? props[named] : undefined;
  const candidates = isRecord(declaredArray) ? [declaredArray] : Object.values(props);
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    if (candidate.type !== "array" && !isRecord(candidate.items)) continue;
    if (isRecord(candidate.items)) return candidate.items as JsonSchema;
  }
  return undefined;
}

/**
 * How deep a synthesized body follows a declared schema. `materializeSchema`
 * has already removed `$ref` cycles, so this is not a termination guard — it is
 * a statement that a body nested past this point contributes structure no agent
 * reads, and following it further would inflate a cost figure with depth the
 * caller never sees.
 */
const MAX_BODY_DEPTH = 8;

/** Default synthesized string length when the schema constrains neither end. */
const DEFAULT_STRING_LENGTH = 8;

/**
 * The most items a synthesized array carries. `minItems` is a declared fact and
 * is honoured up to this bound; the bound itself is a limit on the *instrument*
 * (a pathological declaration must not make synthesis unbounded), never a claim
 * about the payload — which is why it is not consulted unless the contract
 * asked for more than it.
 */
const MAX_ARRAY_ITEMS = 10;

/** Fixed values for the formats whose shape, not whose entropy, is the point. */
const FORMAT_VALUES: Record<string, string> = {
  date: "2026-01-01",
  "date-time": "2026-01-01T00:00:00Z",
  time: "00:00:00Z",
  email: "user@example.com",
  uri: "https://example.com/resource",
  url: "https://example.com/resource",
  hostname: "api.example.com",
  ipv4: "192.0.2.1",
  ipv6: "2001:db8::1",
};

/** Schema keys that annotate without constraining — a schema of only these is a stub. */
const ANNOTATION_KEYS = new Set([
  "description",
  "title",
  "deprecated",
  "readOnly",
  "writeOnly",
  "nullable",
  "default",
  "$comment",
  "externalDocs",
  "xml",
]);

/**
 * A body for one entity, drawn from a declared item schema under a seeded `Rng`.
 *
 * Returns `undefined` for anything that is not a JSON object: the store is
 * object-keyed, and a resource whose declared representation is a scalar or an
 * array keeps its historical body rather than being served a shape the state
 * machine cannot carry.
 */
function synthesizeBody(schema: JsonSchema, rng: Rng): Record<string, unknown> | undefined {
  const value = synthesize(schema, rng, 0);
  return isRecord(value) ? value : undefined;
}

/**
 * One value for one declared schema node.
 *
 * Declared values beat synthesized ones in every case the contract states one
 * (`const`, `example`, `examples`, `enum`): they are the most faithful answer
 * available, and they cost what the contract says they cost. Everything else is
 * seeded from the `Rng`, so the whole walk stays a pure function of (contract,
 * seed) — the property that lets a measured figure be re-derived instead of
 * merely believed.
 */
function synthesize(schema: JsonSchema, rng: Rng, depth: number): unknown {
  if (schema.const !== undefined) return schema.const;
  if (schema.example !== undefined && schema.example !== null) return schema.example;
  if (Array.isArray(schema.examples)) {
    const first = schema.examples.find((e) => e !== null && e !== undefined);
    if (first !== undefined) return first;
  }
  if (Array.isArray(schema.enum)) {
    const values = schema.enum.filter((v) => v !== null && v !== undefined);
    const picked = values[rng.int(values.length)];
    if (picked !== undefined) return picked;
  }
  if (depth >= MAX_BODY_DEPTH) return schema.type === "array" ? [] : {};

  // A materialized `allOf` composes one object out of several declarations —
  // including truncation stubs that contribute nothing — so every member is
  // synthesized and the object results merged, later members winning.
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    const merged: Record<string, unknown> = {};
    for (const member of schema.allOf) {
      if (!isRecord(member)) continue;
      const part = synthesize(member as JsonSchema, rng, depth + 1);
      if (isRecord(part)) Object.assign(merged, part);
    }
    return merged;
  }
  // `oneOf`/`anyOf`: any branch satisfies the contract, so take the first
  // declared one. A schema may carry both its own structure and alternatives
  // that only refine it, so the branch merges onto the base rather than
  // replacing it.
  const alternatives = (
    Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : []
  ).filter(isRecord) as JsonSchema[];
  const branch = alternatives[0];
  if (branch !== undefined) {
    const value = synthesize(branch, rng, depth + 1);
    if (schema.type === undefined && !isRecord(schema.properties)) return value;
    const own = ownValue(schema, rng, depth);
    return isRecord(own) && isRecord(value) ? { ...own, ...value } : (own ?? value);
  }
  return ownValue(schema, rng, depth);
}

/** Synthesize from a schema's own declared structure, with no compositors left. */
function ownValue(schema: JsonSchema, rng: Rng, depth: number): unknown {
  switch (schema.type) {
    case "string":
      return synthesizeString(schema, rng);
    case "integer":
      return synthesizeInteger(schema, rng);
    case "number":
      return synthesizeInteger(schema, rng) + Math.floor(rng.next() * 100) / 100;
    case "boolean":
      return rng.next() < 0.5;
    case "array":
      return synthesizeArray(schema, rng, depth);
    case "object":
      return synthesizeObject(schema, rng, depth);
    default:
      // An untyped schema that still declares `properties` (or a `required`
      // list, which is an object constraint in all but name) is an object. A
      // bare annotation stub is an object we know nothing about, so `{}`. A
      // schema that declares neither is a field the contract admits exists
      // without saying what it holds: `null` records that honestly, and costs
      // what an unknown field costs.
      if (isRecord(schema.properties) || Array.isArray(schema.required)) {
        return synthesizeObject(schema, rng, depth);
      }
      if (Object.keys(schema).every((k) => ANNOTATION_KEYS.has(k))) return {};
      return null;
  }
}

function synthesizeString(schema: JsonSchema, rng: Rng): string {
  const format = typeof schema.format === "string" ? schema.format : "";
  const fixed = FORMAT_VALUES[format];
  if (fixed !== undefined) return fixed;
  if (format === "uuid") {
    return `${rng.token(8)}-${rng.token(4)}-4${rng.token(3)}-a${rng.token(3)}-${rng.token(12)}`;
  }
  // Length is declared or it is not: a declared bound is a fact about the
  // payload's size and is honoured in both directions, which is exactly how a
  // contract that promises long strings comes to simulate as expensive.
  const min = boundedInt(schema.minLength, 0);
  const max = boundedInt(schema.maxLength, Number.POSITIVE_INFINITY);
  return rng.token(Math.max(0, Math.max(min, Math.min(max, DEFAULT_STRING_LENGTH))));
}

function synthesizeInteger(schema: JsonSchema, rng: Rng): number {
  const min = boundedInt(schema.minimum, 0);
  const max = boundedInt(schema.maximum, Number.POSITIVE_INFINITY);
  if (max === Number.POSITIVE_INFINITY) return min + rng.int(1000);
  return min + rng.int(Math.max(1, Math.floor(max - min) + 1));
}

function synthesizeArray(schema: JsonSchema, rng: Rng, depth: number): unknown[] {
  const items = isRecord(schema.items) ? (schema.items as JsonSchema) : undefined;
  const min = boundedInt(schema.minItems, 1);
  const max = boundedInt(schema.maxItems, Number.POSITIVE_INFINITY);
  const count = Math.min(MAX_ARRAY_ITEMS, Math.max(0, Math.min(max, Math.max(1, min))));
  if (!items) return new Array(count).fill(null);
  return Array.from({ length: count }, () => synthesize(items, rng, depth + 1));
}

function synthesizeObject(schema: JsonSchema, rng: Rng, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const props = isRecord(schema.properties)
    ? (schema.properties as Record<string, JsonSchema | undefined>)
    : {};
  // Declared order, not sorted: this is a payload as served, not a digest, and
  // reordering keys would move a measured byte count for no reason.
  for (const [name, prop] of Object.entries(props)) {
    out[name] = isRecord(prop) ? synthesize(prop, rng, depth + 1) : null;
  }
  // A map/record schema (typed `additionalProperties`, no fixed properties)
  // gets one representative entry, so the body exercises the map shape rather
  // than the degenerate `{}` that would report a dictionary as free.
  const extra = schema.additionalProperties;
  if (Object.keys(out).length === 0 && isRecord(extra)) {
    out.key = synthesize(extra as JsonSchema, rng, depth + 1);
  }
  return out;
}

function boundedInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A schema that declares nothing is not a schema, so callers treat it as absent. */
function nonEmpty(schema: JsonSchema | undefined): JsonSchema | undefined {
  return schema && Object.keys(schema).length > 0 ? schema : undefined;
}

/**
 * A representative response for one operation, produced under the simulator's
 * seed so a per-item token cost can be measured over something an agent would
 * actually receive.
 *
 * Response size is a fact about a tenant's data, which no contract states — so
 * it can only be measured, never read off the spec. This is the seam that makes
 * the measurement possible without calling the real API, and everything in it
 * comes from the same `invoke` path a caller is served by: a sample drawn from
 * a parallel code path would describe a response nobody is ever sent.
 */
export interface DisclosureSample {
  /** The public (MCP) tool name that was sampled. */
  toolName: string;
  /** Verbatim `output` from `invoke` — the whole response, to be tokenized as-is. */
  response: unknown;
  /**
   * One item out of that response: the unit `responseItemTokens` is measured
   * over, and the unit `safePageSize` divides a budget by. Absent when the
   * response carries no items at all (a read that found nothing).
   */
  item?: unknown;
  /**
   * Items actually in `response`. Compare against `pageSize` before tokenizing
   * `response` as a whole-page cost: the fixture set is small, so a page sized
   * for a generous budget is routinely served short. A caller that wants a
   * full-page figure should scale `item` by `pageSize` rather than measure a
   * response that happened to run out of fixtures.
   */
  itemCount: number;
  /** The page size the simulator served, and why. */
  pageSize: number;
  /** Straight from AIR's solver: `unmeasured`/`not_paginated` means the figure rests on the fixture fallback. */
  pageSizeBasis: PageSizeBasis;
}

/** A stateful, seeded, contract-faithful simulator for one capability. */
export class Simulator {
  private readonly ops: Operation[];
  private store = new Map<string, Map<string, Entity>>();
  private replayLog = new Map<string, SimResult>();
  private rng: Rng;
  private callIndex = 0;
  /**
   * The seed currently in force — `def.seed` until someone calls `reset(other)`.
   * Tracked because `disclosureSample` has to re-seed around itself, and
   * re-seeding to `def.seed` would silently discard a caller's chosen seed and
   * make a sample describe a different data set than the run it belongs to.
   */
  private activeSeed: number;
  /**
   * Per-operation declared item schemas, resolved on first use. Memoized
   * because `materializeSchema` walks a whole schema graph and a paginated read
   * would otherwise repeat that walk once per item on every page; keyed by
   * operation id and never invalidated, since the contract is immutable for the
   * lifetime of a simulator. `undefined` is a cached answer too — "this
   * operation declares nothing usable" is exactly the case worth not re-deriving.
   */
  private readonly itemSchemas = new Map<string, JsonSchema | undefined>();

  constructor(
    private readonly air: AirDocument,
    private readonly def: SimulatorDefinition,
  ) {
    // The simulator serves exactly one surface: the whole service, or one
    // discovered capability. An unknown capability id is a definition error —
    // reject it rather than silently falling back to serving everything (#25).
    const isService = def.capabilityId === air.service.id;
    const capability = air.capabilities.find((c) => c.id === def.capabilityId);
    if (!isService && !capability) {
      throw new Error(
        `Unknown capability '${def.capabilityId}': not the service id '${air.service.id}' and not a discovered capability.`,
      );
    }
    const memberIds = new Set(capability?.operationIds ?? []);
    const inCapability = (op: Operation) => isService || memberIds.has(op.id);
    this.ops = air.operations.filter((op) => op.state === "approved" && inCapability(op));
    this.rng = new Rng(def.seed);
    this.activeSeed = def.seed;
    this.reset();
  }

  /** The surface the simulator serves — identical to the generated MCP's. */
  signature(): SurfaceSignature {
    const capabilityId =
      this.def.capabilityId === this.air.service.id ? undefined : this.def.capabilityId;
    return surfaceSignatureFor(this.air, capabilityId);
  }

  /** Re-seed and repopulate deterministic fixtures. Clears state and replay log. */
  reset(seed?: number): void {
    this.activeSeed = seed ?? this.def.seed;
    this.rng = new Rng(this.activeSeed);
    this.callIndex = 0;
    this.store = new Map();
    this.replayLog = new Map();
    for (const fixture of this.def.fixtures) {
      const table = new Map<string, Entity>();
      for (let i = 0; i < fixture.count; i++) {
        const id = `${fixture.entity}_${this.rng.token(6)}`;
        table.set(id, { id, status: "active" });
      }
      this.store.set(fixture.entity, table);
    }
  }

  private resolve(toolName: string): Operation | undefined {
    return this.ops.find((op) => op.mcp.toolName === toolName);
  }

  private tableFor(op: Operation): Map<string, Entity> {
    const name = op.effect.resource ?? this.def.entities[0]?.name ?? "resource";
    if (!this.store.has(name)) this.store.set(name, new Map());
    return this.store.get(name) as Map<string, Entity>;
  }

  private fault(ctx: InvokeContext): SimResult | undefined {
    if (!ctx.faultScenario) return undefined;
    const profile = this.def.faults.find((f) => f.scenario === ctx.faultScenario);
    if (!profile) return undefined;
    // Deterministic decision seeded by scenario + call index.
    const roll = new Rng(
      this.def.seed ^ (this.callIndex + 1) ^ hashString(profile.scenario),
    ).next();
    if (roll >= profile.rate) return undefined;
    switch (profile.kind) {
      case "rate_limit":
        return { ok: false, error: { code: "rate_limited", message: "Simulated rate limit." } };
      case "transient":
        return { ok: false, error: { code: "upstream_unavailable", message: "Simulated outage." } };
      case "conflict":
        return { ok: false, error: { code: "conflict", message: "Simulated conflict." } };
      default:
        return undefined; // latency / eventual_consistency: still succeeds
    }
  }

  /** Invoke one operation by its public (MCP tool) name. */
  invoke(
    toolName: string,
    input: Record<string, unknown> = {},
    ctx: InvokeContext = {},
  ): SimResult {
    this.callIndex += 1;
    const op = this.resolve(toolName);
    if (!op) {
      return {
        ok: false,
        error: { code: "unsupported_operation", message: `No operation '${toolName}'.` },
      };
    }

    // Auth: a scoped operation needs a principal holding every required scope.
    if (op.auth.scopes.length > 0 || op.auth.type !== "none") {
      const principal = this.def.authProfiles.find((p) => p.id === ctx.principalId);
      if (!principal) {
        return { ok: false, error: { code: "auth_required", message: "No principal supplied." } };
      }
      const missing = op.auth.scopes.filter((s) => !principal.scopes.includes(s));
      if (missing.length > 0) {
        return {
          ok: false,
          error: { code: "permission_denied", message: `Missing scope(s): ${missing.join(", ")}.` },
        };
      }
    }

    // Confirmation gate.
    if (op.confirmation.required && !ctx.confirm) {
      return {
        ok: false,
        error: { code: "confirmation_required", message: "Confirmation required." },
      };
    }

    // Required idempotency + idempotent replay (only for key-supporting mutations).
    const keyed =
      op.effect.kind === "mutation" && op.idempotency.mode !== "none" && !!ctx.idempotencyKey;
    // Scope the replay fingerprint to the caller (principal + tenant) so one
    // caller's idempotency key can never replay another's cached result (#24).
    const fingerprint = hashCanonical([
      toolName,
      input,
      ctx.principalId ?? null,
      ctx.tenantId ?? null,
      ctx.idempotencyKey ?? null,
    ]);
    if (op.effect.kind === "mutation") {
      if (op.idempotency.mode === "required" && !ctx.idempotencyKey) {
        return {
          ok: false,
          error: { code: "idempotency_required", message: "Idempotency key required." },
        };
      }
      if (keyed && this.replayLog.has(fingerprint)) {
        const prior = this.replayLog.get(fingerprint) as SimResult;
        return prior.ok ? { ...prior, replayed: true } : prior;
      }
    }

    // Fault injection (after the safety gates, before the effect).
    const fault = this.fault(ctx);
    if (fault) return fault;

    const result = op.effect.kind === "read" ? this.read(op, ctx) : this.mutate(op, input);
    if (keyed) this.replayLog.set(fingerprint, result);
    return result;
  }

  /**
   * Draw a representative response for one operation so its context cost can be
   * measured. Returns `undefined` when there is nothing honest to tokenize —
   * the tool is not served here, or the contract's own gates refused the call.
   *
   * Two properties make this certifiable rather than merely indicative:
   *
   *  - It is a pure function of (contract, seed). It re-seeds before drawing so
   *    it cannot observe whatever calls preceded it, and re-seeds after so it
   *    leaves nothing behind — a disclosure figure that drifted with call
   *    history would be unreproducible, and an unreproducible figure is a guess
   *    wearing a number's clothes.
   *  - It goes through `invoke`, not around it. Any shortcut that assembled a
   *    "representative" payload directly would measure a response the serving
   *    path never emits, which is the precise failure this whole increment
   *    exists to prevent.
   *
   * The cost of purity is that this *resets the simulator*: call it before
   * building up state, or expect to rebuild it.
   */
  disclosureSample(toolName: string): DisclosureSample | undefined {
    const op = this.resolve(toolName);
    if (!op) return undefined;

    const seed = this.activeSeed;
    this.reset(seed);
    const result = this.invoke(toolName, {}, this.samplingContext(op));
    this.reset(seed);
    // A refused call carries an error payload, not a response. Measuring it
    // would report a confirmation refusal as an operation's response cost —
    // wrong, and wrong in the flattering direction. Decline instead, and let
    // the caller record the operation as unmeasured.
    if (!result.ok) return undefined;

    const items = itemsOf(result.output);
    const page = this.pageSizeFor(op);
    return {
      toolName,
      response: result.output,
      item: items ? items[0] : (result.output ?? undefined),
      itemCount: items ? items.length : result.output == null ? 0 : 1,
      pageSize: page.size,
      pageSizeBasis: page.basis,
    };
  }

  /**
   * The weakest context that still gets past the contract's gates. Sampling is
   * not the place to assert them — coverage already drives every gate as its
   * own matrix cell — so a scoped or confirm-gated operation must not measure
   * as an error payload just because the sampler arrived empty-handed.
   */
  private samplingContext(op: Operation): InvokeContext {
    const principal = this.def.authProfiles.find((p) =>
      op.auth.scopes.every((s) => p.scopes.includes(s)),
    );
    return {
      principalId: principal?.id,
      confirm: true,
      // A fixed key, not a generated one: the fingerprint must be a function of
      // the seed like everything else here.
      idempotencyKey: op.idempotency.mode === "none" ? undefined : "disclosure-sample",
    };
  }

  /**
   * How many items one simulated page carries.
   *
   * A page size chosen by the simulator would make the simulator useless as a
   * measurement instrument: whatever we tokenized would describe a response no
   * agent is ever served. So the arithmetic comes from AIR's `safePageSize` —
   * the identical solver the compiler, the MCP runtime and the certification
   * pass call — and the simulator contributes only the budget. Four surfaces
   * each deriving their own "what fits in context" is exactly how a certified
   * disclosure figure ends up describing a surface nobody serves.
   *
   * When AIR declines to size the page (nothing measured, or the contract never
   * declared pagination) we keep the fixture constant rather than inventing a
   * confident-looking number. That is what holds behaviour byte-identical for
   * the contracts that carry no disclosure measurement — still most of them.
   */
  private pageSizeFor(op: Operation): { size: number; basis: PageSizeBasis } {
    const budget = this.def.responseBudgetTokens ?? DEFAULT_RESPONSE_BUDGET_TOKENS;
    const derived = safePageSize(op, budget);
    return { size: derived.size ?? FALLBACK_PAGE_SIZE, basis: derived.basis };
  }

  private itemSchemaFor(op: Operation): JsonSchema | undefined {
    if (!this.itemSchemas.has(op.id)) {
      this.itemSchemas.set(op.id, declaredItemSchema(this.air, op));
    }
    return this.itemSchemas.get(op.id);
  }

  /**
   * Dress one stored entity in the representation this operation declares.
   *
   * Stored fields are spread last and therefore win: whatever synthesis put in
   * an `id` or a `status` is a plausible-looking value, and the store's is the
   * true one — a projection that could overwrite state would break the state
   * machine, the pagination cursor and idempotent replay in one stroke.
   *
   * The body is seeded from (active seed, operation id, entity id) and drawn
   * from its own `Rng`, never the simulator's. Two consequences, both load
   * bearing: the same entity read twice yields the same body, and the fixture
   * stream that generates entity ids is untouched — so every id the simulator
   * has ever produced under a given seed is still that id.
   */
  private project(op: Operation, entity: Entity): Entity {
    const schema = this.itemSchemaFor(op);
    if (!schema) return entity;
    const seed = mixSeed(this.activeSeed, `${op.id}:${String(entity.id ?? "")}`);
    const body = synthesizeBody(schema, new Rng(seed));
    return body ? { ...body, ...entity } : entity;
  }

  private read(op: Operation, ctx: InvokeContext): SimResult {
    const table = [...this.tableFor(op).values()];
    if (servesItems(op)) {
      const pageSize = this.pageSizeFor(op).size;
      const start = ctx.cursor ? Number.parseInt(ctx.cursor, 10) || 0 : 0;
      const page = table.slice(start, start + pageSize).map((entity) => this.project(op, entity));
      const nextCursor = start + pageSize < table.length ? String(start + pageSize) : undefined;
      return { ok: true, output: { items: page }, nextCursor };
    }
    const first = table[0];
    return { ok: true, output: first ? this.project(op, first) : null };
  }

  private mutate(op: Operation, input: Record<string, unknown>): SimResult {
    const table = this.tableFor(op);
    const action = op.effect.action;
    if (action === "delete" || action === "cancel") {
      const id = String(input.id ?? [...table.keys()][0] ?? "");
      const entity = table.get(id);
      if (!entity)
        return { ok: false, error: { code: "not_found", message: `No entity '${id}'.` } };
      entity.status = "cancelled";
      return { ok: true, output: this.project(op, entity) };
    }
    // create / update / other → upsert an entity with a deterministic id.
    const id = String(input.id ?? `${op.effect.resource ?? "entity"}_${this.rng.token(6)}`);
    const entity: Entity = { ...input, id, status: action === "approve" ? "updated" : "active" };
    table.set(id, entity);
    // A mutation's response is a representation too — a create that returns the
    // whole record costs an agent what that record costs, and measuring it as
    // `{id, status}` under-reported every write in the surface.
    return { ok: true, output: this.project(op, entity) };
  }
}

/**
 * The item array inside a simulated response, when there is one. Mirrors the
 * envelope `read` emits rather than guessing at a shape, so the two cannot
 * drift: if the paginated envelope ever changes, this must change with it.
 */
function itemsOf(output: unknown): unknown[] | undefined {
  if (output !== null && typeof output === "object" && "items" in output) {
    const items = (output as { items: unknown }).items;
    if (Array.isArray(items)) return items;
  }
  return undefined;
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * Derive a sub-seed from the run's seed and a label. Mixed multiplicatively
 * rather than xor'd so that two labels whose hashes differ in few bits still
 * produce unrelated streams — an entity's body must not resemble its
 * neighbour's just because their ids do.
 */
function mixSeed(seed: number, label: string): number {
  return (Math.imul(seed ^ hashString(label), 0x9e3779b1) ^ (seed >>> 3)) >>> 0;
}
