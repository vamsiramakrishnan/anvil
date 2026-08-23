import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type AirDocument, type Claim, loadAirDocument, type Operation } from "@anvil/air";
import {
  type AnvilManifest,
  compile,
  type DriftItem,
  diffContracts,
  type OperationManifest,
} from "@anvil/compiler";
import { z } from "zod";
import type { HarnessFinding, OperationClaim } from "./agent.js";
import { ensureBundleNodeModules, parseJson, withTimeout } from "./bundle-driver.js";
import { connectSource, type McpSource, type TransportFactory } from "./mcp-source.js";
import { type ReconcileDecision, reconcile } from "./reconcile.js";

/**
 * The observed-reality lane.
 *
 * Every other lane in this package is hermetic: `selftest` and `conformance`
 * drive the bundle against its own generated mock, `simulate` against an
 * in-process simulator. They prove the bundle is faithful to AIR. None of them
 * can tell you whether AIR is faithful to the *running application*, because
 * none of them ever meet it.
 *
 * That gap is why a Spring Boot service whose springdoc document drifted from
 * its controllers, or a WCF endpoint whose WSDL describes an operation that was
 * retired two releases ago, sails through every gate Anvil has and fails in
 * production. "We tested the spec" is not "we tested the system."
 *
 * This lane closes it in two passes, both propose-only:
 *
 *  - **Contract drift** — fetch the contract the running app publishes about
 *    *itself* (springdoc `/v3/api-docs`, Swashbuckle `/swagger/v1/swagger.json`,
 *    a WSDL) and diff it against the AIR the bundle was compiled from, through
 *    the same `diffContracts` that powers `anvil drift`. The app is the
 *    authority on its own shape; if it disagrees with what you compiled, that
 *    is a fact, not an opinion.
 *  - **Implementation drift** — drive the operator's opt-in READS against the
 *    real application, through the bundle's own generated MCP server, and
 *    compare what came back to what AIR claims comes back.
 *
 * Nothing here writes AIR. Findings become an `AnvilManifest` proposal that an
 * operator reviews and feeds to `anvil compile --manifest`, exactly like
 * `anvil enrich`. And a read is never allowed to argue that a mutation is safe:
 * see `observationLicenses` for the deliberately short list of claims driving a
 * real endpoint actually earns.
 */

export const OBSERVE_REPORT_FILE = "observe.report.json";

/**
 * The operator-supplied target. Credentials stay in the environment, exactly as
 * they do for the live conformance lane: a config file is a thing people commit.
 */
export const ObserveConfig = z.object({
  /** The running application, e.g. `http://localhost:8080`. */
  baseUrl: z.string(),
  /**
   * Where the app publishes its own contract. Springdoc defaults to
   * `/v3/api-docs`; Swashbuckle to `/swagger/v1/swagger.json`. Omit to skip the
   * contract-drift pass entirely — an app that publishes nothing is a legitimate
   * case, not an error.
   */
  contractPath: z.string().optional(),
  /**
   * Headers for the CONTRACT FETCH only. `${VAR}` resolves from the environment
   * at request time, so no secret is written here.
   *
   * Deliberately not the probes'. The probes run through the bundle's own
   * generated MCP server, which resolves credentials the way every other Anvil
   * surface does — from the auth profile the operation declares, reading the
   * environment. Injecting arbitrary headers around that would route probe
   * traffic through a path no other caller uses, which is the opposite of what
   * this lane is for. Give the probes their credential through `env`.
   */
  contractHeaders: z.record(z.string(), z.string()).default({}),
  /**
   * Operation ids whose READ is safe to actually invoke against this app.
   * Empty by default. A read can still cost money, page someone, or return
   * personal data, so every one is opt-in — and a mutation is never invoked at
   * all, whatever this list says.
   */
  probeReads: z.array(z.string()).default([]),
  /** Per-operation arguments for the opt-in reads (operation id → arguments). */
  inputs: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
  /** Extra environment for the generated MCP server (upstream credentials). */
  env: z.record(z.string(), z.string()).default({}),
});
export type ObserveConfig = z.infer<typeof ObserveConfig>;

