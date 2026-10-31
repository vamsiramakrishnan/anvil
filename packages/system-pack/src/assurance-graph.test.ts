import { hashCanonical } from "@anvil/air";
import { describe, expect, it, vi } from "vitest";
import { attestRelease, executeAssurance, planAssurance } from "./assurance-graph.js";

const digest = hashCanonical("fixture");
const nodes = [
  { id: "source", digest, dependencies: [], complete: true },
  { id: "projection", digest, dependencies: ["source"], complete: true },
  { id: "other", digest, dependencies: [], complete: true },
];
const checks = [
  { id: "conformance", nodes: ["projection"], implementation: "v1" },
  { id: "other", nodes: ["other"], implementation: "v1" },
];
const context = { compiler: "1", runtime: "1", policy: "1", configuration: "dev" };
const run = async () => ({ passed: true, evidenceDigest: digest });

describe("incremental assurance", () => {
  it("reuses unchanged evidence and invalidates only dependent checks", async () => {
    const first = planAssurance(nodes, checks, context);
    const evidence = await executeAssurance(first, run);
    const changed = structuredClone(nodes);
    changed[0]!.digest = hashCanonical("changed");
    const next = planAssurance(changed, checks, context, evidence);
    expect(next.checks.map((c) => c.action)).toEqual(["run", "reuse"]);
    const runner = vi.fn(run);
    const updated = await executeAssurance(next, runner);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(attestRelease(hashCanonical("bundle"), next, updated).digest).toHaveLength(64);
    expect(() => attestRelease(digest, next, evidence)).toThrow(/stale/);
  });
  it("invalidates every check on execution-context or unknown-dependency changes", async () => {
    const first = planAssurance(nodes, checks, context);
    const evidence = await executeAssurance(first, run);
    const changed = structuredClone(nodes);
    changed[0]!.complete = false;
    const next = planAssurance(changed, checks, context, evidence);
    expect(next.checks.every((c) => c.action === "run")).toBe(true);
    expect(() => attestRelease(digest, next, evidence)).toThrow();
    const fresh = await executeAssurance(next, run);
    const repeat = planAssurance(changed, checks, context, fresh);
    expect(() => attestRelease(digest, repeat, fresh)).toThrow();
    expect(
      planAssurance(nodes, checks, { ...context, policy: "2" }, evidence).checks.every(
        (c) => c.action === "run",
      ),
    ).toBe(true);
  });
  it("rejects cycles, missing dependencies and duplicate receipts", async () => {
    expect(() =>
      planAssurance([{ ...nodes[0]!, dependencies: ["source"] }], checks, context),
    ).toThrow();
    expect(() => planAssurance(nodes, [{ ...checks[0]!, nodes: ["missing"] }], context)).toThrow();
    const plan = planAssurance(nodes, checks, context),
      evidence = await executeAssurance(plan, run);
    expect(() => attestRelease(digest, plan, [...evidence, evidence[0]!])).toThrow();
  });
});
