/**
 * The WSO2 API Manager adapter. WSO2 exports an API definition (api.yaml) with
 * per-operation verbs, scopes, and security scheme, plus throttling tiers. The
 * adapter normalizes those into the common source + overlay; no WSO2 type escapes.
 */
import type { AdapterContext, GatewayAdapter, GatewayConnection } from "../adapter.js";
import {
  type ExplicitGatewayIdentityConfiguration,
  projectConfiguredAuthType,
  projectExplicitIdentityConfiguration,
} from "../identity-evidence.js";
import { finalizeInventory } from "../inventory.js";
import type {
  EvidenceCoordinate,
  GatewayAdapterCapabilities,
  GatewayApiImport,
  GatewayApiRef,
  GatewayApiSummary,
  GatewayArtifactEvidence,
  GatewayDiagnostic,
  GatewayDiagnosticSubject,
  GatewayIdentityEvidence,
  GatewayInventorySnapshot,
  GatewayProbeResult,
} from "../model.js";
import { withGatewayDiagnosticSubject } from "../model.js";
import type { GatewayFact } from "../overlay.js";
import {
  asObjects,
  asRecord,
  asStrings,
  parseGatewayDocument,
  safeParseYaml,
} from "../parse-safe.js";
import {
  buildGatewayApiImport,
  gatewayOperationRef,
  joinGatewayPath,
  routeOnlyContract,
  type SynthOp,
  synthOperationId,
} from "../synth.js";

interface WsoOperation {
  target: string;
  verb: string;
  scopes?: string[];
  authType?: string;
  /** Optional exact identity fields supplied by a normalized export step. */
  identity?: ExplicitGatewayIdentityConfiguration;
  /** WSO2 request/response/fault policies attached to this operation. */
  operationPolicies?: unknown;
}
interface WsoApi {
  name: string;
  context?: string;
  version?: string;
  /** WSO2 distinguishes the API's semantic version from a deployed revision. */
  isRevision?: boolean;
  revisionId?: string | number;
  lifeCycleStatus?: string;
  provider?: string;
  operations?: WsoOperation[];
  securityScheme?: string[];
  /** Optional API-wide exact identity fields; native fields remain authoritative. */
  identity?: ExplicitGatewayIdentityConfiguration;
  apiThrottlingPolicy?: string;
  mediationPolicies?: unknown[];
  /** Current native exports attach API-level regular gateway policies here. */
  apiPolicies?: unknown;
  /** Some WSO2 export versions place operation policy configuration at API scope. */
  operationPolicies?: unknown;
}

/** A read-only connection to a WSO2 API export (one or more api.yaml documents). */
export interface Wso2Connection extends GatewayConnection {
  config: string;
  origin?: string;
  /** Native apictl projects collected without flattening them into invented YAML. */
  apiProjects?: Wso2ApiProject[];
  /** Filesystem/container diagnostics that apply to the collection as a whole. */
  collectionDiagnostics?: GatewayDiagnostic[];
}

/** One independently selectable native apictl API project. */
export interface Wso2ApiProject {
  apiYaml: string;
  apiOrigin: string;
  deploymentEnvironmentsYaml?: string;
  deploymentEnvironmentsOrigin?: string;
  artifacts: GatewayArtifactEvidence[];
}

const CAPABILITIES: GatewayAdapterCapabilities = {
  inventory: true,
  apiSpecs: false,
  routes: true,
  authentication: true,
  authorization: true,
  trafficPolicies: true,
  transformations: "partial",
  faultPolicies: false,
  products: false,
  consumers: false,
  trafficAnalytics: false,
  drift: false,
  publish: false,
};

interface LocatedWsoApi {
  api: WsoApi;
  pointer?: string;
  origin: string;
  /** Native WSO2 deployment revision, distinct from the API semantic version. */
  revision?: string;
  environmentIds: string[];
  artifacts: GatewayArtifactEvidence[];
}

function apiFieldPointer(pointer: string | undefined, field: string): string {
  return `${pointer ?? ""}/${field}`;
}

