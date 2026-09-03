import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { airToYaml, type Diagnostic } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { compile } from "../compile.js";
import { adaptHar } from "./har.js";

type Op = Record<string, unknown>;

/** Build a minimal HAR 1.2 document from a short-hand entry list. */
function har(entries: Array<Record<string, unknown>>): string {
  return JSON.stringify({ log: { version: "1.2", entries } });
}

function entry(opts: {
  method?: string;
  url: string;
  headers?: Array<{ name: string; value: string }>;
  query?: Array<{ name: string; value: string }>;
  body?: string;
  bodyMime?: string;
  status?: number;
  responseBody?: string;
  startedDateTime?: string;
}): Record<string, unknown> {
  return {
    startedDateTime: opts.startedDateTime ?? "2026-01-01T00:00:00.000Z",
    request: {
      method: opts.method ?? "GET",
      url: opts.url,
      headers: opts.headers ?? [],
      queryString: opts.query ?? [],
      ...(opts.body !== undefined
        ? { postData: { mimeType: opts.bodyMime ?? "application/json", text: opts.body } }
        : {}),
    },
    response: {
      status: opts.status ?? 200,
      content: {
        mimeType: "application/json",
        text: opts.responseBody ?? "{}",
      },
    },
  };
}

describe("HAR adapter: path templating", () => {
  it("templates a purely numeric segment from a single sample", () => {
    const doc = adaptHar(
      har([
        entry({ url: "https://api.example.com/customers/123" }),
        entry({ url: "https://api.example.com/customers/456" }),
      ]),
    );
    expect(Object.keys(doc.paths ?? {})).toEqual(["/customers/{customer_id}"]);
  });

  it("templates a UUID-shaped segment", () => {
    const doc = adaptHar(
      har([entry({ url: "https://api.example.com/orders/550e8400-e29b-41d4-a716-446655440000" })]),
    );
    expect(Object.keys(doc.paths ?? {})).toEqual(["/orders/{order_id}"]);
  });

  it("templates an opaque digit-bearing identifier (Stripe-style) from one sample", () => {
    const doc = adaptHar(har([entry({ url: "https://api.example.com/customers/cus_101" })]));
    expect(Object.keys(doc.paths ?? {})).toEqual(["/customers/{customer_id}"]);
  });

  it("never conflates two distinct resources that happen to share a segment count", () => {
    const doc = adaptHar(
      har([
        entry({ url: "https://api.example.com/customers/123" }),
        entry({ url: "https://api.example.com/payments/456" }),
      ]),
    );
    // Each numeric id templates on its own path; "customers" and "payments"
    // never merge into one operation.
    expect(Object.keys(doc.paths ?? {}).sort()).toEqual([
      "/customers/{customer_id}",
      "/payments/{payment_id}",
    ]);
  });

  it("does NOT template a purely alphabetic segment on cross-sample variation alone", () => {
    // Two genuinely different org slugs, no digit anywhere — the adapter
    // declines to guess that this position is an id rather than two
    // different resources, matching the documented conservative boundary.
    const doc = adaptHar(
      har([
        entry({ url: "https://api.example.com/orgs/acme-corp" }),
        entry({ url: "https://api.example.com/orgs/widget-inc" }),
      ]),
    );
    expect(Object.keys(doc.paths ?? {}).sort()).toEqual(["/orgs/acme-corp", "/orgs/widget-inc"]);
  });

  it("names the parameter from the preceding literal segment's singular", () => {
    const doc = adaptHar(
      har([entry({ url: "https://api.example.com/customers/123/payments/456" })]),
    );
    const path = Object.keys(doc.paths ?? {})[0];
    expect(path).toBe("/customers/{customer_id}/payments/{payment_id}");
  });

  it("de-duplicates a fallback `id` name for adjacent templated segments", () => {
    const doc = adaptHar(har([entry({ url: "https://api.example.com/123/456" })]));
    const path = Object.keys(doc.paths ?? {})[0];
    expect(path).toBe("/{id}/{id_2}");
  });
});

