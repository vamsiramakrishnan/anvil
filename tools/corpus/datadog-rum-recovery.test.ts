import { readFileSync } from "node:fs";
import { snakeCase } from "@anvil/air";
import { compile, parseManifest, singularize } from "@anvil/compiler";
import { describe, expect, it } from "vitest";
import { measureNamingConformance, namingConformanceOracle } from "./naming-conformance.mjs";

const spec = readFileSync(
  new URL("./fixtures/datadog-rum-recovery.openapi.json", import.meta.url),
  "utf8",
);
const manifest = readFileSync(
  new URL("../../docs/backtesting/reproduce/manifests/datadog.anvil.yaml", import.meta.url),
  "utf8",
);
const expected = JSON.parse(
  readFileSync(new URL("./expected/datadog.json", import.meta.url), "utf8"),
).operations;
const operationId = "GetRUMRecoverySessionCount";
const resource = "rum_recovery_session_count";
const deps = { singularize, snakeCase };

describe("Datadog November 6 RUM recovery count naming", () => {
  it("pins the source delta, both auth factors, and the transitive wire schemas", () => {
    const fixture = JSON.parse(spec);
    const sources = JSON.parse(
      readFileSync(
        new URL("./fixtures/datadog-rum-recovery.sources.json", import.meta.url),
        "utf8",
      ),
    );
    expect(fixture["x-anvil-fixture-source"]).toMatchObject({
      revision: "b3efbc77fc7ff765a88e87b5906c47dcf4f3bdba",
      sha256: sources.failing.sha256,
    });
    expect(sources.lastPassing.operations).toBe(1712);
    expect(sources.preIntroduction.operations).toBe(1774);
    expect(sources.failing.operations).toBe(1784);
    expect(sources.added).toHaveLength(78);
    expect(sources.removed).toHaveLength(6);
    expect(sources.introduced).toHaveLength(10);
    expect(sources.introduced).toContainEqual({
      operationId,
      method: "post",
      path: "/api/v2/rum/recover/count",
    });
    const count = fixture.paths["/api/v2/rum/recover/count"].post;
    expect(count.security).toEqual([{ apiKeyAuth: [], appKeyAuth: [] }]);
    expect(fixture.components.securitySchemes.apiKeyAuth).toMatchObject({
      type: "apiKey",
      in: "header",
      name: "DD-API-KEY",
    });
    expect(fixture.components.securitySchemes.appKeyAuth).toMatchObject({
      type: "apiKey",
      in: "header",
      name: "DD-APPLICATION-KEY",
    });
    expect(count.requestBody.content["application/json"].schema.$ref).toBe(
      "#/components/schemas/RumRecoveryCountRequest",
    );
    expect(count.responses["200"].content["application/json"].schema.$ref).toBe(
      "#/components/schemas/RumRecoveryCountResponse",
    );
    const visit = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      if ("$ref" in value && typeof value.$ref === "string") {
        expect(value.$ref.startsWith("#/components/")).toBe(true);
        const target = value.$ref
          .slice(2)
          .split("/")
          .reduce((node, key) => node?.[key.replace(/~1/g, "/").replace(/~0/g, "~")], fixture);
        expect(target, value.$ref).toBeDefined();
      }
      for (const nested of Object.values(value)) visit(nested);
    };
    visit(fixture);
  });

  it("repairs both counters while preserving every other operation field and neighbouring operation", async () => {
    const incomplete = parseManifest(manifest);
    delete incomplete.operations[operationId];
    const before = await compile({
      spec,
      manifest: JSON.stringify(incomplete),
      serviceId: "datadog",
    });
    const after = await compile({ spec, manifest, serviceId: "datadog" });
    expect(after.service).toEqual(before.service);
    expect(before.operations).toHaveLength(5);
    expect(after.operations).toHaveLength(5);
    expect(after.capabilities).toEqual(
      before.capabilities.map((capability) =>
        capability.id === "datadog.rum_recovery"
          ? {
              ...capability,
              resources: [
                ...capability.resources.filter((name) => name !== "recover"),
                resource,
              ].sort(),
            }
          : capability,
      ),
    );
    expect(singularize("recover")).toBe("recover");
    const measured = measureNamingConformance(before, deps);
    expect(measured.zeroOverlapResource).toBe(1);
    expect(measured.overStrippedResources).toBe(1);
    expect(measureNamingConformance(after, deps)).toEqual({
      ...measured,
      zeroOverlapResource: 0,
      overStrippedResources: 0,
    });

    for (const op of after.operations) {
      const original = before.operations.find((candidate) => candidate.id === op.id);
      expect(original).toBeDefined();
      if (!original) throw new Error(`Missing ${op.id}`);
      if (op.sourceRef.operationId !== operationId) {
        expect(op).toEqual(original);
        continue;
      }
      expect(original.effect.resource).toBe("recover");
      expect(original.cli.command).toBe("datadog recover create");
      expect(op.id).toBe("datadog.recover.create");
      expect(op.canonicalName).toBe(original.canonicalName);
      expect(op.mcp).toEqual(original.mcp);
      expect(op.mcp.toolName).toBe(expected[operationId].toolName);
      expect(op.cli.command).toBe(`datadog ${resource} get`);
      expect(op.effect).toEqual({ ...original.effect, resource });
      expect(op.effect.kind).toBe(expected[operationId].effect);
      expect(op.effect.risk).toBe(expected[operationId].risk);
      expect(op.effect.action).toBe("simulate");
      // A routing correction cannot grant read semantics or remove the AND-auth block.
      expect(op.state).toBe("blocked");
      expect(op.reviewNotes.some((note) => note.includes("multiple security schemes"))).toBe(true);
      expect(op.idempotency.mode).toBe("none");
      expect(op.retries.maxAttempts).toBe(1);
      expect(op.confirmation.required).toBe(true);
      expect(op).toEqual({
        ...original,
        cli: { ...original.cli, command: `datadog ${resource} get` },
        effect: { ...original.effect, resource },
        // Enrichment also reports the existing missing carrier; it stays blocked.
        reviewNotes: [
          original.reviewNotes[0],
          "Auth contract blocked: custom_header auth must name its credential carrier.",
          ...original.reviewNotes.slice(1),
        ],
        evidence: {
          claims: [
            ...original.evidence.claims.map((claim) =>
              claim.predicate === "name.quality"
                ? { ...claim, confidence: 0.95, note: "name re-homed by manifest" }
                : claim,
            ),
            {
              subject: original.id,
              predicate: "enriched",
              value: true,
              source: "spec",
              sourceRef: "anvil-manifest",
              method: "manifest",
              confidence: 0.95,
              note: "enriched by supplemental Anvil manifest",
              review: "accepted",
            },
          ],
        },
      });
    }
    expect(after.diagnostics.filter((diagnostic) => diagnostic.level === "error")).toEqual([]);
  });

  it("fails both unchanged ratchets when only the new mapping is removed", async () => {
    const incomplete = parseManifest(manifest);
    delete incomplete.operations[operationId];
    const air = await compile({ spec, manifest: JSON.stringify(incomplete), serviceId: "datadog" });
    const measured = measureNamingConformance(air, deps);
    const oracle = namingConformanceOracle(
      measured,
      { ...measured, zeroOverlapResource: 0, overStrippedResources: 0 },
      "",
    );
    expect(oracle.ok).toBe(false);
    expect(oracle.detail).toBe(
      "zeroOverlapResource grew 0 -> 1; overStrippedResources grew 0 -> 1",
    );
    // The November 1 repair is present throughout this independent reproduction.
    const grant = air.operations.find(
      (op) => op.sourceRef.operationId === "UpdateTemporaryGrantRequest",
    );
    expect(grant?.mcp.toolName).toBe(expected.UpdateTemporaryGrantRequest.toolName);
  });
});
