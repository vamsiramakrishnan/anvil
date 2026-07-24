/**
 * Stable gateway-import coordinates.
 *
 * Gateway API ids are not globally unique: the same id commonly exists in
 * several environments and revisions, and two otherwise identical exports can
 * come from different gateway control planes. Keep that ambiguity out of file
 * paths, receipts, and approval lineage by resolving a complete coordinate
 * before extraction and hashing it together with the exact source evidence.
 */
import { hashCanonical, ServiceId } from "@anvil/air";
import { z } from "zod";
import { type GatewayApiSummary, GatewayKind } from "./model.js";

export const GATEWAY_UNSCOPED_ENVIRONMENT = "unscoped";
export const GATEWAY_UNVERSIONED_REVISION = "unversioned";

const Sha256Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const CoordinatePart = z.string().trim().min(1);

export const GatewayImportStableCoordinate = z.object({
  vendor: GatewayKind,
  gatewayId: CoordinatePart,
  apiId: CoordinatePart,
  /** Present only when semantic API version and gateway revision are distinct axes. */
  apiVersion: CoordinatePart.optional(),
  serviceId: CoordinatePart,
  environment: CoordinatePart,
  revision: CoordinatePart,
});
export type GatewayImportStableCoordinate = z.infer<typeof GatewayImportStableCoordinate>;

export const GatewayImportIdentityCoordinate = GatewayImportStableCoordinate.extend({
  gatewayIdSource: z.enum(["export", "operator", "unscoped"]),
  exportDigest: Sha256Digest,
  inventoryDigest: CoordinatePart,
});
export type GatewayImportIdentityCoordinate = z.infer<typeof GatewayImportIdentityCoordinate>;

export const GatewayImportIdentity = GatewayImportIdentityCoordinate.extend({
  /** Stable output-owner identity; deliberately excludes estate-wide evidence. */
  digest: Sha256Digest,
  /** Exact import evidence lineage, including export and inventory content. */
  lineageDigest: Sha256Digest,
});
export type GatewayImportIdentity = z.infer<typeof GatewayImportIdentity>;

export function gatewayImportCoordinateDigest(coordinate: GatewayImportStableCoordinate): string {
  return `sha256:${hashCanonical(GatewayImportStableCoordinate.parse(coordinate))}`;
}

export function gatewayImportLineageDigest(coordinate: GatewayImportIdentityCoordinate): string {
  const parsed = GatewayImportIdentityCoordinate.parse(coordinate);
  const { exportDigest, inventoryDigest, gatewayIdSource, ...stable } = parsed;
  return `sha256:${hashCanonical({
    coordinateDigest: gatewayImportCoordinateDigest(stable),
    gatewayIdSource,
    exportDigest,
    inventoryDigest,
  })}`;
}

export function gatewayImportIdentity(
  coordinate: GatewayImportIdentityCoordinate,
): GatewayImportIdentity {
  const parsed = GatewayImportIdentityCoordinate.parse(coordinate);
  const {
    exportDigest: _exportDigest,
    inventoryDigest: _inventoryDigest,
    gatewayIdSource: _gatewayIdSource,
    ...stable
  } = parsed;
  return GatewayImportIdentity.parse({
    ...parsed,
    digest: gatewayImportCoordinateDigest(stable),
    lineageDigest: gatewayImportLineageDigest(parsed),
  });
}

export function verifyGatewayImportIdentity(identity: GatewayImportIdentity): {
  ok: boolean;
  expectedDigest: string;
  expectedLineageDigest: string;
} {
  const {
    digest: _digest,
    lineageDigest: _lineageDigest,
    ...coordinate
  } = GatewayImportIdentity.parse(identity);
  const {
    exportDigest: _exportDigest,
    inventoryDigest: _inventoryDigest,
    gatewayIdSource: _gatewayIdSource,
    ...stable
  } = coordinate;
  const expectedDigest = gatewayImportCoordinateDigest(stable);
  const expectedLineageDigest = gatewayImportLineageDigest(coordinate);
  return {
    ok: identity.digest === expectedDigest && identity.lineageDigest === expectedLineageDigest,
    expectedDigest,
    expectedLineageDigest,
  };
}

/** A readable path component with a digest suffix that remains collision-safe. */
export function gatewayImportIdentitySlug(identity: GatewayImportIdentity): string {
  const slug = (value: string): string => {
    const normalized = value
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32);
    return normalized || "unknown";
  };
  const suffix = identity.digest.slice("sha256:".length, "sha256:".length + 12);
  return [
    slug(identity.vendor),
    slug(identity.environment),
    ...(identity.apiVersion ? [slug(identity.apiVersion)] : []),
    slug(identity.revision),
    suffix,
  ].join("-");
}

