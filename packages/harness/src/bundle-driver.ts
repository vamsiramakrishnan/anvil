import { type ChildProcess, spawn } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cliFlag, type Operation, propKey, resolveIdempotencyCarrier } from "@anvil/air";
import { exampleInput } from "@anvil/generators";
import { credentialProfileName, envPrefix } from "@anvil/runtime";

/**
 * Shared machinery for booting a generated bundle and driving its surfaces
 * against its own mock upstream. Both the MCP loopback self-test (loopback.ts)
 * and the tri-surface conformance harness (conformance.ts) drive the same
 * bundle the same way — one mock, one seeded input per operation, one wire
 * capture — so the driver primitives live here and are never forked between
 * them. Everything is hermetic: no network, no clock beyond the seeded input.
 */

/** One captured wire request, as recorded by the generated mock's ring buffer. */
export interface CaptureRecord {
  method: string;
  url: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  contentType: string | null;
  body: unknown;
  matchedOpId: string | null;
  matchedCandidates: string[];
  pathParams: Record<string, string> | null;
  validation: { ok: boolean; missing: string[]; invalid: string[] };
  /** What the mock answered — carries the NAME of the scenario it served. */
  response: { status: number; kind: string; scenario?: string } | null;
}

/** A structural divergence between what was sent and what the wire received. */
export interface WireLoss {
  /** JSON path of the divergence, e.g. "body.amount" or "query.limit". */
  path: string;
  sent: unknown;
  received: unknown;
}

/** Headers the mock redacts; their captured value is never comparable. */
export const REDACTED_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "x-api-key",
  "api-key",
]);

/**
 * Synthesized arguments for one invocation. Idempotency keys are made unique
 * per call — replaying the example key would let the runtime's ledger serve the
 * previous result without touching the wire, which is correct behavior but
 * would starve the capture-based assertions.
 */
export function argsFor(op: Operation, tag: string): Record<string, unknown> {
  const args = exampleInput(op);
  if (typeof args.idempotency_key === "string") {
    args.idempotency_key = `${tag}-${randomUUID()}`;
  }
  return args;
}

let assertionKey: string | undefined;

/**
 * Build non-secret, hermetic credentials for a generated bundle self-test.
 *
 * Credential namespaces are operation-specific: `default` is only the outer
 * deployment profile, while each imported security scheme contributes its
 * stable `credentialProfile` suffix. OAuth grants point at the generated
 * mock's reserved token endpoint so the real resolver still performs its grant
 * exchange without touching the network or contaminating wire captures.
 */
export function hermeticCredentialEnv(
  operations: readonly Operation[],
  mockBase: string,
  deploymentProfile = "default",
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const op of operations) {
    const auth = op.auth;
    const profile = credentialProfileName(deploymentProfile, auth);
    const prefix = envPrefix(profile);
    switch (auth.type) {
      case "none":
        break;
      case "api_key":
        env[`${prefix}_API_KEY`] = "anvil-hermetic-api-key";
        break;
      case "basic":
        env[`${prefix}_USERNAME`] = "anvil-hermetic-user";
        env[`${prefix}_PASSWORD`] = "anvil-hermetic-password";
        break;
      case "oauth2_client_credentials":
        env[`${prefix}_TOKEN_ENDPOINT`] = `${mockBase}/__anvil/oauth/token`;
        env[`${prefix}_CLIENT_ID`] = "anvil-hermetic-client";
        if (auth.provider?.clientAuth === "private_key_jwt") {
          assertionKey ??= generateKeyPairSync("rsa", { modulusLength: 2048 })
            .privateKey.export({ type: "pkcs8", format: "pem" })
            .toString();
          env[`${prefix}_CLIENT_ASSERTION_KEY`] = assertionKey;
        } else {
          env[`${prefix}_CLIENT_SECRET`] = "anvil-hermetic-client-secret";
        }
        break;
      case "jwt_bearer":
        if (auth.provider?.grant === "jwt_bearer") {
          assertionKey ??= generateKeyPairSync("rsa", { modulusLength: 2048 })
            .privateKey.export({ type: "pkcs8", format: "pem" })
            .toString();
          env[`${prefix}_TOKEN_ENDPOINT`] = `${mockBase}/__anvil/oauth/token`;
          env[`${prefix}_CLIENT_ID`] = "anvil-hermetic-client";
          env[`${prefix}_CLIENT_ASSERTION_KEY`] = assertionKey;
        } else {
          env[`${prefix}_TOKEN`] = "anvil-hermetic-bearer";
        }
        break;
      default:
        // Authorization-code, OBO, mTLS, custom-header, and workload-identity
        // calls require caller/platform context that a wire-only self-test must
        // not fabricate. Their normal auth_required result stays visible.
        break;
    }
  }
  return env;
}

