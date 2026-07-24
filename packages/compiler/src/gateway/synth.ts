/**
 * Shared source synthesis for vendor gateway adapters. Every adapter normalizes
 * its export into a list of `(operationId, method, path)` operations plus overlay
 * facts and diagnostics, then calls `buildGatewayApiImport` — so no adapter
 * re-implements spec synthesis, source binding, or overlay assembly. This is what
 * keeps the vendor abstraction genuinely shared rather than five parallel
 * compilers.
 */
import { snakeCase } from "@anvil/air";
import { makeOverlay } from "../contract/overlay.js";
import { ephemeralCompilerSource } from "../source/compiler-source.js";
import type { SourceOriginKind } from "../source/model.js";
import type {
  EvidenceCoordinate,
  GatewayApiImport,
  GatewayContractProvenance,
  GatewayDiagnostic,
  GatewayPolicyOverlay,
} from "./model.js";
import { buildGatewayOverlay, type GatewayFact } from "./overlay.js";

/** One synthesized operation. */
export interface SynthOp {
  operationId: string;
  method: string;
  path: string;
}

const ROUTE_ONLY_GUARD_NOTE = "Anvil gateway route-only contract safety guard";
const ROUTE_ONLY_REMEDIATION =
  "Re-run `anvil estate import <export> --vendor <vendor> --spec <openapi-or-swagger-path> [--root <workspace>]` to lock and compile the original contract with the gateway policy overlay.";

/** Explicit provenance for a route table that Anvil, not the gateway, turns into OpenAPI. */
export function routeOnlyContract(location: EvidenceCoordinate): GatewayContractProvenance {
  return {
    kind: "synthesized",
    fidelity: "route_only",
    format: "openapi",
    version: "3.0.3",
    location,
    remediation: ROUTE_ONLY_REMEDIATION,
  };
}

/**
 * A stable operationId for a (service, method, path). Inputs are coerced to
 * strings so a malformed vendor export (a missing verb, a numeric path) yields a
 * degenerate id instead of a throw — for well-formed strings this is the
 * identity, so golden ids never move.
 */
export function synthOperationId(service: string, method: string, path: string): string {
  const p = String(path ?? "");
  const m = String(method ?? "");
  const pathToken = snakeCase(p.replace(/[{}]/g, "").replace(/[^a-zA-Z0-9]+/g, "_")) || "root";
  return `${snakeCase(String(service ?? ""))}_${m.toLowerCase()}_${pathToken}`;
}

/** Build the minimal OpenAPI YAML for a set of operations. Deterministic. */
export function synthesizeOpenApiFromOperations(
  title: string,
  version: string,
  rawOps: readonly SynthOp[],
): string {
  // Coerce method/path to strings so a malformed vendor op (a verb that parsed
  // as an object, a numeric path) degenerates rather than throwing downstream.
  // For well-formed ops this is the identity.
  const ops: SynthOp[] = rawOps.map((op) => ({
    operationId: String(op.operationId ?? ""),
    method: String(op.method ?? ""),
    path: String(op.path ?? ""),
  }));
  const byPath = new Map<string, SynthOp[]>();
  for (const op of ops) byPath.set(op.path, [...(byPath.get(op.path) ?? []), op]);

  const lines: string[] = [
    'openapi: "3.0.3"',
    `info: { title: ${JSON.stringify(title)}, version: ${JSON.stringify(version)} }`,
    "x-anvil-contract-fidelity: route_only",
    "x-anvil-contract-source: gateway_route_synthesis",
    "paths:",
  ];
  const paths = [...byPath.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [path, pathOps] of paths) {
    lines.push(`  ${JSON.stringify(path)}:`);
    for (const op of [...pathOps].sort((a, b) => a.method.localeCompare(b.method))) {
      lines.push(`    ${op.method.toLowerCase()}:`);
      lines.push(`      operationId: ${JSON.stringify(op.operationId)}`);
      const pathParams = [
        ...new Set(
          [...path.matchAll(/\{([^{}]+)\}/g)]
            .map((match) => match[1])
            .filter((name): name is string => Boolean(name)),
        ),
      ];
      if (pathParams.length > 0) {
        lines.push("      parameters:");
        for (const name of pathParams) {
          lines.push(`        - name: ${JSON.stringify(name)}`);
          lines.push("          in: path");
          lines.push("          required: true");
          lines.push("          schema: { type: string }");
        }
      }
      lines.push(`      responses: { "200": { description: ok } }`);
    }
  }
  if (ops.length === 0) lines.push("  {}");
  return `${lines.join("\n")}\n`;
}

/** Normalize a vendor path to an OpenAPI path (leading slash, `{}` params kept). */
export function normalizePath(path: string): string {
  const clean = String(path ?? "")
    .replace(/^~/, "")
    .trim();
  return clean.startsWith("/") ? clean : `/${clean}`;
}

/**
 * Operation-scoped gateway evidence selector that survives a supplied
 * contract's different operationId. Parameter names are erased because route
 * attestation already treats `/items/{id}` and `/items/{itemId}` as the same
 * callable coordinate.
 */
