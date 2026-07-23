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
  version: z.string().optional(),
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
  hasQuota: z.boolean().default(false),
  /** Coarse traffic level where the gateway exposes it (never PII). */
  trafficSummary: z.string().optional(),
});
export type GatewayApiSummary = z.infer<typeof GatewayApiSummary>;

/** A structured diagnostic from a gateway operation (parallel to AIR's Diagnostic). */
export const GatewayDiagnostic = z.object({
  level: z.enum(["error", "warning", "info"]),
  code: z.string(),
  message: z.string(),
  coordinate: EvidenceCoordinate.optional(),
});
export type GatewayDiagnostic = z.infer<typeof GatewayDiagnostic>;

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
}

/** An opaque handle for an API within a connection (adapter-defined id). */
export const GatewayApiRef = z.object({
  id: z.string(),
  name: z.string().optional(),
  version: z.string().optional(),
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
