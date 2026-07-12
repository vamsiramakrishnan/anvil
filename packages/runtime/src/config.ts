/**
 * The Cloud Run runtime contract (spec: "Cloud Run runtime contract"). The
 * generated, stateless runtime reads exactly these env vars — no spec parsing,
 * no code generation, no LLM on the hot path.
 */
export interface RuntimeConfig {
  serviceId?: string;
  artifactVersion?: string;
  env: string;
  /** Pinned egress allowlist. Empty = deny all upstream hosts (fail closed). */
  allowedHosts: string[];
  authProfile?: string;
  policyBundle?: string;
  otelExporter?: string;
  /**
   * Durable idempotency ledger backend URI (e.g. `firestore://project/db`).
   * Selects a registered ledger backend via `resolveLedger`. Absent → the
   * process-local in-memory ledger, which fails closed for required-idempotency
   * mutations outside `dev`.
   */
  ledger?: string;
}

/** The environments the runtime recognizes. Anything else is treated as prod. */
export type RuntimeEnv = "dev" | "staging" | "prod";

/**
 * Normalize a raw env string, **failing closed**. Only the exact string `"dev"`
 * enables development affordances (permissive host allowlist, process-local
 * idempotency ledger). Anything unset, misspelled, or unknown resolves to
 * `"prod"` — a runtime that cannot prove it is in dev must behave as production.
 * This removes the old `?? "dev"` fallback that silently gave a misconfigured
 * Cloud Run process dev semantics (any upstream host, no durable-ledger gate).
 */
export function normalizeEnv(raw: string | undefined): RuntimeEnv {
  if (raw === "dev") return "dev";
  if (raw === "staging") return "staging";
  return "prod";
}

/** True when a raw env value is set but not one of the recognized environments. */
export function isUnrecognizedEnv(raw: string | undefined): boolean {
  return raw !== undefined && raw !== "" && raw !== "dev" && raw !== "staging" && raw !== "prod";
}

export function loadRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
  onDiagnostic: (message: string) => void = (m) => console.warn(m),
): RuntimeConfig {
  // Fail closed, but not silently: a misspelled env (e.g. "prd") behaves as prod
  // yet still surfaces a diagnostic so the misconfiguration is visible at boot.
  if (isUnrecognizedEnv(env.ANVIL_ENV)) {
    onDiagnostic(
      `[anvil] ANVIL_ENV="${env.ANVIL_ENV}" is not one of dev|staging|prod; treating it as "prod" (fail closed). Fix the value to silence this.`,
    );
  }
  return {
    serviceId: env.ANVIL_SERVICE_ID,
    artifactVersion: env.ANVIL_ARTIFACT_VERSION,
    env: normalizeEnv(env.ANVIL_ENV),
    allowedHosts: (env.ANVIL_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean),
    authProfile: env.ANVIL_AUTH_PROFILE,
    policyBundle: env.ANVIL_POLICY_BUNDLE,
    otelExporter: env.ANVIL_OTEL_EXPORTER,
    ledger: env.ANVIL_LEDGER,
  };
}

/** The hostname of a URL, or undefined when it does not parse as one. */
export function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/**
 * The base-URL courtesy shared by every serving entrypoint: when the operator
 * supplied an explicit base URL (`--base-url` / `ANVIL_BASE_URL`) but no
 * allowlist, pin egress to that URL's host rather than leaving the allowlist
 * empty (which would deny everything outside dev). An explicit
 * `ANVIL_ALLOWED_HOSTS` always wins — the override never widens a configured
 * allowlist.
 */
export function allowedHostsFor(
  configured: string[],
  baseUrl: string,
  overridden: boolean,
): string[] {
  if (configured.length > 0 || !overridden) return configured;
  const host = hostOf(baseUrl);
  return host ? [host] : configured;
}

/**
 * Enforce the host allowlist (spec §18: pin allowed hosts, prevent
 * prompt-controlled base URL changes). An empty allowlist permits any host
 * only in `dev`; otherwise it fails closed.
 */
export function hostIsAllowed(url: string, allowedHosts: string[], env: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  if (allowedHosts.length === 0) return env === "dev";
  return allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}
