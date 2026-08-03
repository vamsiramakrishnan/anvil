/**
 * Mechanistic coverage. `executableChecks` boots the simulator and exercises one
 * *representative* operation per safety control — enough to certify, not enough
 * to say the surface is well-covered. This enumerates the full matrix instead:
 * every approved operation crossed with every safety dimension that applies to
 * it (auth, confirmation, idempotency, fault, pagination, disclosure), each cell
 * driven through the contract-faithful simulator and checked against an
 * independent expectation. The result is a coverage report — which (operation,
 * dimension) cells were exercised, which held, and which the contract left
 * inapplicable — so "we tested it" becomes a number, not a vibe.
 *
 * The matrix is generated from the contract (mechanistic), and driven by the
 * simulator (the harness). Everything is a pure function of (seed, contract):
 * the same inputs enumerate the same cells with the same outcomes.
 *
 * `disclosure` is the one dimension whose cells are not all the same kind of
 * claim, and the report is shaped to keep that visible. What an operation's tool
 * surface costs an agent is a *fact*: it is exactly the bytes the serving unit
 * publishes, derivable from AIR alone, identical on every tenant forever. What
 * one of its responses costs is a *prediction*: real payload size is a property
 * of somebody's data, which no contract states, so the only honest figure comes
 * from driving the simulator under a recorded seed and tokenizing what it
 * returns. Both are useful; conflating them is not. A report that let a
 * synthetic-data projection read as a certified fact would turn the entire
 * certification story into theatre — so every cell carries the `basis` it was
 * established on, and a projected figure carries the seed and the tokenizer
 * identity that make it re-derivable. A number nobody can re-derive cannot be
 * certified, whatever it is printed next to.
 */
import type { AirDocument, DisclosureCost, Operation } from "@anvil/air";
import {
  DEFAULT_RESPONSE_BUDGET_TOKENS,
  DEFAULT_TOOL_DISCLOSURE_BUDGET_TOKENS,
  responseFitsBudget,
  safePageSize,
  toolSurfaceFitsBudget,
} from "@anvil/air";
import {
  countTokens,
  surfaceSignatureFor,
  TOKEN_ESTIMATOR_ID,
  withResponseMeasurement,
} from "@anvil/compiler";
import {
  type DisclosureSample,
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
  "disclosure",
]);
export type CoverageDimension = z.infer<typeof CoverageDimension>;

/**
 * What a cell's verdict rests on.
 *
 * `contract` — the verdict follows from the contract itself and nothing else.
 * Every behavioural dimension is this: the simulator's fixtures decide what an
 * auth refusal *contains*, never whether it refuses, so the outcome is a fact
 * about the surface regardless of whose data sits behind it.
 *
 * `simulated-data` — the verdict depends on values the simulator invented. Only
 * a disclosure response cell is this today, and it is why the field exists: the
 * cell is a well-founded projection, not a measurement of production, and it
 * must never be read as one.
 */
export const CoverageBasis = z.enum(["contract", "simulated-data"]);
export type CoverageBasis = z.infer<typeof CoverageBasis>;

/**
 * The measured quantity behind a budget verdict, so a reader can argue with the
 * number instead of trusting the boolean.
 *
 * `estimator` is not decoration: token counts are tokenizer-specific, so a
 * figure without its encoding is a number without a unit — it keeps looking
 * authoritative while silently describing a different tokenizer than the one
 * that produced it. `seed` is the fact/prediction discriminator, mirroring
 * `DisclosureCost.seed` in AIR: present means the figure came from synthetic
 * data and is reproducible only under that seed; absent means it was read off
 * the contract and holds unconditionally.
 */
export const CoverageFigure = z.object({
  /** Tokens measured for the surface this cell judges. */
  tokens: z.number().int().nonnegative(),
  /** The budget the figure was judged against. */
  budgetTokens: z.number().int().positive(),
  /** Tokenizer identity — figures from different estimators are not comparable. */
  estimator: z.string(),
  /** Simulator seed behind a projected figure; absent on a contract-derived one. */
  seed: z.number().int().optional(),
});
export type CoverageFigure = z.infer<typeof CoverageFigure>;

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
  /**
   * What the verdict rests on. Defaulted rather than optional so no cell can
   * decline to say — an unlabelled verdict is exactly the ambiguity this field
   * exists to remove, and the default is the conservative, historical one.
   */
  basis: CoverageBasis.default("contract"),
  /** The quantity behind a budget verdict. Only budget cells carry one. */
  figure: CoverageFigure.optional(),
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

/** Verdict tokens for a budget cell — read as prose in a report, unlike error codes. */
const WITHIN_BUDGET = "within-budget";
const OVER_BUDGET = "over-budget";

/**
 * SINGLE POINT OF CONTACT with `@anvil/simulator`'s disclosure sampler.
 *
 * Nothing else in this package may reach for a representative response. The
 * sampler is the only path that yields a page the simulator would actually
 * serve — it sizes the page through AIR's own `safePageSize`, so what we
 * tokenize is what a caller receives. A sample drawn any other way (reading the
 * fixture store, re-implementing pagination, hand-rolling an entity) would
 * describe a response nobody is ever sent, which is precisely the drift that
 * makes a certified figure worthless. Isolating the call here also means the
 * seam can be reconciled in one edit if its name or shape settles differently.
 */
function sampleResponse(sim: Simulator, op: Operation): DisclosureSample | undefined {
  // No context is passed: the sampler builds the weakest one that clears the
  // contract's gates, and re-seeds around itself. Coverage must not hand it one
  // — a sample taken under a context this loop chose would drift the moment the
  // gates above it changed, and the figure would stop being a function of seed.
  return sim.disclosureSample(op.mcp.toolName);
}

