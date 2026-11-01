import { readFileSync } from "node:fs";
import { snakeCase } from "@anvil/air";
import { compile, parseManifest, singularize } from "@anvil/compiler";
import { describe, expect, it } from "vitest";
import { measureNamingConformance, namingConformanceOracle } from "./naming-conformance.mjs";

const spec = readFileSync(new URL("./fixtures/datadog-naming.openapi.json", import.meta.url), "utf8");
const manifest = readFileSync(
  new URL("../../docs/backtesting/reproduce/manifests/datadog.anvil.yaml", import.meta.url),
  "utf8",
);
const expected = JSON.parse(
  readFileSync(new URL("./expected/datadog.json", import.meta.url), "utf8"),
).operations.UpdateTemporaryGrantRequest;
const deps = { singularize, snakeCase };

describe("Datadog October 30 temporary grant request naming", () => {
  it("repairs the resource contradiction without changing the mutation or neighbouring operations", async () => {
    const before = await compile({ spec, serviceId: "datadog" });
    const after = await compile({ spec, manifest, serviceId: "datadog" });
    expect(after.service).toEqual(before.service);
    expect(before.operations).toHaveLength(4);
    expect(after.operations).toHaveLength(4);
    const measured = measureNamingConformance(before, deps);
    expect(measured.zeroOverlapResource).toBe(1);
    expect(measureNamingConformance(after, deps)).toEqual({ ...measured, zeroOverlapResource: 0 });

    for (const op of after.operations) {
      const original = before.operations.find((candidate) => candidate.id === op.id);
      expect(original).toBeDefined();
      if (!original) throw new Error(`Missing ${op.id}`);
      if (op.sourceRef.operationId !== "UpdateTemporaryGrantRequest") {
        expect(op).toEqual(original);
        continue;
      }
      expect(original.effect.resource).toBe("decision");
      expect(op.canonicalName).toBe("decide_temporary_grant_request");
      expect(op.cli.command).toBe("datadog temporary_grant_request decide");
      expect(op.mcp.toolName).toBe(expected.toolName);
      expect(op.effect).toEqual({ ...original.effect, resource: "temporary_grant_request" });
      expect(op.effect.kind).toBe(expected.effect);
      expect(op.effect.risk).toBe(expected.risk);
      expect(op.state).toBe("blocked");
      expect(op.idempotency.mode).toBe("none");
      expect(op.retries.maxAttempts).toBe(1);
      expect(op.confirmation.required).toBe(true);
      // Only names and their derived review/evidence/token-cost metadata move.
      // Every other field, including stable ID, wire schemas and auth, is exact.
      expect(op).toEqual({
        ...original,
        canonicalName: op.canonicalName,
        cli: { ...original.cli, command: op.cli.command },
        mcp: { ...original.mcp, toolName: op.mcp.toolName },
        effect: { ...original.effect, resource: "temporary_grant_request" },
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
    delete incomplete.operations.UpdateTemporaryGrantRequest;
    const air = await compile({ spec, manifest: JSON.stringify(incomplete), serviceId: "datadog" });
    const measured = measureNamingConformance(air, deps);
    const oracle = namingConformanceOracle(measured, { ...measured, zeroOverlapResource: 0 }, "");
    expect(oracle.ok).toBe(false);
    expect(oracle.detail).toBe("zeroOverlapResource grew 0 -> 1");
  });
});
