import { describe, expect, it } from "vitest";
import { contractHash, hashCanonical, loadAirDocument } from "./index.js";

const doc = {
  service: { id: "svc", version: "1", source: { kind: "openapi", uri: "./s.yaml" } },
  operations: [
    {
      id: "svc.things.get",
      canonicalName: "get_thing",
      displayName: "Get thing",
      description: "Get a thing.",
      sourceRef: { kind: "openapi", path: "/things/{id}", method: "get" },
      effect: { kind: "read", action: "get", risk: "none" },
      input: { params: [] },
      idempotency: { mode: "natural" },
      retries: { mode: "none" },
      confirmation: { required: false },
      auth: { type: "api_key" },
      cli: { command: "svc things get" },
      mcp: { toolName: "svc_get_thing" },
      skill: { intentExamples: ["get a thing"] },
    },
  ],
};

describe("hashCanonical", () => {
  it("is independent of object key insertion order", () => {
    expect(hashCanonical({ a: 1, b: { c: 2, d: 3 } })).toBe(
      hashCanonical({ b: { d: 3, c: 2 }, a: 1 }),
    );
  });

  it("is sensitive to values and to array order", () => {
    expect(hashCanonical({ a: 1 })).not.toBe(hashCanonical({ a: 2 }));
    expect(hashCanonical([1, 2])).not.toBe(hashCanonical([2, 1]));
  });
});

describe("contractHash", () => {
  it("is stable across parses and spelled-out defaults", () => {
    const air = loadAirDocument(doc);
    // Re-parsing (which re-applies defaults) must not move the hash.
    expect(contractHash(loadAirDocument(air))).toBe(contractHash(air));
  });

  it("changes when the contract changes", () => {
    const a = loadAirDocument(doc);
    const b = loadAirDocument(doc);
    (b.operations[0] as { description: string }).description = "Get a different thing.";
    expect(contractHash(b)).not.toBe(contractHash(a));
  });

  it("ignores diagnostics (commentary is not contract)", () => {
    const a = loadAirDocument(doc);
    const b = loadAirDocument({
      ...doc,
      diagnostics: [{ level: "info", code: "note", message: "linted later" }],
    });
    expect(contractHash(b)).toBe(contractHash(a));
  });
});
