import { readFileSync } from "node:fs";
import { compile, parseManifest } from "@anvil/compiler";
import { describe, expect, it } from "vitest";

const spec = readFileSync(new URL("./fixtures/okta-current.openapi.json", import.meta.url), "utf8");
const historicalManifest = readFileSync(
  new URL("./fixtures/okta-naming.manifest.yaml", import.meta.url),
  "utf8",
);
const manifest = readFileSync(
  new URL("../../docs/backtesting/reproduce/manifests/okta.anvil.yaml", import.meta.url),
  "utf8",
);
const retired = JSON.parse(spec)["x-anvil-fixture-source"].retiredNamingOperations as string[];

describe("Okta 2026.44.0 retires reviewed 2026.42.1 endpoints", () => {
  it("rejects the stale manifest while preserving all current operations and safety controls", async () => {
    const before = await compile({ spec, manifest: historicalManifest, serviceId: "okta" });
    const after = await compile({ spec, manifest, serviceId: "okta" });
    const errors = before.diagnostics.filter((diagnostic) => diagnostic.level === "error");
    expect(errors).toHaveLength(4);
    for (const operationId of retired) {
      expect(errors).toContainEqual(
        expect.objectContaining({
          code: "manifest_operation_unresolved",
          message: expect.stringContaining(`operations.${operationId} matches no operation`),
        }),
      );
    }
    expect(after.operations).toHaveLength(2);
    expect(after.operations).toEqual(before.operations);
    expect(after.service).toEqual(before.service);
    expect(after.capabilities).toEqual(before.capabilities);
    expect(after.diagnostics).toEqual(
      before.diagnostics.filter(
        (diagnostic) => diagnostic.code !== "manifest_operation_unresolved",
      ),
    );
    expect(after.diagnostics.filter((diagnostic) => diagnostic.level === "error")).toEqual([]);
    for (const operation of after.operations) {
      expect(operation.state).toBe("blocked");
      expect(operation.effect.kind).toBe("mutation");
    }
  });

  it("keeps only the live safety overrides and preserves every retired naming expectation", () => {
    const fixture = JSON.parse(spec);
    expect(fixture.info.version).toBe("2026.44.0");
    expect(fixture["x-anvil-fixture-source"]).toMatchObject({
      revision: "68eed9d2039a59b5c7cf045ba1993a6cac7e0ec5",
      sha256: "0e1ccf7a1c12f4e77e2e5cebf2d625f8869f7603746360a54e0360673644049f",
      sourceOperations: 726,
      removedSincePrevious: 56,
    });
    const live = parseManifest(manifest);
    const historical = parseManifest(historicalManifest);
    expect(live.operations).toEqual({
      createFederatedClaim: { state: "blocked" },
      replaceFederatedClaim: { state: "blocked" },
    });
    const liveExpected = JSON.parse(
      readFileSync(new URL("./expected/okta.json", import.meta.url), "utf8"),
    ).operations;
    const historicalExpected = JSON.parse(
      readFileSync(new URL("./fixtures/okta-naming.expected.json", import.meta.url), "utf8"),
    ).operations;
    expect(retired).toHaveLength(4);
    for (const operationId of retired) {
      expect(live.operations[operationId]).toBeUndefined();
      expect(liveExpected[operationId]).toBeUndefined();
      expect(historical.operations[operationId]?.name).toBeDefined();
      expect(historicalExpected[operationId]).toBeDefined();
    }
    expect(Object.keys(liveExpected).sort()).toEqual([
      "createUser",
      "deleteUser",
      "getUser",
      "listUsers",
    ]);
  });
});
