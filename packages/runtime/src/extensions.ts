import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import type { RuntimeConfig } from "./config.js";
import { hostIsAllowed } from "./config.js";
import type { CredentialResolverFactory } from "./credentials.js";
import { registerCredentialBackend } from "./credentials.js";
import { AnvilError } from "./errors.js";
import type { LedgerFactory } from "./idempotency.js";
import { InMemoryLedger, registerLedgerBackend } from "./idempotency.js";
import type { Observer } from "./observability.js";
import type { PolicyHook, PolicyHooks } from "./policy.js";
import { denyPolicy } from "./policy.js";
import type { Transport } from "./transport.js";

export { composeObservers } from "./observability.js";

/**
 * Runtime extensions — operator code the serving path loads at boot.
 *
 * The runtime has always had the seams: six policy hook points the executor
 * calls (`policy.ts`, spec §14), an `Observer` sink for execution records,
 * and two open registries (`registerLedgerBackend`, `registerCredentialBackend`)
 * whose own comments say "operators can register another implementation
 * before boot". What it never had was a place for an operator to run code
 * before boot: every serving entrypoint is a fixed file (the deployed
 * `runtime/server.js` is a prebuilt, byte-copied bundle) that builds its
 * `ExecuteContext` from environment variables alone. The registries were open
 * at the type level and unreachable in practice, and `PolicyHooks` was dead
 * code on every shipped path.
 *
 * `ANVIL_EXTENSIONS` names one or more ES modules (comma- or semicolon-
 * separated). Each is imported once, before the ledger and credential
 * resolvers are chosen, and contributes any of: policy hooks, an observer,
 * ledger backends keyed by URI scheme, credential backends keyed by
 * `ANVIL_CREDENTIALS` value, and a transport wrapper. `ANVIL_POLICY_BUNDLE`
 * — a slot the runtime contract has declared and the Terraform template has
 * emitted for a long time without anything reading it — is one more module
 * specifier, appended after `ANVIL_EXTENSIONS`.
 *
 * The contract is deliberately dependency-free: a module exports a plain
 * object (or a function of the `RuntimeExtensionApi` that returns one), so
 * it needs no import of `@anvil/runtime` — which is the one thing the
 * distroless production image cannot resolve. Everything a hook needs that
 * lives in this package (`denyPolicy`, `AnvilError`, `InMemoryLedger`,
 * `hostIsAllowed`) is handed in through the api argument instead.
 *
 * Trust: an extension is operator-owned code in the operator's own process,
 * exactly like the credentials it runs beside. It is not agent input. The
 * loader is still fail-closed about the things it CAN check — a module that
 * fails to import, exports a malformed shape, or tries to replace one of the
 * runtime's own backends refuses the boot rather than serving with a policy
 * the operator believes is installed and is not. What an extension can never
 * do is loosen a gate: hooks run inside `execute()` after the approval,
 * confirmation, idempotency, and principal gates have already refused, and
 * they can only deny (`denyPolicy`), record a decision, or shape the outbound
 * request. Asymmetric trust holds by construction.
 */

/** What a module contributes. Every field is optional; `name` is not. */
export interface RuntimeExtension {
  /** A stable name, recorded on `/healthz` and in the boot log. */
  name: string;
  /** Hooks the executor runs around every call (`policy.ts`). */
  policy?: PolicyHooks;
  /** One more execution-record sink, fanned out beside the built-in one. */
  observer?: Observer;
  /** Durable ledger backends by URI scheme (`ANVIL_LEDGER=<scheme>://…`). */
  ledgers?: Record<string, LedgerFactory>;
  /** Credential storage backends by `ANVIL_CREDENTIALS` value. */
  credentials?: Record<string, CredentialResolverFactory>;
  /** Wrap the upstream transport (an egress proxy, a recorder, a circuit breaker). */
  transport?: (base: Transport) => Transport;
}

