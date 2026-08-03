import type { Operation } from "@anvil/air";
import {
  type GatewayArtifactEvidence,
  type GatewayContractProvenance,
  type GatewayDiagnostic,
  type GatewayImportReceiptDraft,
  type GatewayPolicyOverlay,
  gatewayOperationRef,
  makeOverlay,
} from "@anvil/compiler";

/**
 * Attesting a *supplied* contract against the gateway it claims to describe.
 *
 * A contract an operator hands Anvil is authoritative for API shape and nothing
 * else. It does not prove gateway membership, it does not prove that calls still
 * traverse the gateway, and matching routes is not the same as matching bytes.
 * Everything here exists to keep those three claims separate.
 *
 * All of it is pure: operations and artifacts in, diagnostics and decisions out.
 * It was already pure inside `estate.ts` — it simply had no door, which is why
 * four of its codes had no assertion anywhere in the workspace.
 */

/** How the supplied contract's bytes relate to the gateway's own definition. */
export type FormalDefinitionLineage = NonNullable<
  GatewayImportReceiptDraft["contract"]["formalDefinitionLineage"]
>;

/** A refusal to establish lineage, with the details the CLI reports alongside it. */
export interface LineageRejection {
  code: string;
  message: string;
  details: Record<string, unknown>;
}

export function operationKeys(operation: Operation): string[] {
  const route =
    operation.sourceRef.method && operation.sourceRef.path
      ? gatewayOperationRef(operation.sourceRef.method, operation.sourceRef.path)
      : undefined;
  return [operation.id, operation.canonicalName, operation.sourceRef.operationId, route].filter(
    (key): key is string => key !== undefined,
  );
}