/** What one probed operation actually did, as opposed to what AIR says it does. */
export const Observation = z.object({
  operationId: z.string(),
  tool: z.string(),
  /** `ok` — the call returned a result. `refused` — the runtime refused it. */
  outcome: z.enum(["ok", "refused", "error", "unreachable"]),
  /** The Anvil error code when the call failed through the structured envelope. */
  errorCode: z.string().optional(),
  /** Top-level response keys the app returned. */
  observedFields: z.array(z.string()).default([]),
  /** Response keys AIR declares. Empty when the contract declares no shape. */
  declaredFields: z.array(z.string()).default([]),
  /** Returned but undeclared — the contract is behind the implementation. */
  undeclaredFields: z.array(z.string()).default([]),
  /** Declared but absent — the contract promises something the app did not send. */
  absentFields: z.array(z.string()).default([]),
  detail: z.string(),
});
export type Observation = z.infer<typeof Observation>;

export const ContractAcquisition = z.object({
  attempted: z.boolean(),
  /** The URL fetched, so the acquisition is auditable after the fact. */
  url: z.string().optional(),
  /** sha256 of the exact bytes the app served, binding the drift to what we read. */
  sha256: z.string().optional(),
  ok: z.boolean(),
  detail: z.string(),
});
export type ContractAcquisition = z.infer<typeof ContractAcquisition>;

export const ObserveReport = z.object({
  schemaVersion: z.literal(1),
  startedAt: z.string(),
  finishedAt: z.string(),
  service: z.string(),
  /** Host only — a base URL can carry a query-string credential. */
  target: z.string(),
  contract: ContractAcquisition,
  /** Contract-vs-contract differences, from the same differ `anvil drift` uses. */
  drift: z.array(z.custom<DriftItem>()).default([]),
  observations: z.array(Observation).default([]),
  /** The propose-only manifest patch. Never applied; review it, then compile. */
  proposal: z.custom<AnvilManifest>().optional(),
  decisions: z.array(z.custom<ReconcileDecision>()).default([]),
  summary: z.object({
    probed: z.number().int().nonnegative(),
    unreachable: z.number().int().nonnegative(),
    contractGaps: z.number().int().nonnegative(),
    driftItems: z.number().int().nonnegative(),
    /** Probes that answered with an error — asked, but nothing learned. */
    errored: z.number().int().nonnegative().default(0),
    /** Configured probe ids this bundle does not define. */
    unknownProbeIds: z.number().int().nonnegative().default(0),
  }),
  /** False when the app contradicted the contract in a way that needs a human,
   *  or when a check the operator configured never actually ran. */
  ok: z.boolean(),
});
export type ObserveReport = z.infer<typeof ObserveReport>;

export interface ObserveOptions {
  transportFactory?: TransportFactory;
  callTimeoutMs?: number;
  /** Injectable fetch, so the contract-drift pass is testable without a network. */
  fetchImpl?: typeof fetch;
  /**
   * Called with the exact bytes the application served for its own contract.
   *
   * Layer 0 never fetches — `anvil source add` ingests local bytes only, and
   * that boundary is what makes a snapshot id mean something. So this lane does
   * not quietly become a second ingestion path: it hands the operator the bytes
   * it already read, with the digest it already computed, and re-capturing them
   * stays their deliberate act.
   */
  onContract?: (contract: { text: string; url: string; sha256: string }) => void;
}

/** Resolve `${VAR}` header references from the environment at request time. */
function resolveHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key: string) =>
      process.env[key] === undefined ? "" : String(process.env[key]),
    );
  }
  return out;
}

/** The host of a URL, so a report never carries a query-carried credential. */
function safeTarget(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "(unparseable base URL)";
  }
}

/** Top-level property names an operation's AIR output schema declares. */
function declaredResponseFields(op: Operation): string[] {
  const schema = op.output.schema;
  const properties = schema?.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return [];
  return Object.keys(properties as Record<string, unknown>).sort();
}

/** Top-level keys of a decoded response, or [] when it is not an object. */
function observedResponseFields(value: unknown): string[] {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value as Record<string, unknown>).sort()
    : [];
}

