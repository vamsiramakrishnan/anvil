import { readFileSync } from "node:fs";
import { snakeCase } from "@anvil/air";
import { compile, parseManifest, singularize } from "@anvil/compiler";
import { describe, expect, it } from "vitest";
import { measureNamingConformance, namingConformanceOracle } from "./naming-conformance.mjs";

const spec = readFileSync(new URL("./fixtures/okta-naming.openapi.yaml", import.meta.url), "utf8");
const manifest = readFileSync(
  new URL("../../docs/backtesting/reproduce/manifests/okta.anvil.yaml", import.meta.url),
  "utf8",
);
const expected = JSON.parse(
  readFileSync(new URL("./expected/okta.json", import.meta.url), "utf8"),
).operations;
const deps = { singularize, snakeCase };
const cases = [
  ["getApplicationsCsvExport", "app", "application", "export_csv"],
  ["listApplicationsBySearch", "app", "application", "search"],
  ["previewPolicyBranchPromotion", "promote", "policy_branch_promotion", "preview"],
  ["restoreFromHistory", "rollback", "policy_branch", "restore"],
] as const;

describe("Okta October 27 naming drift", () => {
  it("reproduces all four new zero-overlap cases and repairs them with the shipped manifest", async () => {
    const raw = await compile({ spec, serviceId: "okta" });
    const repaired = await compile({ spec, manifest, serviceId: "okta" });
    expect(raw.operations).toHaveLength(6);
    expect(repaired.operations).toHaveLength(6);
    expect(measureNamingConformance(raw, deps).zeroOverlapResource).toBe(4);
    expect(measureNamingConformance(repaired, deps)).toEqual({
      operations: 6,
      zeroOverlapResource: 0,
      stutters: { spec_authored: 0, service_prefix_join: 0, disambiguation_suffix: 0 },
      overStrippedResources: 0,
    });

    for (const [operationId, oldResource, resource, verb] of cases) {
      const before = raw.operations.find((op) => op.sourceRef.operationId === operationId);
      const after = repaired.operations.find((op) => op.sourceRef.operationId === operationId);
      expect(before).toBeDefined();
      expect(after).toBeDefined();
      if (!before || !after) throw new Error(`Missing ${operationId}`);
      expect(before.effect.resource).toBe(oldResource);
      expect(after.effect).toEqual({ ...before.effect, resource });
      expect(after.canonicalName).toBe(`${verb}_${resource}`);
      expect(after.cli.command).toBe(`okta ${resource} ${verb}`);
      expect(after.mcp.toolName).toBe(expected[operationId].toolName);
      expect(after.effect.kind).toBe(expected[operationId].effect);
      expect(after.effect.risk).toBe(expected[operationId].risk);
      // A reviewed name does not change identity, wire inputs or authority.
      expect(after.id).toBe(before.id);
      expect(after.sourceRef).toEqual(before.sourceRef);
      expect(after.input).toEqual({
        ...before.input,
        schema: { ...before.input.schema, title: after.canonicalName },
      });
      expect(after.output).toEqual(before.output);
      expect(after.auth).toEqual(before.auth);
      expect(after.state).toBe(before.state);
      expect(after.state).not.toBe("approved");
      expect(after.idempotency).toEqual(before.idempotency);
      expect(after.confirmation).toEqual(before.confirmation);
      expect(after.retries).toEqual(before.retries);
    }
    const restore = repaired.operations.find(
      (op) => op.sourceRef.operationId === "restoreFromHistory",
    );
    expect(restore?.effect.kind).toBe("mutation");
    expect(restore?.idempotency.mode).toBe("none");
    for (const operationId of ["createFederatedClaim", "replaceFederatedClaim"]) {
      const claim = repaired.operations.find((op) => op.sourceRef.operationId === operationId);
      expect(claim?.state).toBe("blocked");
      expect(claim?.effect.kind).toBe("mutation");
    }
    expect(repaired.diagnostics.filter((diagnostic) => diagnostic.level === "error")).toEqual([]);
  });

  it.each(cases)("keeps the oracle red if the %s repair is removed", async (operationId) => {
    const incomplete = parseManifest(manifest);
    delete incomplete.operations[operationId];
    const air = await compile({ spec, manifest: JSON.stringify(incomplete), serviceId: "okta" });
    const measured = measureNamingConformance(air, deps);
    expect(measured.zeroOverlapResource).toBe(1);
    const oracle = namingConformanceOracle(
      measured,
      { ...measured, zeroOverlapResource: 0 },
      "do not raise the baseline",
    );
    expect(oracle.ok).toBe(false);
    expect(oracle.detail).toBe("zeroOverlapResource grew 0 -> 1");
  });
});
