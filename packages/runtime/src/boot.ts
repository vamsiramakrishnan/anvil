import type { CredentialResolver } from "./auth.js";
import { allowedHostsFor, loadRuntimeConfig, type RuntimeConfig } from "./config.js";
import { resolveCredentials } from "./credentials.js";
import {
  extensionSpecifiersFromConfig,
  type LoadExtensionsOptions,
  loadRuntimeExtensions,
  type RuntimeExtensions,
  runtimeExtensionApi,
} from "./extensions.js";
import { type IdempotencyLedger, resolveLedger } from "./idempotency.js";
import type { InboundIdentity } from "./inbound-identity.js";
import { buildLimitsGate, type LimitsGate } from "./limits.js";
import {
  composeObservers,
  MetricsObserver,
  type Observer,
  type OtelExporter,
  resolveObserver,
} from "./observability.js";
import {
  type PolicyHooks,
  type Principal,
  resolvePrincipalForBearer,
  resolvePrincipalForEnv,
} from "./policy.js";
import { FetchTransport, type Transport } from "./transport.js";

/**
 * The one composition root every serving surface boots through.
 *
 * Five entrypoints build an `ExecuteContext` from configuration: the deployed
 * `runtime/server.js`, the generated `mcp/server.js` (stdio) and
 * `mcp/server-sse.js`, `anvil serve mcp`, and the generated CLI's direct
 * execution path. They used to each hand-write the same eight lines —
 * transport, credentials, ledger, observer — and it is exactly that
 * repetition that let `PolicyHooks` stay unwired on every one of them and
 * `ANVIL_OTEL_EXPORTER` be read into config and consumed nowhere. One root,
 * one order, one place a future dependency gets added: extensions are loaded
 * FIRST (they may register the ledger and credential backends the next two
 * steps select), then the exporter, then the transport (wrapped by any
 * extension), then credentials and the ledger.
 *
 * The root also owns the two caller-facing gates that used to stop one step
 * short of it: the rate/spend limiters (`ANVIL_RATE_LIMIT_*`, `ANVIL_SPEND_*`)
 * and the principal directory (`ANVIL_PRINCIPALS`). Both were parsed into
 * config on every surface and consumed only by `anvil serve mcp --fleet`, so a
 * deployed server silently ran with no limits and every caller as the
 * anonymous, every-scope principal. `contextDeps` now carries the limiters and
 * whether a directory is configured; `principalFor` resolves the caller per
 * request, and each surface must pass its result as `principal` (the drift
 * test in @anvil/generators checks that every surface does).
 */
export interface RuntimeBootOptions extends LoadExtensionsOptions {
  /** The process environment. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** The service these records belong to (`air.service.id`). */
  serviceId: string;
  serviceVersion?: string;
  /** Test seams: replace a dependency instead of resolving it. */
  transport?: Transport;
  credentials?: CredentialResolver;
  ledger?: IdempotencyLedger;
  observer?: Observer;
  /** Where boot diagnostics go. Defaults to `console.error`. */
  log?: (line: string) => void;
  /** Test seam for exporters. */
  fetchImpl?: typeof fetch;
  /**
   * Where the `stdout` exporter writes. Defaults to the process's stdout,
   * which is right for an HTTP server and wrong for a stdio MCP server or a
   * CLI, whose stdout is the protocol or the command's own output — those
   * surfaces pass stderr (or their own diagnostic sink) here.
   */
  recordWrite?: (line: string) => void;
}

export interface RuntimeBoot {
  config: RuntimeConfig;
  extensions: RuntimeExtensions;
  exporter: OtelExporter;
  transport: Transport;
  credentials: CredentialResolver;
  ledger: IdempotencyLedger;
  observer: Observer & { count: number };
  metrics: MetricsObserver;
  policy?: PolicyHooks;
  /** Drain batching exporters. Awaited by a surface's shutdown. */
  flush: () => Promise<void>;
  /** The per-process rate and spend limiters (`ANVIL_RATE_LIMIT_*`, `ANVIL_SPEND_*`). */
  limits: LimitsGate;
  /** Whether `ANVIL_PRINCIPALS` names any entry, so an unresolved caller is refused. */
  principalDirectoryConfigured: boolean;
  /**
   * Resolve the calling principal for one request. With a verified inbound
   * identity the directory is keyed by the caller's own facts, in order: the
   * exact bearer, `issuer:subject`, `subject`, then `email`; an inbound caller
   * the directory does not name resolves to `undefined`, which `execute()`
   * refuses fail-closed when a directory is configured. Without an inbound
   * identity (stdio, the CLI, an HTTP server whose inbound auth is `none`) the
   * session principal comes from `ANVIL_PRINCIPAL`, exactly as the fleet
   * always resolved it. No directory configured resolves to `undefined`, which
   * `execute()` turns into the anonymous, every-scope principal — byte-identical
   * to a surface that never opted in.
   */
  principalFor: (inbound?: InboundIdentity) => Principal | undefined;
  /**
   * The context fields that come from boot, ready to spread into an
   * `ExecuteContext` beside the per-service and per-request ones.
   */
  contextDeps: {
    transport: Transport;
    credentials: CredentialResolver;
    ledger: IdempotencyLedger;
    observer: Observer;
    policy?: PolicyHooks;
    limits: LimitsGate;
    principalDirectoryConfigured: boolean;
  };
}

