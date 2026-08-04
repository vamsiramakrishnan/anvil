import { describe, expect, it } from "vitest";
import type { z } from "zod";
import type { IdempotencyMode } from "./enums.js";
import type {
  IdempotencyCarrierBinding,
  IdempotencyCarrierResolution,
} from "./idempotency-carrier.js";
import {
  idempotencyAuthCarrierIssue,
  idempotencyModeUsesCarrier,
  isModeledIdempotencyCarrierInput,
  resolveIdempotencyCarrier,
} from "./idempotency-carrier.js";
import { type Operation, Operation as OperationSchema } from "./schema.js";

/** Narrows a resolution to its rejected branch, asserting `ok: false` with a normal vitest diff. */
function assertRejected(
  res: IdempotencyCarrierResolution,
): asserts res is { ok: false; issue: string } {
  expect(res.ok).toBe(false);
}

/** Narrows a resolution to its accepted branch, asserting `ok: true` with a normal vitest diff. */
function assertAccepted(
  res: IdempotencyCarrierResolution,
): asserts res is Extract<IdempotencyCarrierResolution, { ok: true }> {
  expect(res.ok).toBe(true);
}

/**
 * A minimal operation, built through the schema.
 *
 * This previously returned an object literal *declared* as `Operation` while
 * omitting `reversible`, `mechanism`, `keyDerivation`, `scopes` and more — the
 * declared type was a lie, and 115 of this package's typecheck errors came from
 * it alone. Parsing means the fixture carries the same defaults production does,
 * so a test cannot assert behaviour on a shape AIR never produces.
 *
 * Overrides are typed as the schema's *input*, not its output: `{ mode:
 * "natural" }` is a complete idempotency input because `mechanism` and
 * `keyDerivation` have defaults. `Partial<Operation>` would demand the
 * post-default shape and reject every call site here.
 */
type OperationInput = z.input<typeof OperationSchema>;

function makeOp(overrides: Partial<OperationInput> = {}): Operation {
  return OperationSchema.parse({
    id: "test.op",
    canonicalName: "test_op",
    displayName: "Test Operation",
    sourceRef: { kind: "openapi", path: "/test", method: "post" },
    effect: { kind: "mutation", action: "create", risk: "none" },
    input: { params: [] },
    idempotency: { mode: "natural" },
    retries: { mode: "none" },
    confirmation: { required: false },
    auth: { type: "none", principal: "anonymous", secretSource: "none" },
    cli: { command: "test op" },
    mcp: { toolName: "test_op" },
    skill: { intentExamples: [] },
    ...overrides,
  });
}

describe("idempotencyModeUsesCarrier", () => {
  it.each<{ mode: IdempotencyMode; expected: boolean }>([
    { mode: "required", expected: true },
    { mode: "key_supported", expected: true },
    { mode: "natural", expected: false },
    { mode: "client_id", expected: false },
    { mode: "none", expected: false },
  ])("returns $expected for mode $mode", ({ mode, expected }) => {
    expect(idempotencyModeUsesCarrier(mode)).toBe(expected);
  });
});