/**
 * The CLI flags that carry a seeded input object to the generated tool CLI.
 * This is the exact inverse of the CLI engine's flag→input mapping (tool-cli
 * reads `cliFlag(name)` and writes `propKey(name)`), derived from the very same
 * operation contract — so the CLI surface receives the identical logical input
 * the MCP surface receives as a tool-args object. Boolean-valued fields are
 * skipped (they map to bare `--flag` toggles the caller adds explicitly).
 */
export function cliFlagsFor(op: Operation, args: Record<string, unknown>): string[] {
  const out: string[] = [];
  const emit = (name: string) => {
    const value = args[propKey(name)];
    if (value === undefined || value === null) return;
    // Use @anvil/air's real cliFlag, never a local re-implementation — the CLI
    // engine parses exactly these flags, and only the shared function handles
    // the full naming (e.g. OData's `$filter` → `--filter`) identically. A real
    // boolean *field* (e.g. an Edm.Boolean property) is a value flag `--f true`,
    // not a bare toggle — the tool CLI coerces it back; only the injected
    // `confirm`/`dry-run` control toggles are bare, and those are never fields
    // iterated here.
    out.push(cliFlag(name), String(value));
  };
  for (const p of op.input.params) emit(p.name);
  if (op.input.body?.projection === "fields") for (const f of op.input.body.fields) emit(f.name);
  else if (op.input.body && args.body !== undefined && args.body !== null) {
    out.push("--body", JSON.stringify(args.body));
  }
  if (typeof args.idempotency_key === "string") out.push("--idempotency-key", args.idempotency_key);
  return out;
}

/**
 * A GET operation that still carries a request body cannot be sent by fetch at
 * all; probing one for error/retry behavior would only re-report its fidelity
 * failure under the wrong check id. Current adapters emit truthful POST
 * methods, so this only guards bundles compiled before that change.
 */
export function wireable(op: Operation): boolean {
  const method = (op.sourceRef.method ?? "get").toLowerCase();
  return method !== "get" || (!op.input.body && !op.input.params.some((p) => p.in === "body"));
}

export interface ExpectedWire {
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
}

function withNestedValue(value: unknown, path: readonly string[], key: string): unknown {
  const root = isRecord(value) ? structuredClone(value) : {};
  let current = root;
  for (const segment of path.slice(0, -1)) {
    const next = current[segment];
    if (isRecord(next)) {
      current = next;
    } else {
      const created: Record<string, unknown> = {};
      current[segment] = created;
      current = created;
    }
  }
  current[path[path.length - 1] as string] = key;
  return root;
}

/**
 * The wire request the AIR contract promises for these args. Derived from AIR
 * here, independently of the executor's own request builder — the self-test is
 * an oracle over the contract, not a mirror of the implementation.
 */
export function expectedWire(op: Operation, args: Record<string, unknown>): ExpectedWire {
  let path = op.sourceRef.path ?? "/";
  const query: Record<string, string> = {};
  const headers: Record<string, string> = {};
  const fields: Record<string, unknown> = {};
  let hasBody = false;
  for (const p of op.input.params) {
    const value = args[propKey(p.name)];
    if (value === undefined || value === null) continue;
    if (p.in === "path") path = path.replace(`{${p.name}}`, encodeURIComponent(String(value)));
    else if (p.in === "query") query[p.name] = String(value);
    else if (p.in === "header" && !REDACTED_HEADERS.has(p.name.toLowerCase())) {
      headers[p.name.toLowerCase()] = String(value);
    } else if (p.in === "body") {
      fields[p.name] = value;
      hasBody = true;
    }
  }
  let body: unknown;
  const b = op.input.body;
  if (b?.projection === "fields") {
    for (const f of b.fields) {
      const value = args[propKey(f.name)];
      if (value === undefined || value === null) continue;
      fields[f.name] = value;
      hasBody = true;
    }
  } else if (b && args.body !== undefined && args.body !== null) {
    body = args.body;
  }
  if (body === undefined && hasBody) body = fields;
  const carrier = resolveIdempotencyCarrier(op);
  const key = typeof args.idempotency_key === "string" ? args.idempotency_key : undefined;
  if (carrier.ok && carrier.binding && key) {
    const binding = carrier.binding;
    switch (binding.mechanism) {
      case "header":
        if (!REDACTED_HEADERS.has(binding.key.toLowerCase())) {
          headers[binding.key.toLowerCase()] = key;
        }
        break;
      case "query":
        query[binding.key] = key;
        break;
      case "path":
        path = path.replace(`{${binding.key}}`, encodeURIComponent(key));
        break;
      case "body":
        body = withNestedValue(body, binding.path, key);
        break;
    }
  }
  return { path, query, headers, body };
}