/** Directory keys a verified inbound caller may be listed under, most specific first. */
function inboundDirectoryKeys(inbound: InboundIdentity): string[] {
  const issuer = inbound.claims?.iss;
  const keys = [inbound.subjectToken];
  if (inbound.sub && typeof issuer === "string") keys.push(`${issuer}:${inbound.sub}`);
  if (inbound.sub) keys.push(inbound.sub);
  if (inbound.email) keys.push(inbound.email);
  return keys;
}

export async function bootRuntime(
  config: RuntimeConfig,
  options: RuntimeBootOptions,
): Promise<RuntimeBoot> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.error(line));

  const extensions = await loadRuntimeExtensions(
    extensionSpecifiersFromConfig(config),
    runtimeExtensionApi(config),
    { cwd: options.cwd, importModule: options.importModule },
  );
  for (const ext of extensions.loaded) {
    log(
      `[anvil] extension ${ext.name} loaded (${ext.contributes.join(", ") || "no contributions"})${ext.sha256 ? ` sha256 ${ext.sha256.slice(0, 12)}…` : ""}`,
    );
  }

  const resolved = options.observer
    ? undefined
    : resolveObserver({
        exporter: config.otelExporter,
        recordsDir: env.ANVIL_RECORDS_DIR,
        serviceName: options.serviceId,
        serviceVersion: options.serviceVersion,
        env,
        fetchImpl: options.fetchImpl,
        write: options.recordWrite,
      });
  const metrics = resolved?.metrics ?? new MetricsObserver();
  const base: Observer[] = options.observer
    ? [options.observer, metrics]
    : resolved
      ? [resolved.observer]
      : [];
  const observer = composeObservers([...base, ...extensions.observers]);

  const transport = extensions.wrapTransport(options.transport ?? new FetchTransport());
  const credentials = options.credentials ?? resolveCredentials(config, { env });
  const ledger =
    options.ledger ??
    resolveLedger(config.ledger, { resultTtlMs: config.ledgerResultTtlSeconds * 1000 });
  const policy = extensions.policy;
  const limits = buildLimitsGate(config.limits);
  const principalDirectoryConfigured = Object.keys(config.principals).length > 0;
  const principalFor = (inbound?: InboundIdentity): Principal | undefined => {
    if (!principalDirectoryConfigured) return undefined;
    if (!inbound) return resolvePrincipalForEnv(config.principals, env);
    for (const key of inboundDirectoryKeys(inbound)) {
      const principal = resolvePrincipalForBearer(config.principals, key);
      if (principal) return principal;
    }
    return undefined;
  };

  return {
    config,
    extensions,
    exporter: resolved?.exporter ?? "memory",
    transport,
    credentials,
    ledger,
    observer,
    metrics,
    policy,
    flush: resolved?.flush ?? (() => Promise.resolve()),
    limits,
    principalDirectoryConfigured,
    principalFor,
    contextDeps: {
      transport,
      credentials,
      ledger,
      observer,
      ...(policy ? { policy } : {}),
      limits,
      principalDirectoryConfigured,
    },
  };
}

/**
 * Convenience for surfaces that boot straight from the environment: load the
 * config, then boot. `serviceId` is the AIR service the surface serves.
 */
export async function bootRuntimeFromEnv(
  options: RuntimeBootOptions,
): Promise<RuntimeBoot & { baseUrlFor: (compiledUrl: string | undefined) => BaseUrlDecision }> {
  const env = options.env ?? process.env;
  const config = loadRuntimeConfig(env);
  const boot = await bootRuntime(config, { ...options, env });
  return {
    ...boot,
    baseUrlFor: (compiledUrl) => resolveBaseUrl(config, env, compiledUrl),
  };
}

export interface BaseUrlDecision {
  baseUrl: string;
  allowedHosts: string[];
  /** `ANVIL_PROTOCOL_FACADE`, verbatim, when the operator declared one. */
  protocolFacade?: string;
}

/**
 * The base-URL/allowlist courtesy every serving entrypoint applies, in one
 * place: `ANVIL_BASE_URL` is a deliberate operator override (loopback
 * self-test, staging smoke) and, when set without an explicit allowlist,
 * egress pins to its host.
 */
export function resolveBaseUrl(
  config: RuntimeConfig,
  env: NodeJS.ProcessEnv,
  compiledUrl: string | undefined,
): BaseUrlDecision {
  const overridden = env.ANVIL_BASE_URL !== undefined;
  const baseUrl = env.ANVIL_BASE_URL ?? compiledUrl ?? "";
  const facade = env.ANVIL_PROTOCOL_FACADE;
  return {
    baseUrl,
    allowedHosts: allowedHostsFor(config.allowedHosts, baseUrl, overridden),
    ...(facade !== undefined ? { protocolFacade: facade } : {}),
  };
}