describe("resolveIdempotencyCarrier", () => {
  describe("mode checks", () => {
    it("returns ok: true without binding for natural mode", () => {
      const op = makeOp({ idempotency: { mode: "natural" } });
      const res = resolveIdempotencyCarrier(op);
      expect(res).toEqual({ ok: true });
    });

    it("returns ok: true without binding for client_id mode", () => {
      const op = makeOp({ idempotency: { mode: "client_id" } });
      const res = resolveIdempotencyCarrier(op);
      expect(res).toEqual({ ok: true });
    });

    it("returns ok: true without binding for none mode", () => {
      const op = makeOp({ idempotency: { mode: "none" } });
      const res = resolveIdempotencyCarrier(op);
      expect(res).toEqual({ ok: true });
    });

    it("rejects required mode without explicit carrier mechanism", () => {
      const op = makeOp({
        idempotency: { mode: "required", mechanism: "none" },
      });
      const res = resolveIdempotencyCarrier(op);
      expect(res).toEqual({
        ok: false,
        issue: "idempotency mode 'required' requires an explicit carrier mechanism",
      });
    });

    it("rejects key_supported mode without explicit carrier mechanism", () => {
      const op = makeOp({
        idempotency: { mode: "key_supported", mechanism: "none" },
      });
      const res = resolveIdempotencyCarrier(op);
      expect(res).toEqual({
        ok: false,
        issue: "idempotency mode 'key_supported' requires an explicit carrier mechanism",
      });
    });
  });

  describe("key validation", () => {
    it("rejects empty key", () => {
      const op = makeOp({
        idempotency: { mode: "required", mechanism: "header", key: "" },
      });
      const res = resolveIdempotencyCarrier(op);
      expect(res).toEqual({
        ok: false,
        issue: "idempotency carrier 'header' requires an exact non-empty key name",
      });
    });

    it("rejects whitespace-only key", () => {
      const op = makeOp({
        idempotency: { mode: "required", mechanism: "header", key: "   " },
      });
      const res = resolveIdempotencyCarrier(op);
      expect(res).toEqual({
        ok: false,
        issue: "idempotency carrier 'header' requires an exact non-empty key name",
      });
    });

    it("trims whitespace from key", () => {
      const op = makeOp({
        idempotency: {
          mode: "required",
          mechanism: "header",
          key: "  X-Idempotency-Key  ",
        },
        input: {
          params: [{ name: "X-Idempotency-Key", in: "header", schema: { type: "string" } }],
        },
      });
      const res = resolveIdempotencyCarrier(op);
      expect(res.ok).toBe(true);
      assertAccepted(res);
      const binding = res.binding;
      if (!binding) throw new Error("expected a carrier binding");
      expect(binding.key).toBe("X-Idempotency-Key");
    });

    it("requires key for query mechanism", () => {
      const op = makeOp({
        idempotency: { mode: "required", mechanism: "query" },
      });
      const res = resolveIdempotencyCarrier(op);
      assertRejected(res);
      expect(res.issue).toContain("requires an exact non-empty key name");
    });

    it("requires key for body mechanism", () => {
      const op = makeOp({
        idempotency: { mode: "required", mechanism: "body" },
      });
      const res = resolveIdempotencyCarrier(op);
      expect(res.ok).toBe(false);
    });

    it("requires key for path mechanism", () => {
      const op = makeOp({
        idempotency: { mode: "required", mechanism: "path" },
      });
      const res = resolveIdempotencyCarrier(op);
      expect(res.ok).toBe(false);
    });
  });

  describe("header carrier", () => {
    it("accepts valid HTTP header field name", () => {
      const op = makeOp({
        idempotency: {
          mode: "required",
          mechanism: "header",
          key: "X-Idempotency-Key",
        },
      });
      const res = resolveIdempotencyCarrier(op);
      expect(res).toEqual({
        ok: true,
        binding: { mechanism: "header", key: "X-Idempotency-Key" },
      });
    });

    it("accepts various valid HTTP field name characters", () => {
      const validNames = [
        "X-Custom-Header",
        "x-custom-header",
        "X_Custom_Header",
        "X.Custom.Header",
        "X123",
        "123X",
        "!#$%&'*+-.^_`|~",
      ];

      for (const name of validNames) {
        const op = makeOp({
          idempotency: {
            mode: "required",
            mechanism: "header",
            key: name,
          },
        });
        const res = resolveIdempotencyCarrier(op);
        expect(res.ok, `Header name '${name}' should be valid`).toBe(true);
      }
    });

    it("rejects invalid HTTP field name with spaces", () => {
      const op = makeOp({
        idempotency: {
          mode: "required",
          mechanism: "header",
          key: "X-Idempotency Key",
        },
      });
      const res = resolveIdempotencyCarrier(op);
      expect(res).toEqual({
        ok: false,
        issue: "idempotency header 'X-Idempotency Key' is not a valid HTTP field name",
      });
    });

    it("rejects invalid HTTP field name with special chars", () => {
      const op = makeOp({
        idempotency: {
          mode: "required",
          mechanism: "header",
          key: "X-Idempotency@Key",
        },
      });
      const res = resolveIdempotencyCarrier(op);
      assertRejected(res);
      expect(res.issue).toContain("not a valid HTTP field name");
    });

    it("rejects runtime-owned headers", () => {
      const runtimeOwned = [
        "accept",
        "authorization",
        "connection",
        "content-length",
        "content-type",
        "cookie",
        "expect",
        "host",
        "proxy-authorization",
        "transfer-encoding",
      ];

      for (const header of runtimeOwned) {
        const op = makeOp({
          idempotency: {
            mode: "required",
            mechanism: "header",
            key: header,
          },
        });
        const res = resolveIdempotencyCarrier(op);
        assertRejected(res);
        expect(res.issue, `Header '${header}' should be rejected as runtime-owned`).toContain(
          "owned by the HTTP/auth runtime",
        );
      }
    });

    it("rejects runtime-owned headers case-insensitively", () => {
      const op = makeOp({
        idempotency: {
          mode: "required",
          mechanism: "header",
          key: "AUTHORIZATION",
        },
      });
      const res = resolveIdempotencyCarrier(op);
      assertRejected(res);
      expect(res.issue).toContain("owned by the HTTP/auth runtime");
    });

    it("validates header schema accepts string", () => {
      const op = makeOp({
        idempotency: {
          mode: "required",
          mechanism: "header",
          key: "X-Idempotency-Key",
        },
        input: {
          params: [{ name: "X-Idempotency-Key", in: "header", schema: { type: "integer" } }],
        },
      });
      const res = resolveIdempotencyCarrier(op);
      expect(res).toEqual({
        ok: false,
        issue: "idempotency header 'X-Idempotency-Key' is not modeled as a string",
      });
    });

    it("accepts header without modeled parameter", () => {
      const op = makeOp({
        idempotency: {
          mode: "required",
          mechanism: "header",
          key: "X-Idempotency-Key",
        },
        input: { params: [] },
      });
      const res = resolveIdempotencyCarrier(op);
      assertAccepted(res);
      expect(res.binding?.schema).toBeUndefined();
    });

    it("includes schema in binding when parameter exists and is valid", () => {
      const schema = { type: "string", description: "Idempotency key" };
      const op = makeOp({
        idempotency: {
          mode: "required",
          mechanism: "header",
          key: "X-Idempotency-Key",
        },
        input: {
          params: [{ name: "X-Idempotency-Key", in: "header", schema }],
        },
      });
      const res = resolveIdempotencyCarrier(op);
      expect(res.ok).toBe(true);
      assertAccepted(res);
      const binding = res.binding;
      if (!binding) throw new Error("expected a carrier binding");
      expect(binding.schema).toEqual(schema);
    });

    it("matches header parameter case-insensitively", () => {
      const op = makeOp({
        idempotency: {
          mode: "required",
          mechanism: "header",
          key: "x-idempotency-key",
        },
        input: {
          params: [{ name: "X-Idempotency-Key", in: "header", schema: { type: "string" } }],
        },
      });
      const res = resolveIdempotencyCarrier(op);
      expect(res.ok).toBe(true);
    });
  });

  describe("query carrier", () => {
    it("accepts valid query parameter", () => {
      const op = makeOp({
        idempotency: {
          mode: "required",
          mechanism: "query",
          key: "idempotency_key",
        },
        input: {
          params: [{ name: "idempotency_key", in: "query", schema: { type: "string" } }],
        },
      });
      const res = resolveIdempotencyCarrier(op);
      expect(res.ok).toBe(true);
      assertAccepted(res);
      const binding = res.binding;
      if (!binding) throw new Error("expected a carrier binding");
      expect(binding.mechanism).toBe("query");
      expect(binding.key).toBe("idempotency_key");
    });

    it("rejects query parameter not in contract", () => {
      const op = makeOp({
        idempotency: {
          mode: "required",
          mechanism: "query",
          key: "idempotency_key",
        },
        input: { params: [] },
      });
      const res = resolveIdempotencyCarrier(op);
      expect(res).toEqual({
        ok: false,
        issue:
          "idempotency query parameter 'idempotency_key' is not declared by the source operation",
      });
    });

    it("rejects query parameter not as string", () => {
      const op = makeOp({
        idempotency: {
          mode: "required",
          mechanism: "query",
          key: "idempotency_key",
        },
        input: {
          params: [{ name: "idempotency_key", in: "query", schema: { type: "integer" } }],
        },
      });
      const res = resolveIdempotencyCarrier(op);
      expect(res).toEqual({
        ok: false,
        issue: "idempotency query parameter 'idempotency_key' is not modeled as a string",
      });
    });

    it("rejects if query parameter exists in body or header", () => {
      const op = makeOp({
        idempotency: {
          mode: "required",
          mechanism: "query",
          key: "idempotency_key",
        },
        input: {
          params: [{ name: "idempotency_key", in: "header", schema: { type: "string" } }],
        },
      });
      const res = resolveIdempotencyCarrier(op);
      expect(res.ok).toBe(false);
    });

    it("matches query parameter exactly (case-sensitive)", () => {
      const op = makeOp({
        idempotency: {
          mode: "required",
          mechanism: "query",
          key: "idempotency_key",
        },
        input: {
          params: [{ name: "Idempotency_Key", in: "query", schema: { type: "string" } }],
        },
      });
      const res = resolveIdempotencyCarrier(op);
      expect(res.ok).toBe(false);
    });
  });

  describe("path carrier", () => {
    it("accepts valid path parameter", () => {
      const op = makeOp({
        sourceRef: { kind: "openapi", path: "/items/{item_id}/action", method: "post" },
        idempotency: {
          mode: "required",
          mechanism: "path",
          key: "item_id",
        },
        input: {
          params: [{ name: "item_id", in: "path", required: true, schema: { type: "string" } }],
        },
      });
      const res = resolveIdempotencyCarrier(op);
      expect(res.ok).toBe(true);
      assertAccepted(res);
      const binding = res.binding;
      if (!binding) throw new Error("expected a carrier binding");
      expect(binding.mechanism).toBe("path");
      expect(binding.key).toBe("item_id");
    });

    it("rejects path parameter not in contract", () => {
      const op = makeOp({
        sourceRef: { kind: "openapi", path: "/items", method: "post" },
        idempotency: {
          mode: "required",
          mechanism: "path",
          key: "item_id",
        },
        input: { params: [] },
      });
      const res = resolveIdempotencyCarrier(op);
      expect(res).toEqual({
        ok: false,
        issue: "idempotency path parameter 'item_id' is not declared in the source path template",
      });
    });

    it("rejects path parameter not in path template", () => {
      const op = makeOp({
        sourceRef: { kind: "openapi", path: "/items", method: "post" },
        idempotency: {
          mode: "required",
          mechanism: "path",
          key: "item_id",
        },
        input: {
          params: [{ name: "item_id", in: "path", required: true, schema: { type: "string" } }],
        },
      });
      const res = resolveIdempotencyCarrier(op);
      expect(res.ok).toBe(false);
    });

    it("rejects path parameter not as string", () => {
      const op = makeOp({
        sourceRef: { kind: "openapi", path: "/items/{item_id}", method: "post" },
        idempotency: {
          mode: "required",
          mechanism: "path",
          key: "item_id",
        },
        input: {
          params: [{ name: "item_id", in: "path", required: true, schema: { type: "integer" } }],
        },
      });
      const res = resolveIdempotencyCarrier(op);
      expect(res.ok).toBe(false);
    });

    it("matches path parameter exactly (case-sensitive)", () => {
      const op = makeOp({
        sourceRef: { kind: "openapi", path: "/items/{item_id}", method: "post" },
        idempotency: {
          mode: "required",
          mechanism: "path",
          key: "item_id",
        },
        input: {
          params: [{ name: "Item_ID", in: "path", required: true, schema: { type: "string" } }],
        },
      });
      const res = resolveIdempotencyCarrier(op);
      expect(res.ok).toBe(false);
    });
  });

  describe("body carrier", () => {
    it("accepts field in legacy body param", () => {
      const op = makeOp({
        idempotency: {
          mode: "required",
          mechanism: "body",
          key: "idempotency_key",
        },
        input: {
          params: [{ name: "idempotency_key", in: "body", schema: { type: "string" } }],
        },
      });
      const res = resolveIdempotencyCarrier(op);
      expect(res.ok).toBe(true);
      assertAccepted(res);
      const binding = res.binding;
      if (binding?.mechanism !== "body") {
        throw new Error(`expected a body carrier, got ${binding?.mechanism ?? "none"}`);
      }
      expect(binding.path).toEqual(["idempotency_key"]);
    });

    it("rejects legacy body param not as string", () => {
      const op = makeOp({
        idempotency: {
          mode: "required",
          mechanism: "body",
          key: "idempotency_key",
        },
        input: {
          params: [{ name: "idempotency_key", in: "body", schema: { type: "integer" } }],
        },
      });
      const res = resolveIdempotencyCarrier(op);
      expect(res.ok).toBe(false);
    });

    it("accepts simple field name in JSON body", () => {
      const op = makeOp({
        idempotency: {
          mode: "required",
          mechanism: "body",
          key: "idempotency_key",
        },
        input: {
          params: [],
          body: {
            contentType: "application/json",
            schema: {
              type: "object",
              properties: {
                idempotency_key: { type: "string" },
              },
            },
          },
        },
      });
      const res = resolveIdempotencyCarrier(op);
      expect(res.ok).toBe(true);
      assertAccepted(res);
      const binding = res.binding;
      if (!binding) throw new Error("expected a carrier binding");
      expect((binding as { path?: string[] }).path).toEqual(["idempotency_key"]);
    });

    it("accepts JSON pointer path", () => {
      const op = makeOp({
        idempotency: {
          mode: "required",
          mechanism: "body",
          key: "/metadata/idempotency_key",
        },
        input: {
          params: [],
          body: {
            contentType: "application/json",
            schema: {
              type: "object",
              properties: {
                metadata: {
                  type: "object",
                  properties: {
                    idempotency_key: { type: "string" },
                  },
                },
              },
            },
          },
        },
      });
      const res = resolveIdempotencyCarrier(op);
      expect(res.ok).toBe(true);
      assertAccepted(res);
      const binding = res.binding;
      if (!binding) throw new Error("expected a carrier binding");
      expect((binding as { path?: string[] }).path).toEqual(["metadata", "idempotency_key"]);
    });

    it("decodes JSON pointer escape sequences", () => {
      const op = makeOp({
        idempotency: {
          mode: "required",
          mechanism: "body",
          key: "/a~1b~0c",
        },
        input: {
          params: [],
          body: {
            contentType: "application/json",
            schema: {
              type: "object",
              properties: {
                "a/b~c": { type: "string" },
              },
            },
          },
        },
      });
      const res = resolveIdempotencyCarrier(op);
      expect(res.ok).toBe(true);
      assertAccepted(res);
      const binding = res.binding;
      if (!binding) throw new Error("expected a carrier binding");
      expect((binding as { path?: string[] }).path).toEqual(["a/b~c"]);
    });

    it("rejects invalid JSON pointer", () => {
      const op = makeOp({
        idempotency: {
          mode: "required",
          mechanism: "body",
          key: "/a//b",
        },
      });
      const res = resolveIdempotencyCarrier(op);
      expect(res).toEqual({
        ok: false,
        issue: "idempotency body field '/a//b' is not a valid field name or JSON Pointer",
      });
    });

    it("requires JSON or application/*+json content type", () => {
      const op = makeOp({
        idempotency: {
          mode: "required",
          mechanism: "body",
          key: "idempotency_key",
        },
        input: {
          params: [],
          body: {
            contentType: "application/xml",
            schema: { type: "object" },
          },
        },
      });
      const res = resolveIdempotencyCarrier(op);
      expect(res).toEqual({
        ok: false,
        issue: "idempotency body field 'idempotency_key' requires a modeled JSON request body",
      });
    });

    it("accepts application/vnd.api+json content type", () => {
      const op = makeOp({
        idempotency: {
          mode: "required",
          mechanism: "body",
          key: "idempotency_key",
        },
        input: {
          params: [],
          body: {
            contentType: "application/vnd.api+json",
            schema: {
              type: "object",
              properties: {
                idempotency_key: { type: "string" },
              },
            },
          },
        },
      });
      const res = resolveIdempotencyCarrier(op);
      expect(res.ok).toBe(true);
    });

    it("requires JSON body to exist", () => {
      const op = makeOp({
        idempotency: {
          mode: "required",
          mechanism: "body",
          key: "idempotency_key",
        },
        input: { params: [] },
      });
      const res = resolveIdempotencyCarrier(op);
      expect(res).toEqual({
        ok: false,
        issue: "idempotency body field 'idempotency_key' requires a modeled JSON request body",
      });
    });

    it("rejects field not in schema", () => {
      const op = makeOp({
        idempotency: {
          mode: "required",
          mechanism: "body",
          key: "nonexistent",
        },
        input: {
          params: [],
          body: {
            contentType: "application/json",
            schema: {
              type: "object",
              properties: {
                idempotency_key: { type: "string" },
              },
            },
          },
        },
      });
      const res = resolveIdempotencyCarrier(op);
      expect(res).toEqual({
        ok: false,
        issue: "idempotency body field 'nonexistent' is not declared by the source request schema",
      });
    });

    it("rejects field not as string in schema", () => {
      const op = makeOp({
        idempotency: {
          mode: "required",
          mechanism: "body",
          key: "idempotency_key",
        },
        input: {
          params: [],
          body: {
            contentType: "application/json",
            schema: {
              type: "object",
              properties: {
                idempotency_key: { type: "integer" },
              },
            },
          },
        },
      });
      const res = resolveIdempotencyCarrier(op);
      expect(res).toEqual({
        ok: false,
        issue: "idempotency body field 'idempotency_key' is not modeled as a string",
      });
    });

    it("strips content type charset parameter", () => {
      const op = makeOp({
        idempotency: {
          mode: "required",
          mechanism: "body",
          key: "idempotency_key",
        },
        input: {
          params: [],
          body: {
            contentType: "application/json; charset=utf-8",
            schema: {
              type: "object",
              properties: {
                idempotency_key: { type: "string" },
              },
            },
          },
        },
      });
      const res = resolveIdempotencyCarrier(op);
      expect(res.ok).toBe(true);
    });
  });

  describe("schema validation", () => {
    it("accepts schema with string type", () => {
      const op = makeOp({
        idempotency: {
          mode: "required",
          mechanism: "header",
          key: "X-Idempotency-Key",
          keyDerivation: "request_fingerprint",
        },
        input: {
          params: [{ name: "X-Idempotency-Key", in: "header", schema: { type: "string" } }],
        },
      });
      const res = resolveIdempotencyCarrier(op);
      expect(res.ok).toBe(true);
    });

    it("accepts schema with union type including string", () => {
      const op = makeOp({
        idempotency: {
          mode: "required",
          mechanism: "header",
          key: "X-Idempotency-Key",
        },
        input: {
          params: [
            { name: "X-Idempotency-Key", in: "header", schema: { type: ["string", "null"] } },
          ],
        },
      });
      const res = resolveIdempotencyCarrier(op);
      expect(res.ok).toBe(true);
    });

    it("accepts schema with const string", () => {
      const op = makeOp({
        idempotency: {
          mode: "required",
          mechanism: "header",
          key: "X-Idempotency-Key",
        },
        input: {
          params: [{ name: "X-Idempotency-Key", in: "header", schema: { const: "idempotency" } }],
        },
      });
      const res = resolveIdempotencyCarrier(op);
      expect(res.ok).toBe(true);
    });

    it("accepts schema with enum of strings", () => {
      const op = makeOp({
        idempotency: {
          mode: "required",
          mechanism: "header",
          key: "X-Idempotency-Key",
        },
        input: {
          params: [
            {
              name: "X-Idempotency-Key",
              in: "header",
              schema: { enum: ["key1", "key2"] },
            },
          ],
        },
      });
      const res = resolveIdempotencyCarrier(op);
      expect(res.ok).toBe(true);
    });

    it("rejects schema with enum of non-strings", () => {
      const op = makeOp({
        idempotency: {
          mode: "required",
          mechanism: "header",
          key: "X-Idempotency-Key",
        },
        input: {
          params: [
            {
              name: "X-Idempotency-Key",
              in: "header",
              schema: { enum: [1, 2] },
            },
          ],
        },
      });
      const res = resolveIdempotencyCarrier(op);
      expect(res.ok).toBe(false);
    });

    it("rejects schema with empty enum", () => {
      const op = makeOp({
        idempotency: {
          mode: "required",
          mechanism: "header",
          key: "X-Idempotency-Key",
        },
        input: {
          params: [
            {
              name: "X-Idempotency-Key",
              in: "header",
              schema: { enum: [] },
            },
          ],
        },
      });
      const res = resolveIdempotencyCarrier(op);
      expect(res.ok).toBe(false);
    });
  });

  describe("request fingerprint key derivation constraints", () => {
    it("accepts derived key with compatible pattern", () => {
      const patterns = ["^[\\u0021-\\u007E]+$", "^[!-~]+$", "^anvil-[0-9a-f]{32}$"];

      for (const pattern of patterns) {
        const op = makeOp({
          idempotency: {
            mode: "required",
            mechanism: "header",
            key: "X-Idempotency-Key",
            keyDerivation: "request_fingerprint",
          },
          input: {
            params: [
              {
                name: "X-Idempotency-Key",
                in: "header",
                schema: { type: "string", pattern },
              },
            ],
          },
        });
        const res = resolveIdempotencyCarrier(op);
        expect(res.ok, `Pattern '${pattern}' should be accepted`).toBe(true);
      }
    });

    it("rejects derived key with incompatible pattern", () => {
      const op = makeOp({
        idempotency: {
          mode: "required",
          mechanism: "header",
          key: "X-Idempotency-Key",
          keyDerivation: "request_fingerprint",
        },
        input: {
          params: [
            {
              name: "X-Idempotency-Key",
              in: "header",
              schema: { type: "string", pattern: "^[a-z]+$" },
            },
          ],
        },
      });
      const res = resolveIdempotencyCarrier(op);
      assertRejected(res);
      expect(res.issue).toContain(
        "request-fingerprint keys cannot be proven to satisfy the modeled carrier schema",
      );
    });

    it("rejects derived key with length constraint too short", () => {
      const op = makeOp({
        idempotency: {
          mode: "required",
          mechanism: "header",
          key: "X-Idempotency-Key",
          keyDerivation: "request_fingerprint",
        },
        input: {
          params: [
            {
              name: "X-Idempotency-Key",
              in: "header",
              schema: { type: "string", minLength: 100 },
            },
          ],
        },
      });
      const res = resolveIdempotencyCarrier(op);
      expect(res.ok).toBe(false);
    });

    it("rejects derived key with length constraint too long", () => {
      const op = makeOp({
        idempotency: {
          mode: "required",
          mechanism: "header",
          key: "X-Idempotency-Key",
          keyDerivation: "request_fingerprint",
        },
        input: {
          params: [
            {
              name: "X-Idempotency-Key",
              in: "header",
              schema: { type: "string", maxLength: 10 },
            },
          ],
        },
      });
      const res = resolveIdempotencyCarrier(op);
      expect(res.ok).toBe(false);
    });

    it("rejects derived key with format constraint", () => {
      const op = makeOp({
        idempotency: {
          mode: "required",
          mechanism: "header",
          key: "X-Idempotency-Key",
          keyDerivation: "request_fingerprint",
        },
        input: {
          params: [
            {
              name: "X-Idempotency-Key",
              in: "header",
              schema: { type: "string", format: "uuid" },
            },
          ],
        },
      });
      const res = resolveIdempotencyCarrier(op);
      expect(res.ok).toBe(false);
    });

    it("rejects derived key with const constraint", () => {
      const op = makeOp({
        idempotency: {
          mode: "required",
          mechanism: "header",
          key: "X-Idempotency-Key",
          keyDerivation: "request_fingerprint",
        },
        input: {
          params: [
            {
              name: "X-Idempotency-Key",
              in: "header",
              schema: { type: "string", const: "fixed" },
            },
          ],
        },
      });
      const res = resolveIdempotencyCarrier(op);
      expect(res.ok).toBe(false);
    });

    it("rejects derived key with enum constraint", () => {
      const op = makeOp({
        idempotency: {
          mode: "required",
          mechanism: "header",
          key: "X-Idempotency-Key",
          keyDerivation: "request_fingerprint",
        },
        input: {
          params: [
            {
              name: "X-Idempotency-Key",
              in: "header",
              schema: { type: "string", enum: ["key1", "key2"] },
            },
          ],
        },
      });
      const res = resolveIdempotencyCarrier(op);
      expect(res.ok).toBe(false);
    });

    it("allows client_supplied key derivation with any schema", () => {
      const op = makeOp({
        idempotency: {
          mode: "required",
          mechanism: "header",
          key: "X-Idempotency-Key",
          keyDerivation: "client_supplied",
        },
        input: {
          params: [
            {
              name: "X-Idempotency-Key",
              in: "header",
              schema: { type: "string", format: "uuid", minLength: 100 },
            },
          ],
        },
      });
      const res = resolveIdempotencyCarrier(op);
      expect(res.ok).toBe(true);
    });

    it("allows none derivation with any schema", () => {
      const op = makeOp({
        idempotency: {
          mode: "required",
          mechanism: "header",
          key: "X-Idempotency-Key",
          keyDerivation: "none",
        },
        input: {
          params: [
            {
              name: "X-Idempotency-Key",
              in: "header",
              schema: { type: "string", format: "uuid" },
            },
          ],
        },
      });
      const res = resolveIdempotencyCarrier(op);
      expect(res.ok).toBe(true);
    });
  });
});

