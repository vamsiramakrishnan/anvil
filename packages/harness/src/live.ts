import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { effectiveAuthCarrier, hashCanonical, loadAirDocument, type Operation } from "@anvil/air";
import { deploymentArtifactHash, exampleInput, readBundleDir } from "@anvil/generators";
import { z } from "zod";
import { withoutConfirmationInput } from "./bundle-driver.js";
import { connectSource, type McpSource } from "./mcp-source.js";
import { resolveTransport } from "./profiles.js";
import type { Transport } from "./sources.js";

/**
 * The opt-in real lane. `selftest`, `conformance`, and `simulate` are all
 * hermetic — mock upstream, in-process simulator, zero network. This drives the
 * SAME agreement checks against a REAL, deployed MCP endpoint (a Cloud Run
 * `/mcp`, say): does the deployed server serve exactly the operations the bundle
 * certified, and does its confirmation gate actually refuse in production?
 *
 * It is off by default and config-gated: nothing runs unless the operator hands
 * it a config file naming the endpoint. The onus of configuration is on the
 * operator — credentials come from the environment (`${VAR}` refs in headers),
 * never from the config file. And it is production-safe by construction: it
 * lists tools, probes the confirmation gate WITHOUT confirm (the executor
 * refuses before building any request, so no side effect ever reaches the real
 * API), and invokes only the reads the operator explicitly opts into. It NEVER
 * drives a real mutation to completion.
 */

/** Operator-supplied live target. Credentials stay in the environment. */
export const LiveConfig = z.object({
  /** The deployed MCP endpoint, e.g. https://payments-abc.a.run.app/mcp. */
  mcpUrl: z.string(),
  /**
   * Auth headers for the endpoint. Values may reference `${VAR}` and are
   * resolved from the environment at connect time, so no secret is written here.
   */
  headers: z.record(z.string(), z.string()).default({}),
  /**
   * Operation ids whose READ is safe to actually invoke against the real API.
   * Empty by default — a read can still cost money or leak, so it is opt-in.
   */
  probeReads: z.array(z.string()).default([]),
  /** Per-operation inputs for the opt-in reads (id → argument object). */
  inputs: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
});
export type LiveConfig = z.infer<typeof LiveConfig>;

export const LiveCheck = z.object({
  /** Stable id: artifact-live | surface-live | gate-live | read-live | identity-live. */
  id: z.string(),
  operationId: z.string().optional(),
  status: z.enum(["pass", "fail", "skipped"]),
  outcome: z.enum(["success", "structured_error"]).optional(),
  /** Present only after a delegated read completes through the live runtime. */
  identityProof: z.literal("real_inbound_jwt_sts_upstream").optional(),
  expectedArtifactHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  observedArtifactHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  detail: z.string().optional(),
});
export type LiveCheck = z.infer<typeof LiveCheck>;

export const LiveReport = z.object({
  /**
   * v2 adds mandatory deployed-artifact attestation and per-contract-group
   * delegated identity proof. A v1 report cannot claim either guarantee.
   */
  schemaVersion: z.literal(2),
  bundle: z.string(),
  /** The endpoint probed. Never carries headers — those hold credentials. */
  target: z.string(),
  startedAt: z.string(),
  artifact: z.object({
    algorithm: z.literal("sha256"),
    expectedHash: z.string().regex(/^[0-9a-f]{64}$/),
    observedHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    matched: z.boolean(),
  }),
  checks: z.array(LiveCheck),
  identity: z.object({
    delegatedOperations: z.number().int(),
    delegatedContractGroups: z.number().int(),
    verifiedContractGroupIds: z.array(z.string()),
    unverifiedContractGroupIds: z.array(z.string()),
    contractGroups: z.array(
      z.object({
        id: z.string(),
        operationIds: z.array(z.string()),
        readOperationIds: z.array(z.string()),
        verifiedByOperationId: z.string().nullable(),
        status: z.enum(["verified", "unverified"]),
      }),
    ),
    liveIdpReadiness: z.enum(["not_applicable", "unverified", "verified_for_opted_in_reads"]),
    proof: z.enum(["not_applicable", "none", "real_inbound_jwt_sts_upstream"]),
    verifiedOperationIds: z.array(z.string()),
    unverifiedOperationIds: z.array(z.string()),
    detail: z.string(),
  }),
  summary: z.object({
    pass: z.number().int(),
    fail: z.number().int(),
    skipped: z.number().int(),
  }),
});
export type LiveReport = z.infer<typeof LiveReport>;