function validateApiDocument(
  value: unknown,
  pointer: string | undefined,
  origin: string,
): { api?: WsoApi; diagnostics: GatewayDiagnostic[] } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {
      diagnostics: [
        {
          level: "error",
          code: "wso2/invalid_api_entry",
          message: "Every WSO2 API entry must be an object.",
          coordinate: { origin, ...(pointer ? { pointer } : {}) },
        },
      ],
    };
  }
  const record = value as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : undefined;
  const version = typeof record.version === "string" ? record.version.trim() : undefined;
  const subject: GatewayDiagnosticSubject | undefined = name
    ? {
        api: {
          id: name,
          ...(version ? { apiVersion: version } : {}),
        },
      }
    : undefined;
  const diagnostics: GatewayDiagnostic[] = [];
  const invalid = (code: string, message: string, field: string): void => {
    diagnostics.push({
      level: "error",
      code,
      message,
      coordinate: { origin, pointer: apiFieldPointer(pointer, field) },
      ...(subject ? { subject } : {}),
    });
  };

  if (record.name === undefined || (typeof record.name === "string" && !name)) {
    invalid(
      "wso2/invalid_export",
      "Every WSO2 API must declare `name` as a non-empty string.",
      "name",
    );
  } else if (typeof record.name !== "string") {
    invalid(
      "wso2/invalid_api_name",
      "WSO2 API `name` must be a non-empty string; numeric or container values cannot be used as an API id.",
      "name",
    );
  }
  if (
    record.version !== undefined &&
    (typeof record.version !== "string" || version?.length === 0)
  ) {
    invalid(
      "wso2/invalid_api_version",
      "WSO2 API `version` must be a non-empty string when declared; numeric or container values cannot be used as an API coordinate.",
      "version",
    );
  }
  if (record.isRevision !== undefined && typeof record.isRevision !== "boolean") {
    invalid(
      "wso2/invalid_revision_flag",
      "WSO2 API `isRevision` must be a boolean when declared.",
      "isRevision",
    );
  }
  if (
    record.revisionId !== undefined &&
    record.revisionId !== null &&
    typeof record.revisionId !== "string" &&
    typeof record.revisionId !== "number"
  ) {
    invalid(
      "wso2/invalid_revision_id_type",
      "WSO2 API `revisionId` must be a string or integer when declared.",
      "revisionId",
    );
  }
  if (diagnostics.length > 0) return { diagnostics };

  return {
    api: {
      ...(record as unknown as WsoApi),
      name: name as string,
      ...(version ? { version } : {}),
    },
    diagnostics,
  };
}

function parseExport(
  config: string,
  origin: string,
): { apis: LocatedWsoApi[]; diagnostics: GatewayDiagnostic[] } {
  const parsed = parseGatewayDocument(config, "wso2", origin);
  if (!parsed.document) return { apis: [], diagnostics: parsed.diagnostics };
  const document = parsed.document as Record<string, unknown>;
  const candidates: Array<{ value: unknown; pointer?: string }> = [];
  if (Object.hasOwn(document, "apis")) {
    if (!Array.isArray(document.apis)) {
      return {
        apis: [],
        diagnostics: [
          ...parsed.diagnostics,
          {
            level: "error",
            code: "wso2/invalid_apis_container",
            message: "WSO2 `apis` must be an array.",
            coordinate: { origin, pointer: "/apis" },
          },
        ],
      };
    }
    if (document.apis.length === 0) {
      return {
        apis: [],
        diagnostics: [
          ...parsed.diagnostics,
          {
            level: "error",
            code: "wso2/empty_export",
            message: "The WSO2 export contains no APIs.",
            coordinate: { origin, pointer: "/apis" },
          },
        ],
      };
    }
    candidates.push(...document.apis.map((value, index) => ({ value, pointer: `/apis/${index}` })));
  } else if (Object.hasOwn(document, "data")) {
    if (
      document.data === null ||
      typeof document.data !== "object" ||
      Array.isArray(document.data)
    ) {
      return {
        apis: [],
        diagnostics: [
          ...parsed.diagnostics,
          {
            level: "error",
            code: "wso2/invalid_api_container",
            message: "WSO2 `data` must be an API object.",
            coordinate: { origin, pointer: "/data" },
          },
        ],
      };
    }
    candidates.push({ value: document.data, pointer: "/data" });
  } else if (Object.hasOwn(document, "name")) {
    candidates.push({ value: document });
  } else {
    return {
      apis: [],
      diagnostics: [
        ...parsed.diagnostics,
        {
          level: "error",
          code: "wso2/invalid_export",
          message:
            "The WSO2 export must be an API object, a `data` API object, or contain an `apis` array.",
          coordinate: { origin },
        },
      ],
    };
  }

  const apis: LocatedWsoApi[] = [];
  const diagnostics = [...parsed.diagnostics];
  for (const candidate of candidates) {
    const validated = validateApiDocument(candidate.value, candidate.pointer, origin);
    diagnostics.push(...validated.diagnostics);
    if (!validated.api) continue;
    apis.push({
      api: validated.api,
      ...(candidate.pointer ? { pointer: candidate.pointer } : {}),
      origin,
      environmentIds: [],
      artifacts: [],
    });
  }
  return { apis, diagnostics };
}