/** Runtime helpers handed to an extension factory so it never has to import this package. */
export interface RuntimeExtensionApi {
  /** Refuse the current call from inside a policy hook with `policy_denied`. */
  denyPolicy: typeof denyPolicy;
  AnvilError: typeof AnvilError;
  InMemoryLedger: typeof InMemoryLedger;
  hostIsAllowed: typeof hostIsAllowed;
  /** The runtime configuration this process booted with. Carries no secret values. */
  config: RuntimeConfig;
}

export type RuntimeExtensionFactory = (
  api: RuntimeExtensionApi,
) => RuntimeExtension | Promise<RuntimeExtension>;

/** A module's default export: the extension itself, or a factory that builds it. */
export type RuntimeExtensionModule = RuntimeExtension | RuntimeExtensionFactory;

export type ExtensionContribution = "policy" | "observer" | "ledgers" | "credentials" | "transport";

/** One loaded module's identity — what `/healthz` reports and the boot log prints. */
export interface LoadedExtension {
  name: string;
  /** The specifier exactly as configured. */
  specifier: string;
  /** sha256 of the module file, when the specifier resolved to a file on disk. */
  sha256?: string;
  contributes: ExtensionContribution[];
  /** Ledger schemes and credential backend keys this module registered. */
  ledgerSchemes: string[];
  credentialBackends: string[];
}

/** The composed result of loading every configured module, in order. */
export interface RuntimeExtensions {
  loaded: LoadedExtension[];
  /** Every extension's hooks, chained in load order — `undefined` when none contributed any. */
  policy?: PolicyHooks;
  /** Every extension's observer, in load order. */
  observers: Observer[];
  /** Every transport wrapper applied in load order (identity when none contributed one). */
  wrapTransport: (base: Transport) => Transport;
}

export const NO_EXTENSIONS: RuntimeExtensions = Object.freeze({
  loaded: [],
  observers: [],
  wrapTransport: (base: Transport) => base,
});

/**
 * Backends the runtime ships. An extension may add a scheme beside them; it may
 * not replace one. Replacing `firestore` with a process-local ledger would let
 * `/readyz` report a durable ledger the deployment does not have — the exact
 * false-safety state the fail-closed selector exists to prevent.
 */
export const RESERVED_LEDGER_SCHEMES: readonly string[] = Object.freeze(["firestore"]);
export const RESERVED_CREDENTIAL_BACKENDS: readonly string[] = Object.freeze([
  "env",
  "secret_manager",
  "delegated",
]);

const POLICY_PHASES = [
  "preValidate",
  "preAuth",
  "preExecute",
  "postExecute",
  "postResponse",
  "postError",
] as const satisfies readonly (keyof PolicyHooks)[];

/** Split `ANVIL_EXTENSIONS` (comma- or semicolon-separated) into specifiers. */
export function parseExtensionSpecifiers(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(/[,;]/)) {
    const specifier = part.trim();
    if (specifier.length > 0 && !out.includes(specifier)) out.push(specifier);
  }
  return out;
}

/**
 * The full ordered list a serving surface loads: `ANVIL_EXTENSIONS` first,
 * then `ANVIL_POLICY_BUNDLE` (the pre-existing, single-module policy slot).
 */
export function extensionSpecifiersFromConfig(config: {
  extensions?: string;
  policyBundle?: string;
}): string[] {
  const list = parseExtensionSpecifiers(config.extensions);
  const policy = config.policyBundle?.trim();
  if (policy && !list.includes(policy)) list.push(policy);
  return list;
}

/** The api every factory receives — one construction site so surfaces agree. */
export function runtimeExtensionApi(config: RuntimeConfig): RuntimeExtensionApi {
  return { denyPolicy, AnvilError, InMemoryLedger, hostIsAllowed, config };
}

export interface LoadExtensionsOptions {
  /** Base directory for relative file specifiers. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Test seam: the dynamic importer. Defaults to `import()`. */
  importModule?: (url: string) => Promise<unknown>;
  /** Test seam: the ledger registry. */
  registerLedger?: typeof registerLedgerBackend;
  /** Test seam: the credential registry. */
  registerCredential?: typeof registerCredentialBackend;
}

/**
 * Whether a specifier names a file on disk (resolved from `cwd`) rather than a
 * bare package name. Anything with a path separator, a relative prefix, or a
 * JavaScript extension is a file; `file:` URLs pass through.
 */
