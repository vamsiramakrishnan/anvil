import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ErrorCode } from "@anvil/air";

/**
 * The execution record (spec §15). Every call emits one. It is OpenTelemetry-
 * shaped (a span with attributes) but transport-neutral so it can be exported
 * to Cloud Trace/Logging, OTLP, or captured in tests. Never contains secrets.
 */
export interface ExecutionRecord {
  traceId: string;
  operationId: string;
  effect: "read" | "mutation";
  upstreamEndpoint?: string;
  outcome: "success" | "error" | "dry_run";
  latencyMs: number;
  retryCount: number;
  idempotencyKeyPresent: boolean;
  authProfile?: string;
  /**
   * WHO called (fleet runtime): the resolved `Principal.id`, never the
   * bearer token or `ANVIL_PRINCIPAL` value that resolved it. `"anonymous"`
   * when no principal directory is configured — the default.
   */
  principalId: string;
  errorCode?: ErrorCode;
  requestBytes: number;
  responseBytes: number;
  /** Decisions made by policy hooks, in order (e.g. "pre_execute:allow"). */
  policyDecisions: string[];
  confirmationRequired: boolean;
  confirmed: boolean;
  ledger?: "reserved" | "replay" | "in_progress" | "conflict" | "none";
}

/** Sink for execution records. Wire this to OTel/Cloud Trace in production. */
export interface Observer {
  onRecord(record: ExecutionRecord): void;
}

/** Collects records in memory — used by tests and `/metrics`. */
export class InMemoryObserver implements Observer {
  readonly records: ExecutionRecord[] = [];
  onRecord(record: ExecutionRecord): void {
    this.records.push(record);
  }
  /** Same property the spool exposes, so /metrics reads one shape. */
  get count(): number {
    return this.records.length;
  }
}

export const noopObserver: Observer = { onRecord() {} };

/**
 * Spools every execution record to newline-delimited JSON on disk, one file
 * per process, so `anvil observe --from-records` can fold real traffic back
 * into evidence. Records are the flywheel's raw material: they carry outcomes,
 * error codes, retry and ledger behaviour — and no secrets, no payloads, by
 * `ExecutionRecord`'s own contract — so a deployed bundle that spools becomes
 * a sensor for the model it was compiled from.
 *
 * Each line is stamped with the wall-clock time at write, which the record
 * itself deliberately does not carry. Write failures are swallowed after the
 * first: an observability sink must never take down the serving path, and a
 * spool that starts failing mid-flight (disk full, volume gone) degrades to
 * exactly what not configuring it would have been.
 */
export class JsonlRecordSpool implements Observer {
  private readonly file: string;
  private broken = false;
  /** Records written so far — the serving path's /metrics reads this. */
  count = 0;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, `records-${process.pid}-${Date.now()}.jsonl`);
  }

  onRecord(record: ExecutionRecord): void {
    if (this.broken) return;
    try {
      appendFileSync(this.file, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
      this.count++;
    } catch {
      this.broken = true;
    }
  }
}

/**
 * Fan one record out to every sink. A sink that throws is dropped after its
 * first failure, exactly as `JsonlRecordSpool` degrades: an observability
 * sink must never take down the serving path. `count` reads the first sink's
 * count when it has one, so `/metrics` keeps one shape.
 */