function normalizedRoutePath(value: string): string | undefined {
  const path = value.trim();
  if (path === "") return undefined;
  const leadingSlash = path.startsWith("/") ? path : `/${path}`;
  return leadingSlash.replace(/\{\+?[^/{]+\}/g, "{}").replace(/(^|\/):[^/]+/g, "$1{}");
}

function routeKey(operation: Operation): string | undefined {
  const { method, path } = operation.sourceRef;
  const normalizedPath = path ? normalizedRoutePath(path) : undefined;
  return method && normalizedPath ? `${method.toUpperCase()} ${normalizedPath}` : undefined;
}

function routeMultiset(operations: readonly Operation[]): {
  routes: Map<string, Operation[]>;
  unattested: Operation[];
} {
  const routes = new Map<string, Operation[]>();
  const unattested: Operation[] = [];
  for (const operation of operations) {
    const key = routeKey(operation);
    if (!key) {
      unattested.push(operation);
      continue;
    }
    routes.set(key, [...(routes.get(key) ?? []), operation]);
  }
  return { routes, unattested };
}

/**
 * A supplied contract is authoritative only for API shape, not gateway
 * membership. Prove that it describes exactly the gateway's selected route
 * multiset before allowing any operation to escape the import guard.
 */
export function attestGatewayRouteSet(
  synthesized: readonly Operation[],
  supplied: readonly Operation[],
  coordinate: GatewayContractProvenance["location"],
): GatewayDiagnostic[] {
  const gateway = routeMultiset(synthesized);
  const contract = routeMultiset(supplied);
  const diagnostics: GatewayDiagnostic[] = [];

  for (const operation of gateway.unattested) {
    diagnostics.push({
      level: "warning",
      code: "gateway/route_set_ambiguous",
      message: `Gateway operation '${operation.id}' has no attestable HTTP method/path coordinate.`,
      coordinate,
    });
  }
  for (const operation of contract.unattested) {
    diagnostics.push({
      level: "warning",
      code: "gateway/route_set_ambiguous",
      message: `Supplied contract operation '${operation.id}' has no attestable HTTP method/path coordinate.`,
      coordinate,
    });
  }

  const keys = [...new Set([...gateway.routes.keys(), ...contract.routes.keys()])].sort();
  for (const key of keys) {
    const gatewayCount = gateway.routes.get(key)?.length ?? 0;
    const contractCount = contract.routes.get(key)?.length ?? 0;
    if (gatewayCount > 1) {
      diagnostics.push({
        level: "warning",
        code: "gateway/route_set_ambiguous",
        message: `Gateway route '${key}' appears ${gatewayCount} times; an explicit reviewed route mapping is required.`,
        coordinate,
      });
    }
    if (contractCount > 1) {
      diagnostics.push({
        level: "warning",
        code: "gateway/route_set_ambiguous",
        message: `Supplied contract route '${key}' appears ${contractCount} times; an explicit reviewed route mapping is required.`,
        coordinate,
      });
    }
    if (gatewayCount > contractCount) {
      diagnostics.push({
        level: "warning",
        code: "gateway/route_set_missing",
        message: `Supplied contract is missing ${gatewayCount - contractCount} gateway operation(s) at '${key}'.`,
        coordinate,
      });
    } else if (contractCount > gatewayCount) {
      diagnostics.push({
        level: "warning",
        code: "gateway/route_set_extra",
        message: `Supplied contract contains ${contractCount - gatewayCount} operation(s) at '${key}' that are absent from the selected gateway API.`,
        coordinate,
      });
    }
  }
  return diagnostics;
}

/**
 * A native spec may use different operationIds from the gateway export. Match
 * policy targets through the route-only source's method/path and fail closed
 * when a target has no unique method/path peer in the supplied contract.
 */
export function retargetGatewayOverlay(
  overlay: GatewayPolicyOverlay,
  synthesized: readonly Operation[],
  supplied: readonly Operation[],
  coordinate: GatewayContractProvenance["location"],
): { overlay: GatewayPolicyOverlay; diagnostics: GatewayDiagnostic[] } {
  const synthesizedByKey = new Map<string, Operation>();
  for (const operation of synthesized) {
    for (const key of operationKeys(operation)) synthesizedByKey.set(key, operation);
  }
  const suppliedByRoute = new Map<string, Operation[]>();
  for (const operation of supplied) {
    const key = routeKey(operation);
    if (key) suppliedByRoute.set(key, [...(suppliedByRoute.get(key) ?? []), operation]);
  }

  const diagnostics: GatewayDiagnostic[] = [];
  const diagnosed = new Set<string>();
  const assertions = overlay.assertions.flatMap((assertion) => {
    if (assertion.target.scope !== "operation") return [assertion];
    const synthesizedOperation = synthesizedByKey.get(assertion.target.ref);
    const key = synthesizedOperation ? routeKey(synthesizedOperation) : undefined;
    const candidates = key ? (suppliedByRoute.get(key) ?? []) : [];
    if (candidates.length === 1) {
      const suppliedOperation = candidates[0] as Operation;
      return [
        {
          ...assertion,
          target: {
            ...assertion.target,
            // Use the AIR id rather than a possibly colliding operationId.
            ref: suppliedOperation.id,
          },
        },
      ];
    }
    if (!diagnosed.has(assertion.target.ref)) {
      diagnostics.push({
        level: "warning",
        code: "gateway/policy_target_unmatched",
        message:
          candidates.length > 1
            ? `Gateway policy target '${assertion.target.ref}' maps to ${candidates.length} supplied operations at ${key}; no policy was applied automatically.`
            : `Gateway policy target '${assertion.target.ref}' has no unique method/path match in the supplied contract; no policy was applied automatically.`,
        coordinate,
      });
      diagnosed.add(assertion.target.ref);
    }
    // Do not leave a stale assertion in place: a colliding operationId could
    // otherwise make the resolver apply gateway policy to the wrong route.
    return [];
  });
  return {
    overlay: makeOverlay({
      origin: overlay.origin,
      id: `${overlay.id}_retargeted`,
      assertions,
      evidence: overlay.evidence,
    }),
    diagnostics,
  };
}

/**
 * Decide how a supplied contract relates to the gateway's own embedded
 * definitions, for a vendor whose native Definitions lineage is modelled.
 *
 * The distinction this protects: **route compatibility is not byte lineage.** A
 * supplied contract that describes the same routes is not the same artifact, and
 * only an exact digest match — or an explicit operator attestation naming a
 * reason — establishes lineage. Anvil will not pick between several embedded
 * definitions on the operator's behalf.
 *
 * `attestationReason` is the already-validated `--attest-spec-override` reason.
 * Supplying one when the digests already match is refused rather than ignored: a
 * recorded override that was never needed is a false claim in the receipt.
 */
export function resolveFormalDefinitionLineage(input: {
  /** Validated embedded definitions, in the caller's stable sort order. */
  formalDefinitions: readonly GatewayArtifactEvidence[];
  /** The locked supplied contract entrypoint, or undefined if it is absent. */
  supplied?: { path: string; digest: string };
  attestationReason?: string;
}): { lineage: FormalDefinitionLineage } | { rejection: LineageRejection } {
  const { formalDefinitions, supplied, attestationReason } = input;
  if (!supplied) {
    return {
      rejection: {
        code: "gateway/formal_definition_source_missing",
        message:
          "The locked supplied contract entrypoint is absent from its own source manifest; no lineage can be established.",
        details: {},
      },
    };
  }

  const candidates = [...formalDefinitions];
  const exactMatch = candidates.length === 1 && candidates[0]?.digest === supplied.digest;

  if (exactMatch && attestationReason) {
    return {
      rejection: {
        code: "gateway/unnecessary_spec_override",
        message:
          "The supplied contract already exactly matches the selected embedded WSO2 definition. Remove `--attest-spec-override`; no override is needed or recorded.",
        details: { formalDefinitions: candidates, supplied },
      },
    };
  }
  if (exactMatch) {
    return { lineage: { mode: "embedded_digest_match", candidates, supplied } };
  }
  if (attestationReason) {
    return {
      lineage: {
        mode: "operator_override",
        candidates,
        supplied,
        override: { attestation: "operator", reason: attestationReason },
      },
    };
  }

  const code =
    candidates.length === 0
      ? "gateway/formal_definition_missing"
      : candidates.length > 1
        ? "gateway/formal_definition_ambiguous"
        : "gateway/formal_definition_digest_mismatch";
  const message =
    candidates.length === 0
      ? "The selected WSO2 project has no validated embedded Definitions OpenAPI/Swagger contract to bind to the supplied --spec. Review the project and, only for a legitimate external contract, repeat with `--attest-spec-override <reason>`."
      : candidates.length > 1
        ? `The selected WSO2 project has ${candidates.length} validated embedded Definitions contracts. Anvil will not infer which one is authoritative; select deliberately and repeat with \`--attest-spec-override <reason>\`.`
        : `The supplied contract digest ${supplied.digest} does not match the selected embedded WSO2 definition ${candidates[0]?.digest}. Route compatibility is not byte lineage. Supply the exact extracted member or explicitly attest a legitimate override with \`--attest-spec-override <reason>\`.`;
  return { rejection: { code, message, details: { formalDefinitions: candidates, supplied } } };
}

/**
 * Record an operator's attestation of the public gateway base URL.
 *
 * The attestation *supersedes* the synthesized `missing_runtime_coordinate`
 * warning rather than sitting beside it: once an operator has named the base
 * URL, the coordinate is no longer missing, and leaving both would leave the
 * receipt self-contradictory. Nothing else is filtered — this narrows exactly
 * one diagnostic and adds exactly one.
 */
export function attestRuntimeCoordinate(
  diagnostics: readonly GatewayDiagnostic[],
  gatewayUrl: string | undefined,
  coordinate: GatewayContractProvenance["location"],
): GatewayDiagnostic[] {
  if (!gatewayUrl) return [...diagnostics];
  return [
    ...diagnostics.filter((d) => d.code !== "gateway/missing_runtime_coordinate"),
    {
      level: "info",
      code: "gateway/runtime_coordinate_attested",
      message: `Operator attested '${gatewayUrl}' as the public gateway base URL; generated runtime coordinates are pinned to it.`,
      coordinate,
    },
  ];
}