export function resolveExtensionSpecifier(
  specifier: string,
  cwd: string,
): { url: string; path?: string } {
  if (specifier.startsWith("file:")) return { url: specifier };
  // A scoped package (`@acme/anvil-policy`) is the one bare specifier that
  // legitimately carries a slash; everything else with a path separator is a
  // file, as is anything with a JavaScript extension.
  const looksLikeFile =
    isAbsolute(specifier) ||
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    (specifier.includes("/") && !specifier.startsWith("@")) ||
    specifier.includes("\\") ||
    /\.(?:[cm]?js)$/.test(specifier);
  if (!looksLikeFile) return { url: specifier };
  const path = isAbsolute(specifier) ? specifier : resolvePath(cwd, specifier);
  return { url: pathToFileURL(path).href, path };
}

/**
 * Import and validate every configured module, in order, registering the
 * backends it contributes. Throws on the first module that cannot be loaded
 * or is malformed — a boot with a missing extension is a boot without the
 * policy the operator configured, and that must never serve.
 */
export async function loadRuntimeExtensions(
  specifiers: readonly string[],
  api: RuntimeExtensionApi,
  options: LoadExtensionsOptions = {},
): Promise<RuntimeExtensions> {
  if (specifiers.length === 0) return NO_EXTENSIONS;
  const cwd = options.cwd ?? process.cwd();
  const importModule = options.importModule ?? ((url: string) => import(url));
  const registerLedger = options.registerLedger ?? registerLedgerBackend;
  const registerCredential = options.registerCredential ?? registerCredentialBackend;

  const loaded: LoadedExtension[] = [];
  const extensions: RuntimeExtension[] = [];
  const seenNames = new Set<string>();

  for (const specifier of specifiers) {
    const { url, path } = resolveExtensionSpecifier(specifier, cwd);
    let sha256: string | undefined;
    if (path !== undefined) {
      try {
        if (!statSync(path).isFile()) throw new Error("not a regular file");
        sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
      } catch (err) {
        throw extensionError(specifier, `cannot be read (${describe(err)})`);
      }
    }
    let mod: unknown;
    try {
      mod = await importModule(url);
    } catch (err) {
      throw extensionError(specifier, `failed to import: ${describe(err)}`);
    }
    const exported = defaultExport(mod);
    let extension: unknown;
    try {
      extension = typeof exported === "function" ? await exported(api) : exported;
    } catch (err) {
      throw extensionError(specifier, `factory threw: ${describe(err)}`);
    }
    const valid = validateExtension(extension, specifier);
    if (seenNames.has(valid.name)) {
      throw extensionError(specifier, `duplicates extension name '${valid.name}'`);
    }
    seenNames.add(valid.name);

    const ledgerSchemes = Object.keys(valid.ledgers ?? {});
    for (const scheme of ledgerSchemes) {
      if (RESERVED_LEDGER_SCHEMES.includes(scheme)) {
        throw extensionError(specifier, `may not replace the built-in '${scheme}' ledger backend`);
      }
      registerLedger(
        scheme,
        (valid.ledgers as Record<string, LedgerFactory>)[scheme] as LedgerFactory,
      );
    }
    const credentialBackends = Object.keys(valid.credentials ?? {});
    for (const key of credentialBackends) {
      if (RESERVED_CREDENTIAL_BACKENDS.includes(key)) {
        throw extensionError(specifier, `may not replace the built-in '${key}' credential backend`);
      }
      registerCredential(
        key,
        (valid.credentials as Record<string, CredentialResolverFactory>)[
          key
        ] as CredentialResolverFactory,
      );
    }

    extensions.push(valid);
    loaded.push({
      name: valid.name,
      specifier,
      ...(sha256 ? { sha256 } : {}),
      contributes: contributionsOf(valid),
      ledgerSchemes,
      credentialBackends,
    });
  }

  const wrappers = extensions.flatMap((e) => (e.transport ? [e.transport] : []));
  return {
    loaded,
    policy: composePolicyHooks(extensions.flatMap((e) => (e.policy ? [e.policy] : []))),
    observers: extensions.flatMap((e) => (e.observer ? [e.observer] : [])),
    wrapTransport: (base) => wrappers.reduce((transport, wrap) => wrap(transport), base),
  };
}

