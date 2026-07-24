/**
 * The gateway-neutral vocabulary. Every gateway estate — Kong, WSO2, Apigee,
 * MuleSoft, IBM API Connect — is normalized into exactly these shapes, so there
 * is no per-vendor compiler and no vendor-specific type escapes the adapter.
 *
 * An adapter emits only two things the rest of the pipeline understands:
 *
 *   GatewayApiImport { source: CompilerSource; overlay: GatewayPolicyOverlay }
 *
 * The `source` is the immutable, content-addressed spec the one compiler path
 * consumes; the `overlay` is a `PolicyOverlay` (origin `gateway`) whose every
 * assertion cites evidence back to the original export or management response.
 * Adapters never return AIR.
 */
import { AuthCredentialCarrier, AuthPrincipal, AuthType } from "@anvil/air";
import { z } from "zod";
import type { PolicyOverlay } from "../contract/model.js";
import type { CompilerSource } from "../source/compiler-source.js";

/**
 * The gateway systems Anvil can normalize. Naming a vendor here is not the same
 * as shipping its adapter — the enum is the neutral registry key; `fixture` is
 * the in-repo fake used to prove the pipeline without any vendor code.
 */
export const GatewayKind = z.enum(["fixture", "kong", "wso2", "apigee", "mulesoft", "api_connect"]);
export type GatewayKind = z.infer<typeof GatewayKind>;

/**
 * How much of the common vocabulary an adapter actually supports. Partial support
 * must stay visible — a `false`/`"partial"` is a capability the estate report and
 * certification must not paper over.
 */
export const GatewayAdapterCapabilities = z.object({
  inventory: z.boolean(),
  apiSpecs: z.boolean(),
  routes: z.boolean(),
  authentication: z.boolean(),
  authorization: z.boolean(),
  trafficPolicies: z.boolean(),
  transformations: z.enum(["none", "partial", "full"]),
  faultPolicies: z.boolean(),
  products: z.boolean(),
  consumers: z.boolean(),
  trafficAnalytics: z.boolean(),
  drift: z.boolean(),
  /** Whether the adapter can mutate the gateway. Read-only adapters declare false. */
  publish: z.boolean(),
});
export type GatewayAdapterCapabilities = z.infer<typeof GatewayAdapterCapabilities>;

/**
 * Where a normalized record came from in the original artifact — an export file
 * path + JSON/XML pointer, or a management-API response coordinate. Every
 * normalized policy record and every overlay assertion carries one so a reviewer
 * can trace an effective semantic back to the byte that justified it.
 */
export const EvidenceCoordinate = z.object({
  /** The export archive member or management endpoint the record came from. */
  origin: z.string(),
  /** A JSON Pointer / XPath / dotted path into that artifact. */
  pointer: z.string().optional(),
  /** Byte or line span, when the origin is a text artifact. */
  span: z.object({ start: z.number().int(), end: z.number().int() }).optional(),
});
export type EvidenceCoordinate = z.infer<typeof EvidenceCoordinate>;

const GatewaySha256Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
/** One accepted collection project container plus every bounded member. */
export const GATEWAY_MAX_ARTIFACT_EVIDENCE = 100_001;
const GatewayArtifactPath = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !path.split("/").some((segment) => segment === "" || segment === "." || segment === ".."),
    "must be a safe relative POSIX path",
  );

/**
 * Content-addressed evidence for a native gateway artifact.
 *
 * A container and each accepted member get separate records. Member records
 * retain their parent container coordinate and digest, so inventory and import
 * reports can prove exactly which bytes were inspected without embedding those
 * bytes or a host-local filesystem path.
 */