export interface LiveOptions {
  /** Wall-clock budget for each live call (default 30s). */
  callTimeoutMs?: number;
}

/** Load and validate a live-config JSON file. */
export function loadLiveConfig(path: string): LiveConfig {
  return LiveConfig.parse(JSON.parse(readFileSync(path, "utf8")));
}

/** Drive production-safe conformance checks against a real MCP endpoint. */
export async function runLiveConformance(
  bundleDir: string,
  config: LiveConfig,
  options: LiveOptions = {},
): Promise<LiveReport> {
  const dir = resolve(bundleDir);
  const air = loadAirDocument(JSON.parse(readFileSync(join(dir, "air.json"), "utf8")));
  const approved = air.operations.filter((op) => op.state === "approved");
  const startedAt = new Date().toISOString();
  const timeoutMs = options.callTimeoutMs ?? 30_000;
  const checks: LiveCheck[] = [];
  const expectedArtifactHash = deploymentArtifactHash(readBundleDir(dir));
  const withTimeout = <T>(p: Promise<T>, label: string): Promise<T> =>
    Promise.race([
      p,
      new Promise<T>((_, rej) =>
        setTimeout(() => rej(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);
  const artifact = await checkArtifactLive(
    config,
    air.service.id,
    expectedArtifactHash,
    withTimeout,
  );
  checks.push(artifact.check);
  if (artifact.check.status !== "pass") {
    return report(
      dir,
      config.mcpUrl,
      startedAt,
      approved,
      {
        algorithm: "sha256",
        expectedHash: expectedArtifactHash,
        observedHash: artifact.observedHash,
        matched: false,
      },
      checks,
    );
  }

  let source: McpSource | undefined;
  try {
    source = await connectSource({
      id: "live",
      system: "generic",
      // resolveTransport substitutes ${VAR} in headers from the environment, so
      // the config file never holds a credential.
      transport: { kind: "http", url: config.mcpUrl, headers: config.headers },
      hints: { scope: [] },
    });
  } catch (err) {
    return report(
      dir,
      config.mcpUrl,
      startedAt,
      approved,
      {
        algorithm: "sha256",
        expectedHash: expectedArtifactHash,
        observedHash: artifact.observedHash,
        matched: true,
      },
      [
        ...checks,
        {
          id: "surface-live",
          status: "fail",
          detail: `could not connect to ${config.mcpUrl}: ${err}`,
        },
      ],
    );
  }

  const src = source;

  try {
    // 1. surface-live: the deployed server serves exactly the certified surface.
    checks.push(await checkSurfaceLive(src, approved, withTimeout));

    // 2. gate-live: every gated mutation refuses without confirm, in production.
    for (const op of approved.filter((o) => o.confirmation.required)) {
      checks.push(await checkGateLive(src, op, withTimeout));
    }

    // 3. read-live: only the reads the operator opted into.
    const byId = new Map(approved.map((o) => [o.id, o]));
    for (const id of config.probeReads) {
      const op = byId.get(id);
      if (!op) {
        checks.push({
          id: "read-live",
          operationId: id,
          status: "fail",
          detail: "not an approved operation",
        });
        continue;
      }
      if (op.effect.kind !== "read") {
        checks.push({
          id: "read-live",
          operationId: id,
          status: "skipped",
          detail: "probeReads only invokes read operations; a mutation is never auto-driven",
        });
        continue;
      }
      checks.push(await checkReadLive(src, op, config.inputs[id], withTimeout));
    }
    const identityGate = liveIdentityGate(approved, checks);
    if (identityGate) checks.push(identityGate);
  } finally {
    await src.close().catch(() => undefined);
  }

  return report(
    dir,
    config.mcpUrl,
    startedAt,
    approved,
    {
      algorithm: "sha256",
      expectedHash: expectedArtifactHash,
      observedHash: artifact.observedHash,
      matched: true,
    },
    checks,
  );
}

/* -------------------------------------------------------------------------- */
/* Checks                                                                      */
/* -------------------------------------------------------------------------- */

type Timeout = <T>(p: Promise<T>, label: string) => Promise<T>;

interface ArtifactCheckResult {
  check: LiveCheck;
  observedHash: string | null;
}

/** Bind live proof to the exact deploy/runtime payload in the local bundle. */
async function checkArtifactLive(
  config: LiveConfig,
  expectedServiceId: string,
  expectedHash: string,
  withTimeout: Timeout,
): Promise<ArtifactCheckResult> {
  const id = "artifact-live";
  let transport: Transport;
  try {
    transport = resolveTransport({
      id: "live-artifact",
      system: "generic",
      transport: { kind: "http", url: config.mcpUrl, headers: config.headers },
      hints: { scope: [] },
    });
  } catch (err) {
    return {
      check: {
        id,
        status: "fail",
        expectedArtifactHash: expectedHash,
        detail: `could not resolve the live endpoint: ${String(err)}`,
      },
      observedHash: null,
    };
  }
  if (transport.kind !== "http") {
    return {
      check: {
        id,
        status: "fail",
        expectedArtifactHash: expectedHash,
        detail: "live artifact attestation requires an HTTP MCP endpoint",
      },
      observedHash: null,
    };
  }

  let healthUrl: URL;
  try {
    healthUrl = new URL(transport.url);
    if (!/\/mcp\/?$/.test(healthUrl.pathname)) {
      throw new Error("mcpUrl path must end in /mcp");
    }
    healthUrl.pathname = healthUrl.pathname.replace(/\/mcp\/?$/, "/healthz");
    healthUrl.search = "";
    healthUrl.hash = "";
  } catch (err) {
    return {
      check: {
        id,
        status: "fail",
        expectedArtifactHash: expectedHash,
        detail: `cannot derive the generated /healthz attestation endpoint: ${String(err)}`,
      },
      observedHash: null,
    };
  }

  try {
    const response = await withTimeout(
      fetch(healthUrl, {
        headers: transport.headers,
        redirect: "error",
      }),
      "artifact health check",
    );
    const body = await boundedResponseText(response, 64 * 1024);
    if (!response.ok) {
      return {
        check: {
          id,
          status: "fail",
          expectedArtifactHash: expectedHash,
          detail: `artifact endpoint returned HTTP ${response.status}`,
        },
        observedHash: null,
      };
    }
    let value: unknown;
    try {
      value = JSON.parse(body);
    } catch {
      return {
        check: {
          id,
          status: "fail",
          expectedArtifactHash: expectedHash,
          detail: "artifact endpoint did not return JSON",
        },
        observedHash: null,
      };
    }
    const parsed = z
      .object({
        status: z.literal("ok"),
        service: z.string(),
        artifactHash: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .safeParse(value);
    if (!parsed.success) {
      return {
        check: {
          id,
          status: "fail",
          expectedArtifactHash: expectedHash,
          detail: "artifact endpoint did not return the generated attestation envelope",
        },
        observedHash: null,
      };
    }
    const observedHash = parsed.data.artifactHash;
    if (parsed.data.service !== expectedServiceId) {
      return {
        check: {
          id,
          status: "fail",
          expectedArtifactHash: expectedHash,
          observedArtifactHash: observedHash,
          detail: `deployed service '${parsed.data.service}' does not match local service '${expectedServiceId}'`,
        },
        observedHash,
      };
    }
    if (observedHash !== expectedHash) {
      return {
        check: {
          id,
          status: "fail",
          expectedArtifactHash: expectedHash,
          observedArtifactHash: observedHash,
          detail:
            `stale or different deployment: local artifact ${expectedHash.slice(0, 12)}… ` +
            `but endpoint attests ${observedHash.slice(0, 12)}…`,
        },
        observedHash,
      };
    }
    return {
      check: {
        id,
        status: "pass",
        expectedArtifactHash: expectedHash,
        observedArtifactHash: observedHash,
        detail: `endpoint attests the exact local deploy/runtime artifact ${expectedHash.slice(0, 12)}…`,
      },
      observedHash,
    };
  } catch (err) {
    return {
      check: {
        id,
        status: "fail",
        expectedArtifactHash: expectedHash,
        detail: `could not attest ${healthUrl.toString()}: ${String(err)}`,
      },
      observedHash: null,
    };
  }
}

async function boundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new Error(`artifact response exceeded ${maxBytes} bytes`);
    }
    chunks.push(next.value);
  }
  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

/** The deployed tool surface equals the approved operations, exactly. */
async function checkSurfaceLive(
  src: McpSource,
  approved: Operation[],
  withTimeout: Timeout,
): Promise<LiveCheck> {
  const id = "surface-live";
  try {
    const tools = await withTimeout(src.listTools(), "listTools");
    const served = new Set(tools.map((t) => t.name));
    const want = new Set(approved.map((op) => op.mcp.toolName));
    const missing = [...want].filter((n) => !served.has(n));
    const extra = [...served].filter((n) => !want.has(n));
    if (missing.length > 0 || extra.length > 0) {
      const parts: string[] = [];
      if (missing.length) parts.push(`missing ${missing.join(", ")}`);
      if (extra.length) parts.push(`serves unapproved ${extra.join(", ")}`);
      return { id, status: "fail", detail: parts.join("; ") };
    }
    return {
      id,
      status: "pass",
      detail: `${want.size} tool(s) served, matching the certified surface exactly`,
    };
  } catch (err) {
    return { id, status: "fail", detail: String(err) };
  }
}

/**
 * A gated mutation refuses without confirm — proven against the live server.
 * The executor refuses before building any request, so this never reaches the
 * real upstream: sending example input WITHOUT confirm has no side effect.
 */
async function checkGateLive(
  src: McpSource,
  op: Operation,
  withTimeout: Timeout,
): Promise<LiveCheck> {
  const id = "gate-live";
  try {
    const args = withoutConfirmationInput(op, exampleInput(op));
    const res = await withTimeout(src.callRaw(op.mcp.toolName, args), `call ${op.mcp.toolName}`);
    if (!res.isError) {
      return {
        id,
        operationId: op.id,
        status: "fail",
        detail: "the live server executed a gated mutation without confirm",
      };
    }
    if (!/confirm/i.test(res.text)) {
      return {
        id,
        operationId: op.id,
        status: "fail",
        detail: `refusal was not a confirmation error: ${trim(res.text)}`,
      };
    }
    return {
      id,
      operationId: op.id,
      status: "pass",
      detail: "refused without confirm, in production",
    };
  } catch (err) {
    return { id, operationId: op.id, status: "fail", detail: String(err) };
  }
}

/** An opted-in read returns a structured result (success or structured error). */
async function checkReadLive(
  src: McpSource,
  op: Operation,
  input: Record<string, unknown> | undefined,
  withTimeout: Timeout,
): Promise<LiveCheck> {
  const id = "read-live";
  try {
    const args = input ?? exampleInput(op);
    const res = await withTimeout(src.callRaw(op.mcp.toolName, args), `call ${op.mcp.toolName}`);
    // A structured error (auth_required, not_found, …) is still a healthy,
    // well-formed response — the endpoint answered the contract, not a crash.
    if (res.isError && !isStructuredEnvelope(res.text)) {
      return {
        id,
        operationId: op.id,
        status: "fail",
        detail: `unstructured error: ${trim(res.text)}`,
      };
    }
    return {
      id,
      operationId: op.id,
      status: "pass",
      outcome: res.isError ? "structured_error" : "success",
      ...(!res.isError && op.auth.type === "oauth2_on_behalf_of"
        ? { identityProof: "real_inbound_jwt_sts_upstream" as const }
        : {}),
      detail: res.isError
        ? "returned a structured error envelope"
        : op.auth.type === "oauth2_on_behalf_of"
          ? "returned a structured success after validated inbound identity, live token exchange, and upstream execution"
          : "returned a structured success",
    };
  } catch (err) {
    return { id, operationId: op.id, status: "fail", detail: String(err) };
  }
}

function isStructuredEnvelope(text: string): boolean {
  try {
    const v = JSON.parse(text) as { error?: { code?: unknown } };
    return typeof v?.error?.code === "string";
  } catch {
    return false;
  }
}

function trim(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat;
}

function report(
  dir: string,
  target: string,
  startedAt: string,
  approved: readonly Operation[],
  artifact: LiveReport["artifact"],
  checks: LiveCheck[],
): LiveReport {
  const count = (status: LiveCheck["status"]) => checks.filter((c) => c.status === status).length;
  const identity = liveIdentityReadiness(approved, checks);
  return LiveReport.parse({
    schemaVersion: 2,
    bundle: dir,
    target,
    startedAt,
    artifact,
    checks,
    identity,
    summary: { pass: count("pass"), fail: count("fail"), skipped: count("skipped") },
  });
}

/**
 * Project live identity readiness from evidence-bearing read checks. Merely
 * reaching the surface, discovery/JWKS, `/readyz`, or receiving an error
 * envelope can never mint this proof.
 */
interface DelegatedIdentityContractGroup {
  id: string;
  operationIds: string[];
  readOperationIds: string[];
}

function normalizedIdentityCarrier(operation: Operation): unknown {
  const carrier = effectiveAuthCarrier(operation.auth);
  if (!carrier) return null;
  return carrier.in === "header"
    ? {
        in: "header",
        name: carrier.name.toLowerCase(),
        ...(carrier.scheme ? { scheme: carrier.scheme.toLowerCase() } : {}),
      }
    : { in: "query", name: carrier.name };
}

/**
 * Group delegated operations by the complete non-secret identity/credential
 * contract that selects and drives token exchange.
 */
export function delegatedIdentityContractGroups(
  approved: readonly Operation[],
): DelegatedIdentityContractGroup[] {
  const grouped = new Map<string, { operations: Operation[] }>();
  for (const operation of approved) {
    if (operation.auth.type !== "oauth2_on_behalf_of") continue;
    const provider = operation.auth.provider;
    const contract = {
      principal: operation.auth.principal,
      issuer: operation.auth.issuer ?? null,
      audience: operation.auth.audience ?? null,
      carrier: normalizedIdentityCarrier(operation),
      credentialProfile: operation.auth.credentialProfile ?? "default",
      scopes: [...new Set(operation.auth.scopes)].sort(),
      tenant: operation.auth.tenant ?? null,
      delegation: operation.auth.delegation ?? null,
      tokenProfile: {
        tokenEndpoint: provider?.tokenEndpoint ?? null,
        grant: provider?.grant ?? "token_exchange",
        clientAuth: provider?.clientAuth ?? null,
        resource: provider?.resource ?? null,
        subjectTokenType: provider?.subjectTokenType ?? null,
        requestedTokenType: provider?.requestedTokenType ?? null,
      },
    };
    const id = `obo:${hashCanonical(contract)}`;
    const current = grouped.get(id) ?? { operations: [] };
    current.operations.push(operation);
    grouped.set(id, current);
  }
  return [...grouped.entries()]
    .map(([id, group]) => ({
      id,
      operationIds: group.operations.map((operation) => operation.id).sort(),
      readOperationIds: group.operations
        .filter((operation) => operation.effect.kind === "read")
        .map((operation) => operation.id)
        .sort(),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function liveIdentityReadiness(
  approved: readonly Operation[],
  checks: readonly LiveCheck[],
): LiveReport["identity"] {
  const delegated = approved.filter((operation) => operation.auth.type === "oauth2_on_behalf_of");
  const artifactBound = checks.some(
    (check) =>
      check.id === "artifact-live" &&
      check.status === "pass" &&
      check.expectedArtifactHash !== undefined &&
      check.expectedArtifactHash === check.observedArtifactHash,
  );
  const successfulReadIds = new Set(
    checks.flatMap((check) =>
      artifactBound &&
      check.id === "read-live" &&
      check.status === "pass" &&
      check.outcome === "success" &&
      check.identityProof === "real_inbound_jwt_sts_upstream" &&
      check.operationId
        ? [check.operationId]
        : [],
    ),
  );
  const groups = delegatedIdentityContractGroups(approved);
  const contractGroups = groups.map((group) => {
    const verifiedByOperationId =
      group.readOperationIds.find((operationId) => successfulReadIds.has(operationId)) ?? null;
    return {
      ...group,
      verifiedByOperationId,
      status: verifiedByOperationId ? ("verified" as const) : ("unverified" as const),
    };
  });
  const verifiedContractGroupIds = contractGroups
    .filter((group) => group.status === "verified")
    .map((group) => group.id);
  const unverifiedContractGroupIds = contractGroups
    .filter((group) => group.status === "unverified")
    .map((group) => group.id);
  const verifiedOperationIds = contractGroups
    .flatMap((group) => (group.verifiedByOperationId ? [group.verifiedByOperationId] : []))
    .sort();
  const unverifiedOperationIds = contractGroups
    .filter((group) => group.status === "unverified")
    .flatMap((group) => group.operationIds)
    .sort();
  const identity =
    delegated.length === 0
      ? {
          delegatedOperations: 0,
          delegatedContractGroups: 0,
          verifiedContractGroupIds,
          unverifiedContractGroupIds,
          contractGroups,
          liveIdpReadiness: "not_applicable" as const,
          proof: "not_applicable" as const,
          verifiedOperationIds,
          unverifiedOperationIds,
          detail: "No approved delegated operations.",
        }
      : groups.length > 0 && unverifiedContractGroupIds.length === 0
        ? {
            delegatedOperations: delegated.length,
            delegatedContractGroups: groups.length,
            verifiedContractGroupIds,
            unverifiedContractGroupIds,
            contractGroups,
            liveIdpReadiness: "verified_for_opted_in_reads" as const,
            proof: "real_inbound_jwt_sts_upstream" as const,
            verifiedOperationIds,
            unverifiedOperationIds,
            detail:
              "Every distinct delegated identity/credential contract group is covered by a successful opted-in read through the exact deployed artifact, real inbound JWT validation, live STS exchange, and the upstream.",
          }
        : {
            delegatedOperations: delegated.length,
            delegatedContractGroups: groups.length,
            verifiedContractGroupIds,
            unverifiedContractGroupIds,
            contractGroups,
            liveIdpReadiness: "unverified" as const,
            proof: "none" as const,
            verifiedOperationIds,
            unverifiedOperationIds,
            detail: !artifactBound
              ? "The endpoint did not attest the exact local deploy/runtime artifact. Tool-name parity and successful calls cannot prove this bundle's IdP/OBO readiness."
              : "At least one delegated identity/credential contract group lacks a successful opted-in read. Surface checks, discovery/JWKS reachability, and /readyz do not prove IdP/OBO readiness.",
          };
  return identity;
}

/**
 * Separate fail-closed live IdP gate. A bundle with delegated operations cannot
 * produce a green live-conformance exit merely from surface/JWKS/readiness
 * checks. Every distinct delegated identity/credential contract group needs one
 * explicitly opted-in successful read. Mutations are never invoked to satisfy
 * this gate, so a write-only group remains unverified by design.
 */
export function liveIdentityGate(
  approved: readonly Operation[],
  checks: readonly LiveCheck[],
): LiveCheck | undefined {
  const identity = liveIdentityReadiness(approved, checks);
  if (identity.delegatedOperations === 0) return undefined;
  if (identity.liveIdpReadiness === "verified_for_opted_in_reads") {
    return {
      id: "identity-live",
      status: "pass",
      detail:
        `Verified ${identity.verifiedContractGroupIds.length} delegated identity contract group(s) ` +
        `through opted-in read(s): ${identity.verifiedOperationIds.join(", ")}`,
    };
  }
  const writeOnlyGroups = identity.contractGroups.filter(
    (group) => group.status === "unverified" && group.readOperationIds.length === 0,
  );
  return {
    id: "identity-live",
    status: "fail",
    detail:
      writeOnlyGroups.length > 0
        ? `Live IdP readiness cannot be proven safely: ${writeOnlyGroups.length} delegated identity contract group(s) have no approved read. Anvil will not invoke a real write.`
        : "Live IdP readiness is unverified. Every delegated identity contract group needs an approved read in probeReads with real inbound JWT credentials and inputs; each must succeed through live STS and upstream execution against the attested artifact.",
  };
}
