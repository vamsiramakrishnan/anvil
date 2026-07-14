/**
 * Mechanistic coverage. `executableChecks` boots the simulator and exercises one
 * *representative* operation per safety control — enough to certify, not enough
 * to say the surface is well-covered. This enumerates the full matrix instead:
 * every approved operation crossed with every safety dimension that applies to
 * it (auth, confirmation, idempotency, fault, pagination), each cell driven
 * through the contract-faithful simulator and checked against an independent
 * expectation. The result is a coverage report — which (operation, dimension)
 * cells were exercised, which held, and which the contract left inapplicable —
 * so "we tested it" becomes a number, not a vibe.
 *
 * The matrix is generated from the contract (mechanistic), and driven by the
 * simulator (the harness). Everything is a pure function of (seed, contract):
 * the same inputs enumerate the same cells with the same outcomes.
 */
import type { AirDocument, Operation } from "@anvil/air";
import { surfaceSignatureFor } from "@anvil/compiler";
import {
  type InvokeContext,
  type SimResult,
  Simulator,
  simulatorDefinitionFor,
} from "@anvil/simulator";
import { z } from "zod";

/** The safety dimensions the matrix crosses each operation with. */
export const CoverageDimension = z.enum([
  "auth",
  "confirmation",
  "idempotency",
  "fault",
  "pagination",
]);
export type CoverageDimension = z.infer<typeof CoverageDimension>;

/** One driven cell: an operation exercised on one dimension variant. */
export const CoverageCell = z.object({
  operationId: z.string(),
  dimension: CoverageDimension,
  /** The specific variant, e.g. "missing-scope", "without-confirm", "outage". */
  variant: z.string(),
  /** The outcome the contract predicts: an error code, "ok", or "replayed". */
  expected: z.string(),
  /** What the simulator actually produced. */
  actual: z.string(),
  ok: z.boolean(),
});
export type CoverageCell = z.infer<typeof CoverageCell>;

export const CoverageReport = z.object({
  schemaVersion: z.literal(1),
  capabilityId: z.string(),
  seed: z.number().int(),
  /** Parity anchor: the surface this coverage was measured against. */
  surfaceSignatureDigest: z.string(),
  cells: z.array(CoverageCell),
  /** Per-dimension rollup: operations for which the dimension applied, and cells passed. */
  dimensions: z.array(
    z.object({
      dimension: CoverageDimension,
      operations: z.number().int(),
      cells: z.number().int(),
      passed: z.number().int(),
    }),
  ),
  summary: z.object({
    operations: z.number().int(),
    cells: z.number().int(),
    passed: z.number().int(),
    failed: z.number().int(),
  }),
});
export type CoverageReport = z.infer<typeof CoverageReport>;

export interface CoverageOptions {
  seed?: number;
}

/** Classify a SimResult into the comparable token the matrix asserts against. */
function outcome(r: SimResult): string {
  if (r.ok) return r.replayed ? "replayed" : "ok";
  return r.error.code;
}

/** Whether an operation's declared auth requires a principal at all. */
function needsAuth(op: Operation): boolean {
  return op.auth.scopes.length > 0 || op.auth.type !== "none";
}

/**
 * The base context that satisfies every gate OTHER than the one under test, so
 * a cell isolates its dimension. A gated op gets `confirm`, a required-key
 * mutation gets a key, an authenticated op gets the authorized principal.
 */
function baseCtx(op: Operation, key?: string): InvokeContext {
  const ctx: InvokeContext = {};
  if (needsAuth(op)) ctx.principalId = "admin";
  if (op.confirmation.required) ctx.confirm = true;
  if (op.effect.kind === "mutation" && op.idempotency.mode === "required") {
    ctx.idempotencyKey = key ?? "coverage-key";
  }
  return ctx;
}

/**
 * Enumerate and drive the coverage matrix for a capability's approved surface.
 */
