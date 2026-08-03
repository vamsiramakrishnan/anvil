import {
  DisclosureCost,
  estimateTokens,
  mcpToolDescription,
  toolSurfaceFitsBudget,
} from "@anvil/air";
import { describe, expect, it } from "vitest";
import { compile } from "./compile.js";
import {
  countTokens,
  measureAirDisclosure,
  measureToolSurface,
  TOKEN_ESTIMATOR_ID,
  toolSurfaceJson,
  withResponseMeasurement,
} from "./disclosure-cost.js";

/** A read and an irreversible mutation, so both description shapes are exercised. */
const SPEC = `openapi: 3.0.0
info: { title: things, version: 1.0.0 }
paths:
  /things:
    get:
      operationId: listThings
      summary: List the things
      tags: [things]
      parameters:
        - { name: cursor, in: query, schema: { type: string } }
      responses: { "200": { description: ok } }
  /things/{id}:
    delete:
      operationId: deleteThing
      summary: Delete a thing
      tags: [things]
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
      responses: { "204": { description: gone } }
`;

async function operations() {
  const air = await compile({ spec: SPEC, serviceId: "things" });
  return air.operations;
}

function op(ops: Awaited<ReturnType<typeof operations>>, idFragment: string) {
  const found = ops.find((candidate) => candidate.id.includes(idFragment));
  if (!found) throw new Error(`no operation matching '${idFragment}'`);
  return found;
}

describe("tool surface measurement", () => {
  it("measures the bytes the runtime actually publishes, not a summary of them", async () => {
    const list = op(await operations(), "list");
    const payload = toolSurfaceJson(list);

    // Everything an agent reads in tools/list must be inside the measured
    // string: the routing name, the compiled safety prose, the input schema
    // (including the reserved dry-run control the SDK publishes), the standard
    // annotation hints, and Anvil's _meta posture block.
    expect(payload).toContain(JSON.stringify(list.mcp.toolName));
    expect(payload).toContain(JSON.stringify(mcpToolDescription(list)));
    expect(payload).toContain("anvil_dry_run");
    expect(payload).toContain("readOnlyHint");
    expect(payload).toContain("anvil/risk");
    expect(payload).toContain(JSON.stringify(list.id));
    // Compact JSON: the wire form, not a pretty-printed one that would inflate
    // every figure with indentation an agent never receives.
    expect(payload).not.toContain("\n");
  });

  it("records the estimator and produces a schema-valid cost", async () => {
    const cost = measureToolSurface(op(await operations(), "list"));
    expect(cost.estimator).toBe(TOKEN_ESTIMATOR_ID);
    expect(TOKEN_ESTIMATOR_ID).toBe("o200k_base");
    expect(cost.toolTokens).toBeGreaterThan(0);
    // The figure must survive a round trip through AIR unchanged, or it cannot
    // be persisted next to the operation it describes.
    expect(DisclosureCost.parse(cost)).toEqual(cost);
  });

  it("is deterministic: the same contract always yields the same figure", async () => {
    const list = op(await operations(), "list");
    const first = measureToolSurface(list);
    const second = measureToolSurface(list);
    expect(second).toEqual(first);

    // Same contract compiled twice — a certified number must not depend on
    // which build produced it.
    const recompiled = op(await operations(), "list");
    expect(measureToolSurface(recompiled)).toEqual(first);
  });

  it("responds to what is disclosed: a longer description costs more", async () => {
    const list = op(await operations(), "list");
    const verbose = { ...list, description: `${list.description} ${"detail ".repeat(200)}` };
    expect(measureToolSurface(verbose).toolTokens).toBeGreaterThan(
      measureToolSurface(list).toolTokens + 100,
    );
  });

  it("prices compiled safety posture, not just the human summary", async () => {
    const ops = await operations();
    // The mutation carries the irreversibility/retry/confirmation prose and the
    // synthesized confirm property; the read carries neither. Its surface is
    // therefore genuinely larger — the cost of making risk visible is measured
    // rather than assumed away.
    expect(measureToolSurface(op(ops, "delete")).toolTokens).toBeGreaterThan(
      measureToolSurface(op(ops, "list")).toolTokens,
    );
  });

  it("calibrates charsPerToken from the same measurement it reports", async () => {
    const list = op(await operations(), "list");
    const cost = measureToolSurface(list);
    const payload = toolSurfaceJson(list);
    expect(cost.charsPerToken).toBeGreaterThan(0);
    // The serving unit carries no BPE table and estimates from length using this
    // ratio; the estimate must land on the exact figure it was calibrated from,
    // or the truncation failsafe is measuring a different surface than the
    // certificate does.
    expect(estimateTokens(payload.length, cost.charsPerToken)).toBeCloseTo(cost.toolTokens, -1);
  });

  it("never throws on hostile text in a spec-supplied description", async () => {
    const list = op(await operations(), "list");
    // A control-token sequence in an upstream description is inert data here.
    // Refusing to encode it would let any spec break a build.
    const hostile = { ...list, description: "list <|endoftext|> things <|im_start|>" };
    expect(() => measureToolSurface(hostile)).not.toThrow();
    expect(measureToolSurface(hostile).toolTokens).toBeGreaterThan(0);
  });

  it("countTokens is the shared estimator other packages must measure with", () => {
    expect(countTokens("")).toBe(0);
    expect(countTokens("hello world")).toBe(2);
    expect(countTokens(JSON.stringify({ a: 1, b: "xyz" }))).toBeGreaterThan(0);
  });
});