function deploymentEnvironmentNames(project: Wso2ApiProject): {
  environmentIds: string[];
  diagnostics: GatewayDiagnostic[];
} {
  if (project.deploymentEnvironmentsYaml === undefined) {
    return { environmentIds: [], diagnostics: [] };
  }
  const origin = project.deploymentEnvironmentsOrigin ?? project.apiOrigin;
  const parsed = safeParseYaml(project.deploymentEnvironmentsYaml);
  if (
    parsed === undefined ||
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    return {
      environmentIds: [],
      diagnostics: [
        {
          level: "error",
          code: "wso2/invalid_deployment_environments",
          message: "deployment_environments.yaml must contain a mapping/object.",
          coordinate: { origin },
        },
      ],
    };
  }
  const document = asRecord(parsed);
  const nativeEnvironments = document.data;
  const normalizedEnvironments = document.environments;
  const environments = nativeEnvironments ?? normalizedEnvironments;
  const nativeShape = nativeEnvironments !== undefined;
  const pointer = nativeShape ? "/data" : "/environments";
  const nameKey = nativeShape ? "deploymentEnvironment" : "name";
  if (environments === undefined) return { environmentIds: [], diagnostics: [] };
  if (!Array.isArray(environments)) {
    return {
      environmentIds: [],
      diagnostics: [
        {
          level: "error",
          code: "wso2/invalid_deployment_environments",
          message:
            `deployment_environments.yaml \`${nativeShape ? "data" : "environments"}\` ` +
            "must be an array.",
          coordinate: { origin, pointer },
        },
      ],
    };
  }
  const names: string[] = [];
  const diagnostics: GatewayDiagnostic[] = [];
  environments.forEach((value, index) => {
    const name = asRecord(value)[nameKey];
    if (typeof name !== "string" || name.trim().length === 0) {
      diagnostics.push({
        level: "error",
        code: "wso2/invalid_deployment_environment",
        message:
          `Every deployment environment must have a non-empty \`${nameKey}\` ` +
          `in the ${nativeShape ? "native apictl" : "normalized"} shape.`,
        coordinate: { origin, pointer: `${pointer}/${index}/${nameKey}` },
      });
      return;
    }
    names.push(name.trim());
  });
  return { environmentIds: [...new Set(names)].sort(), diagnostics };
}

function apiCoordinateSubject(api: WsoApi, revision?: string): GatewayDiagnosticSubject {
  return {
    api: {
      id: api.name,
      ...(revision
        ? {
            ...(api.version ? { apiVersion: api.version } : {}),
            revision,
          }
        : api.version
          ? { revision: api.version }
          : {}),
    },
  };
}

function projectArtifactSubject(
  project: Wso2ApiProject,
  api?: WsoApi,
  revision?: string,
): GatewayDiagnosticSubject | undefined {
  const container = project.artifacts.find((artifact) => artifact.kind === "container");
  const member = project.artifacts.find((artifact) => artifact.role === "api_definition");
  const lineage =
    container === undefined
      ? (member?.parent ?? (member ? { origin: member.origin, digest: member.digest } : undefined))
      : { origin: container.origin, digest: container.digest };
  if (!lineage && !api) return undefined;
  return {
    ...(api
      ? {
          ...apiCoordinateSubject(api, revision),
        }
      : {}),
    ...(lineage ? { artifact: lineage } : {}),
  };
}

function withAdditionalDiagnosticSubject(
  diagnostics: readonly GatewayDiagnostic[],
  additional: GatewayDiagnosticSubject,
): GatewayDiagnostic[] {
  return diagnostics.map((diagnostic) => {
    if (!diagnostic.subject) return { ...diagnostic, subject: additional };
    const api = diagnostic.subject.api ?? additional.api;
    const artifact = diagnostic.subject.artifact ?? additional.artifact;
    const route = diagnostic.subject.route ?? additional.route;
    return {
      ...diagnostic,
      subject: {
        ...(api ? { api } : {}),
        ...(artifact ? { artifact } : {}),
        ...(route ? { route } : {}),
      },
    };
  });
}

