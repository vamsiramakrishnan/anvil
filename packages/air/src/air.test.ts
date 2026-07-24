import { describe, expect, it } from "vitest";
import {
  AuthRequirement,
  airFromYaml,
  airToJson,
  airToYaml,
  authCoherenceIssues,
  cliFlag,
  effectiveAuthCarrier,
  evidenceConfidence,
  kebabCase,
  loadAirDocument,
  type Operation,
  operationBusinessInputCliFlag,
  operationInputSchema,
  operationSafetyInputKeys,
  propKey,
  snakeCase,
} from "./index.js";

const refundOp = {
  id: "payments.refund.create",
  canonicalName: "create_refund",
  displayName: "Create refund",
  description: "Creates a refund for a captured payment.",
  sourceRef: { kind: "openapi", path: "/payments/{payment_id}/refunds", method: "post" },
  effect: { kind: "mutation", resource: "refund", risk: "financial", reversible: false },
  input: {
    params: [
      { name: "paymentId", in: "path", required: true, schema: { type: "string" } },
      { name: "amount", in: "body", required: true, schema: { type: "integer", minimum: 1 } },
      { name: "currency", in: "body", required: true, schema: { type: "string" } },
    ],
  },
  idempotency: { mode: "required", mechanism: "header", key: "Idempotency-Key" },
  retries: { mode: "safe", maxAttempts: 3, backoff: "exponential_jitter", retryOn: ["http_429"] },
  confirmation: { required: true, risk: "financial" },
  auth: { type: "oauth2_client_credentials", scopes: ["payments.write"] },
  cli: { command: "payments refunds create" },
  mcp: { toolName: "payments_create_refund" },
  skill: { intentExamples: ["Refund payment pay_123 for 25 dollars."] },
};

const doc = {
  service: {
    id: "payments",
    version: "2026-07-09",
    source: { kind: "openapi", uri: "./payments.openapi.yaml" },
  },
  operations: [refundOp],
};

describe("naming", () => {
  it("derives snake, kebab, and cli flags consistently", () => {
    expect(snakeCase("paymentId")).toBe("payment_id");
    expect(kebabCase("paymentId")).toBe("payment-id");
    expect(propKey("Idempotency-Key")).toBe("idempotency_key");
    expect(cliFlag("paymentId")).toBe("--payment-id");
    expect(snakeCase("HTTPStatusCode")).toBe("http_status_code");
  });
});

