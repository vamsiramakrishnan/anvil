import type { AirDocument, Operation } from "@anvil/air";
import { DEFAULT_RESPONSE_BUDGET_TOKENS, DEFAULT_TOOL_DISCLOSURE_BUDGET_TOKENS } from "@anvil/air";
import {
  approveOperations,
  compile,
  measureToolSurface,
  TOKEN_ESTIMATOR_ID,
} from "@anvil/compiler";
import { beforeEach, describe, expect, it } from "vitest";
import { staticChecks } from "./checks.js";
import { CoverageReport, coverageMatrix } from "./coverage.js";

/**
 * The disclosure dimension makes agent context cost a certified property. These
 * tests exist mostly to defend one distinction: the tool-surface figure is a
 * FACT about the contract and the response figure is a PREDICTION from synthetic
 * data under a seed. Everything below that looks like bookkeeping (a `basis`
 * enum, a seed on one figure and not the other) is really guarding that line —
 * the moment a projection can pass for a certified fact, certification degrades
 * to theatre, and no downstream reader can tell the difference by inspection.
 *
 * The second thing pinned here is that an unmeasured operation is INAPPLICABLE,
 * not a pass. A coverage figure that counts what it never measured is worse than
 * no coverage figure, because it is confidently wrong.
 */

const SPEC = `openapi: "3.0.3"
info: { title: Refunds, version: "1.0.0" }
paths:
  /refunds:
    get:
      operationId: listRefunds
      tags: [refunds]
      responses: { "200": { description: ok } }
    post:
      operationId: createRefund
      tags: [refunds]
      responses: { "201": { description: created } }
`;

const LIST = "refunds.refunds.list";
const CREATE = "refunds.refunds.create";

let air: AirDocument;

beforeEach(async () => {
  const compiled = await compile({ spec: SPEC, serviceId: "refunds" });
  air = approveOperations(
    compiled,
    compiled.operations.map((o) => o.id),
  );
  for (const op of air.operations) {
    op.effect.resource = "refund";
    if (op.sourceRef.operationId === "createRefund") {
      op.auth = { ...op.auth, type: "oauth2_client_credentials", scopes: ["refunds:write"] };
      op.idempotency = { ...op.idempotency, mode: "required" };
      op.confirmation = { ...op.confirmation, required: true };
    }
    if (op.sourceRef.operationId === "listRefunds") {
      op.effect.action = "list";
    }
  }
});

/** Attach the compiler's real tool-surface measurement, as a build would. */
function measure(doc: AirDocument): void {
  for (const op of doc.operations) op.disclosureCost = measureToolSurface(op);
}

const disclosureCells = (doc: AirDocument, seed = 1) =>
  coverageMatrix(doc, { seed }).cells.filter((c) => c.dimension === "disclosure");

const find = (doc: AirDocument, operationId: string, variant: string, seed = 1) =>
  disclosureCells(doc, seed).find((c) => c.operationId === operationId && c.variant === variant);