export const GatewayArtifactEvidence = z
  .object({
    kind: z.enum(["container", "member"]),
    role: z.enum([
      "api_project",
      "api_definition",
      "api_metadata",
      "deployment_environments",
      "formal_definition",
      "opaque_policy",
      "uninterpreted",
    ]),
    path: GatewayArtifactPath,
    origin: z.string().min(1),
    digest: GatewaySha256Digest,
    bytes: z.number().int().nonnegative(),
    /**
     * Exact outer-package identity when `digest` describes canonical expanded
     * project content. Repacking a ZIP may change this value without changing
     * the semantic member graph; receipts retain both.
     */
    packaging: z
      .object({
        digest: GatewaySha256Digest,
        bytes: z.number().int().nonnegative(),
      })
      .optional(),
    parent: z
      .object({
        origin: z.string().min(1),
        digest: GatewaySha256Digest,
      })
      .optional(),
  })
  .superRefine((artifact, ctx) => {
    if (artifact.kind === "member" && artifact.parent === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["parent"],
        message: "member artifact evidence requires its parent container origin and digest",
      });
    }
    if (artifact.kind === "container" && artifact.parent !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["parent"],
        message: "container artifact evidence cannot claim a parent container",
      });
    }
    if (artifact.kind === "member" && artifact.packaging !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["packaging"],
        message: "only container artifact evidence may carry outer packaging identity",
      });
    }
  });
export type GatewayArtifactEvidence = z.infer<typeof GatewayArtifactEvidence>;

/**
 * Structured, source-addressable identity facts exported by a gateway.
 *
 * Identity fields are optional on purpose: absence is evidence debt, not
 * permission to invent a default. `basis` and `coordinate` are mandatory so an
 * audit can distinguish a configured plugin family from an exact setting. In
 * particular, an OAuth token endpoint is never an issuer; adapters may populate
 * `issuer` only when the gateway export names it.
 */
export const GatewayIdentityEvidence = z
  .object({
    coordinate: EvidenceCoordinate,
    /**
     * Configured plugin family is weaker than exact field configuration, and
     * observed enforcement is a third evidence class. Adapters must not collapse
     * these into one undifferentiated auth summary.
     */
    basis: z.enum(["configured_plugin_type", "explicit_configuration", "observed_enforcement"]),
    /** Operation selector when policy/scopes are route-specific; absent means API-wide. */
    operationRef: z.string().min(1).optional(),
    type: AuthType.optional(),
    principal: AuthPrincipal.optional(),
    issuer: z.string().url().optional(),
    audience: z.string().min(1).optional(),
    carrier: AuthCredentialCarrier.optional(),
    scopes: z.array(z.string()).optional(),
  })
  .superRefine((evidence, ctx) => {
    if (evidence.basis !== "configured_plugin_type") return;
    if (evidence.type === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["type"],
        message: "configured_plugin_type requires an unambiguous normalized auth type",
      });
    }
    for (const field of ["principal", "issuer", "audience", "carrier", "scopes"] as const) {
      if (evidence[field] !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message:
            `configured_plugin_type may identify only the auth type; ${field} requires ` +
            "explicit_configuration or observed_enforcement evidence",
        });
      }
    }
  });
export type GatewayIdentityEvidence = z.infer<typeof GatewayIdentityEvidence>;

/** A route as the gateway exposes it (the runtime coordinate, not the backend). */
export const GatewayRoute = z.object({
  id: z.string(),
  methods: z.array(z.string()).default([]),
  paths: z.array(z.string()).default([]),
  hosts: z.array(z.string()).default([]),
  protocols: z.array(z.string()).default([]),
});
export type GatewayRoute = z.infer<typeof GatewayRoute>;

/** A deployment environment / stage. */
export const GatewayEnvironment = z.object({
  id: z.string(),
  name: z.string().optional(),
  kind: z.string().optional(),
});
export type GatewayEnvironment = z.infer<typeof GatewayEnvironment>;

/** A product / plan grouping consumers subscribe to. */
export const GatewayProduct = z.object({
  id: z.string(),
  name: z.string(),
  plans: z.array(z.string()).default([]),
});
export type GatewayProduct = z.infer<typeof GatewayProduct>;

/**
 * Provenance and fidelity of the API contract behind an inventory/import
 * record. Gateway route tables are not formal API contracts: adapters must say
 * when Anvil synthesized a route-only OpenAPI document instead of implying the
 * gateway supplied Swagger/OpenAPI.
 */
