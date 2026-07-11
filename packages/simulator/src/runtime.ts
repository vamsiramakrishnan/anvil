/**
 * The deterministic simulator runtime. It serves a capability's approved
 * operations with contract-faithful behaviour: auth-scope gating, confirmation
 * refusal, required-idempotency enforcement and idempotent replay, stateful
 * mutations with a domain state machine, pagination, and seeded fault injection.
 *
 * Everything is a pure function of (seed, call sequence): no clock, no
 * randomness beyond the seeded `Rng`, so a run reproduces exactly.
 */
import { type AirDocument, type ErrorCode, hashCanonical, type Operation } from "@anvil/air";
import { type SurfaceSignature, surfaceSignatureFor } from "@anvil/compiler";
import type { SimulatorDefinition } from "./model.js";
import { Rng } from "./rng.js";

export interface InvokeContext {
  principalId?: string;
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

const PAGE_SIZE = 2;

/** A stateful, seeded, contract-faithful simulator for one capability. */
export class Simulator {
  private readonly ops: Operation[];
  private store = new Map<string, Map<string, Entity>>();
  private replayLog = new Map<string, SimResult>();
  private rng: Rng;
  private callIndex = 0;

  constructor(
    private readonly air: AirDocument,
    private readonly def: SimulatorDefinition,
  ) {
    const memberIds = new Set(
      air.capabilities.find((c) => c.id === def.capabilityId)?.operationIds ?? [],
    );
    const inCapability = (op: Operation) =>
      memberIds.size === 0 || memberIds.has(op.id) || def.capabilityId === air.service.id;
    this.ops = air.operations.filter((op) => op.state === "approved" && inCapability(op));
    this.rng = new Rng(def.seed);
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
    this.rng = new Rng(seed ?? this.def.seed);
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

  private fault(op: Operation, ctx: InvokeContext): SimResult | undefined {
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
    const fingerprint = hashCanonical([toolName, input, ctx.idempotencyKey ?? null]);
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
    const fault = this.fault(op, ctx);
    if (fault) return fault;

    const result = op.effect.kind === "read" ? this.read(op, ctx) : this.mutate(op, input);
    if (keyed) this.replayLog.set(fingerprint, result);
    return result;
  }

  private read(op: Operation, ctx: InvokeContext): SimResult {
    const table = [...this.tableFor(op).values()];
    if (op.effect.action === "list" || op.pagination) {
      const start = ctx.cursor ? Number.parseInt(ctx.cursor, 10) || 0 : 0;
      const page = table.slice(start, start + PAGE_SIZE);
      const nextCursor = start + PAGE_SIZE < table.length ? String(start + PAGE_SIZE) : undefined;
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

function hashScenario(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) >>> 0;
  return h;
}