describe("the response-measurement seam", () => {
  it("leaves response figures unmeasured rather than guessing them", async () => {
    const cost = measureToolSurface(op(await operations(), "list"));
    // Payload size depends on a tenant's data, which no contract knows. Zero
    // here means "not measured" — certification fills these in by driving the
    // simulator under a recorded seed.
    expect(cost.responseTokens).toBe(0);
    expect(cost.responseItemTokens).toBe(0);
    expect(cost.seed).toBeUndefined();
  });

  it("merges a simulator measurement without disturbing the contract facts", async () => {
    const cost = measureToolSurface(op(await operations(), "list"));
    const merged = withResponseMeasurement(cost, {
      responseTokens: 4_200,
      responseItemTokens: 140,
      seed: 7,
    });
    expect(merged).toEqual({
      ...cost,
      responseTokens: 4_200,
      responseItemTokens: 140,
      seed: 7,
    });
    // The fact half is untouched and the seed is recorded, which is what makes
    // the prediction half reproducible instead of merely plausible.
    expect(merged.toolTokens).toBe(cost.toolTokens);
    expect(merged.estimator).toBe(cost.estimator);
    expect(cost.responseTokens).toBe(0); // input not mutated
    expect(DisclosureCost.parse(merged)).toEqual(merged);
  });
});

describe("measuring a whole document", () => {
  it("attaches a cost to every operation without mutating the input", async () => {
    const air = await compile({ spec: SPEC, serviceId: "things" });
    const before = structuredClone(air);
    const measured = measureAirDisclosure(air);

    expect(measured.operations).toHaveLength(air.operations.length);
    for (const operation of measured.operations) {
      expect(operation.disclosureCost?.estimator).toBe(TOKEN_ESTIMATOR_ID);
      expect(operation.disclosureCost?.toolTokens).toBeGreaterThan(0);
      // Ordinary operations sit well inside the per-operation budget; the
      // budget only bites on genuinely oversized surfaces.
      expect(toolSurfaceFitsBudget(operation)).toBe(true);
    }
    expect(air).toEqual(before);
    expect(measureAirDisclosure(air)).toEqual(measured);
  });

  it("drops stale response figures rather than carrying them across a re-measure", async () => {
    const air = await compile({ spec: SPEC, serviceId: "things" });
    const measured = measureAirDisclosure(air);
    const first = measured.operations[0];
    if (!first) throw new Error("expected an operation");
    first.disclosureCost = withResponseMeasurement(
      first.disclosureCost ?? measureToolSurface(first),
      { responseTokens: 9_000, responseItemTokens: 300, seed: 1 },
    );

    // Re-measuring is a statement about the contract as it is now. A response
    // prediction made against a possibly-different contract must not ride along
    // wearing the fresh measurement's credibility.
    const again = measureAirDisclosure(measured);
    expect(again.operations[0]?.disclosureCost?.responseTokens).toBe(0);
    expect(again.operations[0]?.disclosureCost?.seed).toBeUndefined();
  });
});