describe("disclosure as a coverage dimension", () => {
  it("emits no cell for an operation that was never measured", () => {
    // Nothing here sets `disclosureCost`. `toolSurfaceFitsBudget` returns true
    // for an unmeasured operation by design, so the trap this closes is a real
    // one: it would be one `??` away from certifying a surface nobody measured.
    const report = coverageMatrix(air, { seed: 1 });
    expect(report.cells.some((c) => c.dimension === "disclosure")).toBe(false);
    const rollup = report.dimensions.find((d) => d.dimension === "disclosure");
    expect(rollup).toEqual({ dimension: "disclosure", operations: 0, cells: 0, passed: 0 });
  });

  it("keeps the dimension in the rollup and the report schema-valid", () => {
    measure(air);
    const report = coverageMatrix(air, { seed: 1 });
    expect(CoverageReport.parse(report)).toEqual(report);
    expect(report.dimensions.map((d) => d.dimension)).toContain("disclosure");
    const rollup = report.dimensions.find((d) => d.dimension === "disclosure");
    expect(rollup?.operations).toBe(2);
    expect(rollup?.passed).toBe(rollup?.cells);
  });

  it("certifies the tool surface as a contract fact — exact, seedless, budgeted", () => {
    measure(air);
    const cell = find(air, CREATE, "tool-surface");
    expect(cell?.basis).toBe("contract");
    expect(cell?.ok).toBe(true);
    expect(cell?.actual).toBe("within-budget");
    expect(cell?.figure?.budgetTokens).toBe(DEFAULT_TOOL_DISCLOSURE_BUDGET_TOKENS);
    expect(cell?.figure?.tokens).toBe(
      air.operations.find((o) => o.id === CREATE)?.disclosureCost?.toolTokens as number,
    );
    // A fact does not need a seed to be re-derived — and must not carry one,
    // because a seed is precisely what marks a figure as a projection.
    expect(cell?.figure?.seed).toBeUndefined();
  });

  it("measures a response page against the simulator under the report's seed", () => {
    measure(air);
    const cell = find(air, LIST, "response-page");
    expect(cell?.basis).toBe("simulated-data");
    expect(cell?.figure?.budgetTokens).toBe(DEFAULT_RESPONSE_BUDGET_TOKENS);
    expect(cell?.figure?.tokens).toBeGreaterThan(0);
    // The two things that make a prediction re-derivable rather than merely
    // plausible: which tokenizer produced it, and which data set it saw.
    expect(cell?.figure?.estimator).toBe(TOKEN_ESTIMATOR_ID);
    expect(cell?.figure?.seed).toBe(1);
    expect(
      coverageMatrix(air, { seed: 4 }).cells.find(
        (c) => c.dimension === "disclosure" && c.variant === "response-page",
      )?.figure?.seed,
    ).toBe(4);
  });

  it("never lets a projection read as a fact: seed presence tracks basis exactly", () => {
    measure(air);
    for (const cell of coverageMatrix(air, { seed: 1 }).cells) {
      expect(cell.figure?.seed !== undefined).toBe(cell.basis === "simulated-data");
      // An estimator-less token count is a number without a unit.
      if (cell.figure) expect(cell.figure.estimator.length).toBeGreaterThan(0);
    }
  });

  it("fails the cell when the tool surface exceeds its budget", () => {
    measure(air);
    const op = air.operations.find((o) => o.id === CREATE) as Operation;
    op.disclosureCost = {
      ...(op.disclosureCost as NonNullable<Operation["disclosureCost"]>),
      toolTokens: DEFAULT_TOOL_DISCLOSURE_BUDGET_TOKENS + 1,
    };
    const cell = find(air, CREATE, "tool-surface");
    expect(cell?.ok).toBe(false);
    expect(cell?.actual).toBe("over-budget");
    expect(coverageMatrix(air, { seed: 1 }).summary.failed).toBeGreaterThan(0);
  });

  it("re-drives the response figure, so a planted cost cannot forge a verdict", () => {
    measure(air);
    const list = air.operations.find((o) => o.id === LIST) as Operation;
    // A stale or hand-edited `responseTokens` on the contract is the obvious way
    // to fake a disclosure claim: write a number, inherit a green cell. It does
    // not work, because the cell is measured from bytes the simulator served on
    // this run — the contract's own figure is an input to nothing here.
    list.disclosureCost = {
      ...(list.disclosureCost as NonNullable<Operation["disclosureCost"]>),
      responseTokens: DEFAULT_RESPONSE_BUDGET_TOKENS * 2,
      responseItemTokens: DEFAULT_RESPONSE_BUDGET_TOKENS,
    };
    const cell = find(air, LIST, "response-page");
    expect(cell?.figure?.tokens).toBeLessThan(DEFAULT_RESPONSE_BUDGET_TOKENS);
    expect(cell?.ok).toBe(true);
  });

  it("counts only what it measured: a half-measured surface reports as half", () => {
    // Measure one operation, leave the other alone. The dimension's denominator
    // must shrink to match — an unmeasured operation has to be visibly missing,
    // because the whole value of a coverage fraction is that the reader can tell
    // 1-of-2 from 2-of-2 without going and checking.
    const list = air.operations.find((o) => o.id === LIST) as Operation;
    list.disclosureCost = measureToolSurface(list);
    const rollup = coverageMatrix(air, { seed: 1 }).dimensions.find(
      (d) => d.dimension === "disclosure",
    );
    expect(rollup?.operations).toBe(1);
    expect(disclosureCells(air).every((c) => c.operationId === LIST)).toBe(true);
  });

  it("is a pure function of (seed, contract)", () => {
    measure(air);
    expect(coverageMatrix(air, { seed: 7 })).toEqual(coverageMatrix(air, { seed: 7 }));
    // And the disclosure cells do not depend on the dimensions driven before
    // them: re-seeding before the sample is what makes that true.
    expect(disclosureCells(air, 7)).toEqual(disclosureCells(air, 7));
  });
});

describe("the static tool-surface budget check", () => {
  const budgetCheck = (doc: AirDocument) =>
    staticChecks(doc).find((c) => c.id === "static/tool_surface_within_disclosure_budget");

  it("passes with an explicit note when nothing was measured", () => {
    const c = budgetCheck(air);
    expect(c?.ok).toBe(true);
    // Vacuous truth is the right answer for a check, but it must announce
    // itself — a silent green tick here would read as "measured and fine".
    expect(c?.detail).toMatch(/no approved operation carries a disclosure measurement/);
  });

  it("passes and reports the population when every measured surface fits", () => {
    measure(air);
    const c = budgetCheck(air);
    expect(c?.ok).toBe(true);
    expect(c?.detail).toMatch(/2 operation\(s\) within/);
  });

  it("fails and names the offender when a surface is over budget", () => {
    measure(air);
    const op = air.operations.find((o) => o.id === CREATE) as Operation;
    op.disclosureCost = {
      ...(op.disclosureCost as NonNullable<Operation["disclosureCost"]>),
      toolTokens: DEFAULT_TOOL_DISCLOSURE_BUDGET_TOKENS + 42,
    };
    const c = budgetCheck(air);
    expect(c?.ok).toBe(false);
    expect(c?.detail).toContain(CREATE);
  });

  it("ignores unapproved operations, which are never on the certified surface", () => {
    measure(air);
    const op = air.operations.find((o) => o.id === CREATE) as Operation;
    op.state = "blocked";
    op.disclosureCost = {
      ...(op.disclosureCost as NonNullable<Operation["disclosureCost"]>),
      toolTokens: DEFAULT_TOOL_DISCLOSURE_BUDGET_TOKENS * 10,
    };
    expect(budgetCheck(air)?.ok).toBe(true);
  });
});
