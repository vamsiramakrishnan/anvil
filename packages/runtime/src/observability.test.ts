import { describe, expect, it } from "vitest";
import {
  CloudTraceObserver,
  composeObservers,
  type ExecutionRecord,
  InMemoryObserver,
  MetricsObserver,
  OtlpHttpObserver,
  otelSpanId,
  otelTraceId,
  otlpTracesEndpoint,
  parseOtlpHeaders,
  resolveObserver,
  StructuredLogObserver,
} from "./observability.js";

function record(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    traceId: "6f1a2b3c-4d5e-4f60-8a71-829394a5b6c7",
    operationId: "payments.refunds.create",
    effect: "mutation",
    outcome: "success",
    latencyMs: 42,
    retryCount: 1,
    idempotencyKeyPresent: true,
    principalId: "anonymous",
    requestBytes: 120,
    responseBytes: 300,
    policyDecisions: ["pre_execute:allow"],
    confirmationRequired: true,
    confirmed: true,
    ledger: "reserved",
    ...overrides,
  };
}

/** A fetch stub that records every call and answers 200. */
function fakeFetch(calls: Array<{ url: string; init: RequestInit }>, status = 200): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(status === 200 ? "{}" : "nope", { status });
  }) as typeof fetch;
}

describe("ids", () => {
  it("derives a 32-hex trace id from a UUID and a stable 16-hex span id", () => {
    expect(otelTraceId(record().traceId)).toBe("6f1a2b3c4d5e4f608a71829394a5b6c7");
    expect(otelTraceId("not-a-uuid")).toMatch(/^[0-9a-f]{32}$/);
    expect(otelSpanId(record())).toMatch(/^[0-9a-f]{16}$/);
    expect(otelSpanId(record())).toBe(otelSpanId(record()));
    expect(otelSpanId(record({ outcome: "error" }))).not.toBe(otelSpanId(record()));
  });
});

describe("composeObservers", () => {
  it("fans out, drops a throwing sink after its first failure, and reports the primary count", () => {
    const primary = new InMemoryObserver();
    let bad = 0;
    const throwing = {
      onRecord() {
        bad++;
        throw new Error("sink down");
      },
    };
    const composed = composeObservers([primary, throwing]);
    composed.onRecord(record());
    composed.onRecord(record());
    expect(primary.count).toBe(2);
    expect(composed.count).toBe(2);
    expect(bad).toBe(1);
  });
});

describe("MetricsObserver", () => {
  it("renders OpenMetrics counters per operation, outcome, and error code", () => {
    const metrics = new MetricsObserver();
    metrics.onRecord(record());
    metrics.onRecord(record({ outcome: "error", errorCode: "policy_denied", ledger: undefined }));
    metrics.onRecord(record({ operationId: "widgets.list", effect: "read", ledger: "none" }));
    const text = metrics.render();
    expect(text).toContain("anvil_execution_records_total 3");
    expect(text).toContain(
      'anvil_operation_calls_total{operation="payments.refunds.create",effect="mutation",outcome="success",error_code=""} 1',
    );
    expect(text).toContain(
      'anvil_operation_calls_total{operation="payments.refunds.create",effect="mutation",outcome="error",error_code="policy_denied"} 1',
    );
    expect(text).toContain('anvil_ledger_outcomes_total{ledger="reserved"} 1');
    expect(text).toContain('anvil_policy_denied_total{operation="payments.refunds.create"} 1');
    expect(text).toContain("anvil_operation_latency_ms_sum{");
    expect(text.trimEnd().endsWith("# EOF")).toBe(true);
    // Labels never carry a principal, trace id, or endpoint.
    expect(text).not.toContain("anonymous");
    expect(text).not.toContain("6f1a2b3c");
  });
});