/**
 * Physical cloud/store namespace for one imported gateway coordinate.
 *
 * AIR service ids remain concise agent-facing names. Deployment resources need
 * the stronger coordinate boundary: two gateways, revisions, or environments
 * may legitimately expose contracts with the same title and therefore the same
 * AIR service id. The stable coordinate digest separates them without allowing
 * re-export evidence churn to rename deployed resources.
 */
export function gatewayDeploymentNamespace(identity: GatewayImportIdentity): string {
  const parsed = GatewayImportIdentity.parse(identity);
  const coordinateSuffix = parsed.digest.slice("sha256:".length, "sha256:".length + 24);
  return `${parsed.serviceId}-${coordinateSuffix}`;
}

/**
 * Default agent-facing service id for a gateway API.
 *
 * Gateway contracts frequently reuse generic titles such as "Applications".
 * A readable coordinate prefix plus a stable digest prevents CLI/MCP/package
 * name collisions when several environments or gateway instances are composed
 * in one agent. Operators may still provide a reviewed `--service` override.
 */
export function gatewayAgentServiceId(
  coordinate: Pick<
    GatewayImportStableCoordinate,
    "vendor" | "gatewayId" | "apiId" | "apiVersion" | "environment" | "revision"
  >,
): string {
  const parsed = GatewayImportStableCoordinate.pick({
    vendor: true,
    gatewayId: true,
    apiId: true,
    apiVersion: true,
    environment: true,
    revision: true,
  }).parse(coordinate);
  const readable = [
    parsed.apiId,
    ...(parsed.apiVersion ? [parsed.apiVersion] : []),
    parsed.environment,
    parsed.revision,
  ]
    .join("-")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const prefixed = /^[a-z]/.test(readable) ? readable : `api-${readable || "service"}`;
  const suffix = hashCanonical(parsed).slice(0, 16);
  const prefix = prefixed.slice(0, 47).replace(/-+$/, "") || "api-service";
  return ServiceId.parse(`${prefix}-${suffix}`);
}

export interface GatewayApiSelectionOptions {
  apiId?: string;
  apiVersion?: string;
  revision?: string;
  environment?: string;
}

export interface ResolvedGatewayApiSelection {
  api: GatewayApiSummary;
  apiVersion?: string;
  revision: string;
  environment: string;
}

export interface GatewayApiSelectionFailure {
  code:
    | "gateway_selection/api_required"
    | "gateway_selection/api_not_found"
    | "gateway_selection/api_version_required"
    | "gateway_selection/api_version_not_found"
    | "gateway_selection/revision_required"
    | "gateway_selection/revision_not_found"
    | "gateway_selection/environment_required"
    | "gateway_selection/environment_not_found"
    | "gateway_selection/ambiguous";
  message: string;
  candidates: string[];
}

export type GatewayApiSelectionResult =
  | { ok: true; selection: ResolvedGatewayApiSelection }
  | { ok: false; failure: GatewayApiSelectionFailure };

function meaningfulCoordinate(value: string | undefined): string | undefined {
  const coordinate = value?.trim();
  return coordinate && coordinate !== "0.0.0" && coordinate !== GATEWAY_UNVERSIONED_REVISION
    ? coordinate
    : undefined;
}

function nativeApiVersion(api: GatewayApiSummary): string | undefined {
  const version = api.version?.trim();
  return meaningfulCoordinate(api.revision) && version ? version : undefined;
}

function nativeRevision(api: GatewayApiSummary): string | undefined {
  const revision = meaningfulCoordinate(api.revision) ?? meaningfulCoordinate(api.version);
  return revision && revision !== "0.0.0" && revision !== GATEWAY_UNVERSIONED_REVISION
    ? revision
    : undefined;
}

function environments(api: GatewayApiSummary): string[] {
  return [...new Set(api.environmentIds.map((value) => value.trim()).filter(Boolean))].sort();
}

function selectionLabel(api: GatewayApiSummary): string {
  const apiVersion = nativeApiVersion(api);
  const revision = nativeRevision(api) ?? GATEWAY_UNVERSIONED_REVISION;
  const scoped = environments(api);
  return `${api.id}${apiVersion ? `:${apiVersion}` : ""}@${revision} [${
    scoped.join(", ") || GATEWAY_UNSCOPED_ENVIRONMENT
  }]`;
}

function fail(
  code: GatewayApiSelectionFailure["code"],
  message: string,
  candidates: readonly GatewayApiSummary[],
): GatewayApiSelectionResult {
  return {
    ok: false,
    failure: {
      code,
      message,
      candidates: [...new Set(candidates.map(selectionLabel))].sort(),
    },
  };
}

