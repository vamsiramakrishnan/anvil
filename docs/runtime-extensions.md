# Runtime extensions and telemetry

Every serving surface Anvil generates boots through one composition root:
the deployed `runtime/server.js`, the generated `mcp/server.js` (stdio) and
`mcp/server-sse.js`, `anvil serve mcp`, and the generated CLI's direct
execution path. That root loads operator extensions first, then the
execution-record exporter, then the transport, credentials, and idempotency
ledger. This page describes what an operator can plug in and how to observe
what a running bundle does.

Extensions are operator-owned code in the operator's own process, like the
credentials they run beside. They are never agent input. A hook can refuse a
call, record a decision, or shape the outbound request. It cannot skip the
approval, confirmation, idempotency, principal, or egress gates, which run
before any hook.

## Configure

| Variable | Effect |
| --- | --- |
| `ANVIL_EXTENSIONS` | Comma- or semicolon-separated ES module specifiers, loaded in order at boot. A file path (absolute, or relative to the working directory) or a package name. |
| `ANVIL_POLICY_BUNDLE` | One more module, conventionally policy-only, loaded after `ANVIL_EXTENSIONS`. Same contract. |
| `ANVIL_OTEL_EXPORTER` | `memory` (default), `stdout`, `otlp`, or `cloud_trace`. See [Export records](#export-records). |
| `ANVIL_RECORDS_DIR` | Spool every record to JSONL beside the exporter, for `anvil observe --from-records`. |

A module that cannot be imported, exports a malformed shape, or tries to
replace a built-in backend refuses the boot. A server never starts believing
a policy is installed when it is not. Every loaded module is reported on
`/healthz` with its name, what it contributed, and the sha256 of its file.

## Write an extension

A module default-exports either an extension object or a function that
receives the runtime api and returns one. The function form needs no import
of `@anvil/runtime`, which matters in the distroless production image where
no packages resolve.

```js
// extensions/acme-guard.mjs
export default (api) => ({
  name: "acme-guard",
  policy: {
    // preAuth runs after the safety gates and before any credential is read.
    preAuth(ctx) {
      ctx.decide("acme_guard:checked");
      if (ctx.operation.effect.kind === "mutation" && ctx.input.region === "restricted") {
        api.denyPolicy(ctx, "Mutations in the restricted region need a change ticket.");
      }
    },
    // postResponse sees the upstream response; record, never rewrite.
    postResponse(ctx) {
      if (ctx.response && ctx.response.status >= 500) ctx.decide("upstream:5xx");
    },
  },
  observer: {
    onRecord(record) {
      // record is secret-free by contract: outcome, latency, retry count,
      // idempotency presence, principal id, policy decisions, ledger outcome.
      auditSink.write(record);
    },
  },
  ledgers: {
    // ANVIL_LEDGER=postgres://... now selects this backend.
    postgres: (uri) => new PostgresLedger(uri),
  },
  credentials: {
    // ANVIL_CREDENTIALS=vault now selects this resolver.
    vault: (config) => new VaultResolver(config.secretProject),
  },
  // Wrap the upstream transport: an egress proxy, a recorder, a circuit breaker.
  transport: (base) => ({ send: (request) => base.send(withProxyHeaders(request)) }),
});
```

| Field | Contract |
| --- | --- |
| `name` | Required. Recorded on `/healthz` and in the boot log. Must be unique across loaded modules. |
| `policy` | Any of the six hook phases: `preValidate`, `preAuth`, `preExecute`, `postExecute`, `postResponse`, `postError`. Hooks from several modules run in load order; the first refusal wins. |
| `observer` | An `onRecord(record)` sink. It is fanned out beside the built-in sinks and dropped after its first throw, so a failing sink never takes down the serving path. |
| `ledgers` | Durable idempotency backends by URI scheme. `firestore` is reserved. A backend must report `durable: true` for `/readyz` to pass outside `dev`. |
| `credentials` | Credential storage backends by `ANVIL_CREDENTIALS` value. `env`, `secret_manager`, and `delegated` are reserved. |
| `transport` | A wrapper over the base transport, applied in load order. |

The api argument carries `denyPolicy`, `AnvilError`, `InMemoryLedger`,
`hostIsAllowed`, and the runtime `config` (no secret values). A hook that
throws anything other than a policy refusal fails the call closed with
`unknown_upstream_error`.

## Deploy an extension

The Cloud Run image copies only `deploy/runtime`. Add the extension beside it
and name it by path:

```dockerfile
COPY deploy/runtime ./runtime
COPY extensions ./extensions
ENV ANVIL_EXTENSIONS=/app/extensions/acme-guard.mjs
```

For the generated Terraform, set `ANVIL_EXTENSIONS` through `var.env`. The
extension is not part of the certified bundle hash. Its identity is reported
at runtime on `/healthz`, which is where a reviewer confirms what a
deployment actually loaded.

For a stdio server or the generated CLI, set the variable in the environment
that launches the process. The stdout exporter writes to stderr on those
surfaces, so the MCP transport and the command's own output stay clean.

## Export records

Every call emits one `ExecutionRecord`: operation, effect, outcome, latency,
retry count, idempotency-key presence, principal id, error code, policy
decisions, and ledger outcome. It never contains a credential or a payload.
`ANVIL_OTEL_EXPORTER` selects where records go:

| Value | Behavior |
| --- | --- |
| `memory` | Records stay in process. The default. |
| `stdout` | One JSON line per record with `severity`, `time`, and `message`. Cloud Run, GKE, and most log agents turn it into a structured entry. With `GOOGLE_CLOUD_PROJECT` set, each line carries the Cloud Logging trace key so it correlates with Cloud Trace. |
| `otlp` | OTLP/HTTP JSON traces, one client span per record, to `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` or `OTEL_EXPORTER_OTLP_ENDPOINT` plus `/v1/traces`, with `OTEL_EXPORTER_OTLP_HEADERS`. Batched, bounded, and flushed on shutdown. Works with a collector sidecar. |
| `cloud_trace` | Cloud Trace v2 `traces:batchWrite` over REST, authenticated with the metadata-server credential. The project comes from `GOOGLE_CLOUD_PROJECT`, `GCLOUD_PROJECT`, `ANVIL_SECRET_PROJECT`, or the metadata server. |

An unknown value refuses the boot. A failed export drops that batch and keeps
serving. No exporter adds a dependency to the runtime.

## Scrape metrics

`/metrics` keeps returning `{ "records": N }` for existing probes. A scraper
that sends `Accept: application/openmetrics-text` (or `?format=openmetrics`)
gets OpenMetrics counters instead:

```text
anvil_operation_calls_total{operation="payments.refunds.create",effect="mutation",outcome="error",error_code="policy_denied"} 1
anvil_operation_retries_total{...} 0
anvil_operation_latency_ms_sum{...} 42
anvil_ledger_outcomes_total{ledger="reserved"} 1
anvil_policy_denied_total{operation="payments.refunds.create"} 1
```

Labels are the record's low-cardinality facts. A principal id, a trace id,
or an endpoint never becomes a label. The route stays behind inbound
authentication like every other tool route.

## Verify

`packages/harness/src/runtime-extensions.test.ts` boots the exact prebuilt
Cloud Run artifact with an extension configured, refuses a tool call over the
real MCP transport with the runtime's own `policy_denied` envelope, reads the
refusal back from `/metrics`, and checks that the stdout record carries the
hook's decision and no credential. `packages/cli/src/tool-cli-extensions.test.ts`
proves the same contract from the generated CLI.

The generated `deploy/env.schema.json` is derived from the runtime's own
environment contract. A drift guard in `@anvil/generators` fails when a
serving process reads a variable the schema does not declare.