/**
 * What driving a real read actually licenses us to claim.
 *
 * Deliberately short. A successful GET proves the endpoint exists and what it
 * returned; it proves nothing about whether a POST elsewhere is idempotent, and
 * this lane must never let recorded traffic's high reliability (0.95) launder an
 * unrelated safety loosening through the reconciler. So the only claim an
 * observation raises is the one it genuinely earns: an operation the application
 * says is gone.
 */
function observationLicenses(observation: Observation): OperationClaim | undefined {
  if (observation.outcome === "unreachable") {
    return { type: "deprecated", value: true, direction: "tighten" };
  }
  return undefined;
}

function claimFor(operationId: string, target: string, note: string, confidence: number): Claim {
  return {
    subject: operationId,
    predicate: "exists",
    source: "recorded_traffic",
    sourceRef: target,
    method: "observed",
    confidence,
    note,
  };
}

/**
 * Fetch the contract the application publishes about itself and diff it against
 * the AIR the bundle carries.
 */
async function observeContract(
  air: AirDocument,
  config: ObserveConfig,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  onContract: ObserveOptions["onContract"],
): Promise<{ acquisition: ContractAcquisition; drift: DriftItem[] }> {
  if (config.contractPath === undefined) {
    return {
      acquisition: {
        attempted: false,
        ok: false,
        detail:
          "No contractPath was configured, so the application was not asked for its own contract.",
      },
      drift: [],
    };
  }
  const url = new URL(config.contractPath, config.baseUrl).toString();
  let text: string;
  try {
    const response = await withTimeout(
      fetchImpl(url, { headers: resolveHeaders(config.contractHeaders) }),
      timeoutMs,
      "contract fetch",
    );
    if (!response.ok) {
      return {
        acquisition: {
          attempted: true,
          url,
          ok: false,
          detail: `the application returned HTTP ${response.status} for its own contract`,
        },
        drift: [],
      };
    }
    text = await response.text();
  } catch (error) {
    return {
      acquisition: {
        attempted: true,
        url,
        ok: false,
        // Never echo the transport's message: it can carry the URL, and the URL
        // can carry a credential.
        detail: `the contract endpoint could not be reached (${error instanceof Error ? error.name : "error"})`,
      },
      drift: [],
    };
  }

  const sha256 = createHash("sha256").update(text, "utf8").digest("hex");
  onContract?.({ text, url, sha256 });
  let fresh: AirDocument;
  try {
    fresh = await compile({ spec: text, serviceId: air.service.id });
  } catch (error) {
    return {
      acquisition: {
        attempted: true,
        url,
        sha256,
        ok: false,
        detail: `the published contract did not compile: ${error instanceof Error ? error.message : "unknown error"}`,
      },
      drift: [],
    };
  }
  // A document that compiles to nothing is not the application's contract. An
  // auth wall that answers 200 with an HTML login page, or a path that serves
  // some unrelated JSON, both land here — and both would otherwise be reported
  // as a successful acquisition whose diff says every operation was removed.
  // That is a wall of false blocking drift from a misconfigured path, which
  // reads exactly like a real emergency.
  if (fresh.operations.length === 0) {
    return {
      acquisition: {
        attempted: true,
        url,
        sha256,
        ok: false,
        detail:
          "the endpoint answered, but what it served declares no operations — " +
          "it is not this application's contract. Check contractPath, and whether " +
          "an auth wall answered in the contract's place.",
      },
      drift: [],
    };
  }

  // The same differ `anvil drift` uses. Two contracts, one comparison rule —
  // an observed-drift item and a re-compile drift item mean the same thing.
  const drift = diffContracts(air, fresh);
  return {
    acquisition: {
      attempted: true,
      url,
      sha256,
      ok: true,
      detail: `compiled the application's own contract (${fresh.operations.length} operation(s))`,
    },
    drift,
  };
}

/**
 * Why an operation the operator listed will not be driven, or undefined when it
 * will be.
 *
 * A single partition rather than two independent filters, so "probed" and
 * "refused" are disjoint by construction: an earlier draft derived them
 * separately, and deleting the read-only test there left a mutation in BOTH
 * sets — reported as refused while also being driven. The mutation gate caught
 * it (`observe/read-only-probe`). One predicate, one answer, and each refusal
 * states its actual reason instead of a generic one.
 */