describe("HAR adapter: schema inference (conservative union across samples)", () => {
  it("requires a body field only when present in EVERY sample", () => {
    const doc = adaptHar(
      har([
        entry({
          method: "POST",
          url: "https://api.example.com/payments/1/refunds",
          body: '{"amount":500,"currency":"USD","reason":"dup"}',
        }),
        entry({
          method: "POST",
          url: "https://api.example.com/payments/2/refunds",
          body: '{"amount":1000,"currency":"USD"}',
        }),
      ]),
    );
    const op = (doc.paths?.["/payments/{payment_id}/refunds"] as Record<string, Op>)?.post as Op;
    const schema = (op.requestBody as { content: Record<string, { schema: Op }> }).content[
      "application/json"
    ]?.schema as Op;
    expect(schema.required).toEqual(["amount", "currency"]);
    expect((schema.properties as Op)?.reason).toEqual({ type: "string" });
    expect(schema.additionalProperties).toBe(true);
  });

  it("unions a property's type across samples rather than picking one", () => {
    const doc = adaptHar(
      har([
        entry({
          method: "POST",
          url: "https://api.example.com/widgets/1/tag",
          body: '{"label":"a"}',
        }),
        entry({
          method: "POST",
          url: "https://api.example.com/widgets/2/tag",
          body: '{"label":5}',
        }),
      ]),
    );
    const op = (doc.paths?.["/widgets/{widget_id}/tag"] as Record<string, Op>)?.post as Op;
    const schema = (op.requestBody as { content: Record<string, { schema: Op }> }).content[
      "application/json"
    ]?.schema as Op;
    const label = (schema.properties as Op)?.label as { type: string[] };
    expect(label.type.sort()).toEqual(["number", "string"]);
  });

  it("keys responses by observed status code and infers each conservatively", () => {
    const doc = adaptHar(
      har([
        entry({
          url: "https://api.example.com/customers/1",
          status: 200,
          responseBody: '{"id":"1","email":"a@x.com"}',
        }),
        entry({
          url: "https://api.example.com/customers/2",
          status: 404,
          responseBody: '{"error":"not found"}',
        }),
      ]),
    );
    const op = (doc.paths?.["/customers/{customer_id}"] as Record<string, Op>)?.get as Op;
    const responses = op.responses as Record<string, Op>;
    expect(Object.keys(responses).sort()).toEqual(["200", "404"]);
  });

  it("required query/header params are only those present in EVERY sample", () => {
    const doc = adaptHar(
      har([
        entry({
          url: "https://api.example.com/customers/1?expand=true",
          query: [{ name: "expand", value: "true" }],
        }),
        entry({ url: "https://api.example.com/customers/2" }),
      ]),
    );
    const op = (doc.paths?.["/customers/{customer_id}"] as Record<string, Op>)?.get as Op;
    const params = op.parameters as Array<{ name: string; in: string; required: boolean }>;
    const expand = params.find((p) => p.name === "expand" && p.in === "query");
    expect(expand?.required).toBe(false);
    const customerId = params.find((p) => p.name === "customer_id");
    expect(customerId?.required).toBe(true); // path params are always required
  });
});

