import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compile } from "./compile.js";

const spec = readFileSync(new URL("../fixtures/linear-manifest.graphql", import.meta.url), "utf8");
const manifest = readFileSync(
  new URL("../../../docs/backtesting/reproduce/manifests/linear.anvil.yaml", import.meta.url),
  "utf8",
);

describe("Linear public schema manifest drift (#95)", () => {
  it("resolves every shipped override and preserves the reviewed exposure", async () => {
    const air = await compile({ spec, manifest, sourceUri: "linear.graphql" });
    expect(air.diagnostics.filter((d) => d.level === "error")).toEqual([]);
    expect(
      Object.fromEntries(air.operations.map((op) => [op.sourceRef.operationId, op.state])),
    ).toEqual({
      viewer: "approved",
      issue: "approved",
      customView: "generated",
      issueImportJqlCheck: "blocked",
      issueImportCreateJira: "blocked",
    });
  });

  it("rejects the obsolete key rather than matching a similarly named root field", async () => {
    const air = await compile({
      spec,
      manifest: `${manifest}  customViewDetailsSuggestion:\n    state: blocked\n`,
      sourceUri: "linear.graphql",
    });
    expect(air.diagnostics.filter((d) => d.code === "manifest_operation_unresolved")).toEqual([
      expect.objectContaining({
        level: "error",
        message: expect.stringContaining("operations.customViewDetailsSuggestion"),
      }),
    ]);
    expect(air.operations.find((op) => op.sourceRef.operationId === "customView")?.state).toBe(
      "generated",
    );
  });

  it("still discovers and exactly resolves the old field when present in a source", async () => {
    const oldSpec = `${spec}\nscalar JSONObject\ntype CustomViewSuggestionPayload { name: String! }\nextend type Query { customViewDetailsSuggestion(filter: JSONObject!, modelName: String): CustomViewSuggestionPayload! }\n`;
    const air = await compile({
      spec: oldSpec,
      manifest: `${manifest}  customViewDetailsSuggestion:\n    state: blocked\n`,
      sourceUri: "linear.graphql",
    });
    expect(air.diagnostics.filter((d) => d.level === "error")).toEqual([]);
    expect(
      air.operations.find((op) => op.sourceRef.operationId === "customViewDetailsSuggestion")
        ?.state,
    ).toBe("blocked");
  });
});