/**
 * The exact text whose tokens we count: the JSON an agent receives.
 *
 * Not a canonicalized (key-sorted) rendering, though one is available in AIR —
 * sorting would change the bytes and therefore the count, and we are measuring
 * a payload as served, not hashing it for identity. Determinism comes from the
 * simulator being a pure function of its seed, not from imposing an order on it.
 */
function servedJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/**
 * Fold a driven sample into a `DisclosureCost`, or decline.
 *
 * Declines when the operation carries no compiler measurement, because the
 * estimator identity and the tool-surface figure live on that record and this
 * layer must not invent either — a response figure with a fabricated tokenizer
 * id is worse than no figure, since it looks comparable and is not. `@anvil/
 * compiler` owns the merge (`withResponseMeasurement`) and the counter
 * (`countTokens`) so that both halves of the record are counted with one
 * encoding; measuring here with a different tokenizer would produce a number
 * that cannot be compared to the tool figure printed beside it.
 */
function measureResponse(
  op: Operation,
  sample: DisclosureSample,
  seed: number,
): DisclosureCost | undefined {
  const cost = op.disclosureCost;
  if (!cost) return undefined;
  // An empty page is not a cheap page, it is an unmeasured one. `{"items":[]}`
  // costs a handful of tokens and would sail through any budget while saying
  // nothing whatsoever about what a populated page costs — a pass earned by
  // having no data is the flattering-verdict failure in its purest form.
  if (sample.itemCount === 0 || sample.item === undefined) return undefined;
  return withResponseMeasurement(cost, {
    responseTokens: countTokens(servedJson(sample.response)),
    responseItemTokens: countTokens(servedJson(sample.item)),
    seed,
  });
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
      // Behavioural cells are contract verdicts: the simulator's fixtures shape
      // what a refusal says, never whether it refuses.
      basis: "contract",
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
        basis: "contract",
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
        basis: "contract",
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
      ["none", "ok"],
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

    // --- disclosure ---------------------------------------------------------
    // Context cost, as two claims of deliberately different weight. Neither is
    // ever asserted for an operation nobody measured: an unmeasured operation
    // emits NO cell and simply does not appear in this dimension's denominator.
    //
    // That is the opposite of `checks.ts`'s "no applicable operation is a pass
    // with a note", and the divergence is intentional rather than an oversight.
    // A check answers "did anything violate this?", where silence is genuine
    // vacuous truth. Coverage answers "how much of the surface did we exercise?",
    // where a vacuous pass lands in the numerator *and* the denominator and
    // makes a wholly unmeasured surface report as fully covered — inflating the
    // exact figure the matrix exists to make honest. Unmeasured is a gap; it is
    // the refinement layer's job to raise it, not this layer's job to absolve it.
    const cost = op.disclosureCost;
    if (cost) {
      // (a) Tool surface: a fact. These are the bytes `tools/list` publishes for
      // this operation — no tenant, no seed, no data can move the number, so the
      // cell carries no seed and holds for every deployment of this contract.
      const toolFits = toolSurfaceFitsBudget(op, DEFAULT_TOOL_DISCLOSURE_BUDGET_TOKENS);
      cells.push({
        operationId: op.id,
        dimension: "disclosure",
        variant: "tool-surface",
        expected: WITHIN_BUDGET,
        actual: toolFits ? WITHIN_BUDGET : OVER_BUDGET,
        ok: toolFits,
        basis: "contract",
        figure: {
          tokens: cost.toolTokens,
          budgetTokens: DEFAULT_TOOL_DISCLOSURE_BUDGET_TOKENS,
          estimator: cost.estimator,
        },
      });

      // (b) One page of response: a projection. The sampler re-seeds around
      // itself, so this cell cannot observe the state the dimensions above left
      // behind — a figure that moved with the order its neighbours ran in would
      // not be reproducible, and an unreproducible figure cannot be certified.
      const sample = sampleResponse(sim, op);
      const measured = sample ? measureResponse(op, sample, seed) : undefined;
      if (measured) {
        // Judge the page that WOULD be served, not the page we happened to
        // sample. The sampled page may have been sized by the simulator's
        // fixture fallback (nothing was measured yet — that is why we are here);
        // feeding the freshly measured per-item cost back through AIR's solver
        // re-derives the page the budget actually admits. Same solver the MCP
        // runtime serves from, so the certified page and the served page are one
        // page by construction.
        const measuredOp: Operation = { ...op, disclosureCost: measured };
        const page = safePageSize(measuredOp, DEFAULT_RESPONSE_BUDGET_TOKENS);
        const fits = responseFitsBudget(measuredOp, DEFAULT_RESPONSE_BUDGET_TOKENS);
        cells.push({
          operationId: op.id,
          dimension: "disclosure",
          variant: "response-page",
          expected: WITHIN_BUDGET,
          actual: fits ? WITHIN_BUDGET : OVER_BUDGET,
          ok: fits,
          basis: "simulated-data",
          figure: {
            // An unpaginated operation has no page to solve for — it returns
            // what it returns, so the whole response IS the figure.
            tokens: page.projectedTokens ?? measured.responseTokens,
            budgetTokens: DEFAULT_RESPONSE_BUDGET_TOKENS,
            // Stamped from the compiler's own constant, not copied off the
            // record: the count above was taken with `countTokens`, and the
            // estimator recorded must be the one that did the counting.
            estimator: TOKEN_ESTIMATOR_ID,
            seed,
          },
        });
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
  // Enumerated from the schema rather than restated, so a new dimension cannot
  // be driven above yet silently vanish from the rollup a reader actually reads.
  const dims: CoverageDimension[] = [...CoverageDimension.options];
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
