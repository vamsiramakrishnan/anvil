/**
 * Inventory identity. A `GatewayInventorySnapshot`'s digest is content-derived
 * (key-sorted canonical JSON via `@anvil/air`'s hasher), independent of the
 * order APIs/environments/products happen to arrive in, and excludes the digest
 * field itself — so re-inventorying an unchanged estate yields the same digest.
 */
import { hashCanonical } from "@anvil/air";
import type { GatewayInventorySnapshot } from "./model.js";

export type InventoryDraft = Omit<GatewayInventorySnapshot, "digest">;

const canonicalOrder = (left: unknown, right: unknown): number =>
  hashCanonical(left).localeCompare(hashCanonical(right));

const byId = <T extends { id: string }>(items: readonly T[]): T[] =>
  [...items].sort((left, right) => left.id.localeCompare(right.id) || canonicalOrder(left, right));

const sortedStrings = (items: readonly string[]): string[] => [...new Set(items)].sort();

function apiCoordinateKey(api: InventoryDraft["apis"][number]): string {
  return JSON.stringify([
    api.id,
    api.version ?? "",
    api.revision ?? "",
    [...new Set(api.environmentIds)].sort(),
    api.name,
  ]);
}

function meaningfulCoordinate(value: string | undefined): string | undefined {
  const coordinate = value?.trim();
  return coordinate && coordinate !== "0.0.0" && coordinate !== "unversioned"
    ? coordinate
    : undefined;
}

function semanticApiVersion(value: string | undefined): string | undefined {
  const version = value?.trim();
  return version || undefined;
}

function apiAxes(api: InventoryDraft["apis"][number]): {
  apiVersion?: string;
  revision: string;
} {
  const distinctRevision = meaningfulCoordinate(api.revision);
  const apiVersion = distinctRevision ? semanticApiVersion(api.version) : undefined;
  return {
    ...(apiVersion ? { apiVersion } : {}),
    revision: distinctRevision ?? meaningfulCoordinate(api.version) ?? "unversioned",
  };
}

function byApiCoordinate(apis: readonly InventoryDraft["apis"][number][]): InventoryDraft["apis"] {
  return [...apis]
    .map((api) => ({
      ...api,
      environmentIds: sortedStrings(api.environmentIds),
      productIds: sortedStrings(api.productIds),
      routes: byId(
        api.routes.map((route) => ({
          ...route,
          methods: sortedStrings(route.methods),
          paths: sortedStrings(route.paths),
          hosts: sortedStrings(route.hosts),
          protocols: sortedStrings(route.protocols),
        })),
      ),
      identityEvidence: api.identityEvidence
        ?.map((evidence) => ({
          ...evidence,
          scopes: evidence.scopes ? sortedStrings(evidence.scopes) : undefined,
        }))
        .sort(canonicalOrder),
      artifacts: api.artifacts
        ?.map((artifact) => ({
          kind: artifact.kind,
          role: artifact.role,
          path: artifact.path,
          origin: artifact.origin,
          digest: artifact.digest,
          bytes: artifact.bytes,
          ...(artifact.parent ? { parent: artifact.parent } : {}),
        }))
        .sort(canonicalOrder),
    }))
    .sort(
      (left, right) =>
        apiCoordinateKey(left).localeCompare(apiCoordinateKey(right)) ||
        canonicalOrder(left, right),
    );
}

/** The content digest of an inventory draft (stable, order-independent). */
export function inventoryDigest(draft: InventoryDraft): string {
  return hashCanonical({
    schemaVersion: draft.schemaVersion,
    gateway: draft.gateway,
    environments: byId(draft.environments),
    apis: byApiCoordinate(draft.apis),
    products: byId(
      draft.products.map((product) => ({
        ...product,
        plans: sortedStrings(product.plans),
      })),
    ),
    diagnostics: [...draft.diagnostics].sort(canonicalOrder),
  });
}