describe("AirDocument", () => {
  it.each([
    "../escape",
    "nested/service",
    "windows\\service",
    "UPPER",
    "has space",
    "a${danger}",
    `a${"b".repeat(64)}`,
    "trailing-",
  ])("rejects the unsafe or non-portable service id %j", (id) => {
    expect(() =>
      loadAirDocument({
        ...doc,
        service: { ...doc.service, id },
      }),
    ).toThrow(/service id/i);
  });

  it.each([
    "a",
    "payments",
    "payments-api",
    "payments_api",
    `a${"b".repeat(63)}`,
  ])("accepts the portable service id %j", (id) => {
    expect(
      loadAirDocument({
        ...doc,
        service: { ...doc.service, id },
      }).service.id,
    ).toBe(id);
  });

  it("applies defaults and validates structure", () => {
    const air = loadAirDocument(doc);
    expect(air.anvilVersion).toBe("0.1.0");
    const op = air.operations[0] as Operation;
    expect(op.state).toBe("generated");
    expect(op.effect.reversible).toBe(false);
    // No claims → derived confidence is 0 (there is no stored aggregate).
    expect(op.evidence.claims).toEqual([]);
    expect(evidenceConfidence(op.evidence)).toBe(0);
    expect(op.retries.baseDelayMs).toBe(200);
  });

  it("round-trips through YAML and JSON", () => {
    const air = loadAirDocument(doc);
    const back = airFromYaml(airToYaml(air));
    expect(back.operations[0]?.id).toBe("payments.refund.create");
    const json = JSON.parse(airToJson(air));
    expect(json.operations[0].mcp.toolName).toBe("payments_create_refund");
  });

  it("round-trips a bundle with many repeated substructures without emitting aliases", () => {
    // A large real bundle (PagerDuty's 465-op AIR) repeats identical
    // substructures — the same retry-condition list, error shapes, etc. — on
    // every operation. The `yaml` serializer's default would emit a YAML
    // anchor/alias per repeat, and on re-read the parser's anti-"billion
    // laughs" cap of 100 aliases threw "Excessive alias count", so `anvil
    // lint`/`certify` failed on Anvil's own output. Fabricate that shape:
    // 120 operations that all share a byte-identical retry policy object —
    // past the parser's default 100-alias cap.
    const base = loadAirDocument(doc);
    const proto = base.operations[0] as Operation;
    const many = {
      ...base,
      operations: Array.from({ length: 120 }, (_, i) => ({
        ...structuredClone(proto),
        id: `payments.refund.create_${i}`,
        canonicalName: `create_refund_${i}`,
      })),
    };
    const air = loadAirDocument(many);
    const yaml = airToYaml(air);
    // No YAML anchors are emitted — the canonical form is self-contained.
    expect(yaml).not.toMatch(/: &/);
    expect(yaml).not.toMatch(/ \*[A-Za-z0-9_]/);
    // And it re-parses (this threw before the fix — 120 shared substructures
    // is past the parser's default 100-alias cap).
    const back = airFromYaml(yaml);
    expect(back.operations).toHaveLength(120);
  }, 20_000);

  it("round-trips descriptions with YAML-hostile whitespace (whitespace-only lines, trailing spaces)", () => {
    // Real shape from the lgtm.com spec (found by the corpus sweep's round-trip
    // oracle): a long description mixing indented lines, a line with a trailing
    // space, and a whitespace-only line. The pretty block-scalar emission
    // gained an extra newline on re-parse, silently drifting the contract
    // hash; airToYaml now verifies and falls back to lossless quoting.
    const hostile =
      "Download all the alerts.\nUse the `Accept:` header, e.g. `text/csv; without-header` \n" +
      "      would result in CSV output without a header row.\n    \n\n\n\n" +
      "To find the analysis identifier for a commit, use the analyses endpoint.";
    const base = loadAirDocument(doc);
    const withHostile = structuredClone(base);
    (withHostile.operations[0] as Operation).description = hostile;
    const air = loadAirDocument(withHostile);
    const back = airFromYaml(airToYaml(air));
    expect(back.operations[0]?.description).toBe(hostile);
  });

  it("keeps pretty block scalars for ordinary multi-line descriptions", () => {
    const base = loadAirDocument(doc);
    const withPlain = structuredClone(base);
    (withPlain.operations[0] as Operation).description = "line one\nline two\nline three";
    const yaml = airToYaml(loadAirDocument(withPlain));
    // The common case still emits a readable block scalar, not quoted strings.
    expect(yaml).toMatch(/description: [|>]/);
    expect(airFromYaml(yaml).operations[0]?.description).toBe("line one\nline two\nline three");
  });

  it("rejects unknown enum values", () => {
    const bad = structuredClone(doc) as { operations: { effect: { kind: string } }[] };
    bad.operations[0].effect.kind = "teleport";
    expect(() => loadAirDocument(bad)).toThrow();
  });
});