function nativeProjectRevision(
  api: WsoApi,
  origin: string,
): {
  revision?: string;
  diagnostics: GatewayDiagnostic[];
} {
  if (api.isRevision !== true) {
    const isWorkingCopySentinel =
      api.revisionId === undefined ||
      api.revisionId === null ||
      api.revisionId === 0 ||
      (typeof api.revisionId === "string" && api.revisionId.trim() === "0");
    if (!isWorkingCopySentinel) {
      return {
        revision: "working-copy",
        diagnostics: [
          {
            level: "error",
            code: "wso2/contradictory_revision_identity",
            message:
              "api.yaml declares `isRevision: false` while also carrying `revisionId`; the native WSO2 coordinate is contradictory.",
            coordinate: { origin, pointer: "/data/revisionId" },
          },
        ],
      };
    }
    return { revision: "working-copy", diagnostics: [] };
  }
  const MAX_WSO2_REVISION_ID = 2_147_483_647;
  const revisionId =
    typeof api.revisionId === "number"
      ? Number.isInteger(api.revisionId) &&
        api.revisionId > 0 &&
        api.revisionId <= MAX_WSO2_REVISION_ID
        ? String(api.revisionId)
        : undefined
      : typeof api.revisionId === "string" &&
          /^[1-9][0-9]*$/.test(api.revisionId.trim()) &&
          Number(api.revisionId.trim()) <= MAX_WSO2_REVISION_ID
        ? api.revisionId.trim()
        : undefined;
  if (!revisionId) {
    return {
      diagnostics: [
        {
          level: "error",
          code: "wso2/missing_revision_id",
          message:
            "api.yaml declares `isRevision: true` without a usable `revisionId`; Anvil will not collapse it into the working copy.",
          coordinate: { origin, pointer: "/data/revisionId" },
        },
      ],
    };
  }
  return { revision: `revision-${revisionId}`, diagnostics: [] };
}

function parseConnection(connection: Wso2Connection): {
  apis: LocatedWsoApi[];
  diagnostics: GatewayDiagnostic[];
} {
  const origin = connection.origin ?? "wso2-api.yaml";
  if (!connection.apiProjects) {
    const parsed = parseExport(connection.config, origin);
    const diagnostics = [...parsed.diagnostics];
    const apis = parsed.apis.map((located) => {
      if (located.api.isRevision === undefined && located.api.revisionId === undefined) {
        return located;
      }
      const nativeRevision = nativeProjectRevision(located.api, located.origin);
      const subject = apiCoordinateSubject(located.api, nativeRevision.revision);
      diagnostics.push(...withGatewayDiagnosticSubject(nativeRevision.diagnostics, subject));
      return {
        ...located,
        ...(nativeRevision.revision ? { revision: nativeRevision.revision } : {}),
      };
    });
    return { apis, diagnostics };
  }

  const apis: LocatedWsoApi[] = [];
  const diagnostics: GatewayDiagnostic[] = [...(connection.collectionDiagnostics ?? [])];
  for (const project of [...connection.apiProjects].sort((left, right) =>
    left.apiOrigin.localeCompare(right.apiOrigin),
  )) {
    const parsed = parseExport(project.apiYaml, project.apiOrigin);
    const artifactSubject = projectArtifactSubject(project);
    diagnostics.push(
      ...(artifactSubject
        ? withAdditionalDiagnosticSubject(parsed.diagnostics, artifactSubject)
        : parsed.diagnostics),
    );
    if (parsed.apis.length !== 1) {
      if (parsed.apis.length > 1) {
        const diagnostic: GatewayDiagnostic = {
          level: "error",
          code: "wso2/apictl_project_multiple_apis",
          message:
            "A native apictl API project must contain exactly one API in api.yaml; the project was not flattened into an aggregate.",
          coordinate: { origin: project.apiOrigin },
        };
        diagnostics.push(
          artifactSubject ? { ...diagnostic, subject: artifactSubject } : diagnostic,
        );
      }
      continue;
    }
    const located = parsed.apis[0] as LocatedWsoApi;
    const nativeRevision = nativeProjectRevision(located.api, project.apiOrigin);
    const environments = deploymentEnvironmentNames(project);
    const subject =
      projectArtifactSubject(project, located.api, nativeRevision.revision) ??
      apiCoordinateSubject(located.api, nativeRevision.revision);
    diagnostics.push(...withGatewayDiagnosticSubject(nativeRevision.diagnostics, subject));
    diagnostics.push(...withGatewayDiagnosticSubject(environments.diagnostics, subject));
    const opaqueArtifacts = project.artifacts.filter(
      (artifact) => artifact.role === "opaque_policy",
    );
    if (opaqueArtifacts.length > 0) {
      diagnostics.push({
        level: "warning",
        code: "gateway/opaque_policy",
        message:
          `WSO2 apictl project '${located.api.name}' contains ${opaqueArtifacts.length} ` +
          "policy, mediation, sequence, or CAR artifact(s). Their bytes are preserved, but their implementation is not interpreted.",
        coordinate: { origin: opaqueArtifacts[0]?.origin ?? project.apiOrigin },
        subject,
      });
    }
    const formalContracts = project.artifacts
      .filter((artifact) => artifact.role === "formal_definition")
      .sort((left, right) => left.origin.localeCompare(right.origin));
    if (formalContracts.length === 1) {
      const formalContract = formalContracts[0] as GatewayArtifactEvidence;
      diagnostics.push({
        level: "info",
        code: "wso2/formal_contract_available",
        message:
          `One supported OpenAPI/Swagger definition is available at '${formalContract.origin}' ` +
          `(member '${formalContract.path}', ${formalContract.digest}). It is preserved as evidence but not auto-bound; pass the extracted member with --spec.`,
        coordinate: { origin: formalContract.origin },
        subject,
      });
    } else if (formalContracts.length > 1) {
      diagnostics.push({
        level: "warning",
        code: "wso2/ambiguous_formal_contract",
        message:
          `The apictl project contains ${formalContracts.length} supported OpenAPI/Swagger definitions ` +
          `(${formalContracts.map((artifact) => artifact.origin).join(", ")}). Anvil will not choose one; review and pass the intended contract with --spec.`,
        coordinate: { origin: formalContracts[0]?.origin ?? project.apiOrigin },
        subject,
      });
    }
    apis.push({
      ...located,
      origin: project.apiOrigin,
      ...(nativeRevision.revision ? { revision: nativeRevision.revision } : {}),
      environmentIds: environments.environmentIds,
      artifacts: [...project.artifacts],
    });
  }
  return { apis, diagnostics };
}

