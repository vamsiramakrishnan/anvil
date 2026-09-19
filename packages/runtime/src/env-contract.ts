import {
  DEFAULT_UPSTREAM_TIMEOUT_MS,
  MAX_UPSTREAM_TIMEOUT_MS,
  MIN_UPSTREAM_TIMEOUT_MS,
} from "./config.js";
import { DEFAULT_LEDGER_RESULT_TTL_SECONDS } from "./idempotency.js";
import { OTEL_EXPORTERS } from "./observability.js";

/**
 * The runtime's environment contract, declared once beside the code that
 * reads it.
 *
 * `deploy/env.schema.json` used to be a hand-written literal in the deploy
 * generator. It drifted: every `ANVIL_INBOUND_*` variable — the family that
 * gates production auth — the principal directory, the rate and spend limits,
 * `ANVIL_RECORDS_DIR`, `PORT`, and `ANVIL_PROTOCOL_FACADE` were all read by a
 * serving process and absent from the schema an operator was told to
 * validate against. This table is what the schema is generated from, and a
 * drift-guard test in `@anvil/generators` asserts that every `env.X` /
 * `process.env.X` read in this package and in `@anvil/mcp-runtime` names a
 * variable declared here (or matches the credential pattern), so the schema
 * can no longer be quietly out of date.
 */
export interface RuntimeEnvVar {
  name: string;
  description: string;
  /** Required by every deployment. */
  required?: boolean;
  enum?: readonly string[];
  pattern?: string;
  default?: string;
  examples?: readonly string[];
  /** Compiler-owned: the generated Terraform sets it; `var.env` may not redefine it. */
  compilerOwned?: boolean;
}

