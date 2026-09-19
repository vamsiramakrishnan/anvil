import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compile } from "./compile.js";
import {
  formatManifestIssue,
  ManifestParseError,
  parseManifest,
  parseManifestDetailed,
} from "./manifest.js";
import { manifestJsonSchema } from "./manifest-schema.js";

/**
 * The manifest is the one file a reviewer hand-writes to change what an
 * operation means. Three silent failures used to live here: an unknown key
 * (a typo'd `idempotancy`) was stripped and the override never applied; an
 * operation key that matched nothing was ignored without a word; and a
 * schema violation surfaced as a raw multi-kilobyte error with no position.
 */

const spec = readFileSync(
  fileURLToPath(new URL("../../../examples/payments/openapi.yaml", import.meta.url)),
  "utf8",
);

describe("strict manifest keys", () => {
  it("rejects an unknown operation key with its line, column, and the nearest real key", () => {
    const text = [
      "operations:",
      "  createRefund:",
      "    side_effect: mutation",
      "    idempotancy:",
      "      strategy: required_request_key",
      "",
    ].join("\n");
    const result = parseManifestDetailed(text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toHaveLength(1);
    const issue = result.issues[0];
    expect(issue?.path).toBe("operations.createRefund.idempotancy");
    expect(issue?.message).toBe("unknown key");
    expect(issue?.suggestion).toBe("idempotency");
    expect(issue?.line).toBe(4);
    expect(issue?.col).toBe(5);
    expect(formatManifestIssue(issue as never, "anvil.yaml")).toBe(
      "anvil.yaml:4:5 operations.createRefund.idempotancy: unknown key (did you mean 'idempotency'?)",
    );
  });

  it("rejects an unknown top-level key and a nested one, each located at its key", () => {
    const top = parseManifestDetailed("operatons: {}\n");
    expect(top.ok).toBe(false);
    if (!top.ok) {
      expect(top.issues[0]?.path).toBe("operatons");
      expect(top.issues[0]?.suggestion).toBe("operations");
      expect(top.issues[0]).toMatchObject({ line: 1, col: 1 });
    }
    const nested = parseManifestDetailed("service:\n  nmae: payments\n");
    expect(nested.ok).toBe(false);
    if (!nested.ok) {
      expect(nested.issues[0]?.path).toBe("service.nmae");
      expect(nested.issues[0]?.suggestion).toBe("name");
      expect(nested.issues[0]).toMatchObject({ line: 2, col: 3 });
    }
  });

  it("locates a schema violation and reports YAML syntax errors with a position", () => {
    const bad = parseManifestDetailed("operations:\n  createRefund:\n    risk: enormous\n");
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.issues[0]?.path).toBe("operations.createRefund.risk");
      expect(bad.issues[0]?.line).toBe(3);
      expect(bad.issues[0]?.message).toMatch(/Invalid|expected|option/i);
    }
    const syntax = parseManifestDetailed("operations:\n  a: [\n");
    expect(syntax.ok).toBe(false);
    if (!syntax.ok) expect(syntax.issues[0]?.line).toBeGreaterThan(0);
  });

  it("parseManifest throws a ManifestParseError that carries the located issues", () => {
    expect(() => parseManifest("operations:\n  x:\n    reversable: true\n")).toThrow(
      ManifestParseError,
    );
    try {
      parseManifest("operations:\n  x:\n    reversable: true\n");
    } catch (error) {
      const parseError = error as ManifestParseError;
      expect(parseError.issues[0]?.suggestion).toBe("reversible");
      expect(parseError.message).toContain("manifest:3:5 operations.x.reversable: unknown key");
    }
  });

  it("still accepts every key the payments example uses", () => {
    const example = readFileSync(
      fileURLToPath(new URL("../../../examples/payments/anvil.yaml", import.meta.url)),
      "utf8",
    );
    expect(parseManifestDetailed(example).ok).toBe(true);
  });
});

describe("unresolved manifest entries", () => {
  it("reports an operation key that matches nothing, with the nearest real id", async () => {
    const air = await compile({
      spec,
      manifest:
        "operations:\n  createRefundz:\n    risk: financial\n  getPayment:\n    risk: none\n",
      serviceId: "payments",
    });
    const unresolved = air.diagnostics.filter((d) => d.code === "manifest_operation_unresolved");
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]?.level).toBe("error");
    expect(unresolved[0]?.message).toContain("operations.createRefundz");
    expect(unresolved[0]?.message).toContain("did you mean 'createRefund'");
    expect(unresolved[0]?.message).toContain("were not applied");
  });

  it("is silent when every key resolves by id, canonical name, or source operationId", async () => {
    const air = await compile({
      spec,
      manifest:
        "operations:\n  createRefund:\n    risk: financial\n  get_payment:\n    risk: none\n",
      serviceId: "payments",
    });
    expect(air.diagnostics.filter((d) => d.code === "manifest_operation_unresolved")).toEqual([]);
  });
});

describe("manifest JSON Schema", () => {
  it("is derived from the zod schema, strict, and names the keys a reviewer writes", () => {
    const schema = manifestJsonSchema() as {
      $id: string;
      $schema?: string;
      type: string;
      additionalProperties?: boolean;
      properties: Record<
        string,
        { additionalProperties?: unknown; properties?: Record<string, unknown> }
      >;
    };
    expect(schema.$id).toContain("anvil-manifest.schema.json");
    expect(schema.$schema).toContain("2020-12");
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    for (const key of [
      "service",
      "auth",
      "operations",
      "workflows",
      "capabilities",
      "query_templates",
    ]) {
      expect(schema.properties[key], key).toBeDefined();
    }
    const operation = schema.properties.operations?.additionalProperties as {
      properties?: Record<string, unknown>;
      additionalProperties?: boolean;
    };
    expect(operation.additionalProperties).toBe(false);
    for (const key of [
      "side_effect",
      "risk",
      "idempotency",
      "confirmation",
      "name",
      "pagination",
    ]) {
      expect(operation.properties?.[key], key).toBeDefined();
    }
  });
});
