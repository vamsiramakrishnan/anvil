/**
 * The deterministic simulator runtime. It serves a capability's approved
 * operations with contract-faithful behaviour: auth-scope gating, confirmation
 * refusal, required-idempotency enforcement and idempotent replay, stateful
 * mutations with a domain state machine, pagination, and seeded fault injection.
 *
 * Everything is a pure function of (seed, call sequence): no clock, no
 * randomness beyond the seeded `Rng`, so a run reproduces exactly.
 */
import {
  type AirDocument,
  DEFAULT_RESPONSE_BUDGET_TOKENS,
  type ErrorCode,
  hashCanonical,
  type Operation,
  type PageSizeBasis,
  safePageSize,
} from "@anvil/air";
import { type SurfaceSignature, surfaceSignatureFor } from "@anvil/compiler";
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
      this.def.seed ^ (this.callIndex + 1) ^ hashScenario(profile.scenario),
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

  private read(op: Operation, ctx: InvokeContext): SimResult {
    const table = [...this.tableFor(op).values()];
    if (op.effect.action === "list" || op.pagination) {
      const pageSize = this.pageSizeFor(op).size;
      const start = ctx.cursor ? Number.parseInt(ctx.cursor, 10) || 0 : 0;
      const page = table.slice(start, start + pageSize);
      const nextCursor = start + pageSize < table.length ? String(start + pageSize) : undefined;
      return { ok: true, output: { items: page }, nextCursor };
    }
    return { ok: true, output: table[0] ?? null };
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
      return { ok: true, output: entity };
    }
    // create / update / other → upsert an entity with a deterministic id.
    const id = String(input.id ?? `${op.effect.resource ?? "entity"}_${this.rng.token(6)}`);
    const entity: Entity = { ...input, id, status: action === "approve" ? "updated" : "active" };
    table.set(id, entity);
    return { ok: true, output: entity };
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

function hashScenario(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) >>> 0;
  return h;
}