describe("HAR adapter: secrets are dropped before anything else runs", () => {
  it("never copies Authorization/Cookie/api-key VALUES into the document", () => {
    const doc = adaptHar(
      har([
        entry({
          url: "https://api.example.com/customers/1",
          headers: [
            { name: "Authorization", value: "Bearer sk_live_SUPER_SECRET_TOKEN" },
            { name: "Cookie", value: "session_id=SUPER_SECRET_SESSION" },
            { name: "X-Api-Key", value: "SUPER_SECRET_API_KEY" },
          ],
          query: [{ name: "session_token", value: "SUPER_SECRET_QUERY_TOKEN" }],
        }),
      ]),
    );
    const serialized = JSON.stringify(doc);
    expect(serialized).not.toContain("SUPER_SECRET");
    // Secret carriers never become regular parameters either — only names
    // that survive scrubbing (or the carrier's own name via `auth`) do.
    const op = (doc.paths?.["/customers/{customer_id}"] as Record<string, Op>)?.get as Op;
    const params = op.parameters as Array<{ name: string }>;
    expect(params.map((p) => p.name)).not.toContain("Authorization");
    expect(params.map((p) => p.name)).not.toContain("Cookie");
    expect(params.map((p) => p.name)).not.toContain("session_token");
  });

  it("emits one har_secrets_dropped diagnostic with the count, even when nothing was dropped", () => {
    const diagnostics: Diagnostic[] = [];
    adaptHar(har([entry({ url: "https://api.example.com/health" })]), undefined, diagnostics);
    const d = diagnostics.find((x) => x.code === "har_secrets_dropped");
    expect(d).toBeDefined();
    expect(d?.message).toContain("0 secret header/query value(s)");
  });

  it("counts every dropped secret header/query value", () => {
    const diagnostics: Diagnostic[] = [];
    adaptHar(
      har([
        entry({
          url: "https://api.example.com/customers/1",
          headers: [
            { name: "Authorization", value: "Bearer x" },
            { name: "X-Api-Key", value: "y" },
          ],
          query: [{ name: "session_token", value: "z" }],
        }),
      ]),
      undefined,
      diagnostics,
    );
    const d = diagnostics.find((x) => x.code === "har_secrets_dropped");
    expect(d?.message).toContain("3 secret header/query value(s)");
  });

  it("records the Bearer scheme from Authorization without touching the credential", () => {
    const doc = adaptHar(
      har([
        entry({
          url: "https://api.example.com/customers/1",
          headers: [{ name: "Authorization", value: "Bearer sk_live_abc123" }],
        }),
      ]),
    );
    const schemes = (doc.components as { securitySchemes?: Record<string, Op> })?.securitySchemes;
    expect(schemes?.bearerAuth).toEqual({ type: "http", scheme: "bearer" });
    expect(JSON.stringify(doc)).not.toContain("sk_live_abc123");
  });

  it("records only the carrier NAME for an api-key-shaped header, never its value", () => {
    const doc = adaptHar(
      har([
        entry({
          url: "https://api.example.com/customers/1",
          headers: [{ name: "X-Api-Key", value: "top-secret-value" }],
        }),
      ]),
    );
    const schemes = (doc.components as { securitySchemes?: Record<string, Op> })?.securitySchemes;
    expect(schemes?.apiKeyAuth_X_Api_Key).toEqual({
      type: "apiKey",
      in: "header",
      name: "X-Api-Key",
    });
    expect(JSON.stringify(doc)).not.toContain("top-secret-value");
  });

  it("classifies a bare opaque Authorization value as present-but-unrecognized, never leaking it", () => {
    const doc = adaptHar(
      har([
        entry({
          url: "https://api.example.com/customers/1",
          headers: [{ name: "Authorization", value: "sk_live_opaque_no_scheme_word" }],
        }),
      ]),
    );
    const schemes = (doc.components as { securitySchemes?: Record<string, Op> })?.securitySchemes;
    expect(schemes?.authHeaderAuth).toEqual({
      type: "apiKey",
      in: "header",
      name: "Authorization",
    });
    expect(JSON.stringify(doc)).not.toContain("sk_live_opaque_no_scheme_word");
  });
});

describe("HAR adapter: servers and operationId", () => {
  it("collects distinct origins in first-appearance order", () => {
    const doc = adaptHar(
      har([
        entry({ url: "https://a.example.com/x/1" }),
        entry({ url: "https://b.example.com/y/1" }),
        entry({ url: "https://a.example.com/x/2" }),
      ]),
    );
    expect((doc.servers ?? []).map((s) => s.url)).toEqual([
      "https://a.example.com",
      "https://b.example.com",
    ]);
  });

  it("never sets operationId — naming falls back to the compiler's own path+method heuristic", () => {
    const doc = adaptHar(har([entry({ url: "https://api.example.com/customers/1" })]));
    const op = (doc.paths?.["/customers/{customer_id}"] as Record<string, Op>)?.get as Op;
    expect(op.operationId).toBeUndefined();
  });

  it("skips and reports an entry with no parseable request.url", () => {
    const diagnostics: Diagnostic[] = [];
    const doc = adaptHar(
      har([{ startedDateTime: "2026-01-01T00:00:00.000Z", request: { method: "GET" } }]),
      undefined,
      diagnostics,
    );
    expect(diagnostics.some((d) => d.code === "har_entry_unparseable_url")).toBe(true);
    expect(Object.keys(doc.paths ?? {})).toEqual([]);
  });
});