function refusalReason(op: Operation): string | undefined {
  if (op.effect.kind !== "read") {
    return "classified as a mutation; this lane never drives a mutation against a real application.";
  }
  if (op.state !== "approved") {
    return `not approved (state '${op.state}'); only approved operations are exposed, so there is nothing to observe.`;
  }
  if (op.archetype === "webhook_receiver") {
    return "a webhook receiver, which is never a directly callable operation.";
  }
  return undefined;
}

/**
 * Run the observed-reality lane over a generated bundle against a running
 * application. Reads only, opt-in only, propose-only.
 */
export async function runObserve(
  bundleDir: string,
  config: ObserveConfig,
  options: ObserveOptions = {},
): Promise<ObserveReport> {
  const dir = resolve(bundleDir);
  const air = loadAirDocument(JSON.parse(readFileSync(join(dir, "air.json"), "utf8")));
  const startedAt = new Date().toISOString();
  const timeoutMs = options.callTimeoutMs ?? 30_000;
  const fetchImpl = options.fetchImpl ?? fetch;
  const target = safeTarget(config.baseUrl);

  const { acquisition, drift } = await observeContract(
    air,
    config,
    fetchImpl,
    timeoutMs,
    options.onContract,
  );

  const observations: Observation[] = [];
  const findings: HarnessFinding[] = [];
  const listed = air.operations.filter((op) => config.probeReads.includes(op.id));
  const toProbe: Operation[] = [];
  const refused: Operation[] = [];

  // An id in probeReads that matches nothing in AIR is the same failure the
  // loop below refuses loudly, arriving one step earlier: the operator believes
  // that operation is being exercised. Dropping it silently is how a typo, or
  // an operation renamed out of the bundle, quietly stops covering the endpoint
  // it was added for — while the report still says the lane passed.
  const known = new Set(air.operations.map((op) => op.id));
  const unknown = config.probeReads.filter((id) => !known.has(id));
  for (const id of unknown) {
    observations.push({
      operationId: id,
      tool: id,
      outcome: "refused",
      observedFields: [],
      declaredFields: [],
      undeclaredFields: [],
      absentFields: [],
      detail:
        "listed in probeReads but no such operation exists in this bundle — " +
        "check the id against `anvil inspect`, or remove it from the config.",
    });
  }

  for (const op of listed) {
    const reason = refusalReason(op);
    if (reason === undefined) {
      toProbe.push(op);
      continue;
    }
    // Refused loudly rather than skipped silently: an operator who listed an
    // operation believes it is being exercised.
    refused.push(op);
    observations.push({
      operationId: op.id,
      tool: op.mcp.toolName,
      outcome: "refused",
      observedFields: [],
      declaredFields: [],
      undeclaredFields: [],
      absentFields: [],
      detail: `listed in probeReads but ${reason}`,
    });
  }

  let source: McpSource | undefined;
  if (toProbe.length > 0) {
    ensureBundleNodeModules(dir);
    source = await connectSource(
      {
        id: "observe",
        system: "generic",
        transport: {
          kind: "stdio",
          command: process.execPath,
          args: [join(dir, "mcp", "server.js")],
          // The bundle's own generated server, pointed at the real application.
          // Driving through it rather than around it is the point: this
          // exercises the exact executor path the CLI, the MCP server, and all
          // four SDKs share, so what is observed is what a caller would get.
          env: {
            // The runtime pins egress to this URL's host on its own when no
            // explicit allowlist is configured, so setting one here would only
            // be a second place to get it wrong.
            ANVIL_BASE_URL: config.baseUrl,
            ...config.env,
          },
        },
        hints: { scope: [] },
      },
      options.transportFactory,
    );
  }

  try {
    for (const op of toProbe) {
      const args = config.inputs[op.id] ?? {};
      let outcome: Observation["outcome"] = "ok";
      let errorCode: string | undefined;
      let detail = "the application answered";
      let observed: string[] = [];
      try {
        const result = await withTimeout(
          (source as McpSource).callRaw(op.mcp.toolName, args),
          timeoutMs,
          `probe ${op.id}`,
        );
        const decoded = parseJson(result.text);
        if (result.isError) {
          const envelope = decoded as { error?: { code?: string } } | null;
          errorCode = envelope?.error?.code;
          // `not_found` on a read the contract declares is the signal this lane
          // exists for: the contract names an endpoint the application does not
          // serve.
          outcome = errorCode === "not_found" ? "unreachable" : "error";
          detail =
            outcome === "unreachable"
              ? "the application does not serve this operation; the contract declares an endpoint that is not there"
              : `the application refused the call (${errorCode ?? "unknown error"})`;
        } else {
          observed = observedResponseFields(decoded);
        }
      } catch (error) {
        outcome = "error";
        detail = `the probe did not complete (${error instanceof Error ? error.name : "error"})`;
      }

      const declared = declaredResponseFields(op);
      const undeclared = observed.filter((field) => !declared.includes(field));
      const absent = declared.filter((field) => !observed.includes(field));
      if (outcome === "ok") {
        detail =
          declared.length === 0
            ? `the application returned ${observed.length} field(s); the contract declares no response shape at all`
            : `the application answered with ${observed.length} field(s), ${undeclared.length} of them undeclared`;
      }
      const observation: Observation = {
        operationId: op.id,
        tool: op.mcp.toolName,
        outcome,
        ...(errorCode ? { errorCode } : {}),
        observedFields: observed,
        declaredFields: declared,
        undeclaredFields: outcome === "ok" ? undeclared : [],
        absentFields: outcome === "ok" ? absent : [],
        detail,
      };
      observations.push(observation);

      const claim = observationLicenses(observation);
      findings.push({
        operationId: op.id,
        sourceId: "observe",
        evidence: claimFor(op.id, target, detail, outcome === "ok" ? 0.9 : 0.95),
        ...(claim ? { claim } : {}),
      });
    }
  } finally {
    await source?.close();
  }

  // The same reconciler `anvil enrich` uses, so observed evidence is weighed by
  // the one asymmetric-trust gate rather than a second one that could drift.
  const operations: Record<string, OperationManifest> = {};
  const decisions: ReconcileDecision[] = [];
  for (const op of air.operations) {
    const mine = findings.filter((finding) => finding.operationId === op.id);
    if (mine.length === 0) continue;
    const result = reconcile(op, mine);
    decisions.push(...result.decisions);
    if (Object.keys(result.patch).length > 0) operations[op.id] = result.patch;
  }
  const proposal: AnvilManifest | undefined =
    Object.keys(operations).length > 0
      ? { operations, workflows: {}, capabilities: {}, query_templates: {} }
      : undefined;

  const unreachable = observations.filter((o) => o.outcome === "unreachable").length;
  const contractGaps = observations.filter(
    (o) =>
      o.undeclaredFields.length > 0 || o.absentFields.length > 0 || o.declaredFields.length === 0,
  ).length;
  const blockingDrift = drift.filter(
    (item) => item.severity === "blocking" || item.severity === "high",
  ).length;
  // An operation that answered with an error is not an observation: nothing was
  // learned about whether the model matches the application.
  const errored = observations.filter((o) => o.outcome === "error").length;

  return {
    schemaVersion: 1,
    startedAt,
    finishedAt: new Date().toISOString(),
    service: air.service.id,
    target,
    contract: acquisition,
    drift,
    observations,
    ...(proposal ? { proposal } : {}),
    decisions,
    summary: {
      probed: toProbe.length,
      unreachable,
      contractGaps,
      driftItems: drift.length,
      errored,
      unknownProbeIds: unknown.length,
    },
    // An unreachable operation or a high-severity contract difference is the
    // application telling you the compiled model is wrong. That is a failure of
    // the lane, not a note in it.
    //
    // So is a check that never ran. A contract endpoint that answered 401, or
    // was unreachable, or served something unparseable, and a probe that errored
    // rather than returning — each of those leaves the lane with no observation
    // where the operator asked for one. Reporting ok for them is worse than
    // reporting a difference: a difference is information, while an unexecuted
    // check that exits 0 is automation being told a question was answered when
    // it was not asked.
    ok:
      unreachable === 0 &&
      blockingDrift === 0 &&
      refused.length === 0 &&
      errored === 0 &&
      unknown.length === 0 &&
      (!acquisition.attempted || acquisition.ok),
  };
}