/**
 * Chain hook sets in order: every contributor's hook for a phase runs, in
 * load order, and the first refusal wins (a thrown `denyPolicy` stops the
 * chain exactly as it stops the call).
 */
export function composePolicyHooks(sets: readonly PolicyHooks[]): PolicyHooks | undefined {
  const composed: PolicyHooks = {};
  let any = false;
  for (const phase of POLICY_PHASES) {
    const hooks = sets.flatMap((s) => (s[phase] ? [s[phase] as PolicyHook] : []));
    if (hooks.length === 0) continue;
    any = true;
    composed[phase] =
      hooks.length === 1
        ? hooks[0]
        : async (ctx) => {
            for (const hook of hooks) await hook(ctx);
          };
  }
  return any ? composed : undefined;
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

function defaultExport(mod: unknown): unknown {
  if (mod && typeof mod === "object" && "default" in mod) {
    return (mod as { default: unknown }).default;
  }
  return mod;
}

function validateExtension(value: unknown, specifier: string): RuntimeExtension {
  if (!value || typeof value !== "object") {
    throw extensionError(
      specifier,
      "must default-export an extension object or a factory returning one",
    );
  }
  const ext = value as Record<string, unknown>;
  if (typeof ext.name !== "string" || ext.name.trim().length === 0) {
    throw extensionError(specifier, "must declare a non-empty `name`");
  }
  if (ext.policy !== undefined) {
    if (!ext.policy || typeof ext.policy !== "object") {
      throw extensionError(specifier, "`policy` must be an object of hook functions");
    }
    for (const [phase, hook] of Object.entries(ext.policy as Record<string, unknown>)) {
      if (!(POLICY_PHASES as readonly string[]).includes(phase)) {
        throw extensionError(
          specifier,
          `\`policy.${phase}\` is not a hook phase (expected one of ${POLICY_PHASES.join(", ")})`,
        );
      }
      if (typeof hook !== "function") {
        throw extensionError(specifier, `\`policy.${phase}\` must be a function`);
      }
    }
  }
  if (ext.observer !== undefined) {
    const observer = ext.observer as { onRecord?: unknown } | null;
    if (!observer || typeof observer !== "object" || typeof observer.onRecord !== "function") {
      throw extensionError(specifier, "`observer` must have an `onRecord(record)` method");
    }
  }
  for (const field of ["ledgers", "credentials"] as const) {
    if (ext[field] === undefined) continue;
    const table = ext[field];
    if (!table || typeof table !== "object") {
      throw extensionError(specifier, `\`${field}\` must map names to factory functions`);
    }
    for (const [key, factory] of Object.entries(table as Record<string, unknown>)) {
      if (!/^[a-z][a-z0-9_+-]*$/i.test(key)) {
        throw extensionError(specifier, `\`${field}.${key}\` is not a valid backend name`);
      }
      if (typeof factory !== "function") {
        throw extensionError(specifier, `\`${field}.${key}\` must be a factory function`);
      }
    }
  }
  if (ext.transport !== undefined && typeof ext.transport !== "function") {
    throw extensionError(specifier, "`transport` must be a function wrapping the base transport");
  }
  return ext as unknown as RuntimeExtension;
}

function contributionsOf(ext: RuntimeExtension): ExtensionContribution[] {
  const out: ExtensionContribution[] = [];
  if (ext.policy && Object.keys(ext.policy).length > 0) out.push("policy");
  if (ext.observer) out.push("observer");
  if (ext.ledgers && Object.keys(ext.ledgers).length > 0) out.push("ledgers");
  if (ext.credentials && Object.keys(ext.credentials).length > 0) out.push("credentials");
  if (ext.transport) out.push("transport");
  return out;
}

function extensionError(specifier: string, reason: string): Error {
  return new Error(`[anvil] runtime extension '${specifier}' ${reason}. Refusing to serve.`);
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