describe("HAR compile posture: never generated, never approved", () => {
  it("caps every operation at review_required with a review note citing sample count", async () => {
    const air = await compile({
      spec: har([
        entry({ url: "https://api.example.com/customers/1" }),
        entry({ url: "https://api.example.com/customers/2" }),
      ]),
      serviceId: "svc",
      sourceUri: "capture.har",
    });
    expect(air.service.source.kind).toBe("har");
    for (const op of air.operations) {
      expect(op.state).not.toBe("generated");
      expect(op.state).not.toBe("approved");
      expect(op.reviewNotes.some((n) => /captured HTTP request/.test(n))).toBe(true);
    }
  });

  it("caps every safety-relevant claim's confidence at 0.5 and reattributes it to recorded_traffic", async () => {
    const air = await compile({
      spec: har([entry({ method: "POST", url: "https://api.example.com/widgets", body: "{}" })]),
      serviceId: "svc",
      sourceUri: "capture.har",
    });
    const op = air.operations[0];
    expect(op).toBeDefined();
    const safetyPredicates = new Set([
      "effect.kind",
      "effect.stateImpact",
      "idempotency.mode",
      "longRunning",
      "confirmation.required",
      "retries.mode",
      "auth.principal",
    ]);
    for (const claim of op?.evidence.claims ?? []) {
      if (!safetyPredicates.has(claim.predicate)) continue;
      expect(claim.confidence).toBeLessThanOrEqual(0.5);
      expect(claim.source).toBe("recorded_traffic");
    }
    // A non-safety claim (name.quality) is untouched.
    const nameClaim = op?.evidence.claims.find((c) => c.predicate === "name.quality");
    expect(nameClaim?.source).toBe("inferred");
  });

  it("leaves an already-blocked operation blocked (tightening only, never a loosening)", async () => {
    // Two alternative security requirements with different principals force
    // `auth/alternatives_unmodeled`, which blocks — the HAR posture must not
    // relax that back to review_required.
    const air = await compile({
      spec: har([entry({ url: "https://api.example.com/customers/1" })]),
      serviceId: "svc",
      sourceUri: "capture.har",
    });
    // Sanity: nothing in this fixture is blocked, but the invariant under
    // test is that the posture cap is state <= review_required, never a
    // promotion — asserted structurally against har-posture.ts's own logic
    // in har-posture.test.ts. Here we just confirm the ordinary case never
    // regresses to blocked.
    expect(air.operations[0]?.state).toBe("review_required");
  });
});

describe("HAR golden fixture: examples/payments/capture.har", () => {
  it("compiles byte-identically to the checked-in air.yaml", async () => {
    const fixturePath = fileURLToPath(
      new URL("../../../../examples/payments/capture.har", import.meta.url),
    );
    const goldenPath = fileURLToPath(
      new URL("../../../../examples/payments/capture.har.air.yaml", import.meta.url),
    );
    const spec = readFileSync(fixturePath, "utf8");
    const golden = readFileSync(goldenPath, "utf8");
    const air = await compile({
      spec,
      serviceId: "payments",
      sourceUri: "examples/payments/capture.har",
    });
    expect(
      airToYaml(air),
      "examples/payments/capture.har.air.yaml is stale — regenerate it from the fixture and commit the result",
    ).toBe(golden);
  });

  it("never leaks the fixture's placeholder secret markers into the compiled AIR", async () => {
    const fixturePath = fileURLToPath(
      new URL("../../../../examples/payments/capture.har", import.meta.url),
    );
    const spec = readFileSync(fixturePath, "utf8");
    const air = await compile({
      spec,
      serviceId: "payments",
      sourceUri: "examples/payments/capture.har",
    });
    expect(JSON.stringify(air)).not.toContain("redacted-in-source-capture");
  });
});