export const GatewayContractProvenance = z.object({
  kind: z.enum(["native", "synthesized", "missing"]),
  fidelity: z.enum(["full", "route_only", "missing"]),
  /** Contract syntax when known. This is intentionally open for RAML/WSDL/etc. */
  format: z.string().optional(),
  version: z.string().optional(),
  /** Exact export/member/pointer from which this contract claim was derived. */
  location: EvidenceCoordinate,
  /** Immutable source identity once bytes have been materialized for compilation. */
  source: z
    .object({
      snapshotId: z.string(),
      sourceHash: z.string(),
      entrypoint: z.string(),
    })
    .optional(),
  /** Stable next step when the available contract is degraded or missing. */
  remediation: z.string().optional(),
});
export type GatewayContractProvenance = z.infer<typeof GatewayContractProvenance>;

/** One API as it appears in the estate — enough to assess without compiling it. */
export const GatewayApiSummary = z.object({
  id: z.string(),
  name: z.string(),
  /** Semantic API/product version as declared by the contract or gateway. */
  version: z.string().optional(),
  /**
   * Distinct gateway deployment revision. When absent, `version` remains the
   * legacy effective revision for adapters whose source has only one axis.
   */
  revision: z.string().optional(),
  lifecycle: z.string().optional(),
  environmentIds: z.array(z.string()).default([]),
  routes: z.array(GatewayRoute).default([]),
  /**
   * @deprecated Use `contract`. True means a native, full-fidelity formal
   * contract is available; synthesized route tables must remain false.
   */
  hasSpec: z.boolean().default(false),
  contract: GatewayContractProvenance.optional(),
  productIds: z.array(z.string()).default([]),
  owner: z.string().optional(),
  /** A one-line summary of the authentication posture (never a secret). */
  authSummary: z.string().optional(),
  /** Exact identity facts, when the export actually contains them. */
  identityEvidence: z.array(GatewayIdentityEvidence).optional(),
  /** Content-addressed native files that support this API inventory row. */
  artifacts: z.array(GatewayArtifactEvidence).max(GATEWAY_MAX_ARTIFACT_EVIDENCE).optional(),
  hasQuota: z.boolean().default(false),
  /** Coarse traffic level where the gateway exposes it (never PII). */
  trafficSummary: z.string().optional(),
});
export type GatewayApiSummary = z.infer<typeof GatewayApiSummary>;

/**
 * The source object a gateway diagnostic applies to.
 *
 * Absence is meaningful: the diagnostic is estate/global (for example the
 * export cannot be parsed at all). Adapters populate the API identity whenever
 * the source bytes identify one API, and add route identity only when the
 * export identifies that route. Unknown revision/environment/route fields stay
 * absent rather than being replaced with synthetic sentinels.
 */
export const GatewayDiagnosticSubject = z
  .object({
    api: z
      .object({
        id: z.string().min(1),
        /** Semantic API contract/product version, when the gateway distinguishes it. */
        apiVersion: z.string().min(1).optional(),
        /** Gateway deployment revision, when distinct from the API version. */
        revision: z.string().min(1).optional(),
        environment: z.string().min(1).optional(),
      })
      .optional(),
    /**
     * Project/container lineage for a local failure that occurs before an API
     * identity can be parsed. This is not global: selection can compare it with
     * the selected inventory row's content-addressed artifact evidence.
     */
    artifact: z
      .object({
        origin: z.string().min(1),
        digest: GatewaySha256Digest,
      })
      .optional(),
    route: z
      .object({
        id: z.string().min(1).optional(),
        method: z.string().min(1).optional(),
        path: z.string().min(1).optional(),
        operationRef: z.string().min(1).optional(),
      })
      .refine(
        (route) =>
          route.id !== undefined ||
          route.method !== undefined ||
          route.path !== undefined ||
          route.operationRef !== undefined,
        "route subject must carry at least one source route identity",
      )
      .optional(),
  })
  .superRefine((subject, ctx) => {
    if (subject.api === undefined && subject.artifact === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "diagnostic subject requires API identity or artifact lineage",
      });
    }
    if (subject.route !== undefined && subject.api === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["route"],
        message: "route ownership requires an API identity",
      });
    }
  });
export type GatewayDiagnosticSubject = z.infer<typeof GatewayDiagnosticSubject>;