function opsOf(api: WsoApi): SynthOp[] {
  return asObjects<WsoOperation>(api.operations).map((op) => {
    const path = joinGatewayPath(api.context, op.target);
    return {
      operationId: synthOperationId(api.name, op.verb, path),
      method: op.verb,
      path,
    };
  });
}

/**
 * WSO2 serializes operation policy groups as nested request/response/fault
 * objects. Empty groups are inert; any configured leaf is effective behavior
 * that Anvil cannot currently project and therefore must remain visible.
 */
function hasConfiguredPolicy(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.some(hasConfiguredPolicy);
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(hasConfiguredPolicy);
  }
  return typeof value !== "string" || value.trim().length > 0;
}

function apiDiagnosticSubject(api: WsoApi, revision?: string): GatewayDiagnosticSubject {
  return apiCoordinateSubject(api, revision);
}

function operationDiagnosticSubject(
  api: WsoApi,
  operation: WsoOperation,
  revision?: string,
): GatewayDiagnosticSubject {
  const path = joinGatewayPath(api.context, operation.target);
  return {
    ...apiDiagnosticSubject(api, revision),
    route: {
      method: operation.verb,
      path,
      operationRef: gatewayOperationRef(operation.verb, path),
    },
  };
}

function operationPolicyDiagnostic(input: {
  api: WsoApi;
  origin: string;
  pointer: string;
  operation?: WsoOperation;
  revision?: string;
}): GatewayDiagnostic {
  const placement = input.operation
    ? `${String(input.operation.verb)} ${joinGatewayPath(input.api.context, input.operation.target)}`
    : `API '${input.api.name}'`;
  return {
    level: "warning",
    code: "gateway/opaque_policy",
    message: `WSO2 operation policies on ${placement} are not modelled; request, response, or fault behavior may differ, so automatic import remains blocked.`,
    coordinate: { origin: input.origin, pointer: input.pointer },
    subject: input.operation
      ? operationDiagnosticSubject(input.api, input.operation, input.revision)
      : apiDiagnosticSubject(input.api, input.revision),
  };
}