describe("idempotencyAuthCarrierIssue", () => {
  it("returns undefined when no idempotency binding", () => {
    const op = makeOp({ idempotency: { mode: "natural" } });
    const issue = idempotencyAuthCarrierIssue(op);
    expect(issue).toBeUndefined();
  });

  it("returns undefined when no auth carrier", () => {
    const op = makeOp({
      idempotency: {
        mode: "required",
        mechanism: "header",
        key: "X-Idempotency-Key",
      },
      input: {
        params: [{ name: "X-Idempotency-Key", in: "header", schema: { type: "string" } }],
      },
      auth: { type: "none", principal: "anonymous", secretSource: "none" },
    });
    const issue = idempotencyAuthCarrierIssue(op);
    expect(issue).toBeUndefined();
  });

  it("returns undefined when carriers do not conflict", () => {
    const op = makeOp({
      idempotency: {
        mode: "required",
        mechanism: "header",
        key: "X-Idempotency-Key",
      },
      input: {
        params: [{ name: "X-Idempotency-Key", in: "header", schema: { type: "string" } }],
      },
      auth: {
        type: "api_key",
        principal: "service",
        secretSource: "env",
        carrier: { in: "header", name: "X-API-Key" },
      },
    });
    const issue = idempotencyAuthCarrierIssue(op);
    expect(issue).toBeUndefined();
  });

  // Note: "Authorization" cannot be used here because it is a runtime-owned
  // header (RUNTIME_OWNED_HEADERS in idempotency-carrier.ts); resolveIdempotencyCarrier
  // rejects it before an auth-carrier conflict could ever be detected. A custom
  // header shared by an api_key auth carrier is used instead to exercise the
  // sameHeader conflict path in idempotencyAuthCarrierIssue.
  it("detects header conflict", () => {
    const op = makeOp({
      idempotency: {
        mode: "required",
        mechanism: "header",
        key: "X-Api-Key",
      },
      input: {
        params: [{ name: "X-Api-Key", in: "header", schema: { type: "string" } }],
      },
      auth: {
        type: "api_key",
        principal: "service",
        secretSource: "env",
        carrier: { in: "header", name: "X-Api-Key" },
      },
    });
    const issue = idempotencyAuthCarrierIssue(op);
    expect(issue).toContain("idempotency header 'X-Api-Key' conflicts");
  });

  it("detects header conflict case-insensitively", () => {
    const op = makeOp({
      idempotency: {
        mode: "required",
        mechanism: "header",
        key: "x-api-key",
      },
      input: {
        params: [{ name: "x-api-key", in: "header", schema: { type: "string" } }],
      },
      auth: {
        type: "api_key",
        principal: "service",
        secretSource: "env",
        carrier: { in: "header", name: "X-Api-Key" },
      },
    });
    const issue = idempotencyAuthCarrierIssue(op);
    expect(issue).toContain("conflicts with the");
  });

  it("detects query conflict", () => {
    const op = makeOp({
      idempotency: {
        mode: "required",
        mechanism: "query",
        key: "api_key",
      },
      input: {
        params: [{ name: "api_key", in: "query", schema: { type: "string" } }],
      },
      auth: {
        type: "api_key",
        principal: "service",
        secretSource: "env",
        carrier: { in: "query", name: "api_key" },
      },
    });
    const issue = idempotencyAuthCarrierIssue(op);
    expect(issue).toContain("idempotency query 'api_key' conflicts");
  });

  it("ignores body and path carriers", () => {
    const op = makeOp({
      idempotency: {
        mode: "required",
        mechanism: "body",
        key: "idempotency_key",
      },
      input: {
        params: [],
        body: {
          contentType: "application/json",
          schema: {
            type: "object",
            properties: {
              idempotency_key: { type: "string" },
            },
          },
        },
      },
      auth: {
        type: "api_key",
        principal: "service",
        secretSource: "env",
        carrier: { in: "header", name: "X-API-Key" },
      },
    });
    const issue = idempotencyAuthCarrierIssue(op);
    expect(issue).toBeUndefined();
  });
});

