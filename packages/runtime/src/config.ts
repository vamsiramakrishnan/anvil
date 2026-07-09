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
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  return {
    serviceId: env.ANVIL_SERVICE_ID,
    artifactVersion: env.ANVIL_ARTIFACT_VERSION,
    env: env.ANVIL_ENV ?? "dev",
    allowedHosts: (env.ANVIL_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean),
    authProfile: env.ANVIL_AUTH_PROFILE,
    policyBundle: env.ANVIL_POLICY_BUNDLE,
    otelExporter: env.ANVIL_OTEL_EXPORTER,
  };
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