export function coverageMatrix(air: AirDocument, options: CoverageOptions = {}): CoverageReport {
  const seed = options.seed ?? 1;
  const def = simulatorDefinitionFor(air, { seed });
  const sim = new Simulator(air, def);
  const served = air.operations.filter((o) => o.state === "approved");
  const cells: CoverageCell[] = [];

  const record = (
    op: Operation,
    dimension: CoverageDimension,
    variant: string,
    expected: string,
    result: SimResult,
  ) => {
    const actual = outcome(result);
    cells.push({
      operationId: op.id,
      dimension,
      variant,
      expected,
      actual,
      ok: actual === expected,
    });
  };
  const tool = (op: Operation) => op.mcp.toolName;

  for (const op of served) {
    // Clean, deterministic state per operation.
    sim.reset(seed);

    // --- auth ---------------------------------------------------------------
    if (needsAuth(op)) {
      // A missing principal is rejected before any other gate.
      record(
        op,
        "auth",
        "no-principal",
        "auth_required",
        sim.invoke(tool(op), {}, { ...baseCtx(op), principalId: undefined }),
      );
      if (op.auth.scopes.length > 0) {
        record(
          op,
          "auth",
          "missing-scope",
          "permission_denied",
          sim.invoke(tool(op), {}, { ...baseCtx(op), principalId: "limited" }),
        );
      }
      // The authorized principal clears auth (whatever else the op then does).
      const authed = outcome(sim.invoke(tool(op), {}, baseCtx(op)));
      cells.push({
        operationId: op.id,
        dimension: "auth",
        variant: "authorized",
        expected: "not auth_required/permission_denied",
        actual: authed,
        ok: authed !== "auth_required" && authed !== "permission_denied",
      });
    }

    // --- confirmation -------------------------------------------------------
    if (op.confirmation.required) {
      const { confirm: _drop, ...noConfirm } = baseCtx(op);
      record(
        op,
        "confirmation",
        "without-confirm",
        "confirmation_required",
        sim.invoke(tool(op), {}, noConfirm),
      );
      const withConfirm = outcome(sim.invoke(tool(op), {}, baseCtx(op, "coverage-confirm")));
      cells.push({
        operationId: op.id,
        dimension: "confirmation",
        variant: "with-confirm",
        expected: "not confirmation_required",
        actual: withConfirm,
        ok: withConfirm !== "confirmation_required",
      });
    }

    // --- idempotency --------------------------------------------------------
    if (op.effect.kind === "mutation" && op.idempotency.mode === "required") {
      // Empty input is universal: create upserts a fresh entity, cancel/delete
      // act on a seeded fixture — so the cell tests the idempotency gate, not
      // entity existence. Replay short-circuits before the effect, so the
      // matching fingerprint (same input + key) returns the first result.
      const { idempotencyKey: _drop, ...noKey } = baseCtx(op);
      record(
        op,
        "idempotency",
        "without-key",
        "idempotency_required",
        sim.invoke(tool(op), {}, noKey),
      );
      const key = "coverage-replay-key";
      record(op, "idempotency", "with-key", "ok", sim.invoke(tool(op), {}, baseCtx(op, key)));
      record(op, "idempotency", "replay", "replayed", sim.invoke(tool(op), {}, baseCtx(op, key)));
    }

    // --- fault --------------------------------------------------------------
    // Faults fire after the gates, so drive them with a fully-satisfied context.
    for (const [variant, expected] of [
      ["none", op.effect.kind === "read" ? "ok" : "ok"],
      ["throttle", "rate_limited"],
      ["outage", "upstream_unavailable"],
      ["conflict", "conflict"],
    ] as const) {
      const r = sim.invoke(
        tool(op),
        {},
        { ...baseCtx(op, `fault-${variant}`), faultScenario: variant },
      );
      record(op, "fault", variant, expected, r);
    }

    // --- pagination ---------------------------------------------------------
    if (op.effect.kind === "read" && (op.effect.action === "list" || op.pagination)) {
      const first = sim.invoke(tool(op), {}, baseCtx(op));
      record(op, "pagination", "first-page", "ok", first);
      const cursor = first.ok ? first.nextCursor : undefined;
      if (cursor) {
        record(
          op,
          "pagination",
          "follow-cursor",
          "ok",
          sim.invoke(tool(op), {}, { ...baseCtx(op), cursor }),
        );
      }
    }
  }

  return rollup(air, def.capabilityId, seed, cells);
}

function rollup(
  air: AirDocument,
  capabilityId: string,
  seed: number,
  cells: CoverageCell[],
): CoverageReport {
  const dims: CoverageDimension[] = ["auth", "confirmation", "idempotency", "fault", "pagination"];
  const dimensions = dims.map((dimension) => {
    const dcells = cells.filter((c) => c.dimension === dimension);
    return {
      dimension,
      operations: new Set(dcells.map((c) => c.operationId)).size,
      cells: dcells.length,
      passed: dcells.filter((c) => c.ok).length,
    };
  });
  const passed = cells.filter((c) => c.ok).length;
  return CoverageReport.parse({
    schemaVersion: 1,
    capabilityId,
    seed,
    surfaceSignatureDigest: surfaceSignatureFor(air).digest,
    cells,
    dimensions,
    summary: {
      operations: new Set(cells.map((c) => c.operationId)).size,
      cells: cells.length,
      passed,
      failed: cells.length - passed,
    },
  });
}