/** Structural diff producing loss entries with JSON paths; walks both sides. */
export function diff(sent: unknown, received: unknown, path: string, losses: WireLoss[]): void {
  if (isRecord(sent) && isRecord(received)) {
    for (const key of new Set([...Object.keys(sent), ...Object.keys(received)])) {
      diff(sent[key], received[key], `${path}.${key}`, losses);
    }
    return;
  }
  if (Array.isArray(sent) && Array.isArray(received)) {
    if (sent.length !== received.length) {
      losses.push({ path: `${path}.length`, sent: sent.length, received: received.length });
      return;
    }
    for (let i = 0; i < sent.length; i++) diff(sent[i], received[i], `${path}[${i}]`, losses);
    return;
  }
  if (!Object.is(sent, received)) losses.push({ path, sent, received });
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function trim(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat;
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolvePromise(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/* -------------------------------------------------------------------------- */
/* Mock control + process plumbing                                             */
/* -------------------------------------------------------------------------- */

/** Client for the generated mock's reserved /__anvil/ control surface. */
export class MockControl {
  constructor(private readonly base: string) {}

  async capture(): Promise<CaptureRecord[]> {
    const res = await fetch(`${this.base}/__anvil/capture`);
    if (!res.ok) throw new Error(`mock capture failed with ${res.status}`);
    const data = (await res.json()) as { requests: CaptureRecord[] };
    return data.requests;
  }

  reset(): Promise<void> {
    return this.post("/__anvil/reset", {});
  }

  scenario(name: string | null): Promise<void> {
    return this.post("/__anvil/scenario", { name });
  }

  fault(opId: string, status: number, times: number): Promise<void> {
    return this.post("/__anvil/fault", { opId, status, times });
  }

  private async post(path: string, body: unknown): Promise<void> {
    const res = await fetch(`${this.base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`mock control ${path} failed with ${res.status}`);
  }
}

/** Boot mock/server.mjs on an ephemeral port and parse its ready line. */
export function startMockServer(dir: string): Promise<{ port: number; child: ChildProcess }> {
  const child = spawn(process.execPath, [join(dir, "mock", "server.mjs")], {
    env: { ...process.env, PORT: "0", ANVIL_MOCK_SCENARIO: "" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  return new Promise((resolvePromise, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("mock server did not report listening within 15s"));
    }, 15_000);
    child.stderr?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (const line of buffer.split("\n")) {
        const event = parseJson(line) as { event?: string; port?: number } | undefined;
        if (event?.event === "listening" && typeof event.port === "number") {
          clearTimeout(timer);
          resolvePromise({ port: event.port, child });
          return;
        }
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`mock server exited before listening (code ${code})`));
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** A named package to link into a bundle's node_modules before spawning it. */
export interface BundleLink {
  name: string;
  /** Absolute directory to link to. When omitted, resolved from this module. */
  dir?: string;
}

/** What the generated mcp/server.js imports at runtime. */
const BUNDLE_RUNTIME_DEPS: readonly string[] = [
  "@anvil/air",
  "@anvil/runtime",
  "@anvil/mcp-runtime",
  "@modelcontextprotocol/sdk",
];

/**
 * A deployed bundle installs its own package.json dependencies; a bundle under
 * self-test usually has not been installed. Link the toolchain's own copies of
 * the runtime packages into the bundle so `node mcp/server.js` (and, when the
 * caller supplies the CLI link, `node cli/<svc>.mjs`) resolve them. No-op for
 * every dependency that is already present.
 *
 * `extra` carries links the harness cannot resolve on its own — notably
 * `@anvil/cli`, which the harness must not depend on (it would cycle), so the
 * `anvil conformance` command passes its own resolved package directory in.
 */
export function ensureBundleNodeModules(dir: string, extra: BundleLink[] = []): void {
  const links: BundleLink[] = [...BUNDLE_RUNTIME_DEPS.map((name) => ({ name })), ...extra];
  for (const { name, dir: target } of links) {
    const link = join(dir, "node_modules", ...name.split("/"));
    if (existsSync(link)) continue;
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(target ?? packageDirOf(name), link, "dir");
  }
}

/**
 * Locate a dependency's package directory by walking this module's own
 * node_modules chain (ESM-safe: `require.resolve` cannot resolve packages whose
 * exports map has no "require" condition, which is true of every @anvil/*).
 */
export function packageDirOf(name: string): string {
  let current = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const candidate = join(current, "node_modules", ...name.split("/"));
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`Cannot locate ${name} in any node_modules above ${import.meta.url}.`);
    }
    current = parent;
  }
}