describe("isModeledIdempotencyCarrierInput", () => {
  it("returns false when binding is undefined", () => {
    expect(isModeledIdempotencyCarrierInput(undefined, "header", "X-Idempotency-Key")).toBe(false);
  });

  it("returns false when mechanism does not match location", () => {
    const binding: IdempotencyCarrierBinding = {
      mechanism: "header",
      key: "X-Idempotency-Key",
    };
    expect(isModeledIdempotencyCarrierInput(binding, "query", "X-Idempotency-Key")).toBe(false);
  });

  it("returns true for header binding with matching name (case-insensitive)", () => {
    const binding: IdempotencyCarrierBinding = {
      mechanism: "header",
      key: "X-Idempotency-Key",
    };
    expect(isModeledIdempotencyCarrierInput(binding, "header", "x-idempotency-key")).toBe(true);
    expect(isModeledIdempotencyCarrierInput(binding, "header", "X-IDEMPOTENCY-KEY")).toBe(true);
  });

  it("returns false for header binding with different name", () => {
    const binding: IdempotencyCarrierBinding = {
      mechanism: "header",
      key: "X-Idempotency-Key",
    };
    expect(isModeledIdempotencyCarrierInput(binding, "header", "X-Request-ID")).toBe(false);
  });

  it("returns true for query binding with exact name match", () => {
    const binding: IdempotencyCarrierBinding = {
      mechanism: "query",
      key: "idempotency_key",
      schema: {},
    };
    expect(isModeledIdempotencyCarrierInput(binding, "query", "idempotency_key")).toBe(true);
  });

  it("returns false for query binding with case difference", () => {
    const binding: IdempotencyCarrierBinding = {
      mechanism: "query",
      key: "idempotency_key",
      schema: {},
    };
    expect(isModeledIdempotencyCarrierInput(binding, "query", "Idempotency_Key")).toBe(false);
  });

  it("returns true for path binding with exact name match", () => {
    const binding: IdempotencyCarrierBinding = {
      mechanism: "path",
      key: "item_id",
      schema: {},
    };
    expect(isModeledIdempotencyCarrierInput(binding, "path", "item_id")).toBe(true);
  });

  it("returns false for path binding with case difference", () => {
    const binding: IdempotencyCarrierBinding = {
      mechanism: "path",
      key: "item_id",
      schema: {},
    };
    expect(isModeledIdempotencyCarrierInput(binding, "path", "Item_ID")).toBe(false);
  });

  it("returns true for body binding with single-segment path", () => {
    const binding: IdempotencyCarrierBinding = {
      mechanism: "body",
      key: "idempotency_key",
      path: ["idempotency_key"],
      schema: {},
    };
    expect(isModeledIdempotencyCarrierInput(binding, "body", "idempotency_key")).toBe(true);
  });

  it("returns false for body binding with multi-segment path", () => {
    const binding: IdempotencyCarrierBinding = {
      mechanism: "body",
      key: "/metadata/idempotency_key",
      path: ["metadata", "idempotency_key"],
      schema: {},
    };
    expect(isModeledIdempotencyCarrierInput(binding, "body", "idempotency_key")).toBe(false);
  });

  it("returns false for body binding with non-matching name", () => {
    const binding: IdempotencyCarrierBinding = {
      mechanism: "body",
      key: "idempotency_key",
      path: ["idempotency_key"],
      schema: {},
    };
    expect(isModeledIdempotencyCarrierInput(binding, "body", "request_id")).toBe(false);
  });
});