/** A structured diagnostic from a gateway operation (parallel to AIR's Diagnostic). */
export const GatewayDiagnostic = z.object({
  level: z.enum(["error", "warning", "info"]),
  code: z.string(),
  message: z.string(),
  coordinate: EvidenceCoordinate.optional(),
  /**
   * Source ownership used by estate audit/import. Missing means genuinely
   * global, never "the adapter forgot which API this came from".
   */
  subject: GatewayDiagnosticSubject.optional(),
});
export type GatewayDiagnostic = z.infer<typeof GatewayDiagnostic>;

/** Attach source ownership to diagnostics that do not already carry a narrower subject. */
export function withGatewayDiagnosticSubject(
  diagnostics: readonly GatewayDiagnostic[],
  subject: GatewayDiagnosticSubject,
): GatewayDiagnostic[] {
  return diagnostics.map((diagnostic) =>
    diagnostic.subject ? diagnostic : { ...diagnostic, subject },
  );
}

/**
 * A lightweight, content-addressed picture of a gateway estate. Deliberately
 * cheap: it lists APIs without compiling any of them, so a large estate can be
 * inventoried and assessed before selecting which APIs to import.
 */
export const GatewayInventorySnapshot = z.object({
  schemaVersion: z.literal(1),
  gateway: z.object({ kind: GatewayKind, id: z.string(), name: z.string().optional() }),
  environments: z.array(GatewayEnvironment).default([]),
  apis: z.array(GatewayApiSummary).default([]),
  products: z.array(GatewayProduct).default([]),
  diagnostics: z.array(GatewayDiagnostic).default([]),
  /** Content digest over the normalized inventory (excludes timestamps). */
  digest: z.string(),
});
export type GatewayInventorySnapshot = z.infer<typeof GatewayInventorySnapshot>;

/**
 * A `PolicyOverlay` produced by a gateway adapter. It is a plain overlay with
 * `origin: "gateway"`; the alias names the contract that its assertions are
 * evidence-backed control-plane facts, applied to the same resolver as any other
 * overlay.
 */
export type GatewayPolicyOverlay = PolicyOverlay;

/**
 * The one thing a gateway adapter yields per API: an immutable source plus a
 * gateway policy overlay. Both feed the single compiler path
 * (`compileContract`); no adapter-specific type crosses this boundary.
 */
export interface GatewayApiImport {
  source: CompilerSource;
  overlay: GatewayPolicyOverlay;
  contract: GatewayContractProvenance;
  diagnostics: GatewayDiagnostic[];
  /** Exact identity facts carried alongside the compiled contract. */
  identityEvidence?: GatewayIdentityEvidence[];
  /** Native container/member evidence carried into the immutable import receipt. */
  artifacts?: GatewayArtifactEvidence[];
}

/** An opaque handle for an API within a connection (adapter-defined id). */
export const GatewayApiRef = z.object({
  id: z.string(),
  name: z.string().optional(),
  /** Semantic API/product version. */
  version: z.string().optional(),
  /** Distinct gateway deployment revision, when the source exposes one. */
  revision: z.string().optional(),
  /** Selected deployment environment, when the adapter exposes or accepts one. */
  environmentId: z.string().optional(),
  /**
   * Exact native project/container selected from inventory. Collection
   * adapters use this to bind extraction to the reviewed artifact rather than
   * re-resolving a merely similar API coordinate.
   */
  sourceArtifact: z
    .object({
      origin: z.string().min(1),
      digest: GatewaySha256Digest,
    })
    .optional(),
});
export type GatewayApiRef = z.infer<typeof GatewayApiRef>;

/** The outcome of probing a connection. */
export interface GatewayProbeResult {
  reachable: boolean;
  protocolVersion?: string;
  capabilities: GatewayAdapterCapabilities;
  diagnostics: GatewayDiagnostic[];
}

/** One detected drift between a prior inventory and the live gateway. */
export interface GatewayDriftChange {
  apiId: string;
  dimension:
    | "spec"
    | "route"
    | "target"
    | "auth"
    | "scopes"
    | "products"
    | "quota"
    | "transformations"
    | "faults"
    | "lifecycle";
  message: string;
}

export interface GatewayDriftResult {
  changes: GatewayDriftChange[];
  diagnostics: GatewayDiagnostic[];
}