export function composeObservers(sinks: readonly Observer[]): Observer & { count: number } {
  const live = new Set(sinks);
  const primary = sinks[0] as (Observer & { count?: number }) | undefined;
  return {
    onRecord(record) {
      for (const sink of live) {
        try {
          sink.onRecord(record);
        } catch {
          live.delete(sink);
        }
      }
    },
    get count(): number {
      return typeof primary?.count === "number" ? primary.count : 0;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Metrics                                                                    */
/* -------------------------------------------------------------------------- */

interface MetricSeries {
  operationId: string;
  effect: ExecutionRecord["effect"];
  outcome: ExecutionRecord["outcome"];
  errorCode: string;
  calls: number;
  retries: number;
  latencyMsSum: number;
  requestBytes: number;
  responseBytes: number;
}

/**
 * Aggregates records into per-operation counters and renders them as
 * OpenMetrics text, so `/metrics` can be scraped by Prometheus, a Cloud Run
 * sidecar collector, or anything else that speaks the exposition format.
 * Labels are the record's own low-cardinality facts (operation, effect,
 * outcome, error code) — never a principal, a trace id, or an endpoint.
 */
export class MetricsObserver implements Observer {
  private readonly series = new Map<string, MetricSeries>();
  private readonly ledger = new Map<string, number>();
  private readonly policyDenied = new Map<string, number>();
  count = 0;

  onRecord(record: ExecutionRecord): void {
    this.count++;
    const errorCode = record.errorCode ?? "";
    const key = `${record.operationId}\0${record.effect}\0${record.outcome}\0${errorCode}`;
    let s = this.series.get(key);
    if (!s) {
      s = {
        operationId: record.operationId,
        effect: record.effect,
        outcome: record.outcome,
        errorCode,
        calls: 0,
        retries: 0,
        latencyMsSum: 0,
        requestBytes: 0,
        responseBytes: 0,
      };
      this.series.set(key, s);
    }
    s.calls++;
    s.retries += record.retryCount;
    s.latencyMsSum += record.latencyMs;
    s.requestBytes += record.requestBytes;
    s.responseBytes += record.responseBytes;
    if (record.ledger && record.ledger !== "none") {
      this.ledger.set(record.ledger, (this.ledger.get(record.ledger) ?? 0) + 1);
    }
    if (record.errorCode === "policy_denied") {
      this.policyDenied.set(
        record.operationId,
        (this.policyDenied.get(record.operationId) ?? 0) + 1,
      );
    }
  }

  /** The OpenMetrics text exposition of everything recorded so far. */
  render(): string {
    const lines: string[] = [];
    const label = (s: MetricSeries): string =>
      `operation="${esc(s.operationId)}",effect="${s.effect}",outcome="${s.outcome}",error_code="${esc(s.errorCode)}"`;
    const series = [...this.series.values()].sort((a, b) =>
      `${a.operationId}${a.outcome}${a.errorCode}`.localeCompare(
        `${b.operationId}${b.outcome}${b.errorCode}`,
      ),
    );
    lines.push(
      "# TYPE anvil_execution_records counter",
      "# HELP anvil_execution_records Execution records emitted by the safety runtime.",
      `anvil_execution_records_total ${this.count}`,
      "# TYPE anvil_operation_calls counter",
      "# HELP anvil_operation_calls Calls per operation, outcome, and error code.",
    );
    for (const s of series) lines.push(`anvil_operation_calls_total{${label(s)}} ${s.calls}`);
    lines.push(
      "# TYPE anvil_operation_retries counter",
      "# HELP anvil_operation_retries Retry attempts the runtime made per operation.",
    );
    for (const s of series) lines.push(`anvil_operation_retries_total{${label(s)}} ${s.retries}`);
    lines.push(
      "# TYPE anvil_operation_latency_ms summary",
      "# HELP anvil_operation_latency_ms Wall-clock latency of each call in milliseconds.",
    );
    for (const s of series) {
      lines.push(
        `anvil_operation_latency_ms_sum{${label(s)}} ${s.latencyMsSum}`,
        `anvil_operation_latency_ms_count{${label(s)}} ${s.calls}`,
      );
    }
    lines.push(
      "# TYPE anvil_operation_bytes counter",
      "# HELP anvil_operation_bytes Request and response bytes per operation.",
    );
    for (const s of series) {
      lines.push(
        `anvil_operation_bytes_total{${label(s)},direction="request"} ${s.requestBytes}`,
        `anvil_operation_bytes_total{${label(s)},direction="response"} ${s.responseBytes}`,
      );
    }
    lines.push(
      "# TYPE anvil_ledger_outcomes counter",
      "# HELP anvil_ledger_outcomes Idempotency ledger outcomes (reserved, replay, in_progress, conflict).",
    );
    for (const [outcome, n] of [...this.ledger.entries()].sort()) {
      lines.push(`anvil_ledger_outcomes_total{ledger="${outcome}"} ${n}`);
    }
    lines.push(
      "# TYPE anvil_policy_denied counter",
      "# HELP anvil_policy_denied Calls refused by a policy hook, per operation.",
    );
    for (const [operation, n] of [...this.policyDenied.entries()].sort()) {
      lines.push(`anvil_policy_denied_total{operation="${esc(operation)}"} ${n}`);
    }
    lines.push("# EOF");
    return `${lines.join("\n")}\n`;
  }
}

export const OPENMETRICS_CONTENT_TYPE =
  "application/openmetrics-text; version=1.0.0; charset=utf-8";

function esc(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/* -------------------------------------------------------------------------- */
/* Structured log exporter                                                    */
/* -------------------------------------------------------------------------- */

export interface StructuredLogOptions {
  /** Where each line goes. Defaults to `process.stdout`. */
  write?: (line: string) => void;
  /** When set, lines carry the Cloud Logging trace key so they correlate with Cloud Trace. */
  projectId?: string;
  now?: () => number;
}

/**
 * One JSON line per record, in the shape structured-logging agents parse
 * (`severity`, `message`, `time`, and — with a project — the Cloud Logging
 * `logging.googleapis.com/trace` key). Cloud Run, GKE, and most log agents
 * turn stdout JSON into structured entries, so this exporter needs no SDK
 * and survives a distroless image. The record's own secret-free contract is
 * the whole redaction story: nothing beyond its fields is written.
 */
export class StructuredLogObserver implements Observer {
  private readonly write: (line: string) => void;
  private readonly projectId?: string;
  private readonly now: () => number;
  private broken = false;
  count = 0;

  constructor(options: StructuredLogOptions = {}) {
    this.write = options.write ?? ((line) => process.stdout.write(`${line}\n`));
    this.projectId = options.projectId;
    this.now = options.now ?? Date.now;
  }

  onRecord(record: ExecutionRecord): void {
    if (this.broken) return;
    const severity =
      record.outcome === "error"
        ? record.errorCode === "policy_denied" || record.errorCode === "confirmation_required"
          ? "WARNING"
          : "ERROR"
        : "INFO";
    const entry: Record<string, unknown> = {
      severity,
      time: new Date(this.now()).toISOString(),
      message: `${record.operationId} ${record.outcome}${record.errorCode ? ` ${record.errorCode}` : ""} ${record.latencyMs}ms`,
      ...record,
    };
    if (this.projectId) {
      entry["logging.googleapis.com/trace"] =
        `projects/${this.projectId}/traces/${otelTraceId(record.traceId)}`;
    }
    try {
      this.write(JSON.stringify(entry));
      this.count++;
    } catch {
      this.broken = true;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Span shaping shared by the OTLP and Cloud Trace exporters                  */
/* -------------------------------------------------------------------------- */

/** A 32-hex trace id: the record's UUID with dashes removed, else a digest of it. */
export function otelTraceId(traceId: string): string {
  const compact = traceId.replace(/-/g, "").toLowerCase();
  if (/^[0-9a-f]{32}$/.test(compact)) return compact;
  return createHash("sha256").update(traceId).digest("hex").slice(0, 32);
}

/** A 16-hex span id derived from the record, stable for the same call. */
export function otelSpanId(record: ExecutionRecord): string {
  return createHash("sha256")
    .update(`${record.traceId}\0${record.operationId}\0${record.outcome}`)
    .digest("hex")
    .slice(0, 16);
}

/** The attribute set every span exporter emits — the record, minus nothing, plus nothing. */
export function spanAttributes(record: ExecutionRecord): Record<string, string | number | boolean> {
  const attrs: Record<string, string | number | boolean> = {
    "anvil.operation_id": record.operationId,
    "anvil.effect": record.effect,
    "anvil.outcome": record.outcome,
    "anvil.retry_count": record.retryCount,
    "anvil.idempotency_key_present": record.idempotencyKeyPresent,
    "anvil.principal_id": record.principalId,
    "anvil.confirmation_required": record.confirmationRequired,
    "anvil.confirmed": record.confirmed,
    "anvil.request_bytes": record.requestBytes,
    "anvil.response_bytes": record.responseBytes,
    "anvil.policy_decisions": record.policyDecisions.join(","),
  };
  if (record.upstreamEndpoint) attrs["anvil.upstream_endpoint"] = record.upstreamEndpoint;
  if (record.authProfile) attrs["anvil.auth_profile"] = record.authProfile;
  if (record.errorCode) attrs["anvil.error_code"] = record.errorCode;
  if (record.ledger) attrs["anvil.ledger"] = record.ledger;
  return attrs;
}

interface BatchingOptions {
  /** Flush when this many records are pending. Default 64. */
  batchSize?: number;
  /** Flush at least this often while records are pending. Default 5000 ms. */
  flushIntervalMs?: number;
  /** Per-export deadline. Default 10000 ms. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * The batching skeleton both network exporters share: records queue in
 * memory, an unref'd timer or a full batch triggers one bounded POST, and a
 * failed export drops that batch (counted in `dropped`) without ever
 * throwing into the serving path. `flush()` is awaited by the surface's
 * shutdown so the last batch leaves before the process does.
 */
abstract class BatchingExporter implements Observer {
  protected readonly fetchImpl: typeof fetch;
  protected readonly timeoutMs: number;
  protected readonly now: () => number;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private pending: Array<{ record: ExecutionRecord; endEpochMs: number }> = [];
  private timer: NodeJS.Timeout | undefined;
  private inflight: Promise<void> = Promise.resolve();
  count = 0;
  /** Records that could not be exported. */
  dropped = 0;

  constructor(options: BatchingOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.now = options.now ?? Date.now;
    this.batchSize = options.batchSize ?? 64;
    this.flushIntervalMs = options.flushIntervalMs ?? 5_000;
  }

  onRecord(record: ExecutionRecord): void {
    this.count++;
    this.pending.push({ record, endEpochMs: this.now() });
    if (this.pending.length >= this.batchSize) {
      void this.flush();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), this.flushIntervalMs);
      this.timer.unref();
    }
  }

  /** Export everything pending. Never rejects. */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const batch = this.pending;
    this.pending = [];
    if (batch.length === 0) return this.inflight;
    this.inflight = this.inflight.then(async () => {
      try {
        await this.export(batch);
      } catch {
        this.dropped += batch.length;
      }
    });
    return this.inflight;
  }

  protected abstract export(
    batch: ReadonlyArray<{ record: ExecutionRecord; endEpochMs: number }>,
  ): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* OTLP/HTTP exporter                                                         */
/* -------------------------------------------------------------------------- */

export interface OtlpHttpOptions extends BatchingOptions {
  /** The traces endpoint. Defaults from `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` / `OTEL_EXPORTER_OTLP_ENDPOINT`. */
  endpoint: string;
  /** Extra headers (`OTEL_EXPORTER_OTLP_HEADERS` form: `k=v,k2=v2`). */
  headers?: Record<string, string>;
  serviceName: string;
  serviceVersion?: string;
}

/**
 * OTLP/HTTP with JSON encoding (the OpenTelemetry protocol's own JSON
 * mapping of `ExportTraceServiceRequest`), which every collector accepts on
 * `/v1/traces`. Implemented on `fetch` so the runtime takes no SDK dependency
 * and the deployed image stays as it is. Standard `OTEL_EXPORTER_OTLP_*`
 * environment variables configure it, so an operator who already runs a
 * collector (the Cloud Run OpenTelemetry sidecar, for one) points it there
 * and nothing else changes.
 */
export class OtlpHttpObserver extends BatchingExporter {
  private readonly endpoint: string;
  private readonly headers: Record<string, string>;
  private readonly resource: Array<{ key: string; value: { stringValue: string } }>;

  constructor(options: OtlpHttpOptions) {
    super(options);
    this.endpoint = options.endpoint;
    this.headers = options.headers ?? {};
    this.resource = [
      { key: "service.name", value: { stringValue: options.serviceName } },
      ...(options.serviceVersion
        ? [{ key: "service.version", value: { stringValue: options.serviceVersion } }]
        : []),
      { key: "telemetry.sdk.name", value: { stringValue: "anvil-runtime" } },
    ];
  }

  protected async export(
    batch: ReadonlyArray<{ record: ExecutionRecord; endEpochMs: number }>,
  ): Promise<void> {
    const body = {
      resourceSpans: [
        {
          resource: { attributes: this.resource },
          scopeSpans: [
            {
              scope: { name: "anvil.runtime" },
              spans: batch.map(({ record, endEpochMs }) => ({
                traceId: otelTraceId(record.traceId),
                spanId: otelSpanId(record),
                name: record.operationId,
                kind: 3, // SPAN_KIND_CLIENT — the runtime calls the upstream.
                startTimeUnixNano: nanos(endEpochMs - record.latencyMs),
                endTimeUnixNano: nanos(endEpochMs),
                attributes: Object.entries(spanAttributes(record)).map(([key, v]) => ({
                  key,
                  value:
                    typeof v === "boolean"
                      ? { boolValue: v }
                      : typeof v === "number"
                        ? { intValue: String(Math.trunc(v)) }
                        : { stringValue: v },
                })),
                status:
                  record.outcome === "error"
                    ? { code: 2, message: record.errorCode ?? "error" }
                    : { code: 1 },
              })),
            },
          ],
        },
      ],
    };
    const res = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`OTLP export failed (${res.status})`);
  }
}

function nanos(epochMs: number): string {
  return `${Math.max(0, Math.trunc(epochMs))}000000`;
}

/** Parse `OTEL_EXPORTER_OTLP_HEADERS` (`k=v,k2=v2`, values URL-encoded per the spec). */
export function parseOtlpHeaders(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const pair of raw.split(",")) {
    const at = pair.indexOf("=");
    if (at <= 0) continue;
    const key = pair.slice(0, at).trim();
    const value = pair.slice(at + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

/** The OTLP traces endpoint the standard env vars name, or `undefined` when neither is set. */
export function otlpTracesEndpoint(env: NodeJS.ProcessEnv): string | undefined {
  const explicit = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  if (explicit) return explicit;
  const base = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!base) return undefined;
  return `${base.replace(/\/+$/, "")}/v1/traces`;
}

/* -------------------------------------------------------------------------- */
/* Cloud Trace exporter                                                       */
/* -------------------------------------------------------------------------- */

const GCP_METADATA_ROOT = "http://metadata.google.internal/computeMetadata/v1";

export interface CloudTraceOptions extends BatchingOptions {
  /** Defaults from `GOOGLE_CLOUD_PROJECT` / `GCLOUD_PROJECT` / `ANVIL_SECRET_PROJECT`, else the metadata server. */
  projectId?: string;
  serviceName: string;
  /** Test seam. Production mints a token from the metadata server, exactly as the Firestore ledger does. */
  accessToken?: () => Promise<string>;
}

/**
 * Cloud Trace v2 `traces:batchWrite` over REST, authenticated with the same
 * metadata-server token the Firestore ledger already mints — so the
 * `ANVIL_OTEL_EXPORTER=cloud_trace` the generated Terraform has set for every
 * deployment now writes spans instead of being read into config and ignored.
 */
export class CloudTraceObserver extends BatchingExporter {
  private projectId?: string;
  private readonly serviceName: string;
  private readonly mintToken: () => Promise<string>;
  private token?: { value: string; expEpochMs: number };

  constructor(options: CloudTraceOptions) {
    super(options);
    this.projectId = options.projectId;
    this.serviceName = options.serviceName;
    this.mintToken = options.accessToken ?? (() => this.metadataToken());
  }

  protected async export(
    batch: ReadonlyArray<{ record: ExecutionRecord; endEpochMs: number }>,
  ): Promise<void> {
    const project = await this.resolveProject();
    const token = await this.mintToken();
    const spans = batch.map(({ record, endEpochMs }) => {
      const traceId = otelTraceId(record.traceId);
      const spanId = otelSpanId(record);
      const attributeMap: Record<string, unknown> = {
        "service.name": { stringValue: { value: this.serviceName } },
      };
      for (const [key, v] of Object.entries(spanAttributes(record))) {
        attributeMap[key] =
          typeof v === "boolean"
            ? { boolValue: v }
            : typeof v === "number"
              ? { intValue: String(Math.trunc(v)) }
              : { stringValue: { value: v.slice(0, 256) } };
      }
      return {
        name: `projects/${project}/traces/${traceId}/spans/${spanId}`,
        spanId,
        displayName: { value: record.operationId.slice(0, 128) },
        startTime: new Date(endEpochMs - record.latencyMs).toISOString(),
        endTime: new Date(endEpochMs).toISOString(),
        spanKind: "CLIENT",
        attributes: { attributeMap },
        ...(record.outcome === "error"
          ? { status: { code: 2, message: record.errorCode ?? "error" } }
          : {}),
      };
    });
    const res = await this.fetchImpl(
      `https://cloudtrace.googleapis.com/v2/projects/${project}/traces:batchWrite`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ spans }),
        signal: AbortSignal.timeout(this.timeoutMs),
      },
    );
    if (!res.ok) throw new Error(`Cloud Trace export failed (${res.status})`);
  }

  private async resolveProject(): Promise<string> {
    if (this.projectId) return this.projectId;
    const res = await this.fetchImpl(`${GCP_METADATA_ROOT}/project/project-id`, {
      headers: { "metadata-flavor": "Google" },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`Cloud Trace project lookup failed (${res.status})`);
    const project = (await res.text()).trim();
    if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project)) {
      throw new Error("Cloud Trace project lookup returned an invalid project id.");
    }
    this.projectId = project;
    return project;
  }

  private async metadataToken(): Promise<string> {
    if (this.token && this.now() < this.token.expEpochMs) return this.token.value;
    const res = await this.fetchImpl(
      `${GCP_METADATA_ROOT}/instance/service-accounts/default/token`,
      {
        headers: { "metadata-flavor": "Google" },
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      },
    );
    if (!res.ok) throw new Error(`Cloud Trace credential acquisition failed (${res.status}).`);
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token)
      throw new Error("Cloud Trace credential acquisition returned no token.");
    const ttlMs = Math.max(0, (body.expires_in ?? 3600) * 1000 - 60_000);
    this.token = { value: body.access_token, expEpochMs: this.now() + ttlMs };
    return body.access_token;
  }
}

/* -------------------------------------------------------------------------- */
/* Exporter selection                                                         */
/* -------------------------------------------------------------------------- */

export const OTEL_EXPORTERS = ["memory", "stdout", "otlp", "cloud_trace"] as const;
export type OtelExporter = (typeof OTEL_EXPORTERS)[number];

export interface ResolveObserverOptions {
  /** `ANVIL_OTEL_EXPORTER`. Absent or empty selects `memory`. */
  exporter?: string;
  /** `ANVIL_RECORDS_DIR`: spool every record to JSONL beside whatever exporter is chosen. */
  recordsDir?: string;
  serviceName: string;
  serviceVersion?: string;
  env?: NodeJS.ProcessEnv;
  /** Test seams for the exporters. */
  fetchImpl?: typeof fetch;
  write?: (line: string) => void;
  accessToken?: () => Promise<string>;
}

export interface ResolvedObserver {
  /** Which exporter was selected. */
  exporter: OtelExporter;
  /** The sink every record goes to (exporter + spool + metrics, fanned out). */
  observer: Observer & { count: number };
  /** The per-operation counters `/metrics` renders. */
  metrics: MetricsObserver;
  /** The exporter itself, when it batches — awaited on shutdown. */
  flush: () => Promise<void>;
}

/**
 * Choose the execution-record sinks for a serving process from configuration.
 * Precedence: the exporter named by `ANVIL_OTEL_EXPORTER` (`memory` when
 * unset), plus the JSONL spool when `ANVIL_RECORDS_DIR` is set, plus the
 * always-on metrics counters. An unknown exporter name throws — the serving
 * path must never boot believing traces are exported when they are not,
 * which is exactly what reading `otelExporter` into config and consuming it
 * nowhere used to do. The `otlp` exporter also refuses to boot without an
 * endpoint (`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` or `OTEL_EXPORTER_OTLP_ENDPOINT`).
 */
export function resolveObserver(options: ResolveObserverOptions): ResolvedObserver {
  const env = options.env ?? process.env;
  const raw = options.exporter?.trim() ?? "";
  const exporter: string = raw === "" || raw === "none" ? "memory" : raw;
  if (!(OTEL_EXPORTERS as readonly string[]).includes(exporter)) {
    throw new Error(
      `ANVIL_OTEL_EXPORTER="${raw}" is not one of ${OTEL_EXPORTERS.join("|")}. Refusing to serve with an exporter that does not exist.`,
    );
  }
  const metrics = new MetricsObserver();
  const sinks: Observer[] = [];
  let flush: () => Promise<void> = () => Promise.resolve();
  const projectId =
    env.GOOGLE_CLOUD_PROJECT?.trim() ||
    env.GCLOUD_PROJECT?.trim() ||
    env.ANVIL_SECRET_PROJECT?.trim();
  switch (exporter as OtelExporter) {
    case "memory":
      sinks.push(new InMemoryObserver());
      break;
    case "stdout":
      sinks.push(
        new StructuredLogObserver({
          ...(options.write ? { write: options.write } : {}),
          ...(projectId ? { projectId } : {}),
        }),
      );
      break;
    case "otlp": {
      const endpoint = otlpTracesEndpoint(env);
      if (!endpoint) {
        throw new Error(
          "ANVIL_OTEL_EXPORTER=otlp requires OTEL_EXPORTER_OTLP_TRACES_ENDPOINT or OTEL_EXPORTER_OTLP_ENDPOINT.",
        );
      }
      const otlp = new OtlpHttpObserver({
        endpoint,
        headers: parseOtlpHeaders(env.OTEL_EXPORTER_OTLP_HEADERS),
        serviceName: options.serviceName,
        serviceVersion: options.serviceVersion,
        fetchImpl: options.fetchImpl,
      });
      sinks.push(otlp);
      flush = () => otlp.flush();
      break;
    }
    case "cloud_trace": {
      const cloud = new CloudTraceObserver({
        ...(projectId ? { projectId } : {}),
        serviceName: options.serviceName,
        fetchImpl: options.fetchImpl,
        accessToken: options.accessToken,
      });
      sinks.push(cloud);
      flush = () => cloud.flush();
      break;
    }
  }
  if (options.recordsDir) sinks.push(new JsonlRecordSpool(options.recordsDir));
  sinks.push(metrics);
  return { exporter: exporter as OtelExporter, observer: composeObservers(sinks), metrics, flush };
}