describe("StructuredLogObserver", () => {
  it("writes one JSON line per record with severity and the Cloud Logging trace key", () => {
    const lines: string[] = [];
    const log = new StructuredLogObserver({
      write: (l) => lines.push(l),
      projectId: "acme-prod",
      now: () => 1_700_000_000_000,
    });
    log.onRecord(record());
    log.onRecord(record({ outcome: "error", errorCode: "upstream_unavailable" }));
    log.onRecord(record({ outcome: "error", errorCode: "policy_denied" }));
    expect(lines).toHaveLength(3);
    const first = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(first.severity).toBe("INFO");
    expect(first.time).toBe("2023-11-14T22:13:20.000Z");
    expect(first.operationId).toBe("payments.refunds.create");
    expect(first["logging.googleapis.com/trace"]).toBe(
      "projects/acme-prod/traces/6f1a2b3c4d5e4f608a71829394a5b6c7",
    );
    expect((JSON.parse(lines[1] ?? "{}") as { severity: string }).severity).toBe("ERROR");
    expect((JSON.parse(lines[2] ?? "{}") as { severity: string }).severity).toBe("WARNING");
    expect(log.count).toBe(3);
  });
});

describe("OtlpHttpObserver", () => {
  it("posts an OTLP/HTTP JSON trace export with one client span per record", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const otlp = new OtlpHttpObserver({
      endpoint: "http://collector:4318/v1/traces",
      headers: { authorization: "Api-Key k" },
      serviceName: "payments",
      serviceVersion: "1.2.3",
      fetchImpl: fakeFetch(calls),
      now: () => 1_700_000_000_042,
    });
    otlp.onRecord(record());
    otlp.onRecord(record({ outcome: "error", errorCode: "upstream_timeout" }));
    await otlp.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://collector:4318/v1/traces");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Api-Key k");
    const body = JSON.parse(String(calls[0]?.init.body)) as {
      resourceSpans: Array<{
        resource: { attributes: Array<{ key: string; value: { stringValue: string } }> };
        scopeSpans: Array<{
          spans: Array<{
            traceId: string;
            spanId: string;
            name: string;
            kind: number;
            startTimeUnixNano: string;
            endTimeUnixNano: string;
            status: { code: number; message?: string };
            attributes: Array<{ key: string; value: Record<string, unknown> }>;
          }>;
        }>;
      }>;
    };
    const resource = body.resourceSpans[0]?.resource.attributes ?? [];
    expect(resource.find((a) => a.key === "service.name")?.value.stringValue).toBe("payments");
    expect(resource.find((a) => a.key === "service.version")?.value.stringValue).toBe("1.2.3");
    const spans = body.resourceSpans[0]?.scopeSpans[0]?.spans ?? [];
    expect(spans).toHaveLength(2);
    expect(spans[0]?.traceId).toBe("6f1a2b3c4d5e4f608a71829394a5b6c7");
    expect(spans[0]?.name).toBe("payments.refunds.create");
    expect(spans[0]?.kind).toBe(3);
    expect(spans[0]?.endTimeUnixNano).toBe("1700000000042000000");
    expect(spans[0]?.startTimeUnixNano).toBe("1700000000000000000");
    expect(spans[0]?.status.code).toBe(1);
    expect(spans[1]?.status).toEqual({ code: 2, message: "upstream_timeout" });
    const attr = (key: string) => spans[0]?.attributes.find((a) => a.key === key)?.value;
    expect(attr("anvil.effect")).toEqual({ stringValue: "mutation" });
    expect(attr("anvil.retry_count")).toEqual({ intValue: "1" });
    expect(attr("anvil.confirmed")).toEqual({ boolValue: true });
    expect(otlp.dropped).toBe(0);
  });

  it("drops a failed batch without throwing and keeps serving", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const otlp = new OtlpHttpObserver({
      endpoint: "http://collector:4318/v1/traces",
      serviceName: "payments",
      fetchImpl: fakeFetch(calls, 503),
    });
    otlp.onRecord(record());
    await otlp.flush();
    expect(otlp.dropped).toBe(1);
    expect(otlp.count).toBe(1);
  });

  it("flushes on its own once a batch fills", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const otlp = new OtlpHttpObserver({
      endpoint: "http://collector:4318/v1/traces",
      serviceName: "payments",
      fetchImpl: fakeFetch(calls),
      batchSize: 2,
    });
    otlp.onRecord(record());
    otlp.onRecord(record());
    await otlp.flush();
    expect(calls).toHaveLength(1);
  });

  it("reads the standard OTLP environment variables", () => {
    expect(otlpTracesEndpoint({})).toBeUndefined();
    expect(otlpTracesEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318/" })).toBe(
      "http://c:4318/v1/traces",
    );
    expect(
      otlpTracesEndpoint({
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318",
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://t:4318/custom",
      }),
    ).toBe("http://t:4318/custom");
    expect(parseOtlpHeaders("api-key=abc%20def,x=1")).toEqual({ "api-key": "abc def", x: "1" });
  });
});