describe("auth identity contract", () => {
  it("keeps issuer, token endpoint, and credential carrier as distinct coordinates", () => {
    const auth = AuthRequirement.parse({
      type: "oauth2_on_behalf_of",
      principal: "delegated",
      issuer: "https://issuer.example.com/",
      audience: "api://payments",
      carrier: { in: "header", name: "Authorization", scheme: "Bearer" },
      provider: {
        grant: "token_exchange",
        tokenEndpoint: "https://sts.example.com/oauth/token",
      },
    });
    expect(auth.issuer).toBe("https://issuer.example.com/");
    expect(auth.provider?.tokenEndpoint).toBe("https://sts.example.com/oauth/token");
    expect(effectiveAuthCarrier(auth)).toEqual({
      in: "header",
      name: "Authorization",
      scheme: "Bearer",
    });
  });

  it("fails closed on a contradictory bearer carrier", () => {
    const auth = AuthRequirement.parse({
      type: "jwt_bearer",
      carrier: { in: "query", name: "access_token" },
    });
    expect(authCoherenceIssues(auth)).toContain(
      "jwt_bearer requires the Authorization header with the Bearer scheme",
    );
  });

  it("derives protocol carriers without claiming issuer evidence", () => {
    const auth = AuthRequirement.parse({ type: "api_key" });
    expect(effectiveAuthCarrier(auth)).toEqual({ in: "header", name: "X-API-Key" });
    expect(auth.issuer).toBeUndefined();
  });
});

describe("operationInputSchema", () => {
  it("synthesizes idempotency_key and confirm as required for unsafe ops", () => {
    const air = loadAirDocument(doc);
    const schema = operationInputSchema(air.operations[0] as Operation);
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    const required = schema.required as string[];
    expect(required).toEqual(
      expect.arrayContaining(["payment_id", "amount", "currency", "idempotency_key", "confirm"]),
    );
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.confirm?.const).toBe(true);
    expect(props.idempotency_key?.type).toBe("string");
    expect(props.idempotency_key).toMatchObject({
      minLength: 1,
      maxLength: 255,
      pattern: "^[\\u0021-\\u007E]+$",
    });
    const keyPattern = new RegExp(String(props.idempotency_key?.pattern));
    expect(keyPattern.test("business-operation_123")).toBe(true);
    expect(keyPattern.test("has spaces")).toBe(false);
    expect(keyPattern.test("unicode-é")).toBe(false);
  });

  it.each([
    "required",
    "key_supported",
  ] as const)("keeps a derivable idempotency key optional for %s operations", (mode) => {
    const air = loadAirDocument({
      ...doc,
      operations: [
        {
          ...refundOp,
          idempotency: {
            ...refundOp.idempotency,
            mode,
            keyDerivation: "request_fingerprint",
          },
        },
      ],
    });
    const schema = operationInputSchema(air.operations[0] as Operation);
    expect(schema.properties).toHaveProperty("idempotency_key");
    expect(schema.required).not.toContain("idempotency_key");
  });

  it("preserves business fields that collide with both synthesized safety controls", () => {
    const air = loadAirDocument({
      ...doc,
      operations: [
        {
          ...refundOp,
          input: {
            params: [
              ...refundOp.input.params,
              {
                name: "idempotency_key",
                in: "query",
                required: true,
                schema: { type: "string" },
              },
              { name: "confirm", in: "query", required: true, schema: { type: "string" } },
            ],
          },
        },
      ],
    });
    const operation = air.operations[0] as Operation;
    const safety = operationSafetyInputKeys(operation);
    expect(safety).toEqual({
      idempotencyKey: "anvil_idempotency_key",
      confirm: "anvil_confirm",
    });

    const schema = operationInputSchema(operation);
    expect(schema.properties).toMatchObject({
      idempotency_key: { type: "string" },
      confirm: { type: "string" },
      anvil_idempotency_key: { type: "string" },
      anvil_confirm: { type: "boolean", const: true },
    });
    expect(schema.required).toEqual(
      expect.arrayContaining([
        "idempotency_key",
        "confirm",
        "anvil_idempotency_key",
        "anvil_confirm",
      ]),
    );
    expect(new Set(schema.required as string[]).size).toBe((schema.required as string[]).length);
    expect(operationBusinessInputCliFlag(operation, "query", "idempotency_key")).toBe(
      "--input-idempotency-key",
    );
    expect(operationBusinessInputCliFlag(operation, "query", "confirm")).toBe("--input-confirm");
  });
});