function normalizeApi(
  api: WsoApi,
  pointer: string | undefined,
  origin: string,
  revision?: string,
): {
  ops: SynthOp[];
  facts: GatewayFact[];
  diagnostics: GatewayDiagnostic[];
  identityEvidence: GatewayIdentityEvidence[];
  hasQuota: boolean;
} {
  const ops = opsOf(api);
  const facts: GatewayFact[] = [];
  const diagnostics: GatewayDiagnostic[] = [];
  const identityEvidence: GatewayIdentityEvidence[] = [];
  const operationIdentityRefs = ops.map((op) => gatewayOperationRef(op.method, op.path));

  const apiIdentity = projectExplicitIdentityConfiguration({
    configuration: api.identity,
    coordinate: { origin, pointer: `${pointer ?? ""}/identity` },
    operationRefs: operationIdentityRefs,
  });
  identityEvidence.push(...apiIdentity.evidence);
  diagnostics.push(
    ...withGatewayDiagnosticSubject(apiIdentity.diagnostics, apiDiagnosticSubject(api, revision)),
  );

  asStrings(api.securityScheme).forEach((scheme, index) => {
    const type = wso2ConfiguredAuthType(scheme);
    if (!type) return;
    identityEvidence.push(
      ...projectConfiguredAuthType({
        type,
        coordinate: {
          origin,
          pointer: `${pointer ?? ""}/securityScheme/${index}`,
        },
        operationRefs: operationIdentityRefs,
      }),
    );
  });

  asObjects<WsoOperation>(api.operations).forEach((op, j) => {
    const operationRef = synthOperationId(
      api.name,
      op.verb,
      joinGatewayPath(api.context, op.target),
    );
    const operationIdentityRef = gatewayOperationRef(
      op.verb,
      joinGatewayPath(api.context, op.target),
    );
    const scopes = asStrings(op.scopes);
    if (scopes.length > 0) {
      const coordinate: EvidenceCoordinate = {
        origin,
        pointer: `${pointer ?? ""}/operations/${j}/scopes`,
      };
      facts.push({
        target: {
          scope: "operation",
          ref: operationRef,
        },
        predicate: "auth.scopes",
        operation: "restrict",
        value: scopes,
        coordinate,
        note: "WSO2 operation scopes",
      });
    }
    const scopeEvidence = projectExplicitIdentityConfiguration({
      configuration: { ...(op.scopes === undefined ? {} : { scopes: op.scopes }) },
      coordinate: { origin, pointer: `${pointer ?? ""}/operations/${j}` },
      operationRefs: [operationIdentityRef],
      fields: ["scopes"],
    });
    identityEvidence.push(...scopeEvidence.evidence);
    diagnostics.push(
      ...withGatewayDiagnosticSubject(
        scopeEvidence.diagnostics,
        operationDiagnosticSubject(api, op, revision),
      ),
    );

    const operationIdentity = projectExplicitIdentityConfiguration({
      configuration: op.identity,
      coordinate: { origin, pointer: `${pointer ?? ""}/operations/${j}/identity` },
      operationRefs: [operationIdentityRef],
    });
    identityEvidence.push(...operationIdentity.evidence);
    diagnostics.push(
      ...withGatewayDiagnosticSubject(
        operationIdentity.diagnostics,
        operationDiagnosticSubject(api, op, revision),
      ),
    );

    if (op.authType) {
      const type = wso2ConfiguredAuthType(op.authType);
      if (type) {
        identityEvidence.push(
          ...projectConfiguredAuthType({
            type,
            coordinate: {
              origin,
              pointer: `${pointer ?? ""}/operations/${j}/authType`,
            },
            operationRefs: [operationIdentityRef],
          }),
        );
      }
    }
    if (hasConfiguredPolicy(op.operationPolicies)) {
      diagnostics.push(
        operationPolicyDiagnostic({
          api,
          operation: op,
          origin,
          pointer: `${pointer ?? ""}/operations/${j}/operationPolicies`,
          revision,
        }),
      );
    }
  });

  if (hasConfiguredPolicy(api.operationPolicies)) {
    diagnostics.push(
      operationPolicyDiagnostic({
        api,
        origin,
        pointer: `${pointer ?? ""}/operationPolicies`,
        revision,
      }),
    );
  }
  if (hasConfiguredPolicy(api.apiPolicies)) {
    diagnostics.push({
      ...operationPolicyDiagnostic({
        api,
        origin,
        pointer: `${pointer ?? ""}/apiPolicies`,
        revision,
      }),
      message: `WSO2 API policies on API '${api.name}' are not modelled; request, response, or fault behavior may differ, so automatic import remains blocked.`,
    });
  }

  const hasQuota = Boolean(api.apiThrottlingPolicy);
  if (hasQuota) {
    diagnostics.push({
      level: "info",
      code: "wso2/throttling_present",
      message: `Throttling tier '${api.apiThrottlingPolicy}' on '${api.name}' applies but is not an operation semantic.`,
      coordinate: { origin, pointer: `${pointer ?? ""}/apiThrottlingPolicy` },
      subject: apiDiagnosticSubject(api, revision),
    });
  }
  if (hasConfiguredPolicy(api.mediationPolicies)) {
    diagnostics.push({
      level: "warning",
      code: "gateway/opaque_policy",
      message: `WSO2 mediation on '${api.name}' is not modelled; it may transform requests/responses.`,
      coordinate: { origin, pointer: `${pointer ?? ""}/mediationPolicies` },
      subject: apiDiagnosticSubject(api, revision),
    });
  }
  return { ops, facts, diagnostics, identityEvidence, hasQuota };
}

