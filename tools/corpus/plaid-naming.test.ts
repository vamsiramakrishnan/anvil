import { readFileSync } from "node:fs";
import { snakeCase } from "@anvil/air";
import { compile, parseManifest, singularize } from "@anvil/compiler";
import { describe, expect, it } from "vitest";
import { measureNamingConformance, namingConformanceOracle } from "./naming-conformance.mjs";

const spec = readFileSync(new URL("./fixtures/plaid-naming.openapi.json", import.meta.url), "utf8");
const manifest = readFileSync(
  new URL("../../docs/backtesting/reproduce/manifests/plaid.anvil.yaml", import.meta.url),
  "utf8",
);
const expected = JSON.parse(
  readFileSync(new URL("./expected/plaid.json", import.meta.url), "utf8"),
).operations.userTransferLimitsGet;
const deps = { singularize, snakeCase };

describe("Plaid October 30 user transfer limit naming", () => {
  it("names the user-scoped limit without treating its POST as a pure read", async () => {
    const before = await compile({ spec, serviceId: "plaid" });
    const after = await compile({ spec, manifest, serviceId: "plaid" });
    expect(before.operations).toHaveLength(2);
    expect(after.operations).toHaveLength(2);
    // This is a valid singular and a candidate-oracle false positive, not a
    // suffix-stripping defect. The unrelated institution candidate remains.
    expect(singularize("limits")).toBe("limit");
    const measured = measureNamingConformance(before, deps);
    expect(measured.overStrippedResources).toBe(2);
    expect(measureNamingConformance(after, deps)).toEqual({ ...measured, overStrippedResources: 1 });

    for (const op of after.operations) {
      const original = before.operations.find((candidate) => candidate.id === op.id);
      expect(original).toBeDefined();
      if (!original) throw new Error(`Missing ${op.id}`);
      if (op.sourceRef.operationId !== "userTransferLimitsGet") {
        expect(op).toEqual(original);
        continue;
      }
      expect(original.effect.resource).toBe("limit");
      expect(op.canonicalName).toBe("get_user_transfer_limit");
      expect(op.cli.command).toBe("plaid user_transfer_limit get");
      expect(op.mcp.toolName).toBe(expected.toolName);
      expect(op.effect).toEqual({ ...original.effect, resource: "user_transfer_limit" });
      expect(op.effect.kind).toBe(expected.effect);
      expect(op.effect.risk).toBe(expected.risk);
      // The vendor says a missing limit is computed. Naming must not grant
      // read semantics, approval, idempotency, reversibility or retries.
      expect(op.effect.reversible).toBe(false);
      expect(op.state).toBe("blocked");
      expect(op.idempotency.mode).toBe("none");
      expect(op.retries.maxAttempts).toBe(1);
      expect(op.confirmation.required).toBe(true);
      expect(op).toEqual({
        ...original,
        canonicalName: op.canonicalName,
        cli: { ...original.cli, command: op.cli.command },
        mcp: { ...original.mcp, toolName: op.mcp.toolName },
        effect: { ...original.effect, resource: "user_transfer_limit" },
        input: { ...original.input, schema: { ...original.input.schema, title: op.canonicalName } },
        disclosureCost: op.disclosureCost,
        reviewNotes: op.reviewNotes,
        evidence: op.evidence,
      });
    }
    expect(after.diagnostics.filter((diagnostic) => diagnostic.level === "error")).toEqual([]);
  });

  it("fails the unchanged ratchet if the reviewed mapping is removed", async () => {
    const incomplete = parseManifest(manifest);
    delete incomplete.operations.userTransferLimitsGet;
    const air = await compile({ spec, manifest: JSON.stringify(incomplete), serviceId: "plaid" });
    const measured = measureNamingConformance(air, deps);
    const oracle = namingConformanceOracle(measured, { ...measured, overStrippedResources: 1 }, "");
    expect(oracle.ok).toBe(false);
    expect(oracle.detail).toBe("overStrippedResources grew 1 -> 2");
  });
});