describe("CloudTraceObserver", () => {
  it("batch-writes v2 spans with a metadata-server bearer, resolving the project once", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, init: init ?? {} });
      if (u.endsWith("/project/project-id")) return new Response("acme-prod", { status: 200 });
      if (u.endsWith("/token")) {
        return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), {
          status: 200,
        });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const cloud = new CloudTraceObserver({ serviceName: "payments", fetchImpl, now: () => 1_000 });
    cloud.onRecord(record());
    await cloud.flush();
    cloud.onRecord(record());
    await cloud.flush();
    const writes = calls.filter((c) => c.url.includes("traces:batchWrite"));
    expect(writes).toHaveLength(2);
    expect(writes[0]?.url).toBe(
      "https://cloudtrace.googleapis.com/v2/projects/acme-prod/traces:batchWrite",
    );
    const firstWrite = writes[0] as { url: string; init: RequestInit };
    expect((firstWrite.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    // Project and token are cached across batches.
    expect(calls.filter((c) => c.url.endsWith("/project/project-id"))).toHaveLength(1);
    expect(calls.filter((c) => c.url.endsWith("/token"))).toHaveLength(1);
    const body = JSON.parse(String(writes[0]?.init.body)) as {
      spans: Array<{ name: string; spanKind: string; displayName: { value: string } }>;
    };
    expect(body.spans[0]?.name).toMatch(
      /^projects\/acme-prod\/traces\/6f1a2b3c4d5e4f608a71829394a5b6c7\/spans\/[0-9a-f]{16}$/,
    );
    expect(body.spans[0]?.spanKind).toBe("CLIENT");
    expect(body.spans[0]?.displayName.value).toBe("payments.refunds.create");
  });
});

describe("resolveObserver", () => {
  it("defaults to memory and always attaches metrics", () => {
    const r = resolveObserver({ serviceName: "s", env: {} });
    expect(r.exporter).toBe("memory");
    r.observer.onRecord(record());
    expect(r.observer.count).toBe(1);
    expect(r.metrics.count).toBe(1);
  });

  it("refuses an exporter that does not exist instead of silently exporting nothing", () => {
    expect(() => resolveObserver({ serviceName: "s", env: {}, exporter: "cloud_tracing" })).toThrow(
      /ANVIL_OTEL_EXPORTER="cloud_tracing" is not one of/,
    );
  });

  it("refuses otlp without an endpoint", () => {
    expect(() => resolveObserver({ serviceName: "s", env: {}, exporter: "otlp" })).toThrow(
      /requires OTEL_EXPORTER_OTLP_TRACES_ENDPOINT/,
    );
  });

  it("selects stdout and threads the project id from the standard env", () => {
    const lines: string[] = [];
    const r = resolveObserver({
      serviceName: "s",
      exporter: "stdout",
      env: { GOOGLE_CLOUD_PROJECT: "acme" },
      write: (l) => lines.push(l),
    });
    expect(r.exporter).toBe("stdout");
    r.observer.onRecord(record());
    expect(lines[0]).toContain('"logging.googleapis.com/trace":"projects/acme/traces/');
  });
});