export function gatewayOperationRef(method: string, path: string): string {
  const normalizedPath = normalizePath(path)
    .replace(/\{\+?[^/{]+\}/g, "{}")
    .replace(/(^|\/):[^/]+/g, "$1{}");
  return `${String(method ?? "").toUpperCase()} ${normalizedPath}`;
}

/** Join a vendor base/context path to an operation path without losing templates. */
export function joinGatewayPath(base: string | undefined, path: string): string {
  const left = String(base ?? "")
    .trim()
    .replace(/^\/+|\/+$/g, "");
  const right = String(path ?? "")
    .trim()
    .replace(/^\/+|\/+$/g, "");
  const joined = [left, right].filter(Boolean).join("/");
  return normalizePath(joined);
}

/**
 * Assemble the one thing an adapter yields per API: an immutable source
 * synthesized from its operations, plus a gateway overlay from its facts.
 */
export function buildGatewayApiImport(input: {
  originKind: SourceOriginKind;
  apiName: string;
  /** Semantic API version used in the synthesized contract. */
  version?: string;
  /** Distinct gateway deployment revision, when the source exposes one. */
  revision?: string;
  sourceCoordinate: EvidenceCoordinate;
  ops: readonly SynthOp[];
  facts: readonly GatewayFact[];
  /** The export declares an auth policy that route synthesis cannot faithfully encode. */
  authConfigured?: boolean;
  diagnostics: GatewayDiagnostic[];
}): GatewayApiImport {
  // A malformed vendor entity may lack a name; coerce so synthesis degrades to a
  // blank id instead of throwing. For a real name this is the identity.
  const apiName = String(input.apiName ?? "");
  const specText = synthesizeOpenApiFromOperations(apiName, input.version ?? "0.0.0", input.ops);
  const base = ephemeralCompilerSource(specText, `${snakeCase(apiName)}.openapi.yaml`);
  const source = {
    ...base,
    origin: { kind: input.originKind, uri: `${input.originKind}://${apiName}` },
  };
  const contract: GatewayContractProvenance = {
    ...routeOnlyContract(input.sourceCoordinate),
    source: {
      snapshotId: source.snapshotId,
      sourceHash: source.sourceHash,
      entrypoint: source.entrypoint.path,
    },
  };
  const apiSubject = {
    api: {
      id: apiName,
      ...(input.revision
        ? {
            ...(input.version ? { apiVersion: input.version } : {}),
            revision: input.revision,
          }
        : input.version && input.version !== "0.0.0"
          ? { revision: input.version }
          : {}),
    },
  };
  // Adapter diagnostics already own their source scope. In particular, an
  // unscoped diagnostic is deliberately estate/global and must not become
  // API-local merely because this helper is synthesizing one selected API.
  const diagnostics = [...input.diagnostics];
  if (input.ops.length > 0) {
    diagnostics.push(
      {
        level: "warning",
        code: "gateway/route_only_contract",
        message: `Only gateway routes were available for '${apiName}'; the generated OpenAPI has no authoritative schemas, bodies, responses, or security schemes. ${ROUTE_ONLY_REMEDIATION}`,
        coordinate: input.sourceCoordinate,
        subject: apiSubject,
      },
      {
        level: "warning",
        code: "gateway/missing_runtime_coordinate",
        message: `No public gateway server/base URL was available for '${apiName}'; generated operations have no runtime coordinate and remain blocked.`,
        coordinate: input.sourceCoordinate,
        subject: apiSubject,
      },
    );
    if (
      input.authConfigured === true ||
      input.facts.some((fact) => fact.predicate.startsWith("auth."))
    ) {
      diagnostics.push({
        level: "warning",
        code: "gateway/auth_contract_incomplete",
        message: `Gateway authentication is configured for '${apiName}', but the route export does not prove the credential carrier, identity provider, token endpoint, audience, or security scheme. Operations remain blocked.`,
        coordinate: input.sourceCoordinate,
        subject: apiSubject,
      });
    }
  }
  const guardFacts: GatewayFact[] = input.ops.map((op) => ({
    target: { scope: "operation", ref: op.operationId },
    predicate: "state",
    operation: "set",
    value: "blocked",
    coordinate: input.sourceCoordinate,
    note: ROUTE_ONLY_GUARD_NOTE,
  }));
  const overlay = buildGatewayOverlay(
    [...guardFacts, ...input.facts],
    `overlay_${input.originKind}_${snakeCase(apiName)}`,
  );
  return { source, overlay, contract, diagnostics };
}

/**
 * A user-supplied full contract supersedes only Anvil's route-synthesis guard.
 * Gateway policy assertions remain; the CLI retargets them by method/path when
 * operationIds differ. Opaque gateway policy is guarded separately downstream.
 */
export function withoutRouteOnlyGuard(overlay: GatewayPolicyOverlay): GatewayPolicyOverlay {
  const guardEvidence = new Set(
    overlay.evidence.filter((e) => e.note === ROUTE_ONLY_GUARD_NOTE).map((e) => e.id),
  );
  const assertions = overlay.assertions.filter(
    (a) =>
      !(
        a.predicate === "state" &&
        a.value === "blocked" &&
        a.evidenceRefs.some((ref) => guardEvidence.has(ref))
      ),
  );
  const usedEvidence = new Set(assertions.flatMap((a) => a.evidenceRefs));
  return makeOverlay({
    origin: overlay.origin,
    id: `${overlay.id}_full_contract`,
    assertions,
    evidence: overlay.evidence.filter((e) => usedEvidence.has(e.id)),
  });
}