/** Every variable `@anvil/runtime` itself reads (`loadRuntimeConfig`, `bootRuntime`, credentials, limits). */
export const RUNTIME_ENV_CONTRACT: readonly RuntimeEnvVar[] = [
  {
    name: "ANVIL_SERVICE_ID",
    description:
      "Stable AIR service identity the runtime serves and namespaces replay protection by.",
    required: true,
    compilerOwned: true,
  },
  {
    name: "ANVIL_ARTIFACT_VERSION",
    description: "Version label of the deployed artifact, for records and diagnostics.",
  },
  {
    name: "ANVIL_ENV",
    description:
      'Runtime environment. Only the exact value "dev" enables development affordances; anything else behaves as prod (fail closed).',
    required: true,
    enum: ["dev", "staging", "prod"],
    compilerOwned: true,
  },
  {
    name: "ANVIL_ALLOWED_HOSTS",
    description: "Comma-separated egress allowlist.",
    required: true,
    examples: ["api.internal.example.com"],
    compilerOwned: true,
  },
  {
    name: "ANVIL_BASE_URL",
    description:
      "Override the compiled-in upstream base URL (loopback self-test, staging smoke). When set without ANVIL_ALLOWED_HOSTS, egress pins to this URL's host.",
  },
  {
    name: "ANVIL_PROTOCOL_FACADE",
    description:
      "An operator's stated reason that ANVIL_BASE_URL is a protocol facade serving a non-HTTP/JSON source's synthesized coordinates over HTTP+JSON. Without it those operations are refused. A declaration, never an inference.",
  },
  {
    name: "ANVIL_LEDGER",
    description:
      "Durable idempotency ledger backend URI (firestore://PROJECT/DATABASE/SERVICE_NAMESPACE, or a scheme an ANVIL_EXTENSIONS module registers). Required outside dev for required-idempotency mutations.",
    compilerOwned: true,
  },
  {
    name: "ANVIL_LEDGER_RESULT_TTL_SECONDS",
    description:
      "Completed replay-result retention in seconds (60..31536000). In-progress reservations never expire automatically.",
    pattern: "^[1-9][0-9]*$",
    default: String(DEFAULT_LEDGER_RESULT_TTL_SECONDS),
    compilerOwned: true,
  },
  {
    name: "ANVIL_UPSTREAM_TIMEOUT_MS",
    description: `Per-attempt upstream timeout in milliseconds (${MIN_UPSTREAM_TIMEOUT_MS}..${MAX_UPSTREAM_TIMEOUT_MS}).`,
    pattern: "^[1-9][0-9]*$",
    default: String(DEFAULT_UPSTREAM_TIMEOUT_MS),
    compilerOwned: true,
  },
  {
    name: "ANVIL_AUTH_PROFILE",
    description:
      "Selects the upstream credential profile: the ANVIL_<PROFILE>_* prefix. Defaults per env (e.g. prod → ANVIL_PROD_*).",
    compilerOwned: true,
  },
  {
    name: "ANVIL_EXTENSIONS",
    description:
      "Runtime extension modules (comma- or semicolon-separated ES module specifiers) loaded at boot, before the ledger and credential resolvers are chosen. Each contributes policy hooks, an observer, ledger or credential backends, or a transport wrapper. A module that cannot load refuses the boot.",
    examples: ["/app/extensions/policy.mjs"],
  },
  {
    name: "ANVIL_POLICY_BUNDLE",
    description:
      "One more extension module, conventionally policy-only, loaded after ANVIL_EXTENSIONS. Same contract.",
  },
  {
    name: "ANVIL_OTEL_EXPORTER",
    description:
      "Execution-record exporter: memory (default; records stay in process), stdout (one structured JSON log line per record), otlp (OTLP/HTTP JSON traces to OTEL_EXPORTER_OTLP_TRACES_ENDPOINT or OTEL_EXPORTER_OTLP_ENDPOINT), or cloud_trace (Cloud Trace v2 batchWrite with the metadata-server credential). An unknown value refuses the boot. Every exporter also feeds the OpenMetrics /metrics counters.",
    enum: OTEL_EXPORTERS,
    examples: ["cloud_trace"],
    compilerOwned: true,
  },
  {
    name: "ANVIL_RECORDS_DIR",
    description:
      "Spool every execution record (no secrets, no payloads) to newline-delimited JSON in this directory, beside whichever exporter is selected, for `anvil observe --from-records`.",
  },
  {
    name: "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
    description:
      "The OTLP/HTTP traces endpoint the otlp exporter posts to (standard OpenTelemetry variable).",
    examples: ["http://localhost:4318/v1/traces"],
  },
  {
    name: "OTEL_EXPORTER_OTLP_ENDPOINT",
    description:
      "The OTLP/HTTP base endpoint; the otlp exporter appends /v1/traces when OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is unset (standard OpenTelemetry variable).",
    examples: ["http://localhost:4318"],
  },
  {
    name: "OTEL_EXPORTER_OTLP_HEADERS",
    description:
      "Extra headers for the otlp exporter, `key=value,key2=value2` (standard OpenTelemetry variable).",
  },
  {
    name: "GOOGLE_CLOUD_PROJECT",
    description:
      "GCP project for the cloud_trace exporter and the Cloud Logging trace key on stdout records. Falls back to GCLOUD_PROJECT, ANVIL_SECRET_PROJECT, then the metadata server.",
  },
  {
    name: "GCLOUD_PROJECT",
    description: "Legacy alias of GOOGLE_CLOUD_PROJECT.",
  },
  {
    name: "ANVIL_CREDENTIALS",
    description:
      "Storage selector for static api-key/basic/bearer values. OAuth grants and delegated identity always route per operation. Unset defaults static values to Secret Manager references.",
    enum: ["env", "secret_manager"],
    compilerOwned: true,
  },
  {
    name: "ANVIL_SECRET_PROJECT",
    description:
      "Default GCP project for shorthand `sm://<secret>` credential references. Full `sm://projects/…` references do not need it.",
    compilerOwned: true,
  },
  {
    name: "ANVIL_CREDENTIAL_HOSTS",
    description:
      "Comma-separated exact public host allowlist for token endpoints imported from API specifications. Not needed when ANVIL_<PROFILE>_TOKEN_ENDPOINT is explicitly operator-configured.",
  },
  {
    name: "ANVIL_PRINCIPALS",
    description:
      "Principal directory (fleet runtime): `token:id:scope1,scope2;…` pairs or a JSON object keyed by bearer token. Unset, every caller is the anonymous every-scope principal. Malformed input yields an empty directory (fail closed).",
  },
  {
    name: "ANVIL_PRINCIPAL",
    description:
      "For a stdio session: the ANVIL_PRINCIPALS key naming this process's caller, resolved once at boot.",
  },
  {
    name: "ANVIL_RATE_LIMIT_CAPACITY",
    description:
      "Per-principal token-bucket capacity. Must be set together with ANVIL_RATE_LIMIT_REFILL_PER_SECOND; a partial pair disables the limiter.",
    pattern: "^[0-9]*\\.?[0-9]+$",
  },
  {
    name: "ANVIL_RATE_LIMIT_REFILL_PER_SECOND",
    description: "Per-principal token-bucket refill rate. See ANVIL_RATE_LIMIT_CAPACITY.",
    pattern: "^[0-9]*\\.?[0-9]+$",
  },
  {
    name: "ANVIL_SPEND_BUDGET",
    description:
      "Per-principal spend budget for the window. Must be set together with ANVIL_SPEND_WINDOW_SECONDS; a partial pair disables the budget.",
    pattern: "^[0-9]*\\.?[0-9]+$",
  },
  {
    name: "ANVIL_SPEND_WINDOW_SECONDS",
    description: "Length of the spend window in seconds. See ANVIL_SPEND_BUDGET.",
    pattern: "^[0-9]*\\.?[0-9]+$",
  },
];

/**
 * Per-profile upstream credential env vars (names by convention). Any value
 * may be a Secret Manager reference (`sm://…`), dereferenced at call time.
 */
export const CREDENTIAL_ENV_PATTERN =
  "^ANVIL_[A-Z0-9_]+_(TOKEN|API_KEY|API_KEY_HEADER|API_KEY_QUERY|USERNAME|PASSWORD|TOKEN_ENDPOINT|CLIENT_ID|CLIENT_SECRET|CLIENT_ASSERTION_KEY|AUDIENCE|RESOURCE|SCOPES|ACTOR_TOKEN|HEADER_VALUE|MTLS_CLIENT_CERT|MTLS_CLIENT_KEY|MTLS_CA|CERT|KEY|CA|REFRESH_TOKEN)$";

export const CREDENTIAL_ENV_DESCRIPTION =
  "Upstream credential (ANVIL_<PROFILE>_*). Static schemes (api_key/basic/bearer) read directly; OAuth grants (client_credentials, RFC 8693 OBO, RFC 7523 jwt-bearer) mint a token from *_TOKEN_ENDPOINT. Provision secrets as `sm://` references.";

/** The JSON Schema property for one declared variable. */
export function envVarJsonSchema(v: RuntimeEnvVar): Record<string, unknown> {
  return {
    type: "string",
    description: v.description,
    ...(v.enum ? { enum: [...v.enum] } : {}),
    ...(v.pattern ? { pattern: v.pattern } : {}),
    ...(v.default !== undefined ? { default: v.default } : {}),
    ...(v.examples ? { examples: [...v.examples] } : {}),
  };
}