function wso2ConfiguredAuthType(
  scheme: string,
): "api_key" | "basic" | "jwt_bearer" | "mtls" | undefined {
  switch (scheme.trim().toLowerCase().replaceAll("-", "_")) {
    case "api_key":
    case "apikey":
      return "api_key";
    case "basic":
    case "basic_auth":
      return "basic";
    case "jwt":
    case "jwt_bearer":
      return "jwt_bearer";
    case "mtls":
    case "mutual_ssl":
      return "mtls";
    default:
      // `oauth2` alone does not reveal the client grant / user authority, and
      // compound WSO2 scheme labels do not identify one AIR auth type.
      return undefined;
  }
}

export class Wso2GatewayAdapter implements GatewayAdapter<Wso2Connection> {
  readonly kind = "wso2" as const;
  readonly capabilities = CAPABILITIES;

  async probe(connection: Wso2Connection, _ctx: AdapterContext): Promise<GatewayProbeResult> {
    const parsed = parseConnection(connection);
    return {
      reachable: parsed.diagnostics.every((d) => d.level !== "error"),
      capabilities: CAPABILITIES,
      diagnostics: parsed.diagnostics,
    };
  }

  async inventory(
    connection: Wso2Connection,
    _ctx: AdapterContext,
  ): Promise<GatewayInventorySnapshot> {
    const origin = connection.origin ?? "wso2-api.yaml";
    const parsed = parseConnection(connection);
    const diagnostics: GatewayDiagnostic[] = [...parsed.diagnostics];
    const summaries: GatewayApiSummary[] = parsed.apis.map(
      ({ api, pointer, origin: apiOrigin, revision, environmentIds, artifacts }) => {
        const norm = normalizeApi(api, pointer, apiOrigin, revision);
        diagnostics.push(...norm.diagnostics);
        return {
          id: api.name,
          name: api.name,
          ...(api.version ? { version: api.version } : {}),
          ...(revision ? { revision } : {}),
          lifecycle: api.lifeCycleStatus ?? "CREATED",
          environmentIds,
          routes: norm.ops.map((o) => ({
            id: o.operationId,
            methods: [o.method],
            paths: [o.path],
            hosts: [],
            protocols: [],
          })),
          hasSpec: false,
          contract: routeOnlyContract({ origin: apiOrigin, pointer }),
          productIds: [],
          owner: api.provider,
          authSummary: asStrings(api.securityScheme).join(", ") || undefined,
          ...(norm.identityEvidence.length > 0 ? { identityEvidence: norm.identityEvidence } : {}),
          ...(artifacts.length > 0 ? { artifacts } : {}),
          hasQuota: norm.hasQuota,
        };
      },
    );
    const environmentIds = [
      ...new Set(parsed.apis.flatMap((located) => located.environmentIds)),
    ].sort();
    return finalizeInventory({
      schemaVersion: 1,
      gateway: { kind: "wso2", id: connection.id, name: origin },
      environments: environmentIds.map((id) => ({ id })),
      apis: summaries,
      products: [],
      diagnostics,
    });
  }