/**
 * Resolve one API coordinate without ever choosing the first matching row.
 *
 * Every supplied axis must match source evidence. The `unversioned` and
 * `unscoped` sentinels match a genuinely absent source axis; a concrete value
 * never attests a missing revision or environment into existence.
 */
export function resolveGatewayApiSelection(
  apis: readonly GatewayApiSummary[],
  options: GatewayApiSelectionOptions,
): GatewayApiSelectionResult {
  const requestedApi = options.apiId?.trim();
  const requestedApiVersion = options.apiVersion?.trim();
  const requestedRevision = options.revision?.trim();
  const requestedEnvironment = options.environment?.trim();
  const ids = [...new Set(apis.map((api) => api.id))].sort();

  if (!requestedApi && ids.length !== 1) {
    return fail(
      "gateway_selection/api_required",
      apis.length === 0
        ? "The estate has no APIs to import."
        : `The estate contains ${ids.length} API ids. Select one with --api <id>.`,
      apis,
    );
  }

  const apiId = requestedApi ?? ids[0];
  let candidates = apis.filter((api) => api.id === apiId);
  if (!apiId || candidates.length === 0) {
    return fail(
      "gateway_selection/api_not_found",
      `No API '${apiId ?? ""}' exists in this estate. Use an id shown by \`anvil estate inventory\`.`,
      apis,
    );
  }

  if (requestedApiVersion) {
    const matching = candidates.filter((api) => nativeApiVersion(api) === requestedApiVersion);
    if (matching.length === 0) {
      return fail(
        "gateway_selection/api_version_not_found",
        `API '${apiId}' has no semantic API version '${requestedApiVersion}'. Choose an API version shown by inventory.`,
        candidates,
      );
    }
    candidates = matching;
  } else {
    const apiVersions = [...new Set(candidates.map(nativeApiVersion).filter(Boolean))].sort();
    if (apiVersions.length > 1) {
      return fail(
        "gateway_selection/api_version_required",
        `API '${apiId}' has ${apiVersions.length} semantic API versions (${apiVersions.join(", ")}). Select one with --api-version <version>.`,
        candidates,
      );
    }
  }

  if (requestedRevision) {
    const matching = candidates.filter((api) => {
      const revision = nativeRevision(api) ?? GATEWAY_UNVERSIONED_REVISION;
      return revision === requestedRevision;
    });
    if (matching.length === 0) {
      return fail(
        "gateway_selection/revision_not_found",
        `API '${apiId}' has no revision '${requestedRevision}'. Choose a revision shown by inventory.`,
        candidates,
      );
    }
    candidates = matching;
  } else {
    const revisions = [...new Set(candidates.map(nativeRevision).filter(Boolean))].sort();
    if (revisions.length > 1) {
      return fail(
        "gateway_selection/revision_required",
        `API '${apiId}' has ${revisions.length} revisions (${revisions.join(", ")}). Select one with --revision <revision>.`,
        candidates,
      );
    }
  }

  if (requestedEnvironment) {
    const matching = candidates.filter((api) => {
      const declared = environments(api);
      return declared.length === 0
        ? requestedEnvironment === GATEWAY_UNSCOPED_ENVIRONMENT
        : declared.includes(requestedEnvironment);
    });
    if (matching.length === 0) {
      return fail(
        "gateway_selection/environment_not_found",
        `API '${apiId}' is not deployed to environment '${requestedEnvironment}'. Choose an environment shown by inventory.`,
        candidates,
      );
    }
    candidates = matching;
  } else {
    const declared = [...new Set(candidates.flatMap(environments))].sort();
    if (declared.length > 1) {
      return fail(
        "gateway_selection/environment_required",
        `API '${apiId}' is present in ${declared.length} environments (${declared.join(", ")}). Select one with --environment <environment>.`,
        candidates,
      );
    }
  }

  if (candidates.length !== 1) {
    return fail(
      "gateway_selection/ambiguous",
      `API '${apiId}' still resolves to ${candidates.length} inventory rows. Supply both --revision and --environment, or repair the duplicate export coordinates.`,
      candidates,
    );
  }

  const api = candidates[0] as GatewayApiSummary;
  return {
    ok: true,
    selection: {
      api,
      ...((requestedApiVersion ?? nativeApiVersion(api))
        ? { apiVersion: requestedApiVersion ?? nativeApiVersion(api) }
        : {}),
      revision: requestedRevision ?? nativeRevision(api) ?? GATEWAY_UNVERSIONED_REVISION,
      environment: requestedEnvironment ?? environments(api)[0] ?? GATEWAY_UNSCOPED_ENVIRONMENT,
    },
  };
}