/** Stamp an inventory draft with its content digest. */
export function finalizeInventory(draft: InventoryDraft): GatewayInventorySnapshot {
  const counts = new Map<
    string,
    {
      count: number;
      label: string;
      subject: NonNullable<InventoryDraft["diagnostics"][number]["subject"]>;
    }
  >();
  const reservedRevisions = new Map<
    string,
    NonNullable<InventoryDraft["diagnostics"][number]["subject"]>
  >();
  const reservedApiVersions = new Map<
    string,
    NonNullable<InventoryDraft["diagnostics"][number]["subject"]>
  >();
  const reservedEnvironments = new Map<
    string,
    NonNullable<InventoryDraft["diagnostics"][number]["subject"]>
  >();
  for (const api of draft.apis) {
    const declaredApiVersion = api.version?.trim();
    const declaredGatewayRevision = api.revision?.trim();
    const axes = apiAxes(api);
    const labelPrefix = `${api.id}${axes.apiVersion ? `:${axes.apiVersion}` : ""}`;
    if (
      declaredGatewayRevision === "unversioned" ||
      (!declaredGatewayRevision && declaredApiVersion === "unversioned")
    ) {
      reservedRevisions.set(`${labelPrefix}@unversioned`, {
        api: {
          id: api.id,
          ...(axes.apiVersion ? { apiVersion: axes.apiVersion } : {}),
          revision: "unversioned",
        },
      });
    }
    if (meaningfulCoordinate(api.revision) !== undefined && declaredApiVersion === "unversioned") {
      reservedApiVersions.set(`${api.id}:unversioned@${axes.revision}`, {
        api: {
          id: api.id,
          apiVersion: "unversioned",
          revision: axes.revision,
        },
      });
    }
    const environments = [
      ...new Set(api.environmentIds.map((value) => value.trim()).filter(Boolean)),
    ].sort();
    if (environments.includes("unscoped")) {
      reservedEnvironments.set(`${labelPrefix}@${axes.revision}#unscoped`, {
        api: {
          id: api.id,
          ...(axes.apiVersion ? { apiVersion: axes.apiVersion } : {}),
          revision: axes.revision,
          environment: "unscoped",
        },
      });
    }
    for (const environment of environments.length > 0 ? environments : ["unscoped"]) {
      const key = JSON.stringify([api.id, axes.apiVersion ?? "", axes.revision, environment]);
      const current = counts.get(key);
      counts.set(key, {
        count: (current?.count ?? 0) + 1,
        label: `${labelPrefix}@${axes.revision} [${environment}]`,
        subject: {
          api: {
            id: api.id,
            ...(axes.apiVersion ? { apiVersion: axes.apiVersion } : {}),
            revision: axes.revision,
            environment,
          },
        },
      });
    }
  }
  const duplicates = [...counts.entries()]
    .filter(([, value]) => value.count > 1)
    .map(([, value]) => value)
    .sort((left, right) => left.label.localeCompare(right.label));
  const identityDiagnostics: InventoryDraft["diagnostics"] = [];
  if (reservedApiVersions.size > 0) {
    for (const [label, subject] of [...reservedApiVersions.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      identityDiagnostics.push({
        level: "error",
        code: "gateway/reserved_api_version",
        message: `Gateway inventory declares reserved semantic API version 'unversioned' for ${label}. Omit an unknown API version or supply its real value explicitly during import.`,
        subject,
      });
    }
  }
  if (reservedRevisions.size > 0) {
    for (const [label, subject] of [...reservedRevisions.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      identityDiagnostics.push({
        level: "error",
        code: "gateway/reserved_api_revision",
        message: `Gateway inventory declares reserved revision 'unversioned' for ${label}. Omit an unknown native revision; supply its real revision explicitly during import.`,
        subject,
      });
    }
  }
  if (reservedEnvironments.size > 0) {
    for (const [label, subject] of [...reservedEnvironments.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      identityDiagnostics.push({
        level: "error",
        code: "gateway/reserved_api_environment",
        message: `Gateway inventory declares reserved environment 'unscoped' for ${label}. Omit an unknown native environment; supply its real environment explicitly during import.`,
        subject,
      });
    }
  }
  if (duplicates.length > 0) {
    for (const duplicate of duplicates) {
      identityDiagnostics.push({
        level: "error",
        code: "gateway/duplicate_api_coordinate",
        message: `Gateway inventory contains duplicate API coordinate ${duplicate.label}. Each gateway/API/API-version/revision/environment coordinate must identify exactly one inventory row.`,
        subject: duplicate.subject,
      });
    }
  }
  const normalized: InventoryDraft =
    identityDiagnostics.length === 0
      ? draft
      : { ...draft, diagnostics: [...draft.diagnostics, ...identityDiagnostics] };
  return { ...normalized, digest: inventoryDigest(normalized) };
}