  async extractApi(
    connection: Wso2Connection,
    api: GatewayApiRef,
    _ctx: AdapterContext,
  ): Promise<GatewayApiImport> {
    const origin = connection.origin ?? "wso2-api.yaml";
    const parsed = parseConnection(connection);
    const requestedSubject: GatewayDiagnosticSubject = {
      api: {
        id: api.id,
        ...(api.revision
          ? {
              ...(api.version ? { apiVersion: api.version } : {}),
              revision: api.revision,
            }
          : api.version
            ? { revision: api.version }
            : {}),
        ...(api.environmentId ? { environment: api.environmentId } : {}),
      },
      ...(api.sourceArtifact ? { artifact: api.sourceArtifact } : {}),
    };
    const matches = parsed.apis.filter(
      ({ api: candidate, revision, environmentIds, artifacts }) => {
        if (candidate.name !== api.id) return false;
        // A caller-supplied axis is a constraint, never permission to attest a
        // missing source value as if it matched.
        if (api.version !== undefined && candidate.version !== api.version) return false;
        if (api.revision !== undefined && revision !== api.revision) return false;
        if (api.environmentId !== undefined && !environmentIds.includes(api.environmentId)) {
          return false;
        }
        if (api.sourceArtifact) {
          const containers = artifacts.filter(
            (artifact) => artifact.kind === "container" && artifact.role === "api_project",
          );
          if (containers.length !== 1) return false;
          const container = containers[0] as GatewayArtifactEvidence;
          if (
            container.origin !== api.sourceArtifact.origin ||
            container.digest !== api.sourceArtifact.digest
          ) {
            return false;
          }
        }
        return true;
      },
    );
    const found = matches.length === 1 ? matches[0] : undefined;
    if (!found) {
      const empty = buildGatewayApiImport({
        originKind: "wso2",
        apiName: api.id,
        sourceCoordinate: { origin: api.sourceArtifact?.origin ?? origin },
        ops: [],
        facts: [],
        diagnostics: [],
      });
      return {
        ...empty,
        diagnostics: [
          ...parsed.diagnostics,
          {
            level: "error",
            code: matches.length > 1 ? "wso2/ambiguous_api_coordinate" : "wso2/unknown_api",
            message:
              matches.length > 1
                ? `${matches.length} WSO2 projects match the requested API/version/revision/environment coordinate. Bind extraction to one inventory sourceArtifact; Anvil will not choose the first project.`
                : `No WSO2 API '${api.id}' matches every requested API-version/revision/environment/source-artifact constraint.`,
            subject: requestedSubject,
          },
        ],
      };
    }
    const norm = normalizeApi(found.api, found.pointer, found.origin, found.revision);
    const selectedDiagnostics = parsed.diagnostics.filter((diagnostic) => {
      if (diagnostic.subject === undefined) return true;
      const subjectApi = diagnostic.subject.api;
      if (subjectApi) {
        if (subjectApi.id !== found.api.name) return false;
        if (subjectApi.apiVersion !== undefined && subjectApi.apiVersion !== found.api.version) {
          return false;
        }
        const foundRevision = found.revision ?? found.api.version;
        if (subjectApi.revision !== undefined && subjectApi.revision !== foundRevision) {
          return false;
        }
        if (subjectApi.environment !== undefined && subjectApi.environment !== api.environmentId) {
          return false;
        }
      }
      const lineage = diagnostic.subject.artifact;
      if (lineage) {
        const matches = found.artifacts.some(
          (artifact) =>
            (artifact.origin === lineage.origin && artifact.digest === lineage.digest) ||
            (artifact.parent?.origin === lineage.origin &&
              artifact.parent?.digest === lineage.digest),
        );
        if (!matches) return false;
      }
      return true;
    });
    return {
      ...buildGatewayApiImport({
        originKind: "wso2",
        apiName: found.api.name,
        version: found.api.version,
        revision: found.revision,
        sourceCoordinate: { origin: found.origin, pointer: found.pointer },
        ops: norm.ops,
        facts: norm.facts,
        authConfigured:
          asStrings(found.api.securityScheme).length > 0 ||
          asObjects<WsoOperation>(found.api.operations).some((op) => Boolean(op.authType)),
        diagnostics: [...selectedDiagnostics, ...norm.diagnostics],
      }),
      ...(norm.identityEvidence.length > 0 ? { identityEvidence: norm.identityEvidence } : {}),
      ...(found.artifacts.length > 0 ? { artifacts: found.artifacts } : {}),
    };
  }
}
